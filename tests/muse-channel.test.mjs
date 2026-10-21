import test from 'node:test';
import assert from 'node:assert/strict';
import { MuseDelivery, MuseChannelError, MuseRpcClient } from '../src/muse/rpc.mjs';
import {
  GATEWAY_ERROR_MODULE_ID,
  HTTP_ROUTE_MODULE_ID,
  MuseNoiseChannel,
  NOISE_CHANNEL_MODULE_ID,
} from '../src/muse/channel.mjs';

const OPEN = 1;
const CLOSED = 3;
const SESSION_UUID = '00000000-0000-4000-8000-000000000001';
const OTHER_SESSION_UUID = '00000000-0000-4000-8000-000000000002';

class FakeWebSocket extends EventTarget {
  readyState = OPEN;
  closeCalls = 0;
  close() {
    this.closeCalls += 1;
    this.readyState = CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
  remoteClose() {
    this.readyState = CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  message(data) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
}

function makeHarness({ ack = null, onSend, prewrite = false, maxEvents, maxEventBytes } = {}) {
  const ws = new FakeWebSocket();
  const sent = [];
  let noiseOptions;
  let disposeCalls = 0;
  class FakeNoiseChannel {
    constructor(options) { noiseOptions = options; this.alive = true; }
    isAlive() { return this.alive; }
    dispose() { disposeCalls++; this.alive = false; }
    handleInboundBinary(bytes) { sent.push({ inbound: [...bytes] }); }
    async sendHttpRequest(method, resolved, options) {
      sent.push({ method, resolved, options });
      if (prewrite) {
        throw new FakeOfficialGatewayError({ kind: 'transport', deliveryState: 'not_sent' });
      }
      if (onSend) return onSend({ method, resolved, options, noiseOptions, sent });
      return method === 'chat.cancel' ? { cancelled: true } : (ack ?? { session_id: resolved.params.session_id });
    }
  }
  class FakeOfficialGatewayError extends Error {
    constructor({ kind = 'transport', deliveryState, httpStatus } = {}) {
      super('secret gateway response');
      this.kind = kind;
      this.deliveryState = deliveryState;
      this.httpStatus = httpStatus;
    }
  }
  const routeSpecs = {
    'chat.stream': { method: 'chat.stream', httpMethod: 'POST', path: '/chat/stream', noiseOnly: true, streamMode: 'subscription' },
    'chat.subscribe': { method: 'chat.subscribe', httpMethod: 'POST', path: '/chat/subscribe', noiseOnly: true, streamMode: 'subscription' },
    'chat.cancel': { method: 'chat.cancel', httpMethod: 'POST', path: '/chat/cancel', noiseOnly: true },
  };
  const runtime = {
    getModule(id) {
      if (id === NOISE_CHANNEL_MODULE_ID) return { NoiseChannel: FakeNoiseChannel };
      if (id === HTTP_ROUTE_MODULE_ID) return {
        resolveHttpRouteRequest(method, params) {
          const route = routeSpecs[method];
          return route ? { route, path: route.path, params: { ...params } } : null;
        },
      };
      if (id === GATEWAY_ERROR_MODULE_ID) return {
        isGatewayRequestError(error) { return error instanceof FakeOfficialGatewayError; },
      };
      throw new Error('unknown module');
    },
  };
  const channel = new MuseNoiseChannel({
    runtime,
    connection: { ws, transport: {} },
    nodeId: 'persisted-device-1',
    maxEvents,
    maxEventBytes,
  });
  return { channel, ws, sent, getNoiseOptions: () => noiseOptions, getDisposeCalls: () => disposeCalls, FakeOfficialGatewayError };
}

function event(sessionId, text = 'hi') {
  return { type: 'event', event: 'delta.text_append', session_id: sessionId,
    payload: { message_id: 'm-1', text } };
}

test('wraps official NoiseChannel, converts the RPC message to the public chat.stream body, and routes ArrayBuffer frames', async () => {
  const fake = makeHarness();
  const opened = await fake.channel.openStream({
    method: 'POST', path: '/chat/stream',
    body: { message: 'hello', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: ['delta_stream'] },
  });
  assert.deepEqual(opened.ack, { session_id: SESSION_UUID });
  const call = fake.sent.find((entry) => entry.method === 'chat.stream');
  assert.equal(call.resolved.route.method, 'chat.stream');
  assert.deepEqual(call.resolved.params, {
    items: [{ type: 'text', text: 'hello' }],
    node_id: 'persisted-device-1',
    session_id: SESSION_UUID,
    capabilities: ['delta_stream'],
  });
  const methods = fake.sent.filter((entry) => entry.method).map((entry) => entry.method);
  assert.deepEqual(methods, ['chat.stream', 'chat.subscribe']);
  const subscribe = fake.sent.find((entry) => entry.method === 'chat.subscribe');
  assert.deepEqual(subscribe.resolved.params, {
    session_id: SESSION_UUID,
    after_stream_seq: 0,
    after_chat_event_seq: 0,
    capabilities: ['delta_stream'],
  });
  fake.ws.message(Uint8Array.from([1, 2, 3]).buffer);
  assert.deepEqual(fake.sent.at(-1), { inbound: [1, 2, 3] });
  await fake.channel.close({ quarantine: true });
  assert.equal(fake.ws.closeCalls, 1);
});

test('an unexpected socket close after ACK fails the stream as unknown and quarantines without retry', async () => {
  let fake;
  fake = makeHarness({ onSend: async ({ method }) => {
    if (method === 'chat.cancel') return { cancelled: true };
    if (method === 'chat.stream') return { session_id: SESSION_UUID, message_id: 'user-1' };
    if (method === 'chat.subscribe') {
      setImmediate(() => fake.ws.remoteClose());
      return { session_id: SESSION_UUID };
    }
  } });
  const rpc = new MuseRpcClient({
    channel: fake.channel,
    sessionIdFactory: () => SESSION_UUID,
    pollIntervalMs: 5,
    timeoutMs: 500,
    cancelTimeoutMs: 25,
  });
  await assert.rejects(rpc.generate('bounded remote close'), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    assert.equal(error.safe?.quarantine, true);
    return true;
  });
  assert.deepEqual(fake.sent.filter((entry) => entry.method).map((entry) => entry.method), [
    'chat.stream', 'chat.subscribe',
  ]);
  assert.equal(rpc.quarantinedCount, 1);
  await fake.channel.close({ quarantine: true });
  assert.equal(fake.ws.closeCalls, 1);
  assert.equal(fake.getDisposeCalls(), 1);
});

test('reports unexpected post-ACK closure on the event stream as unknown', async () => {
  const fake = makeHarness();
  const opened = await fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'remote close', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } });
  const pending = opened.events.next();
  fake.ws.remoteClose();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof MuseChannelError);
    assert.equal(error.code, 'noise_socket_closed');
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    return true;
  });
  await fake.channel.close({ quarantine: true });
  assert.equal(fake.ws.closeCalls, 1);
  assert.equal(fake.getDisposeCalls(), 1);
});

