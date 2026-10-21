#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClaudeLiveLaunchSpec, prepareFixture, proveSandbox, runProcess, sandboxProfile, sha256,
} from './verify-clients.mjs';

const PORT = 8787;
const TIMEOUT_MS = 8 * 60 * 1000;
const SOURCE_FILES = [
  'src/agent-clients.mjs', 'src/anthropic.mjs', 'src/protocol.mjs', 'src/server.mjs',
  'scripts/verify-clients.mjs', 'scripts/verify-claude-live.mjs', 'tests/client-scripted-driver.mjs',
];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATHS = SOURCE_FILES.map(file => path.join(ROOT, file));
const PROMPT = [
  'This is a synthetic invoice-code task in the current temporary repository only.',
  'Use only the Bash tool and work only in the current directory.',
  'Only invoice.mjs and proof.json are writable; tests are read-only and no sibling temporary files may be created.',
  'Node.js is available. Use Node built-in fs.readFileSync/writeFileSync for source edits and proof creation. System python3 and Apple developer tools are unavailable here; avoid in-place editors that create sibling temporary files.',
  'First run `node --test tests/invoice.test.mjs` and observe the failure.',
  'Read `invoice.mjs`, then make the smallest correction so taxPercent is treated as a percentage.',
  'Run the full test file again and confirm all three tests pass.',
  'Create `proof.json` with kind `synthetic-invoice-proof` and boolean checks named standard, fractional, and zero for the three test cases.',
  'Read `proof.json` back and report the red failure, source correction, green test results, and proof checks.',
  'In the final summary explicitly confirm RED reproduced, source read and fixed, GREEN with three passing tests, and proof standard/fractional/zero checks.',
  'Do not access files outside this temporary repository or use network services.',
].join(' ');

export function parseOptions(argv = process.argv.slice(2), env = process.env, platform = process.platform) {
  if (platform !== 'darwin') throw new Error('This one-off sandbox verifier requires macOS.');
  let executable = env.MUSE_VERIFY_CLAUDE_BIN ?? null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--claude-bin') {
      if (index + 1 >= argv.length) throw new Error('--claude-bin requires an absolute executable path.');
      executable = argv[++index];
    } else throw new Error('Only --claude-bin is supported.');
  }
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
    throw new Error('Set MUSE_VERIFY_CLAUDE_BIN or pass --claude-bin with an absolute executable path.');
  }
  return { executable };
}

export function liveClaudeArgs(launchSpec) {
  return [...launchSpec.args, '--tools', 'Bash', '--allowedTools', 'Bash'];
}

let currentRun = null;

function parseStream(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch { /* Ignore non-JSON CLI diagnostics; never persist them. */ }
  }
  return events;
}

function commandOf(input) {
  for (const key of ['command', 'cmd', 'script']) if (typeof input?.[key] === 'string') return input[key];
  return '';
}

