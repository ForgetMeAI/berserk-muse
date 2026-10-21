#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTerminalToolResult, verifyResult } from '../tests/client-scripted-driver.mjs';
import { prepareFixture, proveSandbox, runProcess, sandboxProfile, sha256 } from './verify-clients.mjs';
import { classifyCommand, finalSummaryComplete as verifiedFinalSummary, healthDeltas, waitForIdleHealth } from './verify-claude-live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_ORIGIN = 'http://127.0.0.1:8787';
const TIMEOUT_MS = 8 * 60 * 1000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const LOCAL_KEY = 'Bearer muse-local';
const REQUIRED_STAGES = ['red', 'read', 'edit', 'green', 'proof-create', 'proof-read'];
const HERMES_RUNTIME_ROOTS = [
  path.join(os.homedir(), '.hermes', 'hermes-agent'),
  path.join(os.homedir(), '.local', 'share', 'uv', 'python'),
];
const SOURCE_FILES = [
  'src/agent-clients.mjs', 'src/server.mjs', 'src/protocol.mjs',
  'tests/client-scripted-driver.mjs', 'scripts/verify-clients.mjs',
  'scripts/verify-claude-live.mjs',
  'scripts/verify-hermes-live.mjs', 'tests/verify-hermes-live.test.mjs',
];
const TASK_PROMPT = [
  'In this synthetic temporary repository, correct invoice tax percentage calculation.',
  'Use only the terminal tool and work only inside the current directory.',
  'Only invoice.mjs and proof.json are writable; tests are read-only and no sibling temporary files may be created.',
  'Node.js is available. Use Node fs.readFileSync/writeFileSync for source edits and proof creation. Avoid system python3, Apple developer tools, and in-place editors that create sibling files.',
  'First run `node --test tests/invoice.test.mjs` and observe the failing test.',
  'Read invoice.mjs, then make the smallest correction so taxPercent is treated as a percentage.',
  'Run the entire test file again and confirm all three tests pass.',
  'Create proof.json with kind `synthetic-invoice-proof` and exactly three boolean checks named standard, fractional, and zero, all true.',
  'Read proof.json back and report the failing test, inspected source, correction, passing tests, and all three proof checks.',
  'In the final summary explicitly confirm RED reproduced, source read and fixed, GREEN with three passing tests, and proof standard/fractional/zero checks.',
  'Do not access files outside this temporary repository or use network services.',
].join(' ');

function jsonResponse(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

export function parseHermesLiveOptions(argv = process.argv.slice(2), platform = process.platform) {
  if (platform !== 'darwin') throw new Error('The isolated Hermes live verifier requires macOS.');
  let hermesBin = null;
  let approveIsolatedHermes = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--hermes-bin') {
      if (!argv[index + 1]) throw new Error('--hermes-bin requires an absolute executable path.');
      hermesBin = argv[++index];
    } else if (argv[index] === '--approve-isolated-hermes') {
      approveIsolatedHermes = true;
    } else {
      throw new Error('Only --hermes-bin and --approve-isolated-hermes are supported.');
    }
  }
  if (typeof hermesBin !== 'string' || !path.isAbsolute(hermesBin) || /[\0\r\n]/.test(hermesBin)) {
    throw new Error('Pass --hermes-bin with an absolute executable path.');
  }
  if (!approveIsolatedHermes) throw new Error('Pass --approve-isolated-hermes for the isolated local test profile.');
  return { hermesBin, approveIsolatedHermes };
}

