#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, ROOT_ID, settings } from '../src/config.mjs';
import { sandboxProfile } from '../src/client-config.mjs';

const REPO = ROOT;
const LAUNCHER = path.join(REPO, 'scripts', 'agent.mjs');
const OPENCODE = process.env.OPENCODE_BIN || path.join(os.homedir(), '.local', 'bin', 'opencode');
const MAX_RUNTIME_MS = 8 * 60_000;
const MAX_OUTPUT_BYTES = 2_000_000;
const PROOF = 'BERSERK_AGENT_E2E_OK\n';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

const posixPath = value => value.split(path.sep).join('/');

async function collectEvidenceTree(relativeRoot, include) {
  const root = path.join(REPO, relativeRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Unsafe project evidence directory: ${relativeRoot}`);
  const files = [];
  async function visit(relativeDirectory) {
    const directory = path.join(REPO, relativeDirectory);
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const relative = posixPath(path.join(relativeDirectory, name));
      const absolute = path.join(REPO, relative);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe project evidence input: ${relative}`);
      if (stat.isDirectory()) { await visit(relative); continue; }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe project evidence input: ${relative}`);
      if (include(relative)) files.push(relative);
    }
  }
  await visit(relativeRoot);
  return files;
}

async function ensurePlainDir(directory, mode = 0o700) {
  try { await mkdir(directory, { mode }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe evidence directory: ${directory}`);
  await chmod(directory, mode);
}

async function secureRegularFile(file, root) {
  const resolvedRoot = await realpath(root);
  const resolvedFile = await realpath(file);
  if (!within(resolvedRoot, resolvedFile)) throw new Error('Evidence path escaped its run directory.');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Evidence file must be a single-link regular file.');
  return { bytes: await readFile(file), stat };
}

async function atomicEvidence(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { flag: 'wx', mode: 0o600 });
  const stat = await lstat(temp);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe temporary evidence file.');
  await rename(temp, file);
  await chmod(file, 0o600);
  const final = await lstat(file);
  if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1) throw new Error('Unsafe final evidence file.');
}

