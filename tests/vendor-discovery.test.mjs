import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createVendorResolver, discoverVendorLock } from '../src/muse/vendor-discovery.mjs';

const initialSource = '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([null,11,(e,t,r)=>{e.i(15);e.s(["openNoiseConnection",0,function openNoiseConnection(){}],11)},12,(e,t,r)=>{e.i(15);e.s(["NoiseChannel",0,function NoiseChannel(){}],12)},13,(e,t,r)=>{e.s(["resolveHttpRouteRequest",0,function resolveHttpRouteRequest(){}],13)},14,(e,t,r)=>{e.s(["isGatewayRequestError",0,function isGatewayRequestError(){}],14)},15,e=>{e.v(t=>Promise.all(["static/chunks/dynamic.js"].map(t=>e.l(t))).then(()=>t(16)))}]);';
const dynamicSource = '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([null,16,(e,t,r)=>{e.s(["asyncFeature",0,function asyncFeature(){}],16)}]);';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'muse-vendor-discovery-')));
  const initialUrl = 'https://muse.ai/_next/static/chunks/initial.js?dpl=dpl_currentBuild123';
  const dynamicUrl = 'https://muse.ai/_next/static/chunks/dynamic.js';
  const bodies = new Map([[initialUrl, Buffer.from(initialSource)], [dynamicUrl, Buffer.from(dynamicSource)]]);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const bytes = bodies.get(url);
    return bytes ? new Response(bytes, { status: 200 }) : new Response('', { status: 404 });
  };
  const html = `<script src="${initialUrl}"></script><script src="https://evil.example/_next/static/chunks/nope.js"></script>`;
  const oldBytes = Buffer.from('obsolete');
  const oldLock = {
    schema: 1, origin: 'https://muse.ai',
    assets: [{ fileName: 'initial.js', url: 'https://muse.ai/_next/static/chunks/initial.js?dpl=dpl_oldBuild123', sha256: hash(oldBytes), bytes: oldBytes.length }],
    dynamicChunks: {},
  };
  return { root, html, oldLock, bodies, requests, fetchImpl, dispose: () => rm(root, { recursive: true, force: true }) };
}

test('discovers only shell scripts and reachable async chunks with an exact public fetch policy', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const lock = await discoverVendorLock({ shellHtml: f.html, fetchImpl: f.fetchImpl });
  assert.deepEqual(lock.assets.map(asset => asset.fileName), ['dynamic.js', 'initial.js']);
  assert.deepEqual(lock.dynamicChunks, {
    'static/chunks/dynamic.js': { asset: 'dynamic.js', moduleIds: [16] },
  });
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(({ init }) => init.method === 'GET' && init.redirect === 'manual' && init.credentials === 'omit' && init.referrerPolicy === 'no-referrer'));
  assert.ok(f.requests.every(({ url }) => new URL(url).origin === 'https://muse.ai'));
});

test('repairs a stale lock once, validates semantic exports before caching, and reuses the prepared generation', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const staleBytes = Buffer.from('obsolete');
  const staleLock = {
    schema: 1, origin: 'https://muse.ai',
    assets: [{ fileName: 'initial.js', url: 'https://muse.ai/_next/static/chunks/initial.js?dpl=dpl_currentBuild123', sha256: hash(staleBytes), bytes: staleBytes.length }],
    dynamicChunks: {},
  };
  let staleOnce = true;
  const staleFetch = async (url, init) => {
    const parsed = new URL(url);
    if (staleOnce && parsed.pathname.endsWith('/initial.js') && parsed.searchParams.get('dpl') === 'dpl_currentBuild123') {
      staleOnce = false;
      f.requests.push({ url, init });
      return new Response('', { status: 404 });
    }
    return f.fetchImpl(url, init);
  };
  let shellCalls = 0;
  const resolve = createVendorResolver({ cacheDir: path.join(f.root, 'cache'), lock: staleLock });
  const getShell = async () => { shellCalls++; return f.html; };
  const first = await resolve({ getShell, fetchImpl: staleFetch });
  assert.equal(Object.keys(first.assets).length, 2);
  assert.deepEqual(first.dynamicChunks['static/chunks/dynamic.js'].moduleIds, [16]);
  const requestsAfterRepair = f.requests.length;
  const second = await resolve({ getShell, fetchImpl: staleFetch });
  assert.equal(second, first);
  assert.equal(shellCalls, 1);
  assert.equal(f.requests.length, requestsAfterRepair);
  assert.equal(f.requests.filter(request => new URL(request.url).searchParams.get('dpl') === 'dpl_currentBuild123' && new URL(request.url).pathname.endsWith('/initial.js')).length, 2);
});

