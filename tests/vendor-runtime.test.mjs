import assert from 'node:assert/strict';
import test from 'node:test';
import { createNoiseRuntime, NoiseRuntimeError, NOISE_CHANNEL_MODULE_ID } from '../src/muse/vendor-runtime.mjs';

const manifest = {
  schema: 1,
  origin: 'https://muse.ai',
  assetsDirValidated: '/private/test-cache/assets',
  assets: Object.assign(Object.create(null), { 'fixture.js': 'a'.repeat(64) }),
  dynamicChunks: Object.create(null),
};

function response(body = {}, status = 200) {
  return { status, async json() { return body; } };
}

const validNoiseUrl = 'wss://hatch.metaaivm.com/v1/noise?vm_id=test-vm&auth_token=fake-auth&notary_token=fake-notary&app_id=hatch-web&request_id=fake-request&atod_token=fake-atod';

test('requires prepared vendor manifest; no default working-tree asset path', async () => {
  await assert.rejects(createNoiseRuntime(), error => error instanceof NoiseRuntimeError && error.code === 'needs_vendor_assets');
});

test('allows only exact Muse methods and paths and keeps WebSocket constants', async () => {
  const seen = [];
  const sockets = [];
  let websocketStatics;
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.handlers = new Map();
      sockets.push(this);
    }
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    close() { this.readyState = FakeWebSocket.CLOSED; this.handlers.get('close')?.(); }
  }
  const loaderFactory = async ({ fetchImpl, WebSocketImpl }) => ({
    async close() {},
    getModule(id) {
      if (id === NOISE_CHANNEL_MODULE_ID) return { Channel: class {} };
      if (id === 499475) return {
        async openNoiseConnection(url, options) {
          await fetchImpl('/api/hatch/token', { method: 'POST' });
          await fetchImpl('/api/hatch/noise-notary-token', { method: 'POST' });
          websocketStatics = [WebSocketImpl.CONNECTING, WebSocketImpl.OPEN, WebSocketImpl.CLOSING, WebSocketImpl.CLOSED];
          const socket = new WebSocketImpl(validNoiseUrl);
          assert.equal(url, 'wss://hatch.metaaivm.com/');
          return { ws: socket, optionsSignal: options.signal };
        },
      };
      throw Object.assign(new Error('missing module'), { code: 'public_module_missing' });
    },
  });
  const runtime = await createNoiseRuntime({
    assetsDirValidatedManifest: manifest,
    loaderFactory,
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async (url, init) => { seen.push({ url, method: init.method, redirect: init.redirect }); return response(); },
  });
  try {
    const connection = await runtime.open('wss://hatch.metaaivm.com/', { vmName: 'test-vm' });
    assert.equal(new URL(connection.ws.url).origin, 'wss://hatch.metaaivm.com');
    assert.equal(new URL(connection.ws.url).pathname, '/v1/noise');
    assert.deepEqual(websocketStatics, [0, 1, 2, 3]);
    assert.deepEqual(seen.map(item => [new URL(item.url).origin, new URL(item.url).pathname, item.method]), [
      ['https://muse.ai', '/api/hatch/token', 'POST'],
      ['https://muse.ai', '/api/hatch/noise-notary-token', 'POST'],
    ]);
    assert.ok(seen.every(item => item.redirect === 'manual'));
    await assert.rejects(runtime.open('wss://metaaivm.com/'), error => error instanceof NoiseRuntimeError && error.code === 'noise_runtime_failed');
  } finally {
    await runtime.close();
  }
  assert.equal(sockets[0].readyState, FakeWebSocket.CLOSED);
});