async function sourceHashes() {
  const allowedSet = new Set([
    'scripts/agent.mjs', 'scripts/start.mjs', 'scripts/control.mjs',
    'scripts/verify-coding.mjs', 'scripts/verify-live.mjs', 'package.json', 'package-lock.json',
    'docs/muse-vendor.lock.json',
  ]);
  for (const relative of await collectEvidenceTree('src', relative => relative.endsWith('.mjs'))) allowedSet.add(relative);
  for (const relative of await collectEvidenceTree('public/panel', () => true)) allowedSet.add(relative);
  const allowed = [...allowedSet].sort();
  const result = {};
  for (const relative of allowed) {
    const absolute = path.join(REPO, relative);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Unsafe project evidence input: ${relative}`);
    result[relative] = sha256(await readFile(absolute));
  }
  return result;
}

async function captureClient(command, args, { cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let total = 0;
    let timeout = false;
    let outputLimit = false;
    let settled = false;
    let spawnError = null;
    let killTimer = null;
    const stop = why => {
      if (why === 'timeout') timeout = true;
      if (why === 'output') outputLimit = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1200);
      killTimer.unref();
    };
    const collect = target => chunk => {
      total += chunk.length;
      const budget = Math.max(0, MAX_OUTPUT_BYTES - (total - chunk.length));
      const accepted = chunk.subarray(0, Math.min(chunk.length, budget));
      if (target === 'stdout') stdout = Buffer.concat([stdout, accepted]);
      else stderr = Buffer.concat([stderr, accepted]);
      if (total > MAX_OUTPUT_BYTES && !outputLimit) stop('output');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', error => { spawnError = `${error.name}: ${error.message}`; });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 1, signal: signal ?? null, timeout, outputLimit, spawnError, stdout, stderr, command, args });
    });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref();
  });
}

function parseJsonl(bytes) {
  const events = [];
  let malformed = 0;
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { malformed += 1; }
  }
  return { events, malformed };
}

function eventKind(event) { return event?.type ?? event?.event ?? event?.kind ?? ''; }
function toolName(event) { return event?.part?.tool ?? event?.tool ?? event?.name ?? ''; }
function toolState(event) { return event?.part?.state?.status ?? event?.state?.status ?? event?.status ?? ''; }
function toolInput(event) { return event?.part?.state?.input ?? event?.part?.input ?? event?.input ?? event?.arguments ?? {}; }
function toolOutput(event) { return event?.part?.state?.output ?? event?.part?.state?.result ?? event?.output ?? event?.result ?? ''; }
function outputText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}
function stepReason(event) { return event?.part?.reason ?? event?.reason ?? event?.step?.reason ?? ''; }
function pathFrom(input, keys) {
  for (const key of keys) if (typeof input?.[key] === 'string') return input[key];
  return '';
}

function analyzeEvents(events, fixture) {
  const completedTools = events.filter(event => /tool_use|tool-call|tool_call/i.test(eventKind(event)) && toolState(event) === 'completed');
  const bash = completedTools.filter(event => toolName(event) === 'bash');
  const reads = completedTools.filter(event => toolName(event) === 'read');
  const edits = completedTools.filter(event => toolName(event) === 'edit');
  const writes = completedTools.filter(event => toolName(event) === 'write');
  const testFile = path.join(fixture, 'tests', 'invoice.test.mjs');
  const sourceFile = path.join(fixture, 'src', 'invoice.mjs');
  const isTestCommand = event => /node\s+--test\s+tests\/invoice\.test\.mjs/.test(String(toolInput(event)?.command ?? ''));
  const red = bash.find(event => isTestCommand(event) && Number(toolInput(event)?.metadata?.exit ?? toolInput(event)?.exitCode ?? event?.part?.state?.metadata?.exit ?? 0) !== 0 && /16\.5/.test(outputText(toolOutput(event))) && /37/.test(outputText(toolOutput(event))));
  const green = bash.find(event => isTestCommand(event) && Number(toolInput(event)?.metadata?.exit ?? toolInput(event)?.exitCode ?? event?.part?.state?.metadata?.exit ?? 1) === 0 && /pass\s+1/i.test(outputText(toolOutput(event))));
  const proofWriteIndex = writes.findIndex(event => pathFrom(toolInput(event), ['filePath', 'path', 'file']) === 'PROOF.txt' || pathFrom(toolInput(event), ['filePath', 'path', 'file']) === path.join(fixture, 'PROOF.txt'));
  const sourceEditIndex = edits.findIndex(event => pathFrom(toolInput(event), ['filePath', 'path', 'file']) === 'src/invoice.mjs' || pathFrom(toolInput(event), ['filePath', 'path', 'file']) === sourceFile);
  const proofReadIndex = reads.findIndex(event => pathFrom(toolInput(event), ['filePath', 'path', 'file']) === 'PROOF.txt' || pathFrom(toolInput(event), ['filePath', 'path', 'file']) === path.join(fixture, 'PROOF.txt'));
  const topStop = events.findIndex(event => /step_finish|step-finish/i.test(eventKind(event)) && stepReason(event) === 'stop');
  const eventIndex = target => events.indexOf(target);
  const proofWrite = proofWriteIndex >= 0 ? writes[proofWriteIndex] : null;
  const proofRead = proofReadIndex >= 0 ? reads[proofReadIndex] : null;
  return {
    eventCount: events.length,
    completedToolCount: completedTools.length,
    redBeforeEdit: Boolean(red && sourceEditIndex >= 0 && eventIndex(red) < eventIndex(edits[sourceEditIndex])),
    redOutput: red ? outputText(toolOutput(red)).slice(0, 1200) : null,
    greenAfterEdit: Boolean(green && sourceEditIndex >= 0 && eventIndex(edits[sourceEditIndex]) < eventIndex(green)),
    greenOutput: green ? outputText(toolOutput(green)).slice(0, 1200) : null,
    sourceRead: reads.some(event => ['src/invoice.mjs', sourceFile].includes(pathFrom(toolInput(event), ['filePath', 'path', 'file']))),
    protectedTestRead: reads.some(event => ['tests/invoice.test.mjs', testFile].includes(pathFrom(toolInput(event), ['filePath', 'path', 'file']))),
    sourceEdit: sourceEditIndex >= 0,
    proofCreatedAfterGreen: Boolean(proofWrite && green && eventIndex(proofWrite) > eventIndex(green)),
    proofReadAfterWrite: Boolean(proofRead && proofWrite && eventIndex(proofRead) > eventIndex(proofWrite)),
    finalStopAfterProofRead: Boolean(topStop >= 0 && proofRead && topStop > eventIndex(proofRead)),
    finalStopReason: topStop >= 0 ? stepReason(events[topStop]) : null,
    toolNames: [...new Set(completedTools.map(toolName))],
  };
}

async function runIndependentTest(fixture, port) {
  const fixtureState = path.join(fixture, '.state', 'client');
  await mkdir(fixtureState, { recursive: true, mode: 0o700 });
  const nodePath = await realpath(process.execPath);
  const profile = sandboxProfile({
    projectRoot: fixture,
    port,
    writablePaths: [fixtureState],
    protectedPaths: [path.join(fixture, 'tests'), path.join(fixture, 'src'), path.join(fixture, 'PROOF.txt')],
    runtimePaths: [nodePath],
    allowNetwork: false,
  });
  if (!profile.supported) return { code: 1, signal: null, error: profile.reason ?? 'Sandbox unavailable.', output: '' };
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile.profile, nodePath, '--test', 'tests/invoice.test.mjs'], {
    cwd: fixture,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: fixtureState, TMPDIR: fixtureState, XDG_CACHE_HOME: fixtureState, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 128_000,
  });
  return { code: result.status ?? 1, signal: result.signal ?? null, error: result.error ? `${result.error.name}: ${result.error.message}` : null, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function writeFixture(fixture) {
  await mkdir(path.join(fixture, 'src'), { mode: 0o700 });
  await mkdir(path.join(fixture, 'tests'), { mode: 0o700 });
  await writeFile(path.join(fixture, 'package.json'), '{"name":"muse-invoice-e2e","private":true,"type":"module"}\n', { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(fixture, 'src', 'invoice.mjs'), `export function invoice({ price, quantity, discount }) {\n  return price - discount;\n}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(fixture, 'tests', 'invoice.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { invoice } from '../src/invoice.mjs';\n\ntest('invoice multiplies unit price by quantity before discount', () => {\n  assert.equal(invoice({ price: 20.5, quantity: 2, discount: 4 }), 37);\n});\n`, { mode: 0o444, flag: 'wx' });
  const sourceBefore = await readFile(path.join(fixture, 'src', 'invoice.mjs'));
  const testBefore = await readFile(path.join(fixture, 'tests', 'invoice.test.mjs'));
  await chmod(path.join(fixture, 'tests', 'invoice.test.mjs'), 0o444);
  const testStatBefore = await lstat(path.join(fixture, 'tests', 'invoice.test.mjs'));
  return { sourceBefore, testBefore, sourceHashBefore: sha256(sourceBefore), testHashBefore: sha256(testBefore), testModeBefore: testStatBefore.mode & 0o777 };
}

function summarizeReady(ready) {
  if (ready.ok) return null;
  const body = ready.body ?? {};
  const details = JSON.stringify(body).toLowerCase();
  if (body.state === 'login_or_setup_required' || /login|quota|rate.?limit|429|approval_required/.test(details)) return 'BLOCKED';
  return 'BLOCKED';
}

async function main() {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const evidenceRoot = path.join(REPO, '.verification');
  await ensurePlainDir(evidenceRoot, 0o700);
  const evidenceDir = path.join(evidenceRoot, `live-coding-${stamp}`);
  await ensurePlainDir(evidenceDir, 0o700);
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'muse-client-e2e-')));
  await chmod(fixture, 0o700);
  const settingsAtStart = settings();
  const report = {
    schema: 'muse-live-coding-verification/v1',
    status: 'FAIL',
    qualification: 'NONE',
    experimentalTransport: 'real-muse-native-or-browser-synthetic-tools',
    createdAt: new Date().toISOString(),
    liveOrigin: `http://127.0.0.1:${settingsAtStart.port}`,
    rootId: ROOT_ID,
    toolMode: 'synthetic-json',
    sourceHash: null,
    runtime: { node: process.version, os: `${os.platform()} ${os.release()}`, clientVersion: null, clientBinarySha256: null },
    gates: {
      bridgeReady: false, clientVersion: false, initialRed: false, sourceChanged: false,
      protectedTestUnchanged: false, proofExact: false, independentGreenNoNetwork: false,
      clientEventOrder: false, immutableTestRead: false, projectHarnessUnchanged: false,
      clientJsonlValid: false, syntheticArtifactsPersisted: false,
    },
    limitations: ['Synthetic invoice task only; not FAAS N3/N4 and not production qualification.'],
    evidence: path.relative(REPO, evidenceDir),
  };
  let fixtureState = null;
  let result = null;
  try {
    const readyResponse = await fetch(`${report.liveOrigin}/readyz`, { signal: AbortSignal.timeout(3000) });
    let readyBody = {};
    try { readyBody = await readyResponse.json(); } catch {}
    report.experimentalTransport = readyBody.mode === 'http' ? 'real-muse-native-noise-synthetic-tools' : 'real-muse-browser-synthetic-tools';
    const readyOk = readyResponse.ok && readyBody.ready === true && readyBody.rootId === ROOT_ID;
    report.gates.bridgeReady = readyOk;
    report.bridge = { httpStatus: readyResponse.status, ready: readyBody.ready === true, state: readyBody.state ?? null, rootIdMatches: readyBody.rootId === ROOT_ID };
    if (!readyOk) {
      report.status = summarizeReady({ ok: false, body: readyBody });
      report.failure = 'Local bridge was not ready for this project root; no client request was sent.';
      return;
    }

    fixtureState = await writeFixture(fixture);
    const initial = await runIndependentTest(fixture, settingsAtStart.port);
    report.gates.initialRed = initial.code !== 0 && /16\.5/.test(initial.output) && /37/.test(initial.output) && /AssertionError|AssertionError/.test(initial.output);
    await atomicEvidence(path.join(evidenceDir, 'red-test.log'), initial.output);
    if (!report.gates.initialRed) throw new Error('Initial offline RED did not show the intended exact 16.5-versus-37 failure.');

    const [binaryPath, launcherReal] = await Promise.all([realpath(OPENCODE), realpath(LAUNCHER)]);
    const binaryStat = await lstat(binaryPath);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw new Error('OpenCode executable is not a regular file.');
    const binaryBytes = await readFile(binaryPath);
    report.runtime.clientBinarySha256 = sha256(binaryBytes);
    const version = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', HOME: fixture, TMPDIR: fixture } });
    report.runtime.clientVersion = (version.stdout ?? '').trim().split(/\s+/).at(-1) ?? null;
    if (version.status !== 0 || report.runtime.clientVersion !== '1.18.34') throw new Error(`Unexpected OpenCode version (${version.status ?? 'unavailable'}): ${report.runtime.clientVersion ?? 'unknown'}`);
    report.gates.clientVersion = true;
    report.projectSourceHashesBefore = await sourceHashes();

    const task = 'In this synthetic fixture only, inspect src/invoice.mjs and tests/invoice.test.mjs. First run `node --test tests/invoice.test.mjs` and observe the expected failure. The test file is immutable; do not change it. Fix only src/invoice.mjs so quantity is included, rerun the same test until it passes, then create PROOF.txt with exactly `BERSERK_AGENT_E2E_OK` followed by one newline. Read PROOF.txt back, verify it, and stop. Do not edit or inspect anything outside this fixture. Use bash for tests, read to inspect files, edit for the source correction, and write/read for proof.';
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: fixture,
      TMPDIR: fixture,
      MUSE_PORT: String(settingsAtStart.port),
      MUSE_VERIFICATION_ROOT: fixture,
      MUSE_VERIFICATION_TIMEOUT_MS: String(MAX_RUNTIME_MS),
    };
    result = await captureClient(process.execPath, [launcherReal, '--verification-auto', '--project-root', fixture, '--work-dir', fixture, '--port', String(settingsAtStart.port), '--protect-path', 'tests', '--', task], {
      cwd: fixture,
      env,
      timeoutMs: MAX_RUNTIME_MS + 5000,
    });
    await atomicEvidence(path.join(evidenceDir, 'client.stdout.jsonl'), result.stdout);
    await atomicEvidence(path.join(evidenceDir, 'client.stderr.log'), result.stderr);
    report.client = { exitCode: result.code, signal: result.signal, timedOut: result.timeout, outputLimited: result.outputLimit, spawnError: result.spawnError, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length, launcher: path.relative(REPO, launcherReal), args: ['--verification-auto', '--project-root', '<fresh-fixture>', '--work-dir', '<fresh-fixture>', '--port', settingsAtStart.port, '--protect-path', 'tests', '<synthetic-task>'] };
    report.client.sandbox = 'launcher completed only after its required macOS sandbox preflight';
    const parsed = parseJsonl(result.stdout);
    report.clientEvents = analyzeEvents(parsed.events, fixture);
    report.clientEvents.malformedJsonlLines = parsed.malformed;
    report.gates.clientJsonlValid = parsed.malformed === 0 && parsed.events.length > 0;
    if (result.stdout.length + result.stderr.length > MAX_OUTPUT_BYTES || result.outputLimit) throw new Error('Client output exceeded 2 MB.');
    if (result.timeout) throw new Error('Client exceeded the 8 minute wall-clock bound.');
    if (result.spawnError || result.code !== 0) throw new Error(`OpenCode exited unsuccessfully (${result.code}${result.signal ? `/${result.signal}` : ''}).`);
    const fixtureSource = await secureRegularFile(path.join(fixture, 'src', 'invoice.mjs'), fixture);
    const fixtureTest = await secureRegularFile(path.join(fixture, 'tests', 'invoice.test.mjs'), fixture);
    const proofPath = path.join(fixture, 'PROOF.txt');
    let proof = null;
    try { proof = await secureRegularFile(proofPath, fixture); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const finalTest = await runIndependentTest(fixture, settingsAtStart.port);
    await atomicEvidence(path.join(evidenceDir, 'green-test.log'), finalTest.output);
    report.hashes = {
      sourceBefore: fixtureState.sourceHashBefore,
      sourceAfter: sha256(fixtureSource.bytes),
      protectedTestBefore: fixtureState.testHashBefore,
      protectedTestAfter: sha256(fixtureTest.bytes),
      proof: proof ? sha256(proof.bytes) : null,
    };
    report.gates.sourceChanged = report.hashes.sourceBefore !== report.hashes.sourceAfter;
    report.gates.protectedTestUnchanged = report.hashes.protectedTestBefore === report.hashes.protectedTestAfter && (fixtureState.testModeBefore & 0o222) === 0 && (fixtureTest.stat.mode & 0o222) === 0;
    report.gates.proofExact = proof?.bytes.toString('utf8') === PROOF;
    report.gates.independentGreenNoNetwork = finalTest.code === 0 && /pass\s+1/i.test(finalTest.output) && !finalTest.error;
    report.gates.clientEventOrder = report.clientEvents.redBeforeEdit && report.clientEvents.greenAfterEdit && report.clientEvents.sourceRead && report.clientEvents.sourceEdit && report.clientEvents.proofCreatedAfterGreen && report.clientEvents.proofReadAfterWrite && report.clientEvents.finalStopAfterProofRead;
    report.gates.immutableTestRead = report.clientEvents.protectedTestRead;
    report.projectSourceHashesAfter = await sourceHashes();
    report.gates.projectHarnessUnchanged = JSON.stringify(report.projectSourceHashesBefore) === JSON.stringify(report.projectSourceHashesAfter);
    report.sourceHash = report.hashes.sourceAfter;
    report.harnessSourceHash = report.projectSourceHashesBefore['scripts/agent.mjs'] ?? null;
    const required = ['bridgeReady', 'clientVersion', 'initialRed', 'sourceChanged', 'protectedTestUnchanged', 'proofExact', 'independentGreenNoNetwork', 'clientEventOrder', 'immutableTestRead', 'projectHarnessUnchanged', 'clientJsonlValid'];
    const allPassed = required.every(key => report.gates[key] === true);
    report.status = allPassed ? 'PASS_EXPERIMENTAL' : 'FAIL';
    report.qualification = 'NONE';
    if (!allPassed) report.failure = `Verification gates failed: ${required.filter(key => report.gates[key] !== true).join(', ')}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown verification error.';
    report.failure = message.slice(0, 1000);
    if (/login|quota|rate.?limit|429|approval_required/i.test(message)) report.status = 'BLOCKED';
    if (result) {
      report.client ??= { exitCode: result.code, signal: result.signal, timedOut: result.timeout, outputLimited: result.outputLimit, spawnError: result.spawnError, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length };
      try { await atomicEvidence(path.join(evidenceDir, 'client.stdout.jsonl'), result.stdout); } catch {}
      try { await atomicEvidence(path.join(evidenceDir, 'client.stderr.log'), result.stderr); } catch {}
    }
  } finally {
    if (fixtureState) {
      let artifactWrites = 0;
      try { await atomicEvidence(path.join(evidenceDir, 'synthetic-invoice.initial.mjs'), fixtureState.sourceBefore); artifactWrites += 1; } catch {}
      try { await atomicEvidence(path.join(evidenceDir, 'synthetic-invoice.test.mjs'), fixtureState.testBefore); artifactWrites += 1; } catch {}
      try {
        const finalSource = await secureRegularFile(path.join(fixture, 'src', 'invoice.mjs'), fixture);
        await atomicEvidence(path.join(evidenceDir, 'synthetic-invoice.final.mjs'), finalSource.bytes);
        artifactWrites += 1;
      } catch {}
      try {
        const finalProof = await secureRegularFile(path.join(fixture, 'PROOF.txt'), fixture);
        await atomicEvidence(path.join(evidenceDir, 'synthetic-PROOF.txt'), finalProof.bytes);
        artifactWrites += 1;
      } catch {}
      report.gates.syntheticArtifactsPersisted = artifactWrites === 4;
      if (!report.gates.syntheticArtifactsPersisted && report.status === 'PASS_EXPERIMENTAL') {
        report.status = 'FAIL';
        report.failure = 'Synthetic fixture/proof evidence could not be fully persisted.';
      }
    }
    try {
      report.projectSourceHashes = report.projectSourceHashesAfter ?? await sourceHashes();
    } catch { report.projectSourceHashes = null; }
    report.finishedAt = new Date().toISOString();
    try { await atomicEvidence(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); } catch (error) {
      process.stderr.write(`Could not safely persist report: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    }
    try { await rm(fixture, { recursive: true, force: true }); } catch { /* preserve report; fixture path is generated by mkdtemp */ }
    if (report.status !== 'PASS_EXPERIMENTAL') process.exitCode = 1;
    process.stdout.write(`${report.status} transport=${report.experimentalTransport} qualification=${report.qualification}\nEvidence: ${path.join(evidenceDir, 'report.json')}\n`);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Unknown verifier failure.'}\n`);
  process.exitCode = 1;
});
