#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientSettings } from '../src/agent-clients.mjs';
import { startScriptedBridge } from '../tests/client-scripted-driver.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_HOME = os.homedir();
const DEFAULT_CLAUDE_BIN = path.join(USER_HOME, '.local', 'bin', 'claude');
const HERMES_BIN = path.join(USER_HOME, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes');
const NODE_BIN = process.execPath;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_RUNTIME_MS = 240_000;
const ATTEMPT_LABEL = process.env.MUSE_VERIFY_ATTEMPT === '2' ? 2 : 1;
const HARNESS_CORRECTION = process.env.MUSE_VERIFY_HARNESS_CORRECTION === 'terminal-envelope-unwrapping' ? 'terminal-envelope-unwrapping' : null;
const ALLOWED_SYSTEM_READS = [
  '/System', '/usr', '/bin', '/sbin', '/Library/Apple',
  '/Library/Developer/CommandLineTools', '/opt/homebrew',
];

function quote(value) { return JSON.stringify(value); }

export function sandboxProfile({ fixtureDir, profileDir, port, runtimeRoots, allowNetwork = true }) {
  const reads = [...new Set([...ALLOWED_SYSTEM_READS, fixtureDir, profileDir, ...runtimeRoots])];
  const writes = [profileDir];
  const sourceWrite = path.join(fixtureDir, 'invoice.mjs');
  const proofWrite = path.join(fixtureDir, 'proof.json');
  const denied = [
    ...['.env', '.env.local'].map(item => path.join(USER_HOME, '.hermes', item)),
    ...['.env', '.env.local', '.env.development', '.env.test', '.env.production', '.env.development.local', '.env.test.local', '.env.production.local', 'config.yaml', 'auth.json'].map(item => path.join(USER_HOME, '.hermes', 'hermes-agent', item)),
    path.join(USER_HOME, '.zshrc'),
    path.join(USER_HOME, '.ssh'),
    path.join(USER_HOME, '.aws'),
    path.join(USER_HOME, 'Library', 'Keychains'),
  ];
  const lines = [
    '(version 1)', '(deny default)',
    '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
    '(allow process-exec)', '(allow process-fork)', '(allow sysctl-read)',
    '(allow file-read* (literal "/var/select") (literal "/private/var/select") (literal "/var/select/developer_dir") (literal "/private/var/select/developer_dir"))',
    '(allow file-read-metadata (path-ancestors "/private/var/select/developer_dir"))',
    ...reads.map(item => `(allow file-read-metadata (path-ancestors ${quote(item)}))`),
    ...reads.map(item => `(allow file-read* (subpath ${quote(item)}))`),
    ...reads.map(item => `(allow file-map-executable (subpath ${quote(item)}))`),
    ...writes.map(item => `(allow file-write* (subpath ${quote(item)}))`),
    `(allow file-write* (literal ${quote(sourceWrite)}))`,
    `(allow file-write* (literal ${quote(proofWrite)}))`,
    ...['/dev/null', '/dev/urandom', '/dev/random', '/dev/tty', '/dev/ptmx'].flatMap(item => [
      `(allow file-read* (literal ${quote(item)}))`, `(allow file-write* (literal ${quote(item)}))`,
    ]),
    '(allow file-read* (subpath "/dev/fd"))', '(allow file-write* (subpath "/dev/fd"))',
    '(allow file-read* (subpath "/dev/pts"))', '(allow file-write* (subpath "/dev/pts"))',
    ...denied.map(item => `(deny file-read* (subpath ${quote(item)}))`),
    ...denied.map(item => `(deny file-map-executable (subpath ${quote(item)}))`),
    ...denied.map(item => `(deny file-write* (subpath ${quote(item)}))`),
    ...(allowNetwork ? [`(allow network-inbound (local ip "localhost:${port}"))`, `(allow network-outbound (remote ip "localhost:${port}"))`] : []),
  ];
  return lines.join('\n');
}

export function runProcess(command, args, { cwd, env, sandbox, input = null, timeoutMs = MAX_RUNTIME_MS, shouldStopOutput = null }) {
  return new Promise((resolve, reject) => {
    const fullArgs = sandbox ? ['-p', sandbox, command, ...args] : args;
    const executable = sandbox ? '/usr/bin/sandbox-exec' : command;
    const actualArgs = sandbox ? fullArgs : args;
    const child = spawn(executable, actualArgs, { cwd, env, detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== null) child.stdin.end(input);
    let outputBytes = 0;
    let stdout = '';
    let stderr = '';
    let finished = false;
    const stop = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
      timer.unref();
    };
    const collect = (target, data) => {
      outputBytes += data.length;
      if (outputBytes > MAX_OUTPUT) { stop(); return; }
      const text = data.toString('utf8');
      if (target === 'out') stdout += text;
      else stderr += text;
      if (typeof shouldStopOutput === 'function' && shouldStopOutput(target, text)) stop();
    };
    child.stdout.on('data', data => collect('out', data));
    child.stderr.on('data', data => collect('err', data));
    const timeout = setTimeout(() => { stop(); finish(new Error('process timeout')); }, timeoutMs);
    const finish = (error, code = null, signal = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      const result = { code, signal, stdout, stderr, outputBytes };
      if (error) reject(Object.assign(error, { result }));
      else if (outputBytes > MAX_OUTPUT) reject(Object.assign(new Error('process output exceeded 2 MiB'), { result }));
      else resolve(result);
    };
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => finish(null, code, signal));
  });
}

