#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createScriptedDriver } from '../tests/scripted-driver.mjs';
import { clientConfig, isolatedClientEnv, sandboxProfile } from '../src/client-config.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(DIR, '..');
const OPEN_CODE = process.env.OPENCODE_BIN || path.join(os.homedir(), '.local', 'bin', 'opencode');
const SOURCE = `export function invoice({ price, quantity, discount }) {\n  return price - discount;\n}\n`;
const TEST = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { invoice } from '../src/invoice.mjs';\n\ntest('invoice multiplies price by quantity before subtracting discount', () => {\n  assert.equal(invoice({ price: 20.5, quantity: 2, discount: 4 }), 37);\n});\n`;
const TASK = 'Fix the invoice calculation bug. First read src/invoice.mjs and tests/invoice.test.mjs, run node --test tests/invoice.test.mjs and observe its current failure, then edit src/invoice.mjs only so the result is price multiplied by quantity minus discount. Do not change tests. Run the same test again and confirm it passes. Then write exactly BERSERK_AGENT_E2E_OK followed by one newline to PROOF.txt, read PROOF.txt back, and finish.';

function argsFrom(argv) {
  const options = { bridge: process.env.MUSE_BRIDGE_MODULE ?? path.resolve(process.cwd(), 'src/server.mjs'), rootId: 'muse-agent-e2e', maxChars: 250000, timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--bridge-module') options.bridge = argv[++i] ?? '';
    else if (argv[i] === '--root-id') options.rootId = argv[++i] ?? '';
    else throw new Error(`Unknown verification option: ${argv[i]}`);
  }
  if (!options.bridge) throw new Error('A local bridge module is required.');
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(options.rootId)) throw new Error('Invalid bridge root ID.');
  return options;
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

async function secureFile(pathname, root) {
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(pathname);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Verification target escaped the fresh run directory.');
  const info = await lstat(pathname);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Verification file must be a single-link regular file: ${path.basename(pathname)}`);
  return { bytes: await readFile(pathname), stat: info };
}

function parseEvents(bytes) {
  return bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function hasSequence(events, stages) {
  const actual = events.filter(row => row.kind === 'selected').map(row => row.stage);
  let cursor = -1;
  for (const stage of stages) {
    cursor = actual.indexOf(stage, cursor + 1);
    if (cursor < 0) return false;
  }
  return true;
}

function runProcess(command, argv, { cwd, env, maxMs = 125000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let outputLimit = false;
    const collect = (which, chunk) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) outputLimit = true;
      const target = which === 'stdout' ? stdout : stderr;
      const allowed = Math.max(0, Math.min(chunk.length, 1_000_000 - (bytes - chunk.length)));
      if (allowed) {
        if (which === 'stdout') stdout += chunk.subarray(0, allowed).toString('utf8');
        else stderr += chunk.subarray(0, allowed).toString('utf8');
      }
      if (outputLimit) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    let timeout = false;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal: signal ?? null, stdout, stderr, timeout, outputLimit });
    };
    child.once('error', () => finish(127, null));
    child.once('close', finish);
    const timer = setTimeout(() => {
      timeout = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
      kill.unref();
    }, maxMs);
    timer.unref();
  });
}