test('an unexpected socket close before ACK aborts the pending stream with unknown delivery', async () => {
  let fake;
  fake = makeHarness({ onSend: ({ method, options }) => {
    if (method !== 'chat.stream') return { session_id: SESSION_UUID };
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private abort detail')), { once: true });
      setImmediate(() => fake.ws.remoteClose());
    });
  } });
  const opening = fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'pending', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } });
  await assert.rejects(opening, (error) => {
    assert.ok(error instanceof MuseChannelError);
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    assert.equal(error.code, 'request_outcome_unknown');
    assert.equal(error.message.includes('private abort detail'), false);
    return true;
  });
  assert.deepEqual(fake.sent.filter((entry) => entry.method).map((entry) => entry.method), ['chat.stream']);
  await fake.channel.close({ quarantine: true });
  assert.equal(fake.ws.closeCalls, 1);
  assert.equal(fake.getDisposeCalls(), 1);
});

test('an owned normal close is not classified as an unexpected socket close', async () => {
  const fake = makeHarness();
  const opened = await fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'normal close', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } });
  const waiting = opened.events.next();
  await fake.channel.close({ quarantine: true });
  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, 'channel_closed');
    assert.equal(error.code === 'noise_socket_closed', false);
    return true;
  });
  assert.equal(fake.getDisposeCalls(), 1);
});

test('emits only gateway events correlated to the acknowledged session', async () => {
  let onGatewayMessage;
  const fake = makeHarness({ onSend: async ({ method, noiseOptions }) => {
    onGatewayMessage = noiseOptions.handleGatewayMessage;
    return method === 'chat.cancel' ? { cancelled: true } : { session_id: SESSION_UUID };
  } });
  const opened = await fake.channel.openStream({
    method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] },
  });
  onGatewayMessage(event('other-session', 'ignore'));
  onGatewayMessage({ type: 'event', event: 'delta.text_append', payload: { message_id: 'no-session', text: 'ignore' } });
  onGatewayMessage(event(SESSION_UUID, 'keep'));
  const first = await opened.events.next();
  assert.deepEqual(first.value, event(SESSION_UUID, 'keep'));
  const pending = opened.events.next();
  await opened.events.return();
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(fake.ws.readyState, CLOSED);
});

