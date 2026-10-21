import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/server.mjs';

function readContext(prompt) {
  const marker = 'CANONICAL_CONTEXT_JSON:\n';
  const index = prompt.indexOf(marker);
  assert.notEqual(index, -1, 'prompt includes canonical JSON context');
  return JSON.parse(prompt.slice(index + marker.length));
}

function syntheticDriver(generate = (_prompt, { nonce }) => ({
  text: JSON.stringify({ request_id: nonce, content: 'synthetic reply', tool_calls: [] }),
})) {
  return { generate, async status() { return { ready: true, state: 'ready' }; }, async close() {} };
}

async function withServer(driver, fn) {
  const bridge = createBridge({ driver });
  const port = await bridge.listen(0);
  try { await fn({ bridge, port }); }
  finally { await bridge.close(); }
}

async function post(port, pathname, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const xApiKey = { 'x-api-key': 'muse-local' };
const bearer = { authorization: 'Bearer muse-local' };
const basicMessage = { model: 'muse', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] };

test('Messages accepts x-api-key or Bearer while x-api-key remains unavailable to OpenAI routes', async () => {
  let generated = 0;
  await withServer(syntheticDriver((prompt, { nonce }) => {
    generated++;
    return { text: JSON.stringify({ request_id: nonce, content: 'synthetic reply', tool_calls: [] }) };
  }), async ({ port }) => {
    const apiKeyResponse = await post(port, '/v1/messages', basicMessage, xApiKey);
    assert.equal(apiKeyResponse.status, 200);
    assert.deepEqual((await apiKeyResponse.json()).content, [{ type: 'text', text: 'synthetic reply' }]);

    const bearerResponse = await post(port, '/v1/messages', basicMessage, bearer);
    assert.equal(bearerResponse.status, 200);

    const openAi = await post(port, '/v1/chat/completions', {
      model: 'muse', messages: [{ role: 'user', content: 'Hello' }],
    }, xApiKey);
    assert.equal(openAi.status, 401);
    const error = await openAi.json();
    assert.equal(error.error.code, 'invalid_api_key');
    assert.equal(generated, 2);
  });
});

test('count_tokens validates model and full conversation context without generating or incrementing request stats', async () => {
  let generated = 0;
  await withServer(syntheticDriver(() => { generated++; throw new Error('count_tokens must not generate'); }), async ({ bridge, port }) => {
    const catalog = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: bearer });
    assert.equal(catalog.status, 200);
    assert.deepEqual((await catalog.json()).data.map(model => model.id), ['muse-web', 'muse']);

    const valid = await post(port, '/v1/messages/count_tokens', basicMessage, xApiKey);
    assert.equal(valid.status, 200);
    assert.ok((await valid.json()).input_tokens > 0);
    assert.equal(valid.headers.get('x-muse-usage'), 'estimated-visible-payload');

    const invalidContext = await post(port, '/v1/messages/count_tokens', {
      ...basicMessage,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan' }] }],
    }, xApiKey);
    assert.equal(invalidContext.status, 400);
    assert.equal((await invalidContext.json()).error.type, 'invalid_request_error');

    const unknownModel = await post(port, '/v1/messages/count_tokens', { ...basicMessage, model: 'missing-model' }, xApiKey);
    assert.equal(unknownModel.status, 404);
    assert.equal((await unknownModel.json()).error.code, 'model_not_found');
    assert.equal(generated, 0);
    assert.equal(bridge.stats.requests, 0);
  });
});

