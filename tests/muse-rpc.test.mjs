import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_CAPABILITIES,
  CHAT_CANCEL_PATH,
  CHAT_STREAM_PATH,
  MuseChannelError,
  MuseDelivery,
  MuseRpcClient,
  MuseRpcError,
} from '../src/muse/rpc.mjs';

const sessionUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FIRST_SESSION_ID = sessionUuid(1);

function makeChannel({ ack = null, events = [],
  openStream, cancelResponse = { status: 200, body: { cancelled: true } } } = {}) {
  const calls = { opens: [], requests: [], closes: [] };
  return {
    calls,
    channel: {
      nodeId: 'persisted-device-id',
      async openStream(args) {
        calls.opens.push(args);
        if (openStream) return openStream(args);
        return { ack: ack ?? { session_id: args.body.session_id, message_id: 'user-message-1' },
          events: (async function* () { yield* events; })() };
      },
      async request(args) {
        calls.requests.push(args);
        return cancelResponse;
      },
      async close(options) {
        calls.closes.push(options);
      },
    },
  };
}

function evt(event, payload) {
  return { type: 'event', event, payload: { session_id: FIRST_SESSION_ID, stream_lane: 'main',
    transcript_surface: 'main_chat', ...payload } };
}

function makeClient(channel, overrides = {}) {
  let id = 0;
  let session = 0;
  return new MuseRpcClient({
    channel,
    idFactory: () => `local-op-${++id}`,
    sessionIdFactory: () => sessionUuid(++session),
    ...overrides,
  });
}

