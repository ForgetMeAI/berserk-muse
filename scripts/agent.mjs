#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { mkdir, lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { clientConfig, isolatedClientEnv, sandboxProfile, validatePort } from '../src/client-config.mjs';

const OPEN_CODE = process.env.OPENCODE_BIN || path.join(os.homedir(), '.local', 'bin', 'opencode');
const MAX_MS = 120_000;
const MAX_OUTPUT = 1_000_000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { port: process.env.MUSE_PORT ?? null, workDir: null, projectRoot: null, opencode: OPEN_CODE, protected: [], verificationAuto: false, task: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '--work-dir' || arg === '--project-root' || arg === '--opencode' || arg === '--protect-path') {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      if (arg === '--port') options.port = value;
      else if (arg === '--work-dir') options.workDir = value;
      else if (arg === '--project-root') options.projectRoot = value;
      else if (arg === '--opencode') options.opencode = value;
      else options.protected.push(value);
    } else if (arg === '--verification-auto') options.verificationAuto = true;
    else if (arg === '--') options.task.push(...argv.slice(i + 1)), i = argv.length;
    else options.task.push(arg);
  }
  return options;
}

async function prepareDir(dir, root, privateRoot) {
  const relative = path.relative(root, dir);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Isolated client path must not contain a symlink.');
    const privateRelative = path.relative(privateRoot, current);
    if (current === privateRoot || (!privateRelative.startsWith('..') && !path.isAbsolute(privateRelative))) {
      await import('node:fs/promises').then(({ chmod }) => chmod(current, 0o700));
    }
  }
}