async function listenEphemeral(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

const SANDBOX_PROBE = String.raw`const fs=require('node:fs'); const http=require('node:http'); const root=process.env.PROBE_ROOT; const state=process.env.PROBE_STATE; const canary=process.env.PROBE_CANARY; const protectedPath=process.env.PROBE_PROTECTED; const bridgePort=Number(process.env.PROBE_BRIDGE_PORT); const trapPort=Number(process.env.PROBE_TRAP_PORT); const result={fixtureRead:false,stateReadWrite:false,outsideReadDenied:false,protectedWriteDenied:false,bridgeAllowed:false,otherLocalPortDenied:false}; try { result.fixtureRead=fs.readFileSync(root+'/src/invoice.mjs','utf8').includes('return price - discount;'); fs.writeFileSync(state+'/sandbox-preflight.txt','state-ok'); result.stateReadWrite=fs.readFileSync(state+'/sandbox-preflight.txt','utf8')==='state-ok'; } catch {} try { fs.readFileSync(canary); } catch { result.outsideReadDenied=true; } try { fs.writeFileSync(protectedPath,'must-not-write'); } catch { result.protectedWriteDenied=true; } function probe(port, callback) { const req=http.get({host:'127.0.0.1',port,path:'/health',timeout:1500},res=>{res.resume(); callback(null,res.statusCode);}); req.on('timeout',()=>req.destroy(new Error('timeout'))); req.on('error',err=>callback(err)); } probe(bridgePort,(err,status)=>{result.bridgeAllowed=!err&&status===200; probe(trapPort,(trapErr)=>{result.otherLocalPortDenied=Boolean(trapErr); process.stdout.write(JSON.stringify(result)); if (Object.values(result).some(value=>value!==true)) process.exitCode=3; }); });`;

async function main() {
  const options = argsFrom(process.argv.slice(2));
  const bridgePath = path.resolve(options.bridge);
  const { createBridge } = await import(pathToFileURL(bridgePath));
  if (typeof createBridge !== 'function') throw new Error('Bridge module did not export createBridge().');
  const runDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'muse-client-e2e-')));
  const canaryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'muse-client-canary-')));
  const sourceDir = path.join(runDir, 'src');
  const testsDir = path.join(runDir, 'tests');
  await mkdir(sourceDir, { mode: 0o700 });
  await mkdir(testsDir, { mode: 0o700 });
  const sourcePath = path.join(sourceDir, 'invoice.mjs');
  const testPath = path.join(testsDir, 'invoice.test.mjs');
  const proofPath = path.join(runDir, 'PROOF.txt');
  const evidencePath = path.join(runDir, 'evidence.jsonl');
  const canaryPath = path.join(canaryDir, 'outside-canary.txt');
  await writeFile(sourcePath, SOURCE, { mode: 0o600, flag: 'wx' });
  await writeFile(testPath, TEST, { mode: 0o400, flag: 'wx' });
  await writeFile(evidencePath, '', { mode: 0o600, flag: 'wx' });
  await writeFile(canaryPath, 'outside-canary', { mode: 0o600, flag: 'wx' });
  const initialSource = sha256((await secureFile(sourcePath, runDir)).bytes);
  const immutableTest = sha256((await secureFile(testPath, runDir)).bytes);
  const driver = createScriptedDriver({ evidencePath });
  const bridge = createBridge({ driver, rootId: options.rootId, maxChars: options.maxChars, timeoutMs: options.timeoutMs });
  // Test fixture traffic only; preserve tool schemas to diagnose client dialects.
  bridge.server.prependListener('request', request => {
    if (!request.url.includes('/chat/completions')) return;
    const parts = [];
    let bytes = 0;
    request.on('data', part => { bytes += part.length; if (bytes < 1000000) parts.push(part); });
    request.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        await writeFile(path.join(runDir, 'client-tool-schemas.json'), JSON.stringify(body.tools || [], null, 2), { mode: 0o600 });
      } catch { /* Diagnostic data must never affect the test request. */ }
    });
  });
  let agentResult;
  let bridgePort;
  let trapServer;
  let minimalEnv;
  try {
    const clientDirs = isolatedClientEnv({ projectRoot: runDir });
    const stateDir = clientDirs.stateDir;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, 'opencode.json');
    await writeFile(configPath, `${JSON.stringify(clientConfig({ port: 44567, workDir: runDir, projectRoot: runDir }), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    minimalEnv = { ...clientDirs.env, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: clientDirs.env.XDG_CONFIG_HOME };
    const version = await runProcess(OPEN_CODE, ['--version'], { cwd: runDir, env: minimalEnv, maxMs: 5000 });
    const versionText = version.stdout.trim();
    if (version.code !== 0 || versionText !== '1.18.34') throw new Error(`Expected installed OpenCode 1.18.34, got ${versionText || `exit ${version.code}`}.`);
    const configCheck = await runProcess(OPEN_CODE, ['debug', 'config', '--pure'], { cwd: runDir, env: minimalEnv, maxMs: 10000 });
    let resolvedConfig;
    try { resolvedConfig = JSON.parse(configCheck.stdout); } catch { throw new Error('Installed OpenCode did not return a parseable resolved configuration.'); }
    const resolvedModel = resolvedConfig.provider?.['muse-local']?.models?.['muse-web'];
    const configValidated = configCheck.code === 0
      && resolvedConfig.model === 'muse-local/muse-web'
      && resolvedConfig.small_model === 'muse-local/muse-web'
      && Array.isArray(resolvedConfig.enabled_providers) && resolvedConfig.enabled_providers.length === 1 && resolvedConfig.enabled_providers[0] === 'muse-local'
      && Array.isArray(resolvedConfig.plugin) && resolvedConfig.plugin.length === 0
      && resolvedConfig.share === 'disabled' && resolvedConfig.autoupdate === false && resolvedConfig.lsp === false
      && resolvedModel?.tool_call === true
      && resolvedConfig.provider?.['muse-local']?.options?.baseURL === 'http://127.0.0.1:44567/v1';
    if (!configValidated) throw new Error('Installed OpenCode resolved a config that does not match the local-only client policy.');
    try {
      bridgePort = await bridge.listen(0);
    } catch {
      await writeFile(evidencePath, `${JSON.stringify({ at: new Date().toISOString(), kind: 'blocked', reason: 'loopback bridge listener was unavailable' })}\n`, { mode: 0o600, flag: 'a' });
      process.stdout.write(`${JSON.stringify({
        result: 'BLOCKED_LOOPBACK_UNAVAILABLE',
        client: 'OpenCode 1.18.34',
        clientConfigurationValidated: true,
        qualification: { tier: null, transport: 'scripted-client-transport', native: false, qualificationClaim: false },
        sandbox: { behavioralPreflight: 'not-run', platform: process.platform, networkPolicy: '127.0.0.1 bridge port only', credentialEnvironment: 'allowlist only' },
        bridge: { supported: false, listener: '127.0.0.1 ephemeral port unavailable' },
        hashes: { initialSourceSha256: initialSource, immutableTestSha256: immutableTest, evidenceSha256: sha256((await secureFile(evidencePath, runDir)).bytes) },
        proofCreated: false,
        limits: { clientTimeoutMs: 120000, outputBytes: 1000000 },
        runDirectory: runDir,
      }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    trapServer = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('trap'); });
    const trapPort = await listenEphemeral(trapServer);
    const protectedDir = path.join(runDir, 'tests');
    const sandbox = sandboxProfile({
      port: bridgePort,
      projectRoot: runDir,
      writablePaths: [runDir, stateDir],
      protectedPaths: [protectedDir],
      runtimePaths: [await realpath(OPEN_CODE), await realpath(process.execPath)],
    });
    const probeEnv = {
      ...minimalEnv,
      PROBE_ROOT: runDir,
      PROBE_STATE: stateDir,
      PROBE_CANARY: canaryPath,
      PROBE_PROTECTED: path.join(protectedDir, 'write-canary.txt'),
      PROBE_BRIDGE_PORT: String(bridgePort),
      PROBE_TRAP_PORT: String(trapPort),
    };
    const probe = await runProcess('/usr/bin/sandbox-exec', ['-p', sandbox.profile, process.execPath, '-e', SANDBOX_PROBE], { cwd: runDir, env: probeEnv, maxMs: 10000 });
    let checks = {};
    try { checks = JSON.parse(probe.stdout); } catch {}
    if (probe.code !== 0 || Object.values(checks).length !== 6 || Object.values(checks).some(value => value !== true)) {
      await writeFile(evidencePath, `${JSON.stringify({ at: new Date().toISOString(), kind: 'blocked', reason: 'sandbox behavioral preflight failed', status: probe.code, checks })}\n`, { mode: 0o600, flag: 'a' });
      const blocked = probe.code === 71 ? 'BLOCKED_SANDBOX_UNAVAILABLE' : 'BLOCKED_SANDBOX_POLICY';
      process.stdout.write(`${JSON.stringify({
        result: blocked,
        client: 'OpenCode 1.18.34',
        clientConfigurationValidated: true,
        qualification: { tier: null, transport: 'scripted-client-transport', native: false, qualificationClaim: false },
        sandbox: { supported: false, platform: process.platform, preflightExitCode: probe.code, checks },
        hashes: { initialSourceSha256: initialSource, immutableTestSha256: immutableTest, evidenceSha256: sha256((await secureFile(evidencePath, runDir)).bytes) },
        proofCreated: false,
        limits: { clientTimeoutMs: 120000, outputBytes: 1000000 },
        runDirectory: runDir,
      }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    agentResult = await runProcess(process.execPath, [
      path.join(DIR, 'agent.mjs'), '--port', String(bridgePort), '--project-root', runDir, '--work-dir', runDir,
      '--opencode', OPEN_CODE, '--protect-path', 'tests', '--verification-auto', '--', TASK,
    ], { cwd: runDir, env: { ...minimalEnv, MUSE_VERIFICATION_ROOT: runDir }, maxMs: 125000 });
    await writeFile(path.join(runDir, 'client-trace.jsonl'), agentResult.stdout, { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(runDir, 'client-stderr.log'), agentResult.stderr, { mode: 0o600, flag: 'wx' });
  } finally {
    trapServer?.close();
    await bridge.close();
    await rm(canaryDir, { recursive: true, force: true });
  }
  if (!agentResult) throw new Error('The local client did not start.');
  if (agentResult.code !== 0 || agentResult.timeout || agentResult.outputLimit) {
    process.stdout.write(`${JSON.stringify({ result: 'FAIL_CLIENT', agentExitCode: agentResult.code,
      timeout: agentResult.timeout, outputLimit: agentResult.outputLimit, runDirectory: runDir,
      evidenceMode: 'scripted-client-transport', nativeTools: false }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const finalSourceFile = await secureFile(sourcePath, runDir);
  const finalTestFile = await secureFile(testPath, runDir);
  const proofFile = await secureFile(proofPath, runDir);
  const evidenceFile = await secureFile(evidencePath, runDir);
  const finalSource = finalSourceFile.bytes.toString('utf8');
  if (initialSource === sha256(finalSourceFile.bytes)) throw new Error('OpenCode did not change the source fixture.');
  if (!/return\s+price\s*\*\s*quantity\s*-\s*discount\s*;/.test(finalSource)) throw new Error('Source does not contain the correct invoice calculation.');
  if (immutableTest !== sha256(finalTestFile.bytes) || finalTestFile.stat.mode & 0o222) throw new Error('The immutable invoice test changed or became writable.');
  if (proofFile.bytes.toString('utf8') !== 'BERSERK_AGENT_E2E_OK\n') throw new Error('Proof file content did not match the exact expected bytes.');
  const events = parseEvents(evidenceFile.bytes);
  if (agentResult.code !== 0 || agentResult.timeout || agentResult.outputLimit) throw new Error(`OpenCode agent exited unsuccessfully (code ${agentResult.code}, timeout ${agentResult.timeout}, outputLimit ${agentResult.outputLimit}).`);
  if (!hasSequence(events, ['source-read', 'red-test', 'source-edit', 'green-test', 'proof', 'proof-read', 'final'])) throw new Error('Scripted-client events were incomplete or out of order.');
  if (!events.some(row => row.kind === 'observed' && row.stage === 'red-failure') || !events.some(row => row.kind === 'observed' && row.stage === 'green-pass') || !events.some(row => row.kind === 'observed' && row.stage === 'proof-read')) throw new Error('Expected real-client tool results were not observed.');
  const independentTest = await runProcess(process.execPath, ['--test', 'tests/invoice.test.mjs'], { cwd: runDir, env: minimalEnv, maxMs: 10000 });
  if (independentTest.code !== 0 || !/pass\s+1/.test(independentTest.stdout)) throw new Error('Independent final invoice test did not pass.');
  const report = {
    result: 'BERSERK_AGENT_E2E_OK',
    client: 'OpenCode 1.18.34',
    clientConfigurationValidated: true,
    qualification: { tier: null, transport: 'scripted-client-transport', native: false, qualificationClaim: false },
    sandbox: { supported: true, platform: process.platform, network: 'loopback proxy only', credentialEnvironment: 'allowlist only' },
    hashes: {
      initialSourceSha256: initialSource,
      finalSourceSha256: sha256(finalSourceFile.bytes),
      immutableTestSha256: sha256(finalTestFile.bytes),
      proofSha256: sha256(proofFile.bytes),
      evidenceSha256: sha256(evidenceFile.bytes),
    },
    ordering: events.filter(row => row.kind === 'selected').map(row => row.stage),
    agentExitCode: agentResult.code,
    independentTestExitCode: independentTest.code,
    limits: { clientTimeoutMs: 120000, outputBytes: 1000000 },
    runDirectory: runDir,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Verification failed.'}\n`);
  process.exitCode = 1;
});