test('generates one new draft and returns completed assistant text', async () => {
  const fake = makeChannel({
    events: [
      evt('delta.text_append', { message_id: 'assistant-1', text: 'Hello ' }),
      evt('delta.text_append', { message_id: 'assistant-1', text: 'there.' }),
      evt('delta.message_done', { message_id: 'assistant-1', status: 'completed' }),
    ],
  });
  const result = await makeClient(fake.channel).generate('Say hello', { nonce: 'local-only-nonce' });

  assert.deepEqual(result, {
    text: 'Hello there.', sessionId: FIRST_SESSION_ID, messageId: 'assistant-1', delivery: MuseDelivery.ACCEPTED,
  });
  assert.equal(fake.calls.opens.length, 1);
  assert.deepEqual(fake.calls.opens[0], {
    method: 'POST',
    path: CHAT_STREAM_PATH,
    body: {
      message: 'Say hello',
      node_id: 'persisted-device-id',
      session_id: FIRST_SESSION_ID,
      capabilities: [...CHAT_CAPABILITIES],
    },
    signal: fake.calls.opens[0].signal,
  });
  assert.match(fake.calls.opens[0].body.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(JSON.stringify(fake.calls.opens[0].body).includes('local-only-nonce'), false);
  assert.equal(fake.calls.requests.length, 0);
});

test('legacy text append rejects explicit non-assistant roles but accepts missing role', async () => {
  const fake = makeChannel({ events: [
    evt('delta.text_append', { message_id: 'non-ack-user', role: 'user', text: 'USER_CANARY' }),
    evt('delta.message_done', { message_id: 'non-ack-user', role: 'user', status: 'completed' }),
    evt('delta.text_append', { message_id: 'legacy-assistant', text: 'valid legacy assistant reply' }),
    evt('delta.message_done', { message_id: 'legacy-assistant', status: 'completed' }),
  ] });

  const result = await makeClient(fake.channel).generate('Prompt');
  assert.equal(result.text, 'valid legacy assistant reply');
  assert.equal(result.messageId, 'legacy-assistant');
  assert.equal(result.text.includes('USER_CANARY'), false);
});

test('accepts final content field and ignores unrelated events', async () => {
  const fake = makeChannel({
    events: [
      evt('activity.update', { id: 'unrelated' }),
      evt('delta.text_append', { message_id: 'assistant-2', text: 'partial' }),
      evt('delta.message_done', { message_id: 'assistant-2', status: 'completed', content: 'final answer' }),
    ],
  });
  const result = await makeClient(fake.channel).generate('Prompt');
  assert.equal(result.text, 'final answer');
  assert.equal(result.messageId, 'assistant-2');
});

test('uses the assistant presentation and matching visible transcript, ignoring the prompt completion and tool strings', async () => {
  const ack = { session_id: FIRST_SESSION_ID, message_id: 'user-message-1' };
  const fake = makeChannel({ ack, events: [
    evt('delta.message_done', { session_id: FIRST_SESSION_ID, message_id: 'user-message-1', status: 'completed', content: 'echoed prompt' }),
    evt('message.user', { session_id: FIRST_SESSION_ID, message_id: 'assistant-1', role: 'user', display_text: 'wrong role' }),
    evt('delta.presentation', { session_id: 'other-session', message_id: 'assistant-1', role: 'assistant', display_text: 'wrong session' }),
    evt('delta.presentation', { session_id: FIRST_SESSION_ID, message_id: 'assistant-1', role: 'assistant',
      transcript_surface: 'main_chat', display_text: 'working…' }),
    evt('delta.message_done', { session_id: FIRST_SESSION_ID, message_id: 'assistant-1', status: 'completed',
      transcript: { messages: [
        { id: 'user-message-1', role: 'user', content: [{ type: 'text', text: 'prompt' }] },
        { id: 'assistant-1', role: 'assistant', content: [
          { type: 'text', text: 'Answer ' },
          { type: 'tool_call', request: 'private tool request', result: { output: 'must not surface' } },
          { type: 'sub_agent', content: [{ type: 'text', text: 'complete.' }] },
        ] },
      ] },
    }),
  ] });
  const result = await makeClient(fake.channel).generate('Prompt');
  assert.equal(result.messageId, 'assistant-1');
  assert.equal(result.text, 'Answer complete.');
});

test('does not infer assistant identity from an unmatched terminal user message', async () => {
  const fake = makeChannel({ ack: { session_id: FIRST_SESSION_ID, message_id: 'user-message-1' }, events: [
    evt('delta.message_done', { session_id: FIRST_SESSION_ID, message_id: 'user-message-1', status: 'completed', content: 'user content' }),
  ] });
  await assert.rejects(makeClient(fake.channel).generate('Prompt'), (error) => {
    assert.equal(error.code, 'stream_ended_without_completion');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    return true;
  });
});

test('sends a fresh UUID v4 session for each call and ignores caller attempts to choose an existing session', async () => {
  const fake = makeChannel({ openStream: async ({ body }) => ({
    ack: { session_id: body.session_id, message_id: `user-${body.session_id}` },
    events: (async function* () {
      yield evt('delta.presentation', { session_id: body.session_id, message_id: `assistant-${body.session_id}`,
        role: 'assistant', display_text: 'reply' });
      yield evt('delta.message_done', { session_id: body.session_id, message_id: `assistant-${body.session_id}`,
        status: 'completed' });
    })(),
  }) });
  const client = makeClient(fake.channel);
  const one = await client.generate('first', { sessionId: 'known-existing-session' });
  const two = await client.generate('second', { session_id: 'another-existing-session' });
  const ids = fake.calls.opens.map((call) => call.body.session_id);
  assert.notEqual(ids[0], ids[1]);
  assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual([one.sessionId, two.sessionId], ids);
  assert.deepEqual(fake.calls.opens.map((call) => call.body.message), ['first', 'second']);
});

test('rejects a stream acknowledgement that does not echo the newly requested UUID and quarantines', async () => {
  const fake = makeChannel({ ack: { session_id: sessionUuid(2), message_id: 'user-message-1' } });
  const client = makeClient(fake.channel);
  await assert.rejects(client.generate('Prompt'), (error) => {
    assert.equal(error.code, 'invalid_stream_ack');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    assert.equal(error.safe.quarantine, true);
    return true;
  });
  assert.equal(fake.calls.opens[0].body.session_id, FIRST_SESSION_ID);
  assert.deepEqual(fake.calls.closes, [{ quarantine: true }]);
  assert.equal(client.quarantinedCount, 1);
});

test('invalid or reused session UUID factory output is rejected before channel invocation', async () => {
  const invalid = makeChannel();
  await assert.rejects(new MuseRpcClient({ channel: invalid.channel, sessionIdFactory: () => 'old-session' }).generate('Prompt'),
    (error) => error.code === 'invalid_session_id' && error.delivery === MuseDelivery.NOT_SENT);
  assert.equal(invalid.calls.opens.length, 0);

  const repeated = makeChannel();
  const client = new MuseRpcClient({ channel: repeated.channel, sessionIdFactory: () => FIRST_SESSION_ID });
  await assert.rejects(client.generate('first'), (error) => error.code === 'stream_ended_without_completion');
  await assert.rejects(client.generate('second'), (error) =>
    error.code === 'invalid_session_id' && error.delivery === MuseDelivery.NOT_SENT);
  assert.equal(repeated.calls.opens.length, 1);
});

test('ignores non-main commentary but accepts a main assistant reply with an unrecognized reply ID', async () => {
  const fake = makeChannel({ events: [
    evt('delta.presentation', { message_id: 'commentary', role: 'assistant', reply_to_message_id: 'other-user',
      stream_lane: 'subagent', transcript_surface: 'subagent', display_text: 'commentary' }),
    evt('delta.text_append', { message_id: 'subagent', text: 'subagent output', stream_lane: 'subagent', transcript_surface: 'subagent' }),
    evt('delta.message_done', { message_id: 'commentary', status: 'completed', content: 'wrong answer',
      stream_lane: 'subagent', transcript_surface: 'subagent', reply_to_message_id: 'other-user' }),
    evt('delta.presentation', { message_id: 'assistant-main', role: 'assistant', reply_to_message_id: 'unknown-server-link', display_text: 'visible answer' }),
    evt('delta.message_done', { message_id: 'assistant-main', status: 'completed', reply_to_message_id: 'unknown-server-link' }),
  ] });
  const result = await makeClient(fake.channel).generate('Prompt');
  assert.deepEqual({ messageId: result.messageId, text: result.text }, {
    messageId: 'assistant-main', text: 'visible answer',
  });
});

test('excludes both ack-owned user IDs but does not filter on reply_to_message_id or reply_to_text', async () => {
  const replyPromptId = 'local-user-message-4';
  const fake = makeChannel({
    ack: { session_id: FIRST_SESSION_ID, message_id: 'server-user-message-1', reply_to_message_id: replyPromptId },
    events: [
      evt('delta.presentation', { message_id: 'unrelated-assistant', role: 'assistant',
        reply_to_message_id: 'some-other-message', display_text: 'ignore' }),
      evt('delta.presentation', { message_id: replyPromptId, role: 'assistant',
        reply_to_message_id: replyPromptId, display_text: 'must not be treated as assistant' }),
      evt('delta.presentation', { message_id: 'assistant-3', role: 'assistant',
        reply_to_message_id: 'unknown-server-link', reply_to_text: 'quoted user prompt' }),
      evt('delta.message_done', { message_id: 'assistant-3', status: 'completed',
        reply_to_message_id: 'unknown-server-link',
        transcript: { messages: [{ id: 'assistant-3', role: 'assistant', content: [{ type: 'text', text: 'PONG' }] }] },
      }),
    ],
  });
  const result = await makeClient(fake.channel).generate('Prompt');
  assert.equal(result.messageId, 'assistant-3');
  assert.equal(result.text, 'PONG');
});

test('pre-write branded failure is not_sent; an unbranded channel failure is unknown and never retried', async () => {
  let calls = 0;
  const prewrite = makeChannel({ openStream: async () => {
    calls += 1;
    throw new MuseChannelError('connection_not_ready', { delivery: MuseDelivery.NOT_SENT });
  } });
  await assert.rejects(makeClient(prewrite.channel).generate('Prompt'), (error) => {
    assert.ok(error instanceof MuseRpcError);
    assert.equal(error.code, 'connection_not_ready');
    assert.equal(error.delivery, MuseDelivery.NOT_SENT);
    return true;
  });
  assert.equal(calls, 1);

  const sentinel = 'Bearer should-not-leak';
  const postwrite = makeChannel({ openStream: async () => {
    calls += 1;
    throw new Error(sentinel);
  } });
  await assert.rejects(makeClient(postwrite.channel).generate('Prompt'), (error) => {
    assert.equal(error.code, 'channel_failed');
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    assert.equal(error.message.includes(sentinel), false);
    return true;
  });
  assert.equal(calls, 2);
});

test('an identified assistant terminal failure is surfaced without exposing server text', async () => {
  const fake = makeChannel({ events: [
    evt('delta.presentation', { message_id: 'assistant-1', role: 'assistant', display_text: 'working' }),
    evt('delta.message_done', {
    message_id: 'assistant-1', status: 'failed', content: 'private detail',
    }),
  ] });
  await assert.rejects(makeClient(fake.channel).generate('Prompt'), (error) => {
    assert.equal(error.code, 'generation_failed');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    assert.equal(error.message.includes('private detail'), false);
    return true;
  });
  assert.equal(fake.calls.requests.length, 0);
});

test('abort after acknowledgement waits for explicit chat.cancel confirmation', async () => {
  const controller = new AbortController();
  const fake = makeChannel({ openStream: async () => ({
    ack: { session_id: FIRST_SESSION_ID, message_id: 'user-message' },
    events: (async function* () {
      await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
    })(),
  }) });
  const client = makeClient(fake.channel);
  const result = client.generate('Prompt', { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(result, (error) => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    assert.equal(error.cancelConfirmed, true);
    return true;
  });
  assert.equal(fake.calls.requests.length, 1);
  assert.deepEqual(fake.calls.requests[0], {
    method: 'POST', path: CHAT_CANCEL_PATH, body: { session_id: FIRST_SESSION_ID }, signal: fake.calls.requests[0].signal,
  });
  assert.equal(client.quarantinedCount, 0);
});

test('unconfirmed cancellation quarantines the operation and keeps errors safe', async () => {
  const controller = new AbortController();
  const secret = 'do-not-report-this-token';
  const fake = makeChannel({
    openStream: async () => ({
      ack: { session_id: FIRST_SESSION_ID, message_id: 'user-message' },
      events: (async function* () {
        await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
      })(),
    }),
    cancelResponse: { status: 200, body: { cancelled: false, detail: secret } },
  });
  const client = makeClient(fake.channel);
  const result = client.generate('Prompt', { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(result, (error) => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.cancelConfirmed, false);
    assert.equal(error.safe.quarantine, true);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(client.quarantinedCount, 1);
});

test('cancellation timeout quarantines without waiting forever', async () => {
  const controller = new AbortController();
  const fake = makeChannel({
    openStream: async () => ({
      ack: { session_id: FIRST_SESSION_ID, message_id: 'user-message' },
      events: (async function* () {
        await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
      })(),
    }),
  });
  fake.channel.request = async (args) => {
    fake.calls.requests.push(args);
    return new Promise((resolve, reject) => {
      args.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true });
    });
  };
  const client = makeClient(fake.channel, { cancelTimeoutMs: 15 });
  const result = client.generate('Prompt', { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(result, (error) => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.cancelConfirmed, false);
    return true;
  });
  assert.equal(fake.calls.requests.length, 1);
  assert.equal(fake.calls.requests[0].path, CHAT_CANCEL_PATH);
  assert.equal(client.quarantinedCount, 1);
  assert.deepEqual(fake.calls.closes, [{ quarantine: true }]);
});

test('prompt size is configurable up to 2 MiB and accepts the previous 1 MiB request range', async () => {
  const prompt = 'x'.repeat(160 * 1024);
  const fake = makeChannel({ events: [
    evt('delta.presentation', { message_id: 'assistant-large-prompt', role: 'assistant' }),
    evt('delta.message_done', { message_id: 'assistant-large-prompt', status: 'completed', content: 'ok' }),
  ] });
  const client = makeClient(fake.channel, { maxPromptBytes: 170 * 1024 });
  const result = await client.generate(prompt);
  assert.equal(result.text, 'ok');
  assert.equal(fake.calls.opens[0].body.message.length, prompt.length);

  assert.throws(() => new MuseRpcClient({ ...fake.channel, channel: fake.channel, maxPromptBytes: 2 * 1024 * 1024 + 1 }),
    (error) => error.code === 'invalid_limits');
});

test('abort while opening waits for channel close and open settlement, then quarantines safely', async () => {
  const controller = new AbortController();
  let resolveOpen;
  let finishClose;
  let closeStarted;
  const closeGate = new Promise((resolve) => { finishClose = resolve; });
  const closeStartedPromise = new Promise((resolve) => { closeStarted = resolve; });
  const fake = makeChannel({
    openStream: () => new Promise((resolve, reject) => {
      resolveOpen = resolve;
      // A correctly implemented channel settles the pending open when closed.
      closeGate.then(() => reject(new Error('closed')));
    }),
  });
  fake.channel.close = async (options) => {
    fake.calls.closes.push(options);
    closeStarted();
    await closeGate;
  };
  const client = makeClient(fake.channel);
  const result = client.generate('Prompt', { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await closeStartedPromise;

  let settled = false;
  result.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finishClose();
  await assert.rejects(result, (error) => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    assert.equal(error.safe.quarantine, true);
    assert.equal(error.safe.cancelConfirmed, false);
    return true;
  });
  assert.equal(typeof resolveOpen, 'function');
  assert.equal(client.quarantinedCount, 1);
  assert.deepEqual(fake.calls.closes, [{ quarantine: true }]);
});

test('abort while opening is bounded when a broken channel never settles openStream', async () => {
  const controller = new AbortController();
  const fake = makeChannel({ openStream: async () => new Promise(() => {}) });
  const client = makeClient(fake.channel, { cancelTimeoutMs: 10 });
  const startedAt = Date.now();
  const result = client.generate('Prompt', { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);

  await assert.rejects(result, error => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    assert.equal(error.cancelConfirmed, false);
    assert.equal(error.safe.quarantine, true);
    return true;
  });
  assert.ok(Date.now() - startedAt < 500, 'openStream settlement must be bounded after channel close');
  assert.deepEqual(fake.calls.closes, [{ quarantine: true }]);
  assert.equal(fake.calls.requests.length, 0, 'no cancel may be initiated after the request has returned');
  assert.equal(client.quarantinedCount, 1);
});

test('abort while opening closes a late stream iterator exactly once without sending chat.cancel', async () => {
  const controller = new AbortController();
  let resolveOpen;
  let returned = 0;
  const fake = makeChannel({ openStream: () => new Promise(resolve => { resolveOpen = resolve; }) });
  fake.channel.close = async options => {
    fake.calls.closes.push(options);
    resolveOpen({
      ack: { session_id: FIRST_SESSION_ID, message_id: 'late-open' },
      events: {
        [Symbol.asyncIterator]() {
          return {
            async next() { return { done: true }; },
            async return() { returned += 1; return { done: true }; },
          };
        },
      },
    });
  };
  const client = makeClient(fake.channel, { cancelTimeoutMs: 20 });
  const result = client.generate('Prompt', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();

  await assert.rejects(result, error => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.delivery, MuseDelivery.UNKNOWN);
    assert.equal(error.safe.quarantine, true);
    return true;
  });
  assert.equal(returned, 1, 'the late-opened async iterator is cleaned up');
  assert.deepEqual(fake.calls.closes, [{ quarantine: true }]);
  assert.equal(fake.calls.requests.length, 0, 'do not send chat.cancel after the caller has received its abort');
  assert.equal(client.quarantinedCount, 1);
});

test('iterator cleanup timeout waits for channel closure and quarantines the account channel', async () => {
  let finishReturn;
  let finishClose;
  let closeStarted;
  const returnGate = new Promise((resolve) => { finishReturn = resolve; });
  const closeGate = new Promise((resolve) => { finishClose = resolve; });
  const closeStartedPromise = new Promise((resolve) => { closeStarted = resolve; });
  const fake = makeChannel({
    openStream: async () => ({
      ack: { session_id: FIRST_SESSION_ID, message_id: 'user-cleanup' },
      events: {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              const values = [
                evt('delta.presentation', { session_id: FIRST_SESSION_ID, message_id: 'assistant-cleanup', role: 'assistant', display_text: 'done' }),
                evt('delta.message_done', { session_id: FIRST_SESSION_ID, message_id: 'assistant-cleanup', status: 'completed', content: 'done' }),
              ];
              if (index >= values.length) return { done: true };
              return { done: false, value: values[index++] };
            },
            return() { return returnGate.then(() => ({ done: true })); },
          };
        },
      },
    }),
  });
  fake.channel.close = async (options) => {
    fake.calls.closes.push(options);
    closeStarted();
    await closeGate;
    finishReturn();
  };
  const client = makeClient(fake.channel, { cancelTimeoutMs: 10 });
  const result = client.generate('Prompt');
  await closeStartedPromise;
  let settled = false;
  result.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finishClose();
  await assert.rejects(result, (error) => {
    assert.equal(error.code, 'iterator_cleanup_unconfirmed');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    assert.equal(error.safe.quarantine, true);
    return true;
  });
  assert.equal(client.quarantinedCount, 1);
  assert.deepEqual(fake.calls.closes, [{ quarantine: true }]);
});

