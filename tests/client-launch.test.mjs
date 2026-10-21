import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const launcher = path.resolve(import.meta.dirname, '../scripts/client.mjs');

async function hermesSourceFixture(root, { projectEnv = false } = {}) {
  const cliDir = path.join(root, 'hermes_cli');
  const binDir = path.join(root, 'venv', 'bin');
  await mkdir(cliDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(cliDir, 'env_loader.py'), '# synthetic Hermes source marker\n');
  await writeFile(path.join(cliDir, 'main.py'), '# synthetic Hermes source marker\n');
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "synthetic-hermes"\n');
  if (projectEnv) await writeFile(path.join(root, '.env'), 'SYNTHETIC_PRIVATE_CANARY=do-not-print\n');
  const target = path.join(binDir, 'hermes');
  await writeFile(target, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync('observed.json', JSON.stringify({cwd:process.cwd(),env:process.env,args:process.argv.slice(2)}));\n`, { mode: 0o700 });
  const wrapper = path.join(root, 'hermes-wrapper');
  await writeFile(wrapper, `#!/bin/sh\nexec "${target}" "$@"\n`, { mode: 0o700 });
  return { wrapper, target };
}

test('launcher starts a real local subprocess with separate config and no inherited provider credential', { skip: process.platform === 'win32' }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'berserk-client-launch-')));
  const fake = path.join(dir, 'fake-client.mjs');
  await writeFile(fake, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync('observed.json', JSON.stringify({cwd:process.cwd(),env:process.env,args:process.argv.slice(2)}));\n`, {mode:0o700});
  try {
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [launcher, 'claude', '--work-dir', dir, '--executable', fake], {
        env:{PATH:path.dirname(process.execPath),HOME:dir,ANTHROPIC_API_KEY:'SYNTHETIC_SHOULD_NOT_INHERIT',MUSE_PORT:'12345'}, stdio:['ignore','pipe','pipe'],
      });
      let stderr='';child.stderr.on('data',part=>{stderr+=part});child.stdout.resume();
      child.once('close',code=>resolve({code,stderr}));
    });
    assert.equal(result.code, 0, result.stderr);
    const observed=JSON.parse(await readFile(path.join(dir,'observed.json'),'utf8'));
    assert.equal(observed.cwd,dir);
    assert.equal(observed.env.ANTHROPIC_API_KEY,undefined);
    assert.equal(observed.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:12345');
    assert.equal(observed.env.ANTHROPIC_AUTH_TOKEN,'muse-local');
    assert.notEqual(observed.env.HOME,dir);
    assert.deepEqual(observed.args,['--model','muse-web']);
    const profiles=await readdir(path.join(dir,'.berserk-client-profiles'));
    assert.equal(profiles.length,1);
    const settings=JSON.parse(await readFile(path.join(dir,'.berserk-client-profiles',profiles[0],'claude','settings.json'),'utf8'));
    assert.equal(settings.model,'muse-web');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('launcher refuses a Hermes source checkout with a project .env without reading or printing it', { skip: process.platform === 'win32' }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'berserk-hermes-env-')));
  try {
    const source = path.join(dir, 'source-checkout');
    const { wrapper } = await hermesSourceFixture(source, { projectEnv: true });
    const workDir = path.join(dir, 'workspace');
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [launcher, 'hermes', '--work-dir', workDir, '--executable', wrapper], {
        env: { PATH: path.dirname(process.execPath), HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', part => { stdout += part; });
      child.stderr.on('data', part => { stderr += part; });
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /source checkout has a project \.env/);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes('do-not-print'), false);
    assert.equal(await readdir(dir).then(entries => entries.includes('workspace')), false, 'refusal occurs before profile creation');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('launcher accepts a clean Hermes source checkout and keeps its HERMES_HOME isolated', { skip: process.platform === 'win32' }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'berserk-hermes-clean-')));
  try {
    const source = path.join(dir, 'source-checkout');
    const { wrapper } = await hermesSourceFixture(source);
    const workDir = path.join(dir, 'workspace');
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [launcher, 'hermes', '--work-dir', workDir, '--port', '12345', '--executable', wrapper], {
        env: { PATH: path.dirname(process.execPath), HOME: dir, HERMES_API_KEY: 'SYNTHETIC_NOT_INHERITED' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', part => { stderr += part; });
      child.stdout.resume();
      child.once('close', code => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const observed = JSON.parse(await readFile(path.join(workDir, 'observed.json'), 'utf8'));
    assert.equal(observed.cwd, workDir);
    assert.equal(observed.env.HERMES_API_KEY, undefined);
    assert.notEqual(observed.env.HERMES_HOME, dir);
    assert.equal(observed.env.HERMES_HOME.startsWith(path.join(workDir, '.berserk-client-profiles')), true);
    assert.deepEqual(observed.args, ['chat', '--provider', 'custom', '--model', 'muse-web', '--source', 'tool']);
    const profiles = await readdir(path.join(workDir, '.berserk-client-profiles'));
    const config = await readFile(path.join(workDir, '.berserk-client-profiles', profiles[0], 'hermes', 'config.yaml'), 'utf8');
    assert.match(config, /base_url: "http:\/\/127\.0\.0\.1:12345\/v1"/);
    assert.match(config, /api_key: "muse-local"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