function parseProbe(result) {
  try { return JSON.parse(result.stdout.trim()); } catch {
    const detail = result.stderr.replace(/[\r\n]+/g, ' ').slice(0, 500);
    throw new Error(`sandbox preflight could not run (exit ${result.code}; ${detail || 'no sandbox diagnostic'})`);
  }
}

export async function proveSandbox({ sandbox, fixtureDir, port, profileDir }) {
  const outsideWrite = path.join('/private/tmp', `berserk-denied-write-${process.pid}`);
  const program = `import fs from 'node:fs';let personalDenied=false,outsideWriteDenied=false,externalNetworkDenied=false,loopbackOk=false,profileWritable=false;try{const fd=fs.openSync(${JSON.stringify(path.join(USER_HOME, '.zshrc'))},'r');fs.closeSync(fd)}catch{personalDenied=true}try{fs.writeFileSync(${JSON.stringify(outsideWrite)},'x');fs.unlinkSync(${JSON.stringify(outsideWrite)})}catch{outsideWriteDenied=true}try{await fetch('https://example.com',{signal:AbortSignal.timeout(1500)})}catch{externalNetworkDenied=true}try{loopbackOk=(await fetch('http://127.0.0.1:${port}/health')).ok}catch{};try{fs.writeFileSync(${JSON.stringify(path.join(profileDir, 'preflight.txt'))},'ok');profileWritable=true}catch{};console.log(JSON.stringify({personalDenied,outsideWriteDenied,externalNetworkDenied,loopbackOk,fixtureReadable:fs.existsSync(${JSON.stringify(path.join(fixtureDir, 'invoice.mjs'))}),profileWritable}))`;
  const env = { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: path.join(profileDir, 'home'), TMPDIR: path.join(profileDir, 'tmp'), LANG: 'en_US.UTF-8', NO_COLOR: '1' };
  const result = await runProcess(NODE_BIN, ['--input-type=module', '-e', program], { cwd: fixtureDir, env, sandbox, timeoutMs: 10000 });
  const checks = parseProbe(result);
  if (result.code !== 0 || !checks.personalDenied || !checks.outsideWriteDenied || !checks.externalNetworkDenied || !checks.loopbackOk || !checks.fixtureReadable || !checks.profileWritable) {
    throw new Error(`deny-default sandbox preflight failed: ${JSON.stringify(checks)}`);
  }
  return { personalReadDenied: true, outsideWriteDenied: true, externalNetworkDenied: true, loopbackAllowed: true };
}