test('delivers a post-ack live event directly to an already waiting async iterator', async () => {
  let onGatewayMessage;
  const fake = makeHarness({ onSend: async ({ method, noiseOptions }) => {
    onGatewayMessage = noiseOptions.handleGatewayMessage;
    return method === 'chat.cancel' ? { cancelled: true } : { session_id: SESSION_UUID };
  } });
  const opened = await fake.channel.openStream({
    method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] },
  });
  const pending = opened.events.next();
  const expected = event(SESSION_UUID, 'arrived-later');
  onGatewayMessage(expected);
  assert.deepEqual(await pending, { value: expected, done: false });
  await opened.events.return();
});

test('buffers only bounded pre-ack messages and discards events from other sessions', async () => {
  let onGatewayMessage;
  const fake = makeHarness({ onSend: async ({ method, noiseOptions }) => {
    onGatewayMessage = noiseOptions.handleGatewayMessage;
    if (method === 'chat.stream') {
      onGatewayMessage(event('wrong-session', 'drop'));
      onGatewayMessage(event(SESSION_UUID, 'preack'));
      return { session_id: SESSION_UUID };
    }
    return method === 'chat.cancel' ? { cancelled: true } : { session_id: SESSION_UUID };
  } });
  const opened = await fake.channel.openStream({
    method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] },
  });
  assert.deepEqual((await opened.events.next()).value, event(SESSION_UUID, 'preack'));
  await opened.events.return();
});

test('rejects routes outside the typed stream and cancel allowlist without calling NoiseChannel', async () => {
  const fake = makeHarness();
  await assert.rejects(fake.channel.request({ method: 'POST', path: '/api/session/delete', body: {} }), (error) => {
    assert.ok(error instanceof MuseChannelError);
    assert.equal(error.delivery, MuseDelivery.NOT_SENT);
    assert.equal(error.code, 'route_not_allowed');
    return true;
  });
  assert.equal(fake.sent.length, 0);
});

test('accepts cancel only for the acknowledged session and posts one request', async () => {
  const fake = makeHarness();
  await fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } });
  await assert.rejects(fake.channel.request({ method: 'POST', path: '/chat/cancel', body: { session_id: 'other' } }),
    (error) => error.code === 'invalid_cancel_request' && error.delivery === MuseDelivery.NOT_SENT);
  const response = await fake.channel.request({ method: 'POST', path: '/chat/cancel', body: { session_id: SESSION_UUID } });
  assert.deepEqual(response, { status: undefined, body: { cancelled: true } });
  assert.equal(fake.sent.filter((entry) => entry.method === 'chat.cancel').length, 1);
});

test('rejects a stream acknowledgement that does not echo the requested draft UUID before subscribing', async () => {
  const mismatch = makeHarness({ onSend: async ({ method }) =>
    method === 'chat.stream' ? { session_id: OTHER_SESSION_UUID } : { session_id: SESSION_UUID } });
  await assert.rejects(mismatch.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } }), (error) => {
    assert.equal(error.code, 'invalid_stream_ack');
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    return true;
  });
  assert.deepEqual(mismatch.sent.filter((entry) => entry.method).map((entry) => entry.method),
    ['chat.stream']);
  assert.equal(mismatch.ws.readyState, CLOSED);

  const mismatchSubscribe = makeHarness({ onSend: async ({ method }) =>
    method === 'chat.stream' ? { session_id: SESSION_UUID } : { session_id: OTHER_SESSION_UUID } });
  await assert.rejects(mismatchSubscribe.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } }), (error) => {
    assert.equal(error.code, 'subscription_ack_mismatch');
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    return true;
  });
  assert.deepEqual(mismatchSubscribe.sent.filter((entry) => entry.method).map((entry) => entry.method),
    ['chat.stream', 'chat.subscribe']);

  const failedSubscribe = makeHarness({ onSend: async ({ method, noiseOptions }) => {
    if (method === 'chat.stream') return { session_id: SESSION_UUID };
    if (method === 'chat.subscribe') {
      throw new failedSubscribe.FakeOfficialGatewayError({ kind: 'transport', deliveryState: 'not_sent' });
    }
    return { cancelled: true };
  } });
  await assert.rejects(failedSubscribe.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } }), (error) => {
    assert.equal(error.code, 'subscription_failed');
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    return true;
  });
});

test('requires a caller-owned v4 UUID and never subscribes to an old or malformed session', async () => {
  const fake = makeHarness();
  await assert.rejects(fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', capabilities: [] } }), (error) => {
    assert.equal(error.code, 'invalid_stream_request');
    assert.equal(error.delivery, MuseDelivery.NOT_SENT);
    return true;
  });
  await assert.rejects(fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: 'known-old-session', capabilities: [] } }), (error) => {
    assert.equal(error.code, 'invalid_stream_request');
    return true;
  });
  assert.equal(fake.sent.length, 0);
});