export function classifyCommand(command) {
  if (/\bnode\s+--test\b[^\n]*tests\/invoice\.test\.mjs/.test(command)) return 'test';
  if (/\bproof\.json\b/.test(command)) return /(?:>|tee\s|writeFile|writeFileSync|write_text|open\([^\n]*["']w)/.test(command) ? 'proof-create' : 'proof-read';
  if (/\binvoice\.mjs\b/.test(command)) {
    const inPlaceSed = /\bsed\b[^\n]*\s-i(?:\s|$)/.test(command);
    const redirectsSource = />>?\s*['"]?(?:[^\s'"]*\/)?invoice\.mjs\b/.test(command) || /\btee\s+(?:-[a-z]+\s+)*['"]?(?:[^\s'"]*\/)?invoice\.mjs\b/.test(command);
    const writesSource = /writeFile(?:Sync)?|write_text|open\([^\n]*["']w/.test(command);
    return !inPlaceSed && !redirectsSource && !writesSource && /\b(?:cat|sed|head|tail|grep|awk|readFile(?:Sync)?|read_text)\b/.test(command) ? 'read' : 'edit';
  }
  return 'unclassified';
}

function blockText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(block => typeof block?.text === 'string' ? block.text :
    typeof block?.content === 'string' ? block.content : Array.isArray(block?.content) ? blockText(block.content) : '').join('\n');
}

function isPermissionDenial(value) {
  return /BLOCKED:|User denied this command|Operation not permitted|Permission denied|sandbox.*denied|\b(?:EPERM|EACCES)\b/i.test(value);
}

export function finalSummaryComplete(text) {
  if (typeof text !== 'string') return false;
  const value = text.toLowerCase();
  const requirements = [
    /\bred\b|\bfail(?:ed|ure)?\b/.test(value),
    /\bread\b|\binspect(?:ed)?\b/.test(value),
    /\bfix(?:ed)?\b|\bcorrect(?:ed|ion)?\b|\bchange(?:d)?\b/.test(value),
    /\bgreen\b|\bpass(?:ed|es)?\b/.test(value),
    /\b3\s+(?:tests?\s+)?pass(?:ed)?\b|\bthree\s+tests?\b|\b3\s*\/\s*3\b/.test(value),
    /\bproof\b/.test(value),
    /\bstandard\b/.test(value),
    /\bfractional\b/.test(value),
    /\bzero\b/.test(value),
  ];
  return requirements.every(Boolean);
}

export function summarizeConversation(events) {
  const calls = [];
  const toolResults = new Map();
  let final = null;
  let permissionDenied = false;
  for (const event of events) {
    if (event?.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block?.type === 'tool_use') {
          const command = commandOf(block.input);
          calls.push({ id: block.id, name: block.name, category: classifyCommand(command) });
        }
      }
    } else if (event?.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const text = blockText(block.content);
          if (isPermissionDenial(text)) permissionDenied = true;
          toolResults.set(block.tool_use_id, text);
        }
      }
    } else if (event?.type === 'result') {
      final = {
        type: event.type,
        isError: event.is_error,
        resultLength: typeof event.result === 'string' ? event.result.length : null,
        allStagesReported: finalSummaryComplete(event.result),
      };
    }
  }
  const expected = ['test', 'read', 'edit', 'test', 'proof-create', 'proof-read'];
  let cursor = 0;
  const steps = expected.map((stage, index) => {
    const foundAt = calls.findIndex((candidate, callIndex) => callIndex >= cursor && candidate.category === stage && candidate.name === 'Bash');
    const call = foundAt >= 0 ? calls[foundAt] : null;
    if (!call) return { category: stage, verified: false };
    cursor = foundAt + 1;
    const result = toolResults.get(call.id) ?? '';
    let verified = false;
    if (index === 0) verified = call.category === 'test' && /not ok|ERR_ASSERTION|fail\s+[1-9]/i.test(result);
    else if (index === 1) verified = call.category === 'read' && /taxPercent/.test(result) && /Math\.round/.test(result);
    else if (index === 2) verified = call.category === 'edit' && toolResults.has(call.id) && !isPermissionDenial(result);
    else if (index === 3) verified = call.category === 'test' && /pass\s+3/i.test(result) && /fail\s+0/i.test(result);
    else if (index === 4) verified = call.category === 'proof-create' && toolResults.has(call.id) && !isPermissionDenial(result);
    else if (index === 5) verified = call.category === 'proof-read' && /synthetic-invoice-proof/.test(result) && /standard/.test(result) && /fractional/.test(result) && /zero/.test(result);
    return { tool: call.name, category: call.category, resultReceived: toolResults.has(call.id), verified };
  });
  const requiredStagesVerified = steps.every(step => step.verified);
  return { calls: calls.length, results: toolResults.size, requiredStagesVerified, steps, permissionDenied, final, finalVerified: final?.isError === false && final.allStagesReported === true };
}

async function healthSnapshot({ requireIdle = true } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Local Berserk health returned ${response.status}.`);
  const data = await response.json();
  if (data.service !== 'berserk-muse' || !data.queue || (requireIdle && (data.ready !== true || data.queue.active))) throw new Error('Local Berserk is not idle and ready for the isolated check.');
  return { service: data.service, version: data.version ?? null, ready: data.ready === true, requests: data.stats?.requests ?? null, completed: data.stats?.completed ?? null, errors: data.stats?.errors ?? null, queueActive: data.queue.active };
}

export async function waitForIdleHealth(readHealth, { timeoutMs = 15000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const snapshot = await readHealth();
      if (snapshot?.ready === true && snapshot.queueActive === false) return snapshot;
    } catch { /* A bounded read-only probe can wait for service cleanup. */ }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  return null;
}

export function healthDeltas(before, after) {
  const valid = snapshot => snapshot && ['requests', 'completed', 'errors'].every(key => Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0);
  if (!valid(before) || !valid(after)) return { requestDelta: null, completedDelta: null, errorsDelta: null };
  return { requestDelta: after.requests - before.requests, completedDelta: after.completed - before.completed, errorsDelta: after.errors - before.errors };
}

async function hashMap(paths) {
  const entries = await Promise.all(paths.map(async file => [path.relative(ROOT, file), await sha256(file)]));
  return Object.fromEntries(entries);
}

export function isLiveRunSuccessful(report) {
  const { process: result, isolation, conversation, fixture, health } = report;
  // A response may carry several tools, so model request count is not a stage count.
  return result?.failure === null && result?.exitCode === 0 &&
    isolation?.externalNetworkDenied === true && isolation.personalReadDenied === true && isolation.outsideWriteDenied === true &&
    conversation?.permissionDenied === false && conversation.requiredStagesVerified === true &&
    conversation.steps?.length === 6 && conversation.steps.every(step => step.verified === true) && conversation.finalVerified === true &&
    fixture?.testsImmutable === true && typeof fixture.sourceHashAfter === 'string' && fixture.sourceHashAfter !== fixture.sourceHashBefore &&
    fixture.proofValid === true && report.sourceHashesUnchanged === true && report.parentNoNetworkVerifier === true &&
    Number.isSafeInteger(health?.requestDelta) && health.requestDelta > 0 && health.completedDelta === health.requestDelta && health.errorsDelta === 0;
}

async function verifyInner(executable) {
  const tempRoot = await mkdtemp('/private/tmp/berserk-claude-live-');
  currentRun.tempRoot = tempRoot;
  const fixtureDir = path.join(tempRoot, 'fixture');
  const profileDir = path.join(tempRoot, 'profile');
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  let result;
  const healthBefore = await healthSnapshot();
  const sourceHashesBefore = await hashMap(SOURCE_PATHS);
  currentRun.observations = { sourceHashesBefore };
  const settings = await prepareFixture(fixtureDir, profileDir, 'claude', PORT);
  const launchSpec = createClaudeLiveLaunchSpec({ executable, prompt: PROMPT, port: PORT, profileDir, workDir: fixtureDir, pathValue: '/usr/bin:/bin:/opt/homebrew/bin' });
  const configDir = path.join(profileDir, 'claude');
  for (const file of settings.files) await writeFile(path.join(configDir, file.name), file.contents, { mode: 0o600 });
  const sourcePath = path.join(fixtureDir, 'invoice.mjs');
  const testPath = path.join(fixtureDir, 'tests', 'invoice.test.mjs');
  const proofPath = path.join(fixtureDir, 'proof.json');
  const sourceHashBefore = await sha256(sourcePath);
  const testHashBefore = await sha256(testPath);
  const runtimeRoots = [executable];
  const sandbox = sandboxProfile({ fixtureDir, profileDir, port: PORT, runtimeRoots });
  const isolation = await proveSandbox({ sandbox, fixtureDir, port: PORT, profileDir });
  currentRun.observations.isolation = isolation;
  const version = await runProcess(executable, ['--version'], {
    cwd: fixtureDir,
    env: settings.env,
    sandbox: sandboxProfile({ fixtureDir, profileDir, port: PORT, runtimeRoots, allowNetwork: false }),
    timeoutMs: 10000,
  });
  const versionMatch = version.stdout.match(/\b\d+\.\d+\.\d+\b/);
  if (version.code !== 0 || !versionMatch) throw new Error('Claude version preflight failed.');
  currentRun.version = versionMatch[0];
  const env = { ...launchSpec.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
  const args = liveClaudeArgs(launchSpec);
  currentRun.stage = 'client';
  let failure = null;
  let streamBuffer = '';
  let permissionDenialSeen = false;
  try {
    result = await runProcess(launchSpec.binary, args, {
      cwd: launchSpec.cwd, env, sandbox, timeoutMs: TIMEOUT_MS,
      shouldStopOutput(target, chunk) {
        if (target !== 'out') return false;
        streamBuffer += chunk;
        const lines = streamBuffer.split(/\r?\n/);
        streamBuffer = lines.pop() ?? '';
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event?.type !== 'user') continue;
          const denied = (event.message?.content ?? []).some(block => block?.type === 'tool_result' && isPermissionDenial(blockText(block.content)));
          if (denied) { permissionDenialSeen = true; return true; }
        }
        return false;
      },
    });
    if (permissionDenialSeen) failure = 'sandbox_permission_denied';
  } catch (error) {
    result = error.result ?? null;
    failure = error.name === 'Error' && /timeout|output exceeded/.test(error.message) ? 'bounded_process_failure' : 'client_process_failure';
  }
  currentRun.stage = 'conversation';
  currentRun.observations.process = { exitCode: result?.code ?? null, signal: result?.signal ?? null, outputBytes: result?.outputBytes ?? 0, failure };
  const events = parseStream(result?.stdout ?? '');
  const conversation = summarizeConversation(events);
  currentRun.observations.conversation = conversation;
  currentRun.stage = 'fixture';
  const sourceHashAfter = await sha256(sourcePath).catch(() => null);
  const testHashAfter = await sha256(testPath).catch(() => null);
  let proof = null;
  try { proof = JSON.parse(await readFile(proofPath, 'utf8')); } catch {}
  currentRun.stage = 'service_cleanup';
  const healthAfter = await waitForIdleHealth(() => healthSnapshot({ requireIdle: false }));
  const sourceHashesAfter = await hashMap(SOURCE_PATHS);
  const sourceHashesUnchanged = JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter);
  const testImmutable = testHashBefore === testHashAfter;
  const proofValid = proof?.kind === 'synthetic-invoice-proof' && proof.checks?.standard === true && proof.checks?.fractional === true && proof.checks?.zero === true;
  currentRun.observations.fixture = { sourceHashBefore, sourceHashAfter, testHashBefore, testHashAfter, testsImmutable: testImmutable, proof, proofValid };
  currentRun.stage = 'parent_verifier';
  const parentVerifyScript = `import fs from 'node:fs';import assert from 'node:assert/strict';import {totalWithTax} from ${JSON.stringify(sourcePath)};const proof=JSON.parse(fs.readFileSync(${JSON.stringify(proofPath)},'utf8'));assert.equal(totalWithTax(1200,10),1320);assert.equal(totalWithTax(100,7.25),107);assert.equal(totalWithTax(99,0),99);assert.ok(Object.values(proof.checks).every(Boolean));console.log('PARENT_NO_NETWORK_VERIFICATION_OK');`;
  const noNetwork = await runProcess(process.execPath, ['--input-type=module', '-e', parentVerifyScript], {
    cwd: fixtureDir,
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: path.join(profileDir, 'home'), TMPDIR: path.join(profileDir, 'tmp'), LANG: 'en_US.UTF-8', NO_COLOR: '1' },
    sandbox: sandboxProfile({ fixtureDir, profileDir, port: PORT, runtimeRoots: [], allowNetwork: false }),
    timeoutMs: 10000,
  }).catch(() => null);
  const parentNoNetworkVerifier = noNetwork?.code === 0 && noNetwork.stdout.includes('PARENT_NO_NETWORK_VERIFICATION_OK');
  const { requestDelta: statsDelta, completedDelta, errorsDelta } = healthDeltas(healthBefore, healthAfter);
  const report = {
    qualification: 'FAILED_EXPERIMENTAL_LIVE_CLIENT',
    client: 'Claude Code', version: currentRun.version ?? null, executableSha256: await sha256(executable),
    syntheticFixtureOnly: true, realMuseAccountUsedByLocalService: true, credentialsReadByRunner: false, maxRetries: 0,
    externalNetworkAllowed: false, isolation, sourceHashesBefore, sourceHashesAfter, sourceHashesUnchanged,
    fixture: { sourceHashBefore, sourceHashAfter, testHashBefore, testHashAfter, testsImmutable: testImmutable, proof, proofValid },
    conversation, process: { exitCode: result?.code ?? null, signal: result?.signal ?? null, outputBytes: result?.outputBytes ?? 0, failure },
    health: { before: healthBefore, after: healthAfter, requestDelta: statsDelta, completedDelta, errorsDelta }, parentNoNetworkVerifier,
  };
  const passed = isLiveRunSuccessful(report);
  if (passed) report.qualification = 'PASS_EXPERIMENTAL_LIVE_CLIENT';
  const reportPath = path.join('/private/tmp', `berserk-claude-live-${process.pid}-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (passed) await rm(tempRoot, { recursive: true, force: true });
  return { ...report, reportPath, retainedFixture: passed ? null : tempRoot };
}

async function verify(executable) {
  currentRun = { startedAt: new Date().toISOString(), tempRoot: null, version: null, stage: 'preflight', observations: {} };
  try {
    return await verifyInner(executable);
  } catch (error) {
    const reportPath = path.join('/private/tmp', `berserk-claude-live-${process.pid}-${Date.now()}.json`);
    const report = {
      qualification: 'FAILED_EXPERIMENTAL_LIVE_CLIENT',
      client: 'Claude Code',
      version: currentRun.version,
      failure: 'prequalification_exception',
      errorName: error instanceof Error ? error.name : 'Error',
      stage: currentRun.stage,
      diagnosticFrames: String(error?.stack ?? '').split('\n').slice(1).map(line => line.match(/\b(verify[\w-]*\.mjs):(\d+):(\d+)\)?$/)?.slice(1).join(':')).filter(Boolean).slice(0, 5),
      observations: currentRun.observations,
      startedAt: currentRun.startedAt,
      syntheticFixtureOnly: true,
      realMuseAccountUsedByLocalService: true,
      credentialsReadByRunner: false,
      retainedFixture: currentRun.tempRoot,
      reportPath,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } finally {
    currentRun = null;
  }
}

export { verify as runLiveCheck };

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const { executable } = parseOptions();
    const report = await verify(executable);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.qualification !== 'PASS_EXPERIMENTAL_LIVE_CLIENT') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Live synthetic Claude check not started: ${String(error.message).replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