export async function prepareFixture(fixtureDir, profileDir, client, port) {
  const testsDir = path.join(fixtureDir, 'tests');
  await mkdir(testsDir, { recursive: true });
  await mkdir(path.join(profileDir, 'home'), { recursive: true });
  await mkdir(path.join(profileDir, 'tmp'), { recursive: true });
  const source = `export function totalWithTax(subtotal, taxPercent) {\n  if (!Number.isFinite(subtotal) || subtotal < 0) throw new TypeError('subtotal must be nonnegative');\n  if (!Number.isFinite(taxPercent) || taxPercent < 0) throw new TypeError('taxPercent must be nonnegative');\n  return Math.round(subtotal * (1 + taxPercent));\n}\n`;
  const tests = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalWithTax } from '../invoice.mjs';\ntest('calculates a percentage tax', () => assert.equal(totalWithTax(1200, 10), 1320));\ntest('rounds fractional cents', () => assert.equal(totalWithTax(100, 7.25), 107));\ntest('supports zero tax', () => assert.equal(totalWithTax(99, 0), 99));\n`;
  await writeFile(path.join(fixtureDir, 'invoice.mjs'), source, { mode: 0o600 });
  await writeFile(path.join(testsDir, 'invoice.test.mjs'), tests, { mode: 0o400 });
  const settings = clientSettings(client, { port, profileDir, workDir: fixtureDir, pathValue: [...new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', path.join(USER_HOME, '.local', 'bin'), path.dirname(HERMES_BIN)])].join(path.delimiter) });
  const configDir = client === 'claude' ? path.join(profileDir, 'claude') : path.join(profileDir, 'hermes');
  await mkdir(configDir, { recursive: true });
  for (const file of settings.files) await writeFile(path.join(configDir, file.name), file.contents, { mode: 0o600 });
  return settings;
}

export async function sha256(file) {
  const { readFile } = await import('node:fs/promises');
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function parseClaudeFinal(stdout) {
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const final = [...events].reverse().find(event => event?.type === 'result');
  return final ? {
    type: final.type,
    isError: final.is_error,
    resultLength: typeof final.result === 'string' ? final.result.length : null,
    syntheticCompletionMarker: typeof final.result === 'string' && final.result.includes('Synthetic verification complete'),
    verified: final.is_error === false && typeof final.result === 'string' && final.result.includes('Synthetic verification complete'),
  } : { type: null, isError: null, resultLength: null, syntheticCompletionMarker: false, verified: false };
}

function counts(values) {
  const out = {};
  for (const value of values) if (typeof value === 'string') out[value] = (out[value] ?? 0) + 1;
  return out;
}

function summarizeRequestShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { jsonObject: false };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const blocks = messages.flatMap(message => Array.isArray(message?.content) ? message.content : []);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    topLevelKeys: Object.keys(body).sort(),
    topLevelTypes: Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value])),
    messageCount: Array.isArray(body.messages) ? body.messages.length : null,
    roleCounts: counts(messages.map(message => message?.role)),
    contentKindCounts: counts(messages.map(message => Array.isArray(message?.content) ? 'blocks' : typeof message?.content)),
    contentBlockTypeCounts: counts(blocks.map(block => block?.type)),
    toolCount: Array.isArray(body.tools) ? body.tools.length : null,
    toolTypeCounts: counts(tools.map(tool => tool?.type ?? 'omitted')),
    toolSchemaTypeCounts: counts(tools.map(tool => tool?.input_schema?.type)),
    toolChoiceType: typeof body.tool_choice === 'string' ? body.tool_choice : body.tool_choice?.type ?? null,
    maxTokensPositiveInteger: Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0,
  };
}

function validationMessageClass(message) {
  const patterns = [
    [/^Request body must be an object\.$/, 'request_object'],
    [/^model is required\.$/, 'model_required'],
    [/^max_tokens must be a positive integer\.$/, 'max_tokens_invalid'],
    [/^messages must be a non-empty array\.$/, 'messages_invalid'],
    [/^tools must be an array\.$/, 'tools_invalid'],
    [/^tools\[\d+\] is unsupported\.$/, 'tool_unsupported'],
    [/^messages\[\d+\] has an unsupported role\.$/, 'message_role_unsupported'],
    [/^messages\[\d+\]\.content must be text or supported content blocks\.$/, 'message_content_invalid'],
    [/^messages\[\d+\]\.content contains an invalid block\.$/, 'message_block_invalid'],
    [/^messages\[\d+\] uses unsupported content\.$/, 'message_content_unsupported'],
    [/^messages\[\d+\] contains an invalid tool_use block\.$/, 'tool_use_invalid'],
    [/^messages\[\d+\] contains an invalid tool_result block\.$/, 'tool_result_invalid'],
    [/^Unexpected field\.$/, 'unexpected_field'],
    [/^Missing required field\.$/, 'missing_required_field'],
    [/^Only plain text message content is supported\.$/, 'content_not_plain_text'],
    [/^Tool result does not match a pending tool call\.$/, 'tool_result_unmatched'],
    [/^Conversation history ends before all tool calls have results\.$/, 'pending_tool_calls'],
    [/^Invalid function parameter schema\.$/, 'tool_schema_invalid'],
    [/^Function arguments do not match the declared schema\.$/, 'tool_arguments_invalid'],
  ];
  return patterns.find(([pattern]) => pattern.test(message ?? ''))?.[1] ?? 'other';
}

function summarizeErrorResponse(status, chunk) {
  if (status < 400 || status >= 500 || chunk == null) return null;
  let body;
  try { body = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); } catch { return { status, jsonObject: false }; }
  const error = body?.error;
  return {
    status,
    topLevelKeys: Object.keys(body ?? {}).sort(),
    errorKeys: error && typeof error === 'object' ? Object.keys(error).sort() : [],
    errorType: typeof error?.type === 'string' ? error.type : null,
    errorCode: typeof error?.code === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(error.code) ? error.code : null,
    errorParam: typeof error?.param === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(error.param) ? error.param : null,
    validationMessageClass: validationMessageClass(error?.message),
  };
}

export function apiEndpointForClient(client) {
  if (client === 'claude') return '/v1/messages';
  if (client === 'hermes') return '/v1/chat/completions';
  throw new TypeError('client must be claude or hermes');
}

export function clientProcessEnv(client, settings, profileDir, { approveIsolatedHermes = false } = {}) {
  if (client === 'hermes' && !approveIsolatedHermes) throw new Error('Hermes scripted execution requires --approve-isolated-hermes.');
  return {
    ...settings.env,
    ...(client === 'claude' ? { ANTHROPIC_API_KEY: 'muse-local', CLAUDE_CODE_TMPDIR: path.join(profileDir, 'tmp') } : {}),
    ...(client === 'hermes' && approveIsolatedHermes ? { HERMES_YOLO_MODE: '1' } : {}),
    PYTHONDONTWRITEBYTECODE: '1',
    HERMES_SKIP_UPDATE_CHECK: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  };
}

export function parseVerifyCliOptions(argv = process.argv.slice(2), env = process.env) {
  const selected = [];
  let claudeBin = env.MUSE_VERIFY_CLAUDE_BIN || DEFAULT_CLAUDE_BIN;
  let approveIsolatedHermes = false;
  let invalidArg = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--claude-bin' && argv[i + 1]) { claudeBin = argv[++i]; continue; }
    if (arg.startsWith('--claude-bin=')) { claudeBin = arg.slice('--claude-bin='.length); continue; }
    if (arg === '--approve-isolated-hermes') { approveIsolatedHermes = true; continue; }
    if (arg === 'claude' || arg === 'hermes') { selected.push(arg); continue; }
    invalidArg = true;
  }
  const clients = selected.length ? selected : ['claude', 'hermes'];
  if (clients.includes('hermes') && !approveIsolatedHermes) invalidArg = true;
  if (approveIsolatedHermes && !clients.includes('hermes')) invalidArg = true;
  if (invalidArg || !path.isAbsolute(claudeBin) || /[\0\r\n]/.test(claudeBin)) return null;
  return { clients, claudeBin, approveIsolatedHermes };
}

function clientCommand(client, settings, fixtureDir, claudeBin) {
  const prompt = 'In this synthetic repository, fix the invoice tax percentage calculation. First run the tests and observe the failure, inspect invoice.mjs, make the smallest correction, run the full test file, then prove the calculation and report the result. Use only the available local command tool.';
  if (client === 'claude') {
    return { binary: claudeBin, args: [...settings.args, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash'], cwd: fixtureDir, input: null };
  }
  return { binary: HERMES_BIN, args: [...settings.args, '--query', prompt, '--toolsets', 'file,terminal', '--quiet', '--ignore-user-config', '--ignore-rules', '--max-turns', '12'], cwd: fixtureDir, input: null };
}

/** Build an isolated launch specification for a future live-Claude check; this does not spawn the client. */
export function createClaudeLiveLaunchSpec({ executable, prompt, port, profileDir, workDir, pathValue }) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
    throw new TypeError('Claude executable must be an absolute path without control characters.');
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || /\0/.test(prompt)) {
    throw new TypeError('Claude prompt must be a non-empty string up to 8000 characters.');
  }
  const settings = clientSettings('claude', { port, profileDir, workDir, pathValue });
  return {
    binary: executable,
    args: [...settings.args, '-p', prompt, '--output-format', 'stream-json', '--verbose'],
    cwd: workDir,
    env: { ...settings.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
    files: settings.files,
  };
}

async function verify(client, { claudeBin = DEFAULT_CLAUDE_BIN, approveIsolatedHermes = false } = {}) {
  if (client === 'hermes' && !approveIsolatedHermes) throw new Error('Hermes scripted execution requires --approve-isolated-hermes.');
  if (client === 'claude' && (!path.isAbsolute(claudeBin) || /[\0\r\n]/.test(claudeBin))) throw new TypeError('Claude executable must be an absolute path.');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `berserk-client-${client}-`));
  const fixtureDir = path.join(tempRoot, 'fixture');
  const profileDir = path.join(tempRoot, 'profile');
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  const evidence = [];
  const bridgeRequests = [];
  const requestShapes = [];
  const apiDiagnostics = [];
  const { bridge, driver, port } = await startScriptedBridge({ fixtureDir, evidence });
  bridge.server.prependListener('request', (req, res) => {
    const record = {
      method: req.method,
      path: (req.url ?? '').split('?')[0],
      hasAuthorization: typeof req.headers.authorization === 'string',
      authorizationScheme: typeof req.headers.authorization === 'string' ? req.headers.authorization.split(/\s+/, 1)[0] : null,
      hasXApiKey: typeof req.headers['x-api-key'] === 'string',
      status: null,
    };
    bridgeRequests.push(record);
    const bodyParts = [];
    let bodySize = 0;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize <= 1024 * 1024) bodyParts.push(Buffer.from(chunk));
    });
    req.once('end', () => {
      if (record.method === 'POST' && record.path === apiEndpointForClient(client)) {
        try { requestShapes.push(summarizeRequestShape(JSON.parse(Buffer.concat(bodyParts).toString('utf8')))); }
        catch { requestShapes.push({ jsonObject: false, bodySizeBytes: bodySize <= 1024 * 1024 ? bodySize : 'over_limit' }); }
      }
    });
    const originalEnd = res.end;
    res.end = function instrumentedEnd(chunk, ...args) {
      const diagnostic = summarizeErrorResponse(res.statusCode, chunk);
      if (diagnostic) apiDiagnostics.push(diagnostic);
      return originalEnd.call(this, chunk, ...args);
    };
    res.once('finish', () => {
      record.status = res.statusCode;
    });
  });
  const runtimeRoots = client === 'claude'
    ? [claudeBin]
    : [path.join(USER_HOME, '.hermes', 'hermes-agent'), path.join(USER_HOME, '.local', 'share', 'uv', 'python')];
  let completed = false;
  let fixtureEvidence = null;
  let executableVersion = client === 'hermes' ? '0.16.0' : 'unknown';
  let executableSha256 = null;
  try {
    const settings = await prepareFixture(fixtureDir, profileDir, client, port);
    const testPath = path.join(fixtureDir, 'tests', 'invoice.test.mjs');
    const sourcePath = path.join(fixtureDir, 'invoice.mjs');
    const baselineTestHash = await sha256(testPath);
    const baselineSourceHash = await sha256(sourcePath);
    const sandbox = sandboxProfile({ fixtureDir, profileDir, port, runtimeRoots });
    const isolation = await proveSandbox({ sandbox, fixtureDir, port, profileDir });
    const launch = clientCommand(client, settings, fixtureDir, claudeBin);
    const env = clientProcessEnv(client, settings, profileDir, { approveIsolatedHermes });
    if (client === 'claude') {
      const versionProbe = await runProcess(launch.binary, ['--version'], {
        cwd: launch.cwd, env: settings.env,
        sandbox: sandboxProfile({ fixtureDir, profileDir, port, runtimeRoots, allowNetwork: false }), timeoutMs: 10000,
      });
      const match = versionProbe.stdout.match(/\b\d+\.\d+\.\d+\b/);
      if (versionProbe.code !== 0 || !match) throw new Error('Claude executable version probe failed in the no-network sandbox');
      executableVersion = match[0];
    }
    executableSha256 = await sha256(launch.binary);
    const result = await runProcess(launch.binary, launch.args, { cwd: launch.cwd, env, sandbox, input: launch.input });
    if (result.code !== 0) {
      const diagnostic = result.stderr.replaceAll('muse-local', '[local-key]').replaceAll(tempRoot, '[temp]').replace(/[\r\n]+/g, ' ').slice(-700);
      throw new Error(`${client} exited ${result.code ?? result.signal}; bridgeErrors=${bridge.stats.errors}; lastError=${bridge.stats.lastError ?? 'none'}; requests=${JSON.stringify(bridgeRequests)}; requestShapes=${JSON.stringify(requestShapes)}; apiDiagnostics=${JSON.stringify(apiDiagnostics)}; output=${diagnostic || '(empty)'}`);
    }
    if (driver.completedSteps !== 6 || evidence.some(item => item.resultVerified !== true)) {
      const diagnostic = `${result.stdout}\n${result.stderr}`.replaceAll('muse-local', '[local-key]').replaceAll(tempRoot, '[temp]').replace(/[\r\n]+/g, ' ').slice(-700);
      throw new Error(`${client} completed ${driver.completedSteps}/6 verified tool steps; evidence=${JSON.stringify(evidence)}; bridgeErrors=${bridge.stats.errors}; requests=${JSON.stringify(bridgeRequests)}; output=${diagnostic || '(empty)'}`);
    }
    const testHash = await sha256(testPath);
    const sourceHash = await sha256(sourcePath);
    const proofText = await (await import('node:fs/promises')).readFile(path.join(fixtureDir, 'proof.json'), 'utf8');
    const proof = JSON.parse(proofText);
    if (testHash !== baselineTestHash || sourceHash === baselineSourceHash || proof.kind !== 'synthetic-invoice-proof' || Object.values(proof.checks).some(value => value !== true)) {
      throw new Error(`${client} parent verifier failed: testsImmutable=${testHash === baselineTestHash}; sourceChanged=${sourceHash !== baselineSourceHash}; proofValid=${proof.kind === 'synthetic-invoice-proof' && Object.values(proof.checks).every(Boolean)}`);
    }
    const finalEventMetadata = client === 'claude'
      ? parseClaudeFinal(result.stdout)
      : { type: 'normal_exit', isError: false, syntheticCompletionMarker: result.stdout.includes('Synthetic verification complete'), verified: result.stdout.includes('Synthetic verification complete') };
    if (!finalEventMetadata.verified) throw new Error(`${client} final response event was missing or unsuccessful`);
    if (client === 'hermes' && !result.stdout.includes('Synthetic verification complete')) throw new Error('Hermes final normal-exit response was missing');
    const messageRequests = bridgeRequests.filter(item => item.method === 'POST' && item.path === apiEndpointForClient(client));
    if (driver.generationCalls !== 7 || messageRequests.length !== 7 || messageRequests.some(item => item.status !== 200) || evidence.length !== 6 || evidence.some(item => item.resultVerified !== true)) {
      throw new Error(`${client} loop evidence inconsistent: generationCalls=${driver.generationCalls}; messageRequests=${messageRequests.length}; actions=${evidence.length}; allActionsVerified=${evidence.every(item => item.resultVerified === true)}`);
    }
    const verificationScript = `import fs from 'node:fs';import assert from 'node:assert/strict';import {totalWithTax} from ${JSON.stringify(sourcePath)};const proof=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(fixtureDir, 'proof.json'))},'utf8'));assert.equal(totalWithTax(1200,10),1320);assert.equal(totalWithTax(100,7.25),107);assert.equal(totalWithTax(99,0),99);assert.ok(Object.values(proof.checks).every(Boolean));console.log(JSON.stringify({passed:true,sourceHash:${JSON.stringify(sourceHash)},testHash:${JSON.stringify(testHash)}}));`;
    const noNetworkProfile = sandboxProfile({ fixtureDir, profileDir, port, runtimeRoots: [], allowNetwork: false });
    const noNetwork = await runProcess('/usr/bin/sandbox-exec', ['-p', noNetworkProfile, NODE_BIN, '--input-type=module', '-e', verificationScript], {
      cwd: fixtureDir,
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: path.join(profileDir, 'home'), TMPDIR: path.join(profileDir, 'tmp'), LANG: 'en_US.UTF-8', NO_COLOR: '1' },
      timeoutMs: 10000,
    });
    if (noNetwork.code !== 0) throw new Error('post-client parent no-network verifier failed');
    fixtureEvidence = { testHashBefore: baselineTestHash, testHashAfter: testHash, sourceHashBefore: baselineSourceHash, sourceHashAfter: sourceHash, proofArtifact: proof };
    const successReport = path.join('/private/tmp', `berserk-client-${client}-success-${process.pid}-${Date.now()}.json`);
    const successEvidence = {
      client, qualification: 'synthetic N2 scripted-real-client pass', version: executableVersion, executableSha256,
      attempt: ATTEMPT_LABEL, harnessCorrection: HARNESS_CORRECTION,
      syntheticOnly: true, museLive: false, productEnvAligned: true, isolation,
      generationCalls: driver.generationCalls, toolActions: evidence.length, modelResponses: messageRequests.length,
      finalEventMetadata, requests: bridgeRequests, requestShapes, apiDiagnostics, steps: evidence,
      fixtureEvidence, testImmutable: true, sourceChanged: true, parentNoNetworkVerifier: true,
      exitCode: result.code, outputBytes: result.outputBytes,
    };
    await writeFile(successReport, JSON.stringify(successEvidence, null, 2) + '\n', { mode: 0o600 });
    completed = true;
    return { ...successEvidence, qualified: 'synthetic N2 scripted-real-client pass', successReport };
  } catch (error) {
    const failureReport = path.join('/private/tmp', `berserk-client-${client}-failure-${process.pid}-${Date.now()}.json`);
    await writeFile(failureReport, JSON.stringify({ client, version: executableVersion, executableSha256, attempt: ATTEMPT_LABEL, harnessCorrection: HARNESS_CORRECTION, error: String(error.message).replace(/[\r\n]+/g, ' ').slice(0, 1000), requests: bridgeRequests, requestShapes, apiDiagnostics, steps: evidence, fixtureEvidence }, null, 2), { mode: 0o600 });
    error.message = `${error.message}; sanitized synthetic report: ${failureReport}; retained fixture: ${tempRoot}`;
    throw error;
  } finally {
    await bridge.close();
    if (completed) await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseVerifyCliOptions();
  if (!options) {
    process.stderr.write('Usage: node scripts/verify-clients.mjs claude [--claude-bin /absolute/path] | hermes --approve-isolated-hermes\n');
    process.exitCode = 2;
  } else {
    for (const client of options.clients) {
      try {
        const result = await verify(client, { claudeBin: options.claudeBin, approveIsolatedHermes: options.approveIsolatedHermes });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        process.stderr.write(`${client}: ${String(error.message).replace(/[\r\n]+/g, ' ').slice(0, 1500)}\n`);
        process.exitCode = 1;
        break;
      }
    }
  }
}