test('cancel request that remains pending after channel close is bounded and quarantined', async () => {
  const controller = new AbortController();
  const fake = makeChannel({ openStream: async args => ({
    ack: { session_id: args.body.session_id, message_id: 'user-message' },
    events: (async function* () {
      await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true }));
    })(),
  }) });
  fake.channel.request = async args => {
    fake.calls.requests.push(args);
    return new Promise(() => {});
  };
  const client = makeClient(fake.channel, { cancelTimeoutMs: 10 });
  const startedAt = Date.now();
  const result = client.generate('Prompt', { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);

  await assert.rejects(result, error => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    assert.equal(error.cancelConfirmed, false);
    assert.equal(error.safe.quarantine, true);
    return true;
  });
  assert.ok(Date.now() - startedAt < 500, 'the original cancel promise must not keep generation pending');
  assert.equal(fake.calls.requests.length, 1);
  assert.deepEqual(fake.calls.closes, [{ quarantine: true }]);
  assert.equal(client.quarantinedCount, 1);
});

test('iterator return that remains pending after channel close is bounded and quarantined', async () => {
  const fake = makeChannel({ openStream: async args => ({
    ack: { session_id: args.body.session_id, message_id: 'user-message' },
    events: {
      [Symbol.asyncIterator]() {
        let index = 0;
        const events = [
          evt('delta.presentation', { session_id: args.body.session_id, message_id: 'assistant-stuck-return', role: 'assistant', display_text: 'done' }),
          evt('delta.message_done', { session_id: args.body.session_id, message_id: 'assistant-stuck-return', status: 'completed', content: 'done' }),
        ];
        return {
          async next() { return index < events.length ? { done: false, value: events[index++] } : { done: true }; },
          return() { return new Promise(() => {}); },
        };
      },
    },
  }) });
  const client = makeClient(fake.channel, { cancelTimeoutMs: 10 });
  const startedAt = Date.now();
  await assert.rejects(client.generate('Prompt'), error => {
    assert.equal(error.code, 'iterator_cleanup_unconfirmed');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    assert.equal(error.safe.quarantine, true);
    return true;
  });
  assert.ok(Date.now() - startedAt < 500, 'the original iterator return must not keep generation pending');
  assert.deepEqual(fake.calls.closes, [{ quarantine: true }]);
  assert.equal(client.quarantinedCount, 1);
});