test('native WebSocket accepts only the observed Hatch Noise endpoint and credential query schema', async () => {
  let socketCount = 0;
  const urls = [
    'wss://evil.example/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web&request_id=req',
    'wss://test.metaaivm.com/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web&request_id=req',
    'ws://hatch.metaaivm.com/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web&request_id=req',
    'wss://hatch.metaaivm.com:444/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web&request_id=req',
    'wss://hatch.metaaivm.com/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web&request_id=req&extra=1',
    'wss://hatch.metaaivm.com/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web',
    'wss://hatch.metaaivm.com/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web&request_id=req&request_id=duplicate',
    'wss://user@hatch.metaaivm.com/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web&request_id=req',
    'wss://hatch.metaaivm.com/v1/noise?vm_id=x&auth_token=canary-secret&app_id=hatch-web&request_id=req#fragment',
    validNoiseUrl,
  ];
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { socketCount += 1; this.url = url; this.readyState = 1; }
    addEventListener(name, callback) { if (name === 'close') this.onclose = callback; }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const runtime = await createNoiseRuntime({
    assetsDirValidatedManifest: manifest, WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => response(),
    loaderFactory: async ({ WebSocketImpl }) => ({
      close() {},
      getModule(id) {
        if (id === 499475) return { openNoiseConnection: async (_gateway, { vmName }) => ({
          ws: new WebSocketImpl(urls[vmName]),
        }) };
        throw Error();
      },
    }),
  });
  try {
    await assert.rejects(runtime.open('wss://hatch.metaaivm.com/', { vmName: '0' }), error => {
      assert.equal(error.code, 'noise_runtime_failed');
      assert.equal(error.message.includes('canary-secret'), false);
      return true;
    });
    for (let index = 1; index < urls.length - 1; index += 1) {
      await assert.rejects(runtime.open('wss://hatch.metaaivm.com/', { vmName: String(index) }), error => {
        assert.equal(error.code, 'noise_runtime_failed');
        assert.equal(error.message.includes('canary-secret'), false);
        return true;
      });
    }
    assert.equal(socketCount, 0);
    const accepted = await runtime.open('wss://hatch.metaaivm.com/', { vmName: String(urls.length - 1) });
    assert.equal(socketCount, 1);
    assert.equal(new URL(accepted.ws.url).origin, 'wss://hatch.metaaivm.com');
  } finally { await runtime.close(); }
});

test('allowlist rejects alternate origin, query, method, and path without forwarding them', async () => {
  const sent = [];
  let wrappedFetch;
  const loaderFactory = async options => {
    wrappedFetch = options.fetchImpl;
    return {
      close() {},
      getModule(id) { if (id === 499475) return { openNoiseConnection: async () => ({}) }; throw Error(); },
    };
  };
  const runtime = await createNoiseRuntime({ assetsDirValidatedManifest: manifest, loaderFactory, fetchImpl: async (...args) => { sent.push(args); return response(); }, WebSocketImpl: class {} });
  try {
    for (const [url, method] of [
      ['/api/hatch/token', 'POST'],
      ['/api/hatch/noise-notary-token', 'POST'],
      ['/api/session', 'GET'],
      ['/api/auth/check', 'POST'],
    ]) await wrappedFetch(url, { method });
    for (const [url, method] of [
      ['https://evil.example/api/hatch/token', 'POST'],
      ['/api/hatch/token?x=1', 'POST'],
      ['/api/session', 'POST'],
      ['/api/not-allowed', 'GET'],
    ]) await assert.rejects(wrappedFetch(url, { method }), error => error instanceof NoiseRuntimeError && error.code === 'noise_runtime_failed');
    assert.deepEqual(sent.map(([url, init]) => [new URL(url).pathname, init.method]), [
      ['/api/hatch/token', 'POST'],
      ['/api/hatch/noise-notary-token', 'POST'],
      ['/api/session', 'GET'],
      ['/api/auth/check', 'POST'],
    ]);
  } finally { await runtime.close(); }
});

test('abort propagates a safe code and close rejects later use', async () => {
  const controller = new AbortController();
  const loaderFactory = async () => ({
    close() {},
    getModule(id) { if (id === 499475) return { openNoiseConnection: async (_url, { signal }) => new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('stop'), { name: 'AbortError' }));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }) }; throw Error(); },
  });
  const runtime = await createNoiseRuntime({ assetsDirValidatedManifest: manifest, loaderFactory, fetchImpl: async () => response(), WebSocketImpl: class {} });
  const pending = runtime.open('wss://test.metaaivm.com/', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error instanceof NoiseRuntimeError && error.code === 'runtime_aborted');
  await runtime.close();
  assert.throws(() => runtime.getModule(499475), error => error.code === 'runtime_closed');
});

test('fails closed when the loader factory cannot validate the prepared cache', async () => {
  await assert.rejects(createNoiseRuntime({ assetsDirValidatedManifest: manifest, loaderFactory: async () => { throw Error('private detail'); } }), error => {
    assert.equal(error.code, 'needs_vendor_assets');
    assert.equal(error.message, 'Reviewed public vendor chunks are unavailable');
    return true;
  });
});