test('only an official branded not_sent error proves that a request was not sent', async () => {
  const fake = makeHarness({ prewrite: true });
  await assert.rejects(fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } }), (error) => {
    assert.equal(error.delivery, MuseDelivery.NOT_SENT);
    assert.equal(error.code, 'request_not_sent');
    assert.equal(error.message.includes('private connection detail'), false);
    return true;
  });

  const unknown = makeHarness({ onSend: async () => { throw new Error('secret network message'); } });
  await assert.rejects(unknown.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } }), (error) => {
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    assert.equal(error.code, 'request_outcome_unknown');
    assert.equal(error.message.includes('secret network message'), false);
    return true;
  });
  await fake.channel.close({ quarantine: true });
  await unknown.channel.close({ quarantine: true });
});

test('HTTP errors are not converted into cancellation confirmation', async () => {
  const fake = makeHarness({ onSend: async ({ method }) => {
    if (method !== 'chat.cancel') return { session_id: SESSION_UUID };
    throw new fake.FakeOfficialGatewayError({ httpStatus: 400 });
  } });
  await fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } });
  assert.deepEqual(await fake.channel.request({ method: 'POST', path: '/chat/cancel', body: { session_id: SESSION_UUID } }),
    { status: 400, body: null });
  await fake.channel.close({ quarantine: true });
});

test('event overflow rejects/tears down rather than retaining an unbounded queue', async () => {
  let onGatewayMessage;
  const fake = makeHarness({ maxEvents: 1, onSend: async ({ method, noiseOptions }) => {
    onGatewayMessage = noiseOptions.handleGatewayMessage;
    if (method === 'chat.stream') {
      onGatewayMessage(event(SESSION_UUID, 'one'));
      onGatewayMessage(event(SESSION_UUID, 'two'));
      return { session_id: SESSION_UUID };
    }
    if (method === 'chat.subscribe') return { session_id: SESSION_UUID };
  } });
  await assert.rejects(fake.channel.openStream({ method: 'POST', path: '/chat/stream',
    body: { message: 'test', node_id: 'persisted-device-1', session_id: SESSION_UUID, capabilities: [] } }), (error) => {
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    assert.equal(error.code, 'event_buffer_overflow');
    return true;
  });
  await fake.channel.close({ quarantine: true }).catch(() => {});
});

test('drops a 2 MiB pre-ack message.user echo and preserves assistant events within the existing queue cap', async () => {
  let streamRequest;
  const fake = makeHarness({ onSend: async ({ method, resolved, noiseOptions }) => {
    if (method !== 'chat.stream') return { session_id: SESSION_UUID };
    streamRequest = resolved.params;
    const echoedText = resolved.params.items[0].text;
    // Public `message.user` projection reads payload.content/display_text; it
    // is intentionally emitted ahead of the stream acknowledgement here.
    noiseOptions.handleGatewayMessage({
      type: 'event', event: 'message.user', session_id: SESSION_UUID,
      payload: {
        session_id: SESSION_UUID, message_id: 'user-1', role: 'user',
        content: echoedText, display_text: echoedText,
      },
    });
    noiseOptions.handleGatewayMessage({
      type: 'event', event: 'delta.presentation', session_id: SESSION_UUID,
      payload: {
        session_id: SESSION_UUID, transcript_surface: 'main_chat', role: 'assistant',
        message_id: 'assistant-1', display_text: 'bounded answer',
      },
    });
    noiseOptions.handleGatewayMessage({
      type: 'event', event: 'delta.message_done', session_id: SESSION_UUID,
      payload: {
        session_id: SESSION_UUID, transcript_surface: 'main_chat', message_id: 'assistant-1',
        status: 'completed', transcript: { messages: [{ id: 'assistant-1', role: 'assistant',
          content: [{ type: 'text', text: 'bounded answer' }] }] },
      },
    });
    return { session_id: SESSION_UUID, message_id: 'user-1' };
  } });
  const rpc = new MuseRpcClient({
    channel: fake.channel,
    sessionIdFactory: () => SESSION_UUID,
  });
  const maxPrompt = 'p'.repeat(2 * 1024 * 1024);
  const result = await rpc.generate(maxPrompt);
  assert.deepEqual(result, {
    text: 'bounded answer', sessionId: SESSION_UUID, messageId: 'assistant-1', delivery: MuseDelivery.ACCEPTED,
  });
  assert.equal(streamRequest.items[0].text.length, 2 * 1024 * 1024);
  assert.deepEqual(fake.sent.filter(entry => entry.method).map(entry => entry.method), ['chat.stream', 'chat.subscribe']);
  assert.equal(fake.ws.readyState, CLOSED);
});

test('invalid nonbinary frames quarantine and close the channel', async () => {
  const fake = makeHarness();
  fake.ws.message('raw frame must not be forwarded');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.ws.readyState, CLOSED);
  assert.equal(fake.sent.some((entry) => entry.inbound), false);
});