test('output limit triggers cancel and never returns an oversized transcript', async () => {
  const fake = makeChannel({ events: [
    evt('delta.text_append', { message_id: 'assistant-large', text: 'x'.repeat(257) }),
    evt('delta.message_done', { message_id: 'assistant-large', status: 'completed' }),
  ] });
  const client = makeClient(fake.channel, { maxOutputBytes: 256 });
  await assert.rejects(client.generate('Prompt'), (error) => {
    assert.equal(error.code, 'output_too_large');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    return true;
  });
  assert.equal(fake.calls.requests.length, 1);
  assert.deepEqual(fake.calls.requests[0].body, { session_id: FIRST_SESSION_ID });
  assert.deepEqual(fake.calls.closes, []);
});

test('a closed record stream without a completion event is cancelled', async () => {
  const fake = makeChannel({ events: [evt('delta.text_append', { message_id: 'assistant-1', text: 'partial' })] });
  await assert.rejects(makeClient(fake.channel).generate('Prompt'), (error) => {
    assert.equal(error.code, 'stream_ended_without_completion');
    assert.equal(error.delivery, MuseDelivery.ACCEPTED);
    return true;
  });
  assert.equal(fake.calls.requests.length, 1);
});

test('invalid prompt is rejected before calling the channel', async () => {
  const fake = makeChannel();
  await assert.rejects(makeClient(fake.channel).generate(' \n '), (error) => {
    assert.equal(error.code, 'invalid_prompt');
    assert.equal(error.delivery, MuseDelivery.NOT_SENT);
    return true;
  });
  assert.equal(fake.calls.opens.length, 0);
});