export function hermesLiveChildEnv(settings) {
  return {
    ...settings.env,
    HERMES_YOLO_MODE: '1',
    HERMES_STREAM_RETRIES: '0',
    HERMES_SKIP_UPDATE_CHECK: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

export function parseHermesVersion(text) {
  const match = typeof text === 'string' ? text.match(/\bHermes Agent\s+v(\d+\.\d+\.\d+)\s*\((\d{4}\.\d{1,2}\.\d{1,2})\)/) : null;
  return match ? { version: match[1], releaseDate: match[2] } : null;
}

export function readsProofAfterWrite(command) {
  if (typeof command !== 'string') return false;
  const write = command.search(/\bwriteFileSync\s*\(\s*(['"])(?:\.\/)?proof\.json\1/);
  const read = command.search(/\breadFileSync\s*\(\s*(['"])(?:\.\/)?proof\.json\1/);
  return write >= 0 && read > write;
}

function commandFromToolCall(call) {
  let args = call?.function?.arguments ?? call?.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return ''; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const key of ['command', 'cmd', 'script']) if (typeof args[key] === 'string') return args[key];
  return '';
}

export function classifyTerminalCommand(command) {
  if (typeof command !== 'string') return 'other';
  if (/\bproof\.json\b/.test(command)) {
    const writesProof = /writeFile(?:Sync)?|write_text|open\([^\n]*["']w/.test(command) ||
      />>?\s*['"]?(?:[^\s'"]*\/)?proof\.json\b/.test(command) || /\btee\s+(?:-[a-z]+\s+)*['"]?(?:[^\s'"]*\/)?proof\.json\b/.test(command);
    return writesProof ? 'proof-create' : 'proof-read';
  }
  const category = classifyCommand(command);
  return category === 'unclassified' ? 'other' : category;
}

function terminalResultContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n');
  return '';
}

function permissionDenial(text) {
  return /BLOCKED:|User denied this command|Operation not permitted|Permission denied|sandbox[^\n]{0,40}denied|"status"\s*:\s*"blocked"|\b(?:EPERM|EACCES)\b/i.test(text);
}

function effectiveStage(category, decoded) {
  if (category !== 'test') return category;
  const output = decoded.text;
  if (/pass\s+3/i.test(output) && /fail\s+0/i.test(output) && decoded.envelope?.exitCode === 0) return 'green';
  if (/not ok|ERR_ASSERTION|AssertionError|fail(?:ed)?\s*[:=]?\s*[1-9]/i.test(output) && decoded.envelope?.exitCode !== 0) return 'red';
  return 'test';
}

export function createAuditLedger() {
  const bodyHashes = new Set();
  const calls = new Map();
  const results = new Set();
  const actions = [];
  let halted = null;

  function halt(reason) {
    halted ||= reason;
    return { forward: false, reason: halted };
  }

  function inspectBody(rawBody) {
    const bodyHash = digest(rawBody);
    if (halted) return { ...halt(halted), bodyHash };
    if (bodyHashes.has(bodyHash)) return { ...halt('duplicate_request_body'), bodyHash };
    bodyHashes.add(bodyHash);
    let body;
    try { body = JSON.parse(rawBody); } catch { return { ...halt('invalid_json_request'), bodyHash }; }
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return { ...halt('invalid_chat_request'), bodyHash };

    for (const message of body.messages) {
      if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const id = call?.id;
          if (typeof id !== 'string' || !id) return { ...halt('malformed_tool_call'), bodyHash };
          if (calls.has(id)) continue;
          const toolName = call?.function?.name ?? call?.name ?? '';
          if (typeof toolName !== 'string' || toolName.toLowerCase() !== 'terminal') return { ...halt('unsupported_tool'), bodyHash };
          const command = commandFromToolCall(call);
          calls.set(id, { category: classifyTerminalCommand(command), commandHash: digest(command), readsProofAfterWrite: readsProofAfterWrite(command) });
        }
      } else if (message?.role === 'tool' && typeof message.tool_call_id === 'string' && !results.has(message.tool_call_id)) {
        const call = calls.get(message.tool_call_id);
        if (!call) continue;
        const rawResult = terminalResultContent(message);
        const decoded = parseTerminalToolResult(rawResult);
        if (permissionDenial(`${decoded.raw}\n${decoded.text}`)) return { ...halt('tool_permission_denied'), bodyHash };
        const stage = effectiveStage(call.category, decoded);
        const verified = ['red', 'read', 'edit', 'green', 'proof-create', 'proof-read'].includes(stage) && verifyResult({ label: stage }, decoded);
        results.add(message.tool_call_id);
        const proofReadRequiresOfflineReview = stage === 'proof-create' && verified && call.readsProofAfterWrite;
        actions.push({ stage, verified, proofReadRequiresOfflineReview, commandHash: call.commandHash, resultHash: digest(rawResult), resultBytes: Buffer.byteLength(rawResult), exitCode: decoded.envelope?.exitCode ?? null, errorIsNull: decoded.envelope === null ? null : decoded.envelope.error === null });
      }
    }
    return { forward: true, bodyHash };
  }

  function snapshot() {
    let position = -1;
    const stageEvidence = actions.flatMap(action => action.verified ? [action.stage] : []);
    const requiredStagesVerified = REQUIRED_STAGES.every(stage => {
      const next = stageEvidence.findIndex((item, index) => index > position && item === stage);
      if (next < 0) return false;
      position = next;
      return true;
    });
    return { requestBodyHashes: [...bodyHashes], toolActions: actions.map(item => ({ ...item })), requiredStagesVerified, haltReason: halted };
  }

  return { inspectBody, snapshot, stop: halt };
}

export function parseSseCompletion(buffer) {
  const text = buffer.toString('utf8');
  let content = '';
  let done = false;
  let finishReason = null;
  const toolCalls = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { done = true; continue; }
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    for (const choice of event.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      for (const item of delta.tool_calls ?? []) {
        const index = Number.isInteger(item.index) ? item.index : 0;
        const existing = toolCalls.get(index) ?? { name: '', id: '' };
        if (typeof item.id === 'string') existing.id = item.id;
        if (typeof item.function?.name === 'string') existing.name = item.function.name;
        toolCalls.set(index, existing);
      }
    }
  }
  return { complete: done && finishReason !== null, content, finishReason, toolCalls: [...toolCalls.values()] };
}

export function finalSummaryComplete(text) {
  return verifiedFinalSummary(text);
}

async function readLimited(req, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request_too_large');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

async function readResponseLimited(response, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('response_too_large');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

async function replyUpstream(response, res, buffer) {
  const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
  const delivered = new Promise(resolve => {
    res.once('finish', () => resolve(true));
    res.once('close', () => resolve(res.writableFinished));
  });
  res.writeHead(response.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(buffer);
  return delivered;
}

function startRelay({ serviceOrigin, ledger, onHalt }) {
  const requests = [];
  const modelResponses = [];
  let stopped = false;
  const pending = new Set();
  let haltHandler = onHalt;
  const halt = reason => {
    stopped = true;
    ledger.stop(reason);
    haltHandler?.(reason);
  };
  const server = http.createServer(async (req, res) => {
    const requestPath = (req.url ?? '').split('?')[0];
    const hostOK = req.headers.host === `127.0.0.1:${server.address()?.port}` || req.headers.host === `localhost:${server.address()?.port}`;
    const record = { method: req.method ?? 'UNKNOWN', path: requestPath, status: null, authorizationPresent: typeof req.headers.authorization === 'string' };
    requests.push(record);
    if (!hostOK) { record.status = 403; jsonResponse(res, 403, { error: 'invalid_host' }); return; }
    if (req.method === 'GET' && requestPath === '/health') {
      jsonResponse(res, 200, { service: 'berserk-muse', queue: { active: false } });
      record.status = 200;
      return;
    }
    if (req.method === 'GET' && requestPath === '/v1/models') {
      if (req.headers.authorization !== LOCAL_KEY) { record.status = 401; jsonResponse(res, 401, { error: 'unauthorized' }); return; }
      try {
        const upstream = await fetch(`${serviceOrigin}/v1/models`, { headers: { authorization: LOCAL_KEY } });
        const payload = await readResponseLimited(upstream, 65536);
        record.status = upstream.status;
        await replyUpstream(upstream, res, payload);
      } catch {
        record.status = 502;
        jsonResponse(res, 502, { error: 'model_list_unavailable' });
      }
      return;
    }
    if (req.method !== 'POST' || requestPath !== '/v1/chat/completions') {
      record.status = 404;
      jsonResponse(res, 404, { error: 'unsupported_path' });
      return;
    }
    if (stopped) { record.status = 503; jsonResponse(res, 503, { error: 'relay_stopped' }); return; }
    if (req.headers.authorization !== LOCAL_KEY || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      record.status = 401;
      halt('client_request_rejected');
      jsonResponse(res, 401, { error: 'unauthorized_or_invalid_content_type' });
      return;
    }
    let rawBody;
    try { rawBody = (await readLimited(req, MAX_REQUEST_BYTES)).toString('utf8'); }
    catch {
      record.status = 413;
      halt('request_too_large');
      jsonResponse(res, 413, { error: 'request_too_large' });
      return;
    }
    const inspected = ledger.inspectBody(rawBody);
    record.bodyHash = inspected.bodyHash;
    if (!inspected.forward) {
      record.status = inspected.reason === 'tool_permission_denied' ? 403 : 409;
      halt(inspected.reason);
      jsonResponse(res, record.status, { error: inspected.reason });
      return;
    }
    if (req.aborted || res.destroyed) { halt('client_disconnected_before_forward'); return; }
    const responseRecord = { requestHash: inspected.bodyHash, status: null, completed: false, responseHash: null, toolCallCount: 0, finalMessageLength: 0, finalSummaryVerified: false, finishReason: null, errorCode: null };
    modelResponses.push(responseRecord);
    let upstream;
    let buffer;
    const controller = new AbortController();
    pending.add(controller);
    const deadline = setTimeout(() => controller.abort(), 240000);
    res.once('close', () => {
      if (!res.writableFinished) { controller.abort(); halt('client_disconnected_after_acceptance'); }
    });
    try {
      upstream = await fetch(`${serviceOrigin}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: LOCAL_KEY, 'content-type': 'application/json' },
        body: rawBody,
        signal: controller.signal,
      });
      responseRecord.status = upstream.status;
      record.status = upstream.status;
      buffer = await readResponseLimited(upstream, MAX_RESPONSE_BYTES);
    } catch {
      responseRecord.errorCode = 'upstream_transport_failure';
      record.status = 502;
      halt('ambiguous_model_post');
      jsonResponse(res, 502, { error: 'upstream_transport_failure_retry_disabled' });
      return;
    } finally {
      clearTimeout(deadline);
      pending.delete(controller);
    }
    responseRecord.responseHash = digest(buffer);
    if (upstream.status < 200 || upstream.status >= 300) {
      responseRecord.errorCode = 'upstream_non_success';
      halt('failed_model_post');
      jsonResponse(res, upstream.status, { error: 'upstream_model_request_failed_retry_disabled' });
      return;
    }
    let completion;
    if ((upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      completion = parseSseCompletion(buffer);
    } else {
      try {
        const json = JSON.parse(buffer.toString('utf8'));
        const message = json.choices?.[0]?.message ?? {};
        completion = {
          complete: typeof json.id === 'string' && typeof json.choices?.[0]?.finish_reason === 'string',
          content: typeof message.content === 'string' ? message.content : '',
          finishReason: json.choices?.[0]?.finish_reason ?? null,
          toolCalls: (message.tool_calls ?? []).map(call => ({ name: call.function?.name ?? call.name ?? '', id: call.id ?? '' })),
        };
      } catch { completion = { complete: false, content: '', finishReason: null, toolCalls: [] }; }
    }
    responseRecord.toolCallCount = completion.toolCalls.length;
    responseRecord.finalMessageLength = completion.content.length;
    responseRecord.finishReason = completion.finishReason;
    responseRecord.finalSummaryVerified = finalSummaryComplete(completion.content);
    if (!completion.complete) {
      responseRecord.errorCode = 'incomplete_upstream_response';
      halt('ambiguous_model_response');
      jsonResponse(res, 502, { error: 'incomplete_model_response_retry_disabled' });
      return;
    }
    if (completion.toolCalls.some(call => typeof call.name !== 'string' || call.name.toLowerCase() !== 'terminal')) {
      responseRecord.errorCode = 'unsupported_tool';
      halt('unsupported_tool');
      jsonResponse(res, 403, { error: 'unsupported_tool' });
      return;
    }
    responseRecord.completed = false;
    if (res.destroyed) {
      halt('client_disconnected_after_acceptance');
      responseRecord.errorCode = 'client_disconnected_after_acceptance';
      return;
    }
    const delivered = await replyUpstream(upstream, res, buffer);
    if (!delivered) {
      responseRecord.errorCode = 'client_response_delivery_unknown';
      halt('client_response_delivery_unknown');
      return;
    }
    responseRecord.completed = true;
  });
  return {
    server, requests, modelResponses,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      return server.address().port;
    },
    setStopHandler(handler) { haltHandler = handler; },
    async close() {
      for (const controller of pending) controller.abort();
      await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
    get port() { return server.address()?.port ?? null; },
  };
}

function spawnBoundedHermes({ hermesBin, args, cwd, env, sandbox, timeoutMs, onStop }) {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, hermesBin, ...args], {
    cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let stopReason = null;
  let stopped = false;
  const killTree = reason => {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
    timer.unref();
  };
  const collect = (target, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_RESPONSE_BYTES) { killTree('client_output_limit'); return; }
    if (target === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => collect('stdout', chunk));
  child.stderr.on('data', chunk => collect('stderr', chunk));
  child.once('error', () => killTree('client_spawn_error'));
  const timeout = setTimeout(() => killTree('client_timeout'), timeoutMs);
  const promise = new Promise(resolve => child.once('close', (code, signal) => {
    clearTimeout(timeout);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Owned process group has exited. */ }
    resolve({ code, signal, stdout, stderr, outputBytes, stopReason });
  }));
  return { promise, stop: killTree, pid: child.pid, onStop };
}

async function serviceSnapshot({ requireIdle = true } = {}) {
  const response = await fetch(`${SERVICE_ORIGIN}/health`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('service_not_ready');
  const body = await response.json();
  if (body.service !== 'berserk-muse' || !body.queue || (requireIdle && (body.ready !== true || body.queue.active))) throw new Error('service_not_idle');
  return { service: body.service, version: body.version ?? null, ready: body.ready === true, requests: body.stats?.requests ?? null, completed: body.stats?.completed ?? null, errors: body.stats?.errors ?? null, queueActive: body.queue.active };
}

async function hashMap(paths) {
  const items = await Promise.all(paths.map(async relative => [relative, await sha256(path.join(ROOT, relative))]));
  return Object.fromEntries(items);
}

function parentVerifierScript(sourcePath, proofPath) {
  return `import fs from 'node:fs';import assert from 'node:assert/strict';import {totalWithTax} from ${JSON.stringify(sourcePath)};const proof=JSON.parse(fs.readFileSync(${JSON.stringify(proofPath)},'utf8'));assert.equal(totalWithTax(1200,10),1320);assert.equal(totalWithTax(100,7.25),107);assert.equal(totalWithTax(99,0),99);assert.deepEqual(Object.keys(proof.checks).sort(),['fractional','standard','zero']);assert.ok(['fractional','standard','zero'].every(k=>proof.checks[k]===true));console.log(JSON.stringify({verified:true}));`;
}

async function runLiveCheck({ hermesBin, approveIsolatedHermes }) {
  if (!approveIsolatedHermes) throw new Error('isolated_hermes_approval_missing');
  let tempRoot = null;
  let relay = null;
  let child = null;
  const startedAt = new Date().toISOString();
  let failure = 'preflight_failed';
  let version = null;
  let executableSha256 = null;
  let healthBefore = null;
  let healthAfter = null;
  let isolation = null;
  let sourceHashesBefore = null;
  let sourceHashesAfter = null;
  let fixture = null;
  let parentNoNetworkVerifier = false;
  let processResult = null;
  let retryControls = null;
  const ledger = createAuditLedger();
  try {
    healthBefore = await serviceSnapshot();
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'berserk-hermes-live-'));
    const fixtureDir = path.join(tempRoot, 'fixture');
    const profileDir = path.join(tempRoot, 'profile');
    await mkdir(fixtureDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    sourceHashesBefore = await hashMap(SOURCE_FILES);
    const runtimeRoots = [...HERMES_RUNTIME_ROOTS, path.dirname(hermesBin), hermesBin];
    const relayState = startRelay({ serviceOrigin: SERVICE_ORIGIN, ledger, onHalt: reason => child?.stop(reason) });
    relay = relayState;
    const relayPort = await relay.listen();
    const settings = await prepareFixture(fixtureDir, profileDir, 'hermes', relayPort);
    settings.env.PATH = [...new Set([path.dirname(hermesBin), ...settings.env.PATH.split(path.delimiter)])].join(path.delimiter);
    const configDir = path.join(profileDir, 'hermes');
    const configText = await readFile(path.join(configDir, 'config.yaml'), 'utf8');
    retryControls = {
      apiMaxRetriesOne: /^  api_max_retries: 1$/m.test(configText),
      streamRetriesZero: settings.env.HERMES_STREAM_RETRIES === '0',
      yoloScopedToApprovedChild: !Object.hasOwn(settings.env, 'HERMES_YOLO_MODE'),
      relayRejectsDuplicateBodies: true,
    };
    if (!retryControls.apiMaxRetriesOne || !retryControls.streamRetriesZero) throw new Error('retry_controls_missing');
    const testPath = path.join(fixtureDir, 'tests', 'invoice.test.mjs');
    const sourcePath = path.join(fixtureDir, 'invoice.mjs');
    const proofPath = path.join(fixtureDir, 'proof.json');
    const testHashBefore = await sha256(testPath);
    const sourceHashBefore = await sha256(sourcePath);
    const sandbox = sandboxProfile({ fixtureDir, profileDir, port: relayPort, runtimeRoots });
    isolation = await proveSandbox({ sandbox, fixtureDir, port: relayPort, profileDir });
    const versionResult = await runProcess(hermesBin, ['--version'], {
      cwd: fixtureDir,
      env: { ...settings.env, HERMES_SKIP_UPDATE_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' },
      sandbox: sandboxProfile({ fixtureDir, profileDir, port: relayPort, runtimeRoots, allowNetwork: false }),
      timeoutMs: 15000,
    });
    const parsedVersion = parseHermesVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (versionResult.code !== 0 || !parsedVersion) throw new Error('hermes_version_probe_failed');
    version = parsedVersion.version;
    executableSha256 = await sha256(hermesBin);
    const prompt = TASK_PROMPT;
    const args = [...settings.args, '--query', prompt, '--toolsets', 'terminal', '--quiet', '--ignore-user-config', '--ignore-rules', '--max-turns', '16'];
    const env = hermesLiveChildEnv(settings);
    child = spawnBoundedHermes({ hermesBin, args, cwd: fixtureDir, env, sandbox, timeoutMs: TIMEOUT_MS });
    relay.setStopHandler(reason => child.stop(reason));
    processResult = await child.promise;
    if (processResult.stopReason) failure = processResult.stopReason;
    else if (processResult.code !== 0) failure = 'hermes_nonzero_exit';
    else failure = null;

    const audit = ledger.snapshot();
    const sourceHashAfter = await sha256(sourcePath).catch(() => null);
    const testHashAfter = await sha256(testPath).catch(() => null);
    let proof = null;
    try { proof = JSON.parse(await readFile(proofPath, 'utf8')); } catch {}
    const proofValid = proof?.kind === 'synthetic-invoice-proof' &&
      Object.keys(proof.checks ?? {}).sort().join(',') === 'fractional,standard,zero' &&
      ['fractional', 'standard', 'zero'].every(key => proof.checks[key] === true);
    const testsImmutable = testHashBefore === testHashAfter;
    const sourceChanged = sourceHashBefore !== sourceHashAfter;
    const stagesVerified = audit.requiredStagesVerified && audit.toolActions.every(action => action.verified || action.stage === 'other');
    const finalMessageVerified = relay.modelResponses.at(-1)?.finalSummaryVerified === true;
    healthAfter = await waitForIdleHealth(() => serviceSnapshot({ requireIdle: false }));
    sourceHashesAfter = await hashMap(SOURCE_FILES);
    const sourceHashesUnchanged = JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter);
    const postRequests = relay.requests.filter(request => request.method === 'POST' && request.path === '/v1/chat/completions');
    const completedModelPosts = relay.modelResponses.filter(response => response.status === 200 && response.completed).length;
    const { requestDelta: statsDelta, completedDelta, errorsDelta } = healthDeltas(healthBefore, healthAfter);
    const modelPostsAllComplete = postRequests.length > 0 && postRequests.every(request => request.status === 200) && completedModelPosts === postRequests.length && relay.modelResponses.length === postRequests.length;
    const parentScript = parentVerifierScript(sourcePath, proofPath);
    const parentResult = await runProcess('/usr/bin/sandbox-exec', ['-p', sandboxProfile({ fixtureDir, profileDir, port: relayPort, runtimeRoots: [], allowNetwork: false }), process.execPath, '--input-type=module', '-e', parentScript], {
      cwd: fixtureDir,
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: path.join(profileDir, 'home'), TMPDIR: path.join(profileDir, 'tmp'), LANG: 'en_US.UTF-8', NO_COLOR: '1' },
      timeoutMs: 15000,
    }).catch(() => null);
    parentNoNetworkVerifier = parentResult?.code === 0 && /"verified":true/.test(parentResult.stdout);
    fixture = { sourceHashBefore, sourceHashAfter, testHashBefore, testHashAfter, testsImmutable, sourceChanged, proofArtifact: proof, proofValid };
    const passed = failure === null && processResult.code === 0 && isolation.externalNetworkDenied && isolation.personalReadDenied && isolation.outsideWriteDenied &&
      audit.haltReason === null && stagesVerified && finalMessageVerified && testsImmutable && sourceChanged && proofValid &&
      modelPostsAllComplete && statsDelta === postRequests.length && completedDelta === postRequests.length && errorsDelta === 0 &&
      sourceHashesUnchanged && parentNoNetworkVerifier && retryControls.apiMaxRetriesOne && retryControls.streamRetriesZero;
    const reportPath = path.join('/private/tmp', `berserk-hermes-live-${process.pid}-${Date.now()}-${passed ? 'success' : 'failure'}.json`);
    const report = {
      client: 'Hermes', qualification: passed ? 'PASS_EXPERIMENTAL_LIVE_CLIENT' : 'FAILED_EXPERIMENTAL_LIVE_CLIENT',
      version, executableSha256, syntheticFixtureOnly: true, realMuseAccountUsedByLocalService: true,
      credentialsReadByRunner: false, externalNetworkAllowedToClient: false, retryControls,
      isolation, sourceHashesBefore, sourceHashesAfter, sourceHashesUnchanged,
      relay: { requests: relay.requests, modelResponses: relay.modelResponses, audit },
      fixture, final: { processExitCode: processResult.code, signal: processResult.signal, outputBytes: processResult.outputBytes, stopReason: processResult.stopReason, finalMessageVerified, parentNoNetworkVerifier },
      health: { before: healthBefore, after: healthAfter, requestDelta: statsDelta, completedDelta, errorsDelta },
      reportPath, retainedFixture: passed ? null : tempRoot, startedAt,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    if (passed) await rm(tempRoot, { recursive: true, force: true });
    return report;
  } catch (error) {
    const reportPath = path.join('/private/tmp', `berserk-hermes-live-${process.pid}-${Date.now()}-failure.json`);
    healthAfter = healthAfter ?? await serviceSnapshot().catch(() => null);
    sourceHashesAfter = sourceHashesBefore ? await hashMap(SOURCE_FILES).catch(() => null) : null;
    const report = {
      client: 'Hermes', qualification: 'FAILED_EXPERIMENTAL_LIVE_CLIENT', version, executableSha256,
      syntheticFixtureOnly: true, realMuseAccountUsedByLocalService: true, credentialsReadByRunner: false,
      failure: typeof error?.message === 'string' && /^[a-z0-9_]+$/.test(error.message) ? error.message : failure,
      errorName: error instanceof Error ? error.name : 'Error',
      diagnosticFrames: String(error?.stack ?? '').split('\n').slice(1).map(line => line.match(/\b(verify[\w-]*\.mjs):(\d+):(\d+)\)?$/)?.slice(1).join(':')).filter(Boolean).slice(0, 5),
      isolation, sourceHashesBefore, sourceHashesAfter,
      relay: relay ? { requests: relay.requests, modelResponses: relay.modelResponses, audit: ledger.snapshot() } : null,
      fixture, retryControls, health: { before: healthBefore, after: healthAfter },
      process: processResult ? { exitCode: processResult.code, signal: processResult.signal, outputBytes: processResult.outputBytes, stopReason: processResult.stopReason } : null,
      reportPath, retainedFixture: tempRoot, startedAt,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } finally {
    await relay?.close().catch(() => {});
  }
}

export { runLiveCheck };

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const options = parseHermesLiveOptions();
    const report = await runLiveCheck(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.qualification !== 'PASS_EXPERIMENTAL_LIVE_CLIENT') process.exitCode = 1;
  } catch {
    process.stderr.write('Hermes live verifier did not start; check explicit macOS binary and approval flags.\n');
    process.exitCode = 1;
  }
}
