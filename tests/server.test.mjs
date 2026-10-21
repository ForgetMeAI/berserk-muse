import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../src/server.mjs';

const AUTH = 'Bearer muse-local';
const jsonHeaders = { 'content-type': 'application/json', authorization: AUTH };

function readContext(prompt) {
  const marker = 'CANONICAL_CONTEXT_JSON:\n';
  const index = prompt.indexOf(marker);
  assert.notEqual(index, -1, 'prompt includes canonical JSON context');
  return JSON.parse(prompt.slice(index + marker.length));
}

function driver(generate = (_prompt, { nonce }) => ({ text: JSON.stringify({ request_id: nonce, content: 'ok', tool_calls: [] }) })) {
  return {
    generate,
    async status() { return { ready: true, state: 'ready' }; },
    async close() {},
  };
}

async function withBridge(instance, fn, options = {}) {
  const bridge = createBridge({ driver: instance, ...options });
  const port = await bridge.listen(0);
  try { await fn({ bridge, port }); }
  finally { await bridge.close(); }
}

async function send(port, path, { method = 'GET', headers = {}, body } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const addTool = {
  type: 'function',
  function: {
    name: 'add',
    parameters: {
      type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'], additionalProperties: false,
    },
  },
};

test('serves health/readiness and local model catalog/detail with unknown-model handling', async () => {
  await withBridge(driver(), async ({ port }) => {
    const health = await send(port, '/healthz');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'berserk-muse');
    const ready = await send(port, '/readyz');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).ready, true);

    const catalog = await send(port, '/v1/models', { headers: { authorization: AUTH } });
    assert.equal(catalog.status, 200);
    assert.deepEqual((await catalog.json()).data.map(m => m.id), ['muse-web', 'muse']);
    const detail = await send(port, '/v1/models/muse', { headers: { authorization: AUTH } });
    assert.equal((await detail.json()).id, 'muse');
    const missing = await send(port, '/v1/models/no-such-model', { headers: { authorization: AUTH } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'model_not_found');

    const unreadyDriver = driver();
    unreadyDriver.status = async () => ({ ready: false, state: 'signed_out' });
    // A separate listener verifies readiness has a failing status while health stays useful.
    await withBridge(unreadyDriver, async ({ port: unreadyPort }) => {
      assert.equal((await send(unreadyPort, '/health')).status, 200);
      assert.equal((await send(unreadyPort, '/readyz')).status, 503);
    });
  });
});

test('requires local authorization and rejects untrusted Origin and Host headers', async () => {
  await withBridge(driver(), async ({ port }) => {
    const noAuth = await send(port, '/v1/models');
    assert.equal(noAuth.status, 401);
    const origin = await send(port, '/v1/models', { headers: { authorization: AUTH, origin: 'https://example.invalid' } });
    assert.equal(origin.status, 403);
    assert.equal((await origin.json()).error.code, 'invalid_origin');
    const host = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port, path: '/v1/models',
        headers: { authorization: AUTH, host: 'example.invalid' } }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', part => { body += part; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      request.on('error', reject);
    });
    assert.equal(host.status, 403);
    assert.equal(host.body.error.code, 'invalid_host');
  });
});

test('returns a validated completion and buffered tool SSE with explicitly labelled estimated usage', async () => {
  await withBridge(driver((_prompt, { nonce }) => ({ text: JSON.stringify({
    request_id: nonce, content: null, tool_calls: [{ name: 'add', arguments: { a: 2, b: 3 } }],
  }) })), async ({ port }) => {
    const plain = await send(port, '/v1/chat/completions', {
      method: 'POST', headers: jsonHeaders,
      body: { model: 'muse', messages: [{ role: 'user', content: 'Use a tool.' }], tools: [addTool] },
    });
    assert.equal(plain.status, 200);
    const completion = await plain.json();
    assert.equal(completion.choices[0].finish_reason, 'tool_calls');
    assert.equal(completion.choices[0].message.tool_calls[0].function.name, 'add');
    assert.equal(completion.muse_usage.estimated, true);
    assert.equal(completion.muse_usage.scope, 'adapter_visible_payload_only');
    assert.ok(completion.usage.total_tokens > 0);

    const stream = await send(port, '/v1/chat/completions', {
      method: 'POST', headers: jsonHeaders,
      body: { model: 'muse', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Use a tool.' }], tools: [addTool] },
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    assert.equal(stream.headers.get('x-muse-streaming'), 'buffered');
    const lines = (await stream.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    assert.equal(lines.at(-1), '[DONE]');
    const events = lines.slice(0, -1).map(line => JSON.parse(line));
    assert.ok(events.some(e => e.choices[0]?.delta.tool_calls?.[0]?.function?.name === 'add'));
    const turns = events.filter(e => e.choices.length);
    assert.equal(turns.at(-1).choices[0].finish_reason, 'tool_calls');
    const estimates = events.filter(e => Object.hasOwn(e, 'usage'));
    assert.equal(estimates.length, 1);
    assert.equal(estimates[0].muse_usage.estimated, true);
    assert.equal(stream.headers.get('x-muse-usage'), 'estimated-visible-payload');
  });
});

test('preserves complete parallel tool history in the model prompt', async () => {
  let captured;
  await withBridge(driver((prompt, { nonce }) => {
    captured = readContext(prompt);
    return { text: JSON.stringify({ request_id: nonce, content: 'All results received.', tool_calls: [] }) };
  }), async ({ port }) => {
    const history = [
      { role: 'system', content: 'Keep both results.' },
      { role: 'user', content: 'Run two calculations.' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_left', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":2}' } },
        { id: 'call_right', type: 'function', function: { name: 'add', arguments: '{"a":4,"b":5}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_right', content: '9' },
      { role: 'tool', tool_call_id: 'call_left', content: '3' },
      { role: 'user', content: 'Explain both.' },
    ];
    const response = await send(port, '/v1/chat/completions', {
      method: 'POST', headers: jsonHeaders,
      body: { model: 'muse-web', messages: history, tools: [addTool] },
    });
    assert.equal(response.status, 200);
    assert.equal(captured.messages.length, history.length);
    assert.deepEqual(captured.messages.slice(3, 5).map(m => [m.tool_call_id, m.content]), [['call_right', '9'], ['call_left', '3']]);
    assert.equal(captured.messages[2].tool_calls.length, 2);
  });
});

test('returns a generic 502 for malformed model output without exposing its raw text', async () => {
  const privateText = 'PRIVATE_RAW_MODEL_OUTPUT_9ad1';
  await withBridge(driver(() => ({ text: privateText })), async ({ port }) => {
    const response = await send(port, '/v1/chat/completions', {
      method: 'POST', headers: jsonHeaders,
      body: { model: 'muse', messages: [{ role: 'user', content: 'Hi' }] },
    });
    assert.equal(response.status, 502);
    const result = await response.text();
    assert.equal(result.includes(privateText), false);
    assert.equal(JSON.parse(result).error.code, 'invalid_model_response');
  });
});
