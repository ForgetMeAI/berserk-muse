import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkRuntime, NetworkCleanupError } from '../src/net/runtime.mjs';

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, options = {}) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.OPEN;
    this.closeCalls = 0;
  }

  close() {
    this.closeCalls++;
    this.readyState = FakeWebSocket.CLOSING;
  }

  finishClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

test('wraps injected fetch with the runtime dispatcher while preserving request options', async () => {
  const dispatcher = { close: async () => {} };
  const callerDispatcher = { marker: 'caller' };
  let received;
  const fetchImpl = async (input, options) => {
    received = { input, options };
    return { ok: true };
  };
  const runtime = createNetworkRuntime({ fetchImpl, WebSocketImpl: FakeWebSocket, dispatcher });
  const headers = new Headers({ cookie: 'session=opaque' });
  const response = await runtime.fetchImpl('https://example.invalid/api', {
    method: 'POST', headers, body: 'payload', dispatcher: callerDispatcher,
  });

  assert.deepEqual(response, { ok: true });
  assert.equal(received.input, 'https://example.invalid/api');
  assert.equal(received.options.method, 'POST');
  assert.equal(received.options.headers, headers);
  assert.equal(received.options.body, 'payload');
  assert.equal(received.options.dispatcher, dispatcher);
  await runtime.close();
});

test('uses EnvHttpProxyAgent by default for builtin fetch dispatch', async () => {
  let receivedDispatcher;
  const runtime = createNetworkRuntime({
    fetchImpl: async (_input, options) => { receivedDispatcher = options.dispatcher; return {}; },
    WebSocketImpl: FakeWebSocket,
  });
  await runtime.fetchImpl('http://localhost/health');
  assert.equal(receivedDispatcher?.constructor?.name, 'EnvHttpProxyAgent');
  await runtime.close();
});

test('wraps the injected WebSocket base with its dispatcher and preserves inherited statics', async () => {
  const dispatcherEvents = [];
  const dispatcher = { close: async () => { dispatcherEvents.push('closed'); } };
  const runtime = createNetworkRuntime({
    fetchImpl: async () => ({}), WebSocketImpl: FakeWebSocket, dispatcher,
  });
  const socket = new runtime.WebSocketImpl('wss://example.invalid/socket', 'chat');

  assert.ok(socket instanceof FakeWebSocket);
  assert.equal(runtime.WebSocketImpl.CONNECTING, FakeWebSocket.CONNECTING);
  assert.equal(runtime.WebSocketImpl.OPEN, FakeWebSocket.OPEN);
  assert.equal(Object.getPrototypeOf(runtime.WebSocketImpl), FakeWebSocket);
  assert.equal(socket.options.protocols[0], 'chat');
  assert.equal(socket.options.dispatcher, dispatcher);

  const closing = runtime.close();
  assert.equal(socket.closeCalls, 1);
  assert.deepEqual(dispatcherEvents, []);
  socket.finishClose();
  await closing;
  assert.deepEqual(dispatcherEvents, ['closed']);
});

test('turns socket close failures into a sanitized typed cleanup error and destroys dispatcher', async () => {
  const privateDetail = 'PRIVATE_SOCKET_DETAIL_91c2';
  let destroyed = 0;
  const dispatcher = {
    async close() {},
    async destroy() { destroyed++; },
  };
  class ThrowingWebSocket extends FakeWebSocket {
    close() { throw new Error(privateDetail); }
  }
  const runtime = createNetworkRuntime({
    fetchImpl: async () => ({}), WebSocketImpl: ThrowingWebSocket, dispatcher,
  });
  new runtime.WebSocketImpl('wss://example.invalid/socket');

  await assert.rejects(runtime.close(), error => {
    assert.ok(error instanceof NetworkCleanupError);
    assert.equal(error.code, 'network_cleanup_failed');
    assert.equal(error.message.includes(privateDetail), false);
    return true;
  });
  assert.equal(destroyed, 1);
});

test('times out socket cleanup, destroys the dispatcher, and reports only the typed error', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let destroyed = 0;
  const dispatcher = {
    async close() {},
    async destroy() { destroyed++; },
  };
  try {
    globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 5000 ? 1 : delay, ...args);
    const runtime = createNetworkRuntime({
      fetchImpl: async () => ({}), WebSocketImpl: FakeWebSocket, dispatcher,
    });
    new runtime.WebSocketImpl('wss://example.invalid/socket');
    await assert.rejects(runtime.close(), error => {
      assert.ok(error instanceof NetworkCleanupError);
      assert.equal(error.code, 'network_cleanup_failed');
      assert.equal(error.message, 'Network runtime cleanup failed.');
      return true;
    });
    assert.equal(destroyed, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