test('reuses a verified discovered generation after restart without public network access', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const cacheDir = path.join(f.root, 'cache');
  const firstResolver = createVendorResolver({ cacheDir, lock: f.oldLock });
  const first = await firstResolver({ getShell: async () => f.html, fetchImpl: f.fetchImpl });
  const requestCount = f.requests.length;

  const restartedResolver = createVendorResolver({ cacheDir, lock: f.oldLock });
  let shellCalls = 0;
  const restarted = await restartedResolver({
    getShell: async () => { shellCalls++; return f.html; },
    fetchImpl: async () => { throw new Error('cached generation should not need the network'); },
  });
  assert.equal(restarted.assetsDirValidated, first.assetsDirValidated);
  assert.deepEqual(restarted.assets, first.assets);
  assert.equal(shellCalls, 1);
  assert.equal(f.requests.length, requestCount);
});

test('refreshes a fully cached lock when the shell adds a public chunk path at the ten-minute check', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const cacheDir = path.join(f.root, 'cache');
  let now = 1_000;
  let shellCalls = 0;
  let shell = f.html;
  const resolve = createVendorResolver({ cacheDir, lock: f.oldLock, now: () => now });
  const getShell = async () => { shellCalls++; return shell; };
  const first = await resolve({ getShell, fetchImpl: f.fetchImpl });
  assert.equal(shellCalls, 1);

  now += 10 * 60 * 1000;
  const updatedUrl = 'https://muse.ai/_next/static/chunks/initial-v2.js?dpl=dpl_nextBuild123';
  f.bodies.set(updatedUrl, Buffer.from(initialSource));
  shell = `<script src="${updatedUrl}"></script>`;
  const second = await resolve({ getShell, fetchImpl: f.fetchImpl });
  assert.equal(shellCalls, 2);
  assert.notEqual(second.assetsDirValidated, first.assetsDirValidated);
  assert.ok(Object.hasOwn(second.assets, 'initial-v2.js'));
  assert.ok(f.requests.some(request => request.url === updatedUrl));
});

test('refreshes when the shell keeps a chunk pathname but changes its deployment query', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const cacheDir = path.join(f.root, 'cache');
  let now = 1_000;
  let shellCalls = 0;
  const oldUrl = 'https://muse.ai/_next/static/chunks/initial.js?dpl=dpl_oldBuild123';
  const oldBytes = Buffer.from(initialSource);
  f.bodies.set(oldUrl, oldBytes);
  const oldLock = {
    schema: 1,
    origin: 'https://muse.ai',
    assets: [{ fileName: 'initial.js', url: oldUrl, sha256: hash(oldBytes), bytes: oldBytes.length }],
    dynamicChunks: {},
  };
  const resolve = createVendorResolver({ cacheDir, lock: oldLock, now: () => now });
  const first = await resolve({ getShell: async () => { shellCalls++; return `<script src="${oldUrl}"></script>`; }, fetchImpl: f.fetchImpl });
  assert.equal(shellCalls, 1);
  assert.ok(Object.hasOwn(first.assets, 'initial.js'));

  now += 10 * 60 * 1000;
  const nextUrl = 'https://muse.ai/_next/static/chunks/initial.js?dpl=dpl_currentBuild123';
  const second = await resolve({ getShell: async () => { shellCalls++; return `<script src="${nextUrl}"></script>`; }, fetchImpl: f.fetchImpl });
  assert.equal(shellCalls, 2);
  assert.notEqual(second.assetsDirValidated, first.assetsDirValidated);
  assert.ok(f.requests.some(request => request.url === nextUrl));
});

test('same-path hash or integrity failures do not trigger build refresh', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const badBytes = Buffer.from('same-path-but-different-content');
  const integrityLock = {
    schema: 1,
    origin: 'https://muse.ai',
    assets: [{
      fileName: 'initial.js',
      url: 'https://muse.ai/_next/static/chunks/initial.js?dpl=dpl_currentBuild123',
      sha256: hash(badBytes),
      bytes: Buffer.byteLength(initialSource),
    }],
    dynamicChunks: {},
  };
  let shellCalls = 0;
  const resolve = createVendorResolver({ cacheDir: path.join(f.root, 'cache'), lock: integrityLock });
  await assert.rejects(resolve({ getShell: async () => { shellCalls++; return f.html; }, fetchImpl: f.fetchImpl }), { code: 'vendor_asset_integrity_mismatch' });
  assert.equal(shellCalls, 1);
  assert.equal(f.requests.length, 1);
});