test('Messages tool_use continues through tool_result and emits buffered terminal SSE with valid tool input', async () => {
  const contexts = [];
  const instance = syntheticDriver((prompt, { nonce }) => {
    const context = readContext(prompt);
    contexts.push(context);
    const decision = contexts.length === 1
      ? { request_id: nonce, content: null, tool_calls: [{ name: 'lookup', arguments: { key: 'alpha' } }] }
      : { request_id: nonce, content: 'The result is 42.', tool_calls: [] };
    return { text: JSON.stringify(decision) };
  });
  await withServer(instance, async ({ port }) => {
    const tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }];
    const first = await post(port, '/v1/messages', {
      model: 'muse', max_tokens: 120, stream: true, tools,
      messages: [{ role: 'user', content: 'Look up alpha.' }],
    }, xApiKey);
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type'), /text\/event-stream/);
    assert.equal(first.headers.get('x-muse-streaming'), 'buffered');
    const firstFrames = (await first.text()).split('\n\n').filter(Boolean).map(frame => {
      const event = frame.match(/^event: ([^\n]+)/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
    const inputFrame = firstFrames.find(frame => frame.event === 'content_block_delta' && frame.data.delta?.type === 'input_json_delta');
    assert.deepEqual(JSON.parse(inputFrame.data.delta.partial_json), { key: 'alpha' });
    const firstMessageDelta = firstFrames.find(frame => frame.event === 'message_delta');
    assert.equal(firstMessageDelta.data.delta.stop_reason, 'tool_use');
    assert.equal(firstFrames.at(-1).event, 'message_stop');

    const continuation = await post(port, '/v1/messages', {
      model: 'muse', max_tokens: 120,
      messages: [
        { role: 'user', content: 'Look up alpha.' },
        { role: 'assistant', content: [
          { type: 'text', text: 'Checking now.' },
          { type: 'tool_use', id: 'toolu_alpha', name: 'lookup', input: { key: 'alpha' } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_alpha', content: '42' }] },
      ],
    }, bearer);
    assert.equal(continuation.status, 200);
    assert.deepEqual((await continuation.json()).content, [{ type: 'text', text: 'The result is 42.' }]);
    assert.equal(contexts.length, 2);
    const assistantHistory = contexts[1].messages.at(-2);
    assert.equal(assistantHistory.content, 'Checking now.');
    assert.deepEqual(assistantHistory.tool_calls, [{
      id: 'toolu_alpha', type: 'function', function: { name: 'lookup', arguments: '{"key":"alpha"}' },
    }]);
    assert.deepEqual(contexts[1].messages.at(-1), { role: 'tool', tool_call_id: 'toolu_alpha', content: '42' });
    assert.ok(contexts[0].request_id && contexts[1].request_id && contexts[0].request_id !== contexts[1].request_id);
  });
});

test('Messages returns typed safe errors for malformed, unauthorized, unknown-model, and foreign-origin requests', async () => {
  await withServer(syntheticDriver(), async ({ port }) => {
    const malformed = await post(port, '/v1/messages', { model: 'muse', max_tokens: 20, messages: [] }, xApiKey);
    assert.equal(malformed.status, 400);
    assert.deepEqual((await malformed.json()).error, {
      type: 'invalid_request_error', message: 'messages must be a non-empty array.', code: 'invalid_request_error',
    });

    const unauthorized = await post(port, '/v1/messages', basicMessage, { 'x-api-key': 'PRIVATE_CANARY' });
    assert.equal(unauthorized.status, 401);
    const unauthorizedBody = await unauthorized.json();
    assert.equal(unauthorizedBody.error.type, 'authentication_error');
    assert.equal(JSON.stringify(unauthorizedBody).includes('PRIVATE_CANARY'), false);

    const unknown = await post(port, '/v1/messages', { ...basicMessage, model: 'unknown' }, xApiKey);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'model_not_found');

    const foreign = await post(port, '/v1/messages', basicMessage, {
      ...xApiKey, origin: 'https://foreign.example',
    });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error.code, 'invalid_origin');
  });
});

test('unsupported Anthropic reasoning beta header does not invent reasoning output', async () => {
  await withServer(syntheticDriver(), async ({ port }) => {
    const response = await post(port, '/v1/messages', basicMessage, {
      ...xApiKey, 'anthropic-beta': 'interleaved-thinking-2025-05-14',
    });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.deepEqual(message.content, [{ type: 'text', text: 'synthetic reply' }]);
    assert.equal(message.content.some(block => block.type === 'thinking' || block.type === 'redacted_thinking'), false);
  });
});

test('Claude base URL HEAD liveness probe is public without permitting unauthenticated generation', async () => {
  const bridge=createBridge({driver:{status:async()=>({ready:true,state:'ready'}),generate:async()=>{throw Error('must not generate')},close:async()=>{}}});
  const port=await bridge.listen(0);
  try {
    const probe=await fetch(`http://127.0.0.1:${port}/`,{method:'HEAD'});
    assert.equal(probe.status,200);assert.equal(await probe.text(),'');assert.equal(bridge.stats.requests,0);
    const generation=await fetch(`http://127.0.0.1:${port}/v1/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'muse-web',max_tokens:20,messages:[{role:'user',content:'hi'}]})});
    assert.equal(generation.status,401);assert.equal(bridge.stats.requests,0);
  } finally {await bridge.close();}
});
