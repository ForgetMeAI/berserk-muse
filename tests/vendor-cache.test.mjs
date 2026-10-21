import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, link, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareVendor } from '../src/muse/vendor-cache.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const makeManifest = (entries, dynamicChunks = {}) => ({
  schema: 1,
  origin: 'https://muse.ai',
  assets: entries.map(([fileName, source, query = '']) => ({
    fileName,
    url: `https://muse.ai/_next/static/chunks/${fileName}${query}`,
    sha256: digest(source),
    bytes: Buffer.byteLength(source),
  })),
  dynamicChunks,
});

async function withCache(run) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'muse-vendor-test-')));
  try { await run(path.join(root, 'cache')); } finally { await rm(root, { recursive: true, force: true }); }
}

function response(value, status = 200) {
  return new Response(Buffer.from(value), { status });
}

test('downloads only locked URLs with no credentials and bounds concurrency', async () => {
  await withCache(async cacheDir => {
    const bodies = [['one.js', 'one'], ['two.js', 'two'], ['three.js', 'three'], ['four.js', 'four']];
    const manifest = makeManifest(bodies, { 'static/chunks/one.js': { asset: 'one.js', moduleIds: [42] } });
    const byUrl = new Map(manifest.assets.map((asset, index) => [asset.url, bodies[index][1]]));
    let active = 0;
    let maximum = 0;
    let count = 0;
    const calls = [];
    const output = await prepareVendor({
      cacheDir,
      manifest,
      concurrency: 2,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        count++;
        return response(byUrl.get(url));
      },
    });
    assert.equal(count, 4);
    assert.equal(maximum, 2);
    assert.equal(calls.every(call => call.options.method === 'GET' && call.options.redirect === 'manual' && call.options.credentials === 'omit' && call.options.referrerPolicy === 'no-referrer'), true);
    assert.equal(calls.every(call => call.options.headers === undefined), true);
    assert.equal(Object.hasOwn(output.assets, 'one.js'), true);
    assert.equal(output.dynamicChunks['static/chunks/one.js'].moduleIds[0], 42);
    assert.equal(path.isAbsolute(output.assetsDirValidated), true);
    assert.equal((await lstat(output.assetsDirValidated)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(output.assetsDirValidated, 'one.js'))).mode & 0o777, 0o600);
  });
});

test('valid cache is reused without making network requests', async () => {
  await withCache(async cacheDir => {
    const manifest = makeManifest([['one.js', 'already cached']]);
    const first = await prepareVendor({ cacheDir, manifest, fetchImpl: async () => response('already cached') });
    const second = await prepareVendor({ cacheDir, manifest, fetchImpl: async () => { throw Error('unexpected fetch'); } });
    assert.deepEqual(second.assets, first.assets);
  });
});

test('local cache aliases may differ from the public chunk basename', async () => {
  await withCache(async cacheDir => {
    const manifest = makeManifest([['001-contenthash.js', 'source']], { 'static/chunks/vendor-entry.js': { asset: '001-contenthash.js', moduleIds: [9] } });
    const output = await prepareVendor({ cacheDir, manifest, fetchImpl: async () => response('source') });
    assert.equal(output.assets['001-contenthash.js'], digest('source'));
  });
});

test('integrity mismatch fails closed and leaves no cached asset', async () => {
  await withCache(async cacheDir => {
    const manifest = makeManifest([['one.js', 'expected']]);
    await assert.rejects(prepareVendor({ cacheDir, manifest, fetchImpl: async () => response('wrong') }), { code: 'vendor_asset_integrity_mismatch' });
    await assert.rejects(readFile(path.join(cacheDir, 'assets', 'one.js')), { code: 'ENOENT' });
  });
});

test('corrupt cache fails closed by default; explicit repair downloads verified bytes', async () => {
  await withCache(async cacheDir => {
    const manifest = makeManifest([['one.js', 'expected']]);
    await mkdir(path.join(cacheDir, 'assets'), { recursive: true });
    await writeFile(path.join(cacheDir, 'assets', 'one.js'), 'wr0ng!!!', { mode: 0o600 });
    await assert.rejects(prepareVendor({ cacheDir, manifest, fetchImpl: async () => response('expected') }), { code: 'corrupt_cache_file' });
    let count = 0;
    await prepareVendor({ cacheDir, manifest, repairCorrupt: true, fetchImpl: async () => { count++; return response('expected'); } });
    assert.equal(count, 1);
    assert.equal(await readFile(path.join(cacheDir, 'assets', 'one.js'), 'utf8'), 'expected');
  });
});

test('rejects URL substitution, unsafe filenames and symlink cache entries', async () => {
  await withCache(async cacheDir => {
    const manifest = makeManifest([['one.js', 'one']]);
    const outside = { ...manifest, assets: [{ ...manifest.assets[0], url: 'https://evil.example/_next/static/chunks/one.js' }] };
    await assert.rejects(prepareVendor({ cacheDir, manifest: outside }), { code: 'invalid_manifest_url' });
    const traversal = { ...manifest, assets: [{ ...manifest.assets[0], fileName: '../one.js' }] };
    await assert.rejects(prepareVendor({ cacheDir, manifest: traversal }), { code: 'invalid_manifest_asset' });
    const outsideFile = path.join(path.dirname(cacheDir), 'outside.js');
    await writeFile(outsideFile, 'one');
    await mkdir(path.join(cacheDir, 'assets'), { recursive: true });
    await symlink(outsideFile, path.join(cacheDir, 'assets', 'one.js'));
    await assert.rejects(prepareVendor({ cacheDir, manifest }), { code: 'unsafe_cache_file' });
  });
});

test('rejects hard-linked cache entries', async () => {
  await withCache(async cacheDir => {
    const manifest = makeManifest([['one.js', 'one']]);
    await mkdir(path.join(cacheDir, 'assets'), { recursive: true });
    const cached = path.join(cacheDir, 'assets', 'one.js');
    await writeFile(cached, 'one');
    await link(cached, path.join(path.dirname(cacheDir), 'outside.js'));
    await assert.rejects(prepareVendor({ cacheDir, manifest }), { code: 'unsafe_cache_file' });
  });
});

test('external abort is propagated without retry', { timeout: 5000 }, async () => {
  await withCache(async cacheDir => {
    const manifest = makeManifest([['one.js', 'one']]);
    const controller = new AbortController();
    const calls = [];
    let notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    const pending = prepareVendor({
      cacheDir, manifest, signal: controller.signal,
      fetchImpl: async (_url, options) => {
        calls.push(options);
        notifyStarted();
        return await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      },
    });
    await Promise.race([started, pending]);
    controller.abort();
    await assert.rejects(pending, { code: 'vendor_download_aborted' });
    assert.equal(calls.length, 1);
  });
});

test('manifest resource limits and worker limits are enforced before fetch', async () => {
  const manifest = makeManifest([['one.js', 'one']]);
  await assert.rejects(prepareVendor({ cacheDir: '/tmp/unused', manifest, concurrency: 4 }), /concurrency/);
  const tooMany = { ...manifest, assets: Array.from({ length: 13 }, (_, i) => ({ fileName: `${i}.js`, url: `https://muse.ai/_next/static/chunks/${i}.js`, sha256: 'a'.repeat(64), bytes: 2 * 1024 * 1024 })) };
  await assert.rejects(prepareVendor({ cacheDir: '/tmp/unused', manifest: tooMany }), { code: 'manifest_too_large' });
});