test('owner cancellation drains shared preparation while an active joiner succeeds', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const started = deferred();
  const shellGate = deferred();
  const ownerController = new AbortController();
  let ownerSettled = false;
  let sharedSignal;
  const resolve = createVendorResolver({ cacheDir: path.join(f.root, 'cache'), lock: f.oldLock });
  const owner = resolve({
    signal: ownerController.signal,
    getShell: async ({ signal }) => { sharedSignal = signal; started.resolve(); return shellGate.promise; },
    fetchImpl: f.fetchImpl,
  }).finally(() => { ownerSettled = true; });
  await started.promise;
  assert.notEqual(sharedSignal, ownerController.signal);
  const joiner = resolve({ getShell: async () => { throw new Error('joiner callback should not own shared setup'); }, fetchImpl: f.fetchImpl });
  ownerController.abort();
  await Promise.resolve();
  assert.equal(sharedSignal.aborted, false);
  assert.equal(ownerSettled, false);
  shellGate.resolve(f.html);
  const prepared = await joiner;
  assert.ok(Object.hasOwn(prepared.assets, 'initial.js'));
  await assert.rejects(owner, { code: 'vendor_download_aborted' });
});

test('a canceled joiner returns promptly without canceling the owner', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const started = deferred();
  const shellGate = deferred();
  const joinerController = new AbortController();
  let sharedSignal;
  const resolve = createVendorResolver({ cacheDir: path.join(f.root, 'cache'), lock: f.oldLock });
  const owner = resolve({
    getShell: async ({ signal }) => { sharedSignal = signal; started.resolve(); return shellGate.promise; },
    fetchImpl: f.fetchImpl,
  });
  await started.promise;
  const joiner = resolve({ signal: joinerController.signal, fetchImpl: f.fetchImpl });
  joinerController.abort();
  await assert.rejects(joiner, { code: 'vendor_download_aborted' });
  assert.equal(sharedSignal.aborted, false);
  shellGate.resolve(f.html);
  const prepared = await owner;
  assert.ok(Object.hasOwn(prepared.assets, 'initial.js'));
});

test('aborts shared preparation after every waiter cancels', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const started = deferred();
  const ownerController = new AbortController();
  const joinerController = new AbortController();
  let sharedSignal;
  let sharedAborted = false;
  const resolve = createVendorResolver({ cacheDir: path.join(f.root, 'cache'), lock: f.oldLock });
  const owner = resolve({
    signal: ownerController.signal,
    getShell: async ({ signal }) => {
      sharedSignal = signal;
      started.resolve();
      return new Promise((_, reject) => signal.addEventListener('abort', () => { sharedAborted = true; reject(new Error('shared work aborted')); }, { once: true }));
    },
    fetchImpl: f.fetchImpl,
  });
  await started.promise;
  const joiner = resolve({ signal: joinerController.signal, fetchImpl: f.fetchImpl });
  ownerController.abort();
  assert.equal(sharedSignal.aborted, false);
  joinerController.abort();
  await assert.rejects(joiner, { code: 'vendor_download_aborted' });
  assert.equal(sharedSignal.aborted, true);
  assert.equal(sharedAborted, true);
  await assert.rejects(owner, { code: 'vendor_download_aborted' });
});

test('rejects a cache path reached through a symlinked ancestor before network access', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const link = path.join(f.root, 'cache-link');
  await symlink(f.root, link);
  const resolve = createVendorResolver({ cacheDir: path.join(link, 'cache'), lock: f.oldLock });
  await assert.rejects(resolve({ fetchImpl: f.fetchImpl }), { code: 'unsafe_cache_directory' });
  assert.equal(f.requests.length, 0);
});

test('aborts before discovery and never falls back after a discovered asset is stale', async t => {
  const f = await fixture();
  t.after(f.dispose);
  const controller = new AbortController();
  controller.abort();
  let shellCalls = 0;
  await assert.rejects(discoverVendorLock({ getShell: async () => { shellCalls++; return f.html; }, fetchImpl: f.fetchImpl, signal: controller.signal }), { code: 'vendor_download_aborted' });
  assert.equal(shellCalls, 0);

  const staleFetch = async url => new URL(url).pathname.endsWith('/initial.js') ? new Response('', { status: 410 }) : new Response('', { status: 404 });
  await assert.rejects(discoverVendorLock({ shellHtml: f.html, fetchImpl: staleFetch }), { code: 'vendor_asset_stale' });
});
