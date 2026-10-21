import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPublicChunkLoader } from '../src/muse/vendor-loader.mjs';

const hash = source => createHash('sha256').update(source).digest('hex');
const fixtureSource = '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([null,123,(e,t,r)=>{e.s(["answer",0,42])}]);';

async function fixture(source = fixtureSource) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'muse-loader-test-')));
  const assetsDirValidated = path.join(root, 'assets');
  await mkdir(assetsDirValidated, { mode: 0o700 });
  await chmod(assetsDirValidated, 0o700);
  await writeFile(path.join(assetsDirValidated, 'fixture.js'), source, { mode: 0o600 });
  const assets = Object.create(null);
  assets['fixture.js'] = hash(source);
  const dynamicChunks = Object.create(null);
  dynamicChunks['static/chunks/fixture.js'] = { asset: 'fixture.js', moduleIds: [123] };
  return {
    root,
    manifest: { schema: 1, origin: 'https://muse.ai', assetsDirValidated, assets, dynamicChunks },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test('executes only the declared hash-pinned chunk and preserves module exports', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await writeFile(path.join(f.manifest.assetsDirValidated, 'undeclared.js'), 'throw new Error("must not execute")', { mode: 0o600 });
  const loader = await createPublicChunkLoader({ assetsDirValidatedManifest: f.manifest, approvedDynamicChunks: f.manifest.dynamicChunks });
  t.after(loader.close);
  assert.equal(loader.getModule(123).answer, 42);
  assert.equal(loader.getModuleAsset(123), 'fixture.js');
  assert.deepEqual(loader.getAvailableModuleIds(), [123]);
  assert.deepEqual(loader.assets, [{ name: 'fixture.js', sha256: hash(fixtureSource), bytes: Buffer.byteLength(fixtureSource) }]);
  assert.equal(loader.getSandboxGlobals().process, 'undefined');
  assert.equal(loader.getSandboxGlobals().require, 'undefined');
});

test('requires canonical private cache and rejects directory symlinks', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const alias = path.join(f.root, 'alias');
  await symlink(f.manifest.assetsDirValidated, alias);
  const manifest = { ...f.manifest, assetsDirValidated: alias };
  await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: manifest, approvedDynamicChunks: f.manifest.dynamicChunks }), { code: 'needs_vendor_assets' });
  await chmod(f.manifest.assetsDirValidated, 0o755);
  await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: f.manifest, approvedDynamicChunks: f.manifest.dynamicChunks }), { code: 'needs_vendor_assets' });
  assert.equal((await lstat(f.manifest.assetsDirValidated)).isDirectory(), true);
});

test('hash mismatch, missing files, and symlink assets fail closed', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const bad = { ...f.manifest, assets: Object.assign(Object.create(null), f.manifest.assets, { 'fixture.js': '0'.repeat(64) }) };
  await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: bad, approvedDynamicChunks: bad.dynamicChunks }), { code: 'needs_vendor_assets' });
  const missing = { ...f.manifest, assetsDirValidated: path.join(f.root, 'missing') };
  await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: missing, approvedDynamicChunks: missing.dynamicChunks }), { code: 'needs_vendor_assets' });
  await rm(path.join(f.manifest.assetsDirValidated, 'fixture.js'));
  await symlink(path.join(f.root, 'absent.js'), path.join(f.manifest.assetsDirValidated, 'fixture.js'));
  await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: f.manifest, approvedDynamicChunks: f.manifest.dynamicChunks }), { code: 'needs_vendor_assets' });
});

test('rejects hard-linked and broadly readable source assets', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await link(path.join(f.manifest.assetsDirValidated, 'fixture.js'), path.join(f.root, 'outside.js'));
  await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: f.manifest, approvedDynamicChunks: f.manifest.dynamicChunks }), { code: 'needs_vendor_assets' });
  await rm(path.join(f.root, 'outside.js'));
  await chmod(path.join(f.manifest.assetsDirValidated, 'fixture.js'), 0o644);
  await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: f.manifest, approvedDynamicChunks: f.manifest.dynamicChunks }), { code: 'needs_vendor_assets' });
});

test('rejects chunk registration exceptions instead of skipping malformed code', async t => {
  const badSource = '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([);';
  const f = await fixture(badSource);
  t.after(f.dispose);
  await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: f.manifest, approvedDynamicChunks: f.manifest.dynamicChunks }), { code: 'needs_vendor_assets' });
});

test('manifest must name a private absolute validated cache and a hash allowlist', async t => {
  const f = await fixture();
  t.after(f.dispose);
  for (const manifest of [
    { ...f.manifest, assetsDirValidated: 'relative' },
    { ...f.manifest, assets: { 'fixture.js': hash(fixtureSource) } },
    { ...f.manifest, assets: Object.assign(Object.create(null), { '../outside.js': hash(fixtureSource) }) },
  ]) {
    await assert.rejects(createPublicChunkLoader({ assetsDirValidatedManifest: manifest, approvedDynamicChunks: f.manifest.dynamicChunks }), { code: 'needs_vendor_assets' });
  }
});