async function ensureDefaultWorkspace(root) {
  const canonicalRoot = await realpath(root);
  const workspace = path.join(canonicalRoot, 'workspace');
  try {
    await mkdir(workspace, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Default workspace must be a real directory, not a symlink.');
  const canonicalWorkspace = await realpath(workspace);
  if (canonicalWorkspace !== workspace) throw new Error('Default workspace path resolved outside the project root.');
  return workspace;
}

async function replaceConfigAtomically(configPath, configText) {
  const directory = path.dirname(configPath);
  const tempPath = path.join(directory, `.opencode-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(configText, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const stat = await lstat(tempPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error('Temporary client config must be a private, single-link regular file.');
    }
    await rename(tempPath, configPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

function run(command, args, { env, cwd, maxMs = null, maxOutput = null }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['inherit', 'pipe', 'pipe'] });
    let outputBytes = 0;
    let settled = false;
    let timeout = false;
    let outputLimit = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.removeListener('SIGINT', onParentSignal);
      process.removeListener('SIGTERM', onParentSignal);
      resolve({ code: code ?? 1, signal: signal ?? null, timeout, outputLimit });
    };
    const stop = reason => {
      if (reason === 'timeout') timeout = true;
      if (reason === 'output') outputLimit = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
      killTimer.unref();
    };
    const onData = stream => chunk => {
      outputBytes += chunk.length;
      const allowed = maxOutput === null ? chunk.length : Math.max(0, Math.min(chunk.length, maxOutput - (outputBytes - chunk.length)));
      if (allowed > 0) stream.write(chunk.subarray(0, allowed));
      if (maxOutput !== null && outputBytes > maxOutput) stop('output');
    };
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    child.once('error', () => finish(127, null));
    child.once('close', finish);
    const onParentSignal = signal => {
      try { process.kill(-child.pid, signal); } catch {}
    };
    process.once('SIGINT', onParentSignal);
    process.once('SIGTERM', onParentSignal);
    const timer = maxMs === null ? null : setTimeout(() => stop('timeout'), maxMs);
    timer?.unref();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let configuredRoot = process.cwd();
  let configuredPort = 8787;
  if (!options.projectRoot || !options.workDir || !options.port) {
    const config = await import('../src/config.mjs');
    configuredRoot = config.ROOT;
    configuredPort = config.settings().port;
  }
  const port = validatePort(options.port ?? configuredPort);
  let defaultWorkspace = null;
  if (!options.projectRoot && !options.workDir) defaultWorkspace = await ensureDefaultWorkspace(configuredRoot);
  const selectedProjectRoot = options.projectRoot ?? options.workDir ?? defaultWorkspace ?? configuredRoot;
  const selectedWorkDir = options.workDir ?? options.projectRoot ?? defaultWorkspace ?? configuredRoot;
  const projectRoot = await realpath(path.resolve(selectedProjectRoot));
  const workDir = await realpath(path.resolve(selectedWorkDir));
  if (options.verificationAuto) {
    // TMPDIR is intentionally isolated for the client; it is not the outer
    // runner's system temp root. The runner grants exactly its fresh fixture.
    const fixtureRoot = process.env.MUSE_VERIFICATION_ROOT ? await realpath(process.env.MUSE_VERIFICATION_ROOT) : null;
    if (!options.task.length || fixtureRoot !== projectRoot || !/^muse-client-e2e-[a-zA-Z0-9]+$/.test(path.basename(projectRoot))) {
      throw new Error('The test-only automatic permission mode is restricted to a task in a fresh system temporary directory.');
    }
  }
  const rel = path.relative(projectRoot, workDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('workDir must be inside projectRoot.');
  const opencode = await realpath(path.resolve(options.opencode));
  const clientEnv = isolatedClientEnv({ projectRoot });
  for (const directory of [clientEnv.stateDir, clientEnv.homeDir, clientEnv.env.XDG_CONFIG_HOME, clientEnv.env.XDG_DATA_HOME, clientEnv.env.XDG_CACHE_HOME, clientEnv.env.XDG_STATE_HOME, clientEnv.tempDir]) await prepareDir(directory, projectRoot, clientEnv.stateDir);
  const configPath = path.join(clientEnv.stateDir, 'opencode.json');
  const configText = `${JSON.stringify(clientConfig({ port, workDir, projectRoot }), null, 2)}\n`;
  await replaceConfigAtomically(configPath, configText);
  const env = { ...clientEnv.env, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: clientEnv.env.XDG_CONFIG_HOME };
  const protectedPaths = [];
  for (const value of options.protected) {
    const target = await realpath(path.resolve(workDir, value));
    const relative = path.relative(workDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Protected files must be inside workDir.');
    protectedPaths.push(target);
  }
  const runtimePaths = [opencode, await realpath(process.execPath)];
  const sandbox = sandboxProfile({ port, projectRoot, writablePaths: [workDir, clientEnv.stateDir], protectedPaths, runtimePaths });
  if (!sandbox.supported) throw new Error(`SECURITY_BLOCKED: ${sandbox.reason}`);
  const preflight = spawnSync('/usr/bin/sandbox-exec', ['-p', sandbox.profile, '/usr/bin/true'], {
    cwd: workDir,
    env,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (preflight.error || preflight.status !== 0) {
    throw new Error(`SECURITY_BLOCKED: macOS refused the required sandbox profile (status ${preflight.status ?? 'unavailable'}). OpenCode was not started.`);
  }
  if (!options.task.length) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`Файлы задач: ${workDir}\n`);
      const task = (await terminal.question('Задача для Muse: ')).trim();
      if (!task) return;
      options.task.push(task);
    } finally { terminal.close(); }
  }
  const clientArgs = ['-p', sandbox.profile, opencode, 'run', '--pure', '--model', 'muse-local/muse-web', '--dir', workDir];
  const command = options.verificationAuto ? '/usr/bin/sandbox-exec' : '/usr/bin/script';
  const args = options.verificationAuto ? clientArgs : ['-q', '/dev/null', '/usr/bin/sandbox-exec', ...clientArgs];
  if (options.verificationAuto) args.push('--auto', '--format', 'json');
  else args.push('--interactive');
  args.push(...options.task);
  const bounded = options.verificationAuto;
  const verificationMs = Number(process.env.MUSE_VERIFICATION_TIMEOUT_MS || MAX_MS);
  if (bounded && (!Number.isSafeInteger(verificationMs) || verificationMs < 10000 || verificationMs > 600000)) throw new Error('Invalid verification time limit.');
  const result = await run(command, args, {
    env,
    cwd: workDir,
    maxMs: bounded ? verificationMs : null,
    maxOutput: bounded ? MAX_OUTPUT : null,
  });
  if (result.timeout) process.stderr.write(`Client stopped at the ${verificationMs / 1000} second verification limit.\n`);
  if (result.outputLimit) process.stderr.write('Client stopped after the 1 MB output limit.\n');
  process.exitCode = result.code === 0 && !result.timeout && !result.outputLimit ? 0 : 1;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'Unknown launcher error.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
