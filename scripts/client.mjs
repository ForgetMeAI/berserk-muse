#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile, stat, lstat, access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { ROOT, settings } from '../src/config.mjs';
import { clientSettings } from '../src/agent-clients.mjs';
import { assertSupportedRuntime } from '../src/platform.mjs';

async function executable(value) {
  const candidates = value.includes(path.sep) ? [path.resolve(value)] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, value));
  for (const candidate of candidates) {
    try { const resolved = await realpath(candidate); if ((await stat(resolved)).isFile()) { await access(resolved, constants.X_OK); return resolved; } } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Client executable not found. Install the requested client or use --executable with its absolute path.');
}

async function existsMetadata(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false; throw error; }
}

async function hermesSourceRootFrom(command) {
  let current = await realpath(command);
  const visited = new Set();
  for (let depth = 0; depth < 5 && !visited.has(current); depth++) {
    visited.add(current);
    let sourceRoot = path.dirname(current);
    for (;;) {
      const markers = await Promise.all([
        existsMetadata(path.join(sourceRoot, 'hermes_cli', 'env_loader.py')),
        existsMetadata(path.join(sourceRoot, 'hermes_cli', 'main.py')),
        existsMetadata(path.join(sourceRoot, 'pyproject.toml')),
      ]);
      if (markers.every(Boolean)) return sourceRoot;
      const parent = path.dirname(sourceRoot);
      if (parent === sourceRoot) break;
      sourceRoot = parent;
    }

    let text;
    try {
      const info = await stat(current);
      if (!info.isFile() || info.size > 16 * 1024) break;
      text = await readFile(current, 'utf8');
    } catch { break; }
    const firstLine = text.split(/\r?\n/, 1)[0];
    if (!/^#!.*\b(?:ba|z|k)?sh\b/.test(firstLine)) break;
    const target = text.match(/^\s*exec\s+"([^"\r\n]+)"\s+"\$@"\s*$/m)?.[1];
    if (!target || !path.isAbsolute(target)) break;
    try { current = await realpath(target); }
    catch { break; }
  }
  return null;
}

async function rejectHermesProjectEnv(command) {
  const sourceRoot = await hermesSourceRootFrom(command);
  if (!sourceRoot) return;
  // Hermes source env_loader.py intentionally uses PROJECT_ROOT/.env as a
  // development fallback when the isolated HERMES_HOME contains no .env.
  // Inspect only path metadata; never open or parse the file.
  if (await existsMetadata(path.join(sourceRoot, '.env'))) {
    throw new Error('The Hermes source checkout has a project .env; refusing to launch it with the isolated profile.');
  }
}

async function main() {
  assertSupportedRuntime();
  const argv = process.argv.slice(2), client = argv.shift();
  if (!['claude', 'hermes'].includes(client)) throw new Error('Usage: npm run client -- claude|hermes [--work-dir PATH] [--port PORT] [--executable PATH] [-- client arguments]');
  let workDir = path.join(ROOT, 'workspace'), port = settings().port, binary = client;
  let extra = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { extra = argv.slice(i + 1); break; }
    if (!['--work-dir', '--port', '--executable'].includes(argv[i]) || !argv[i + 1]) throw new Error('Invalid client launcher option.');
    const key = argv[i], value = argv[++i];
    if (key === '--work-dir') workDir = path.resolve(value);
    if (key === '--port') port = Number(value);
    if (key === '--executable') binary = value;
  }
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local API port.');
  const command = await executable(binary);
  if (client === 'hermes') await rejectHermesProjectEnv(command);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  workDir = await realpath(workDir);
  const profiles = path.join(workDir, '.berserk-client-profiles');
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const profileStat = await lstat(profiles);
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || (profileStat.mode & 0o077) !== 0
    || (process.getuid && profileStat.uid !== process.getuid())) throw new Error('Client profile directory must be private and owned by this user.');
  const profileDir = await mkdtemp(path.join(profiles, `${client}-`));
  const config = clientSettings(client, { port, profileDir, workDir });
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME']) {
    if (config.env[key]) await mkdir(config.env[key], { recursive: true, mode: 0o700 });
  }
  const configDir = client === 'claude' ? config.env.CLAUDE_CONFIG_DIR : config.env.HERMES_HOME;
  for (const file of config.files) await writeFile(path.join(configDir, file.name), file.contents, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Muse / ${client}: http://127.0.0.1:${port}; workspace: ${workDir}\n`);
  process.stdout.write('Separate client profile; normal client tool-permission prompts apply.\n');
  const child = spawn(command, [...config.args, ...extra], { cwd: workDir, env: config.env, stdio: 'inherit' });
  const forward = signal => { try { child.kill(signal); } catch { /* Already closed. */ } };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  child.once('error', () => { process.stderr.write('Could not start the requested client.\n'); process.exitCode = 1; });
  child.once('close', code => {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? 1;
  });
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
