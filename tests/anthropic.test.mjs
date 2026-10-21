import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeRequest } from '../src/protocol.mjs';
import {
  anthropicError, anthropicToChat, anthropicUnsupportedOptions, chatToAnthropic, sendAnthropicSSE,
} from '../src/anthropic.mjs';

const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };

test('converts system/text/tool definitions and tool choice into a request accepted by the existing protocol', () => {
  const converted = anthropicToChat({
    model: 'muse-web', max_tokens: 1200,
    system: [{ type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Read it.' }] }],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: schema }],
    tool_choice: { type: 'tool', name: 'Read' }, stream: true,
    metadata: { user_id: 'synthetic' }, thinking: { type: 'enabled', budget_tokens: 500 },
  });
  const normalized = normalizeRequest(converted);
  assert.equal(normalized.messages[0].role, 'system');
  assert.equal(normalized.messages[0].content, 'Be concise.');
  assert.equal(normalized.tools[0].function.name, 'Read');
  assert.deepEqual(normalized.toolChoice, { type: 'function', function: { name: 'Read' } });
  assert.deepEqual(anthropicUnsupportedOptions(converted), ['thinking']);
});

test('preserves mixed user text and tool results in order and matches prior tool_use ids', () => {
  const converted = anthropicToChat({ model: 'muse-web', max_tokens: 30, tools: [{ name: 'Read', input_schema: schema }], messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'text', text: 'Before ' }, { type: 'tool_result', tool_use_id: 'toolu_read', content: [{ type: 'text', text: 'file text' }], is_error: true }, { type: 'text', text: ' after' }] },
  ] });
  const normalized = normalizeRequest(converted);
  assert.deepEqual(normalized.messages.map(m => m.role), ['assistant', 'user', 'tool', 'user']);
  assert.deepEqual(normalized.messages[0].tool_calls[0].function, { name: 'Read', arguments: '{"path":"a.txt"}' });
  assert.equal(normalized.messages[2].tool_call_id, 'toolu_read');
  assert.equal(normalized.messages[2].content, 'Tool error: file text');
  assert.equal(normalized.messages[3].content, ' after');
});

test('supports count-only conversion without max_tokens and maps choice variants', () => {
  const request = anthropicToChat({ model: 'muse-web', messages: [{ role: 'user', content: 'count' }] }, { countOnly: true });
  assert.equal(Object.hasOwn(request, 'max_tokens'), false);
  assert.equal(normalizeRequest(request).messages[0].content, 'count');
  assert.equal(anthropicToChat({ model: 'muse-web', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'any' }, tools: [{ name: 'Read', input_schema: schema }] }).tool_choice, 'required');
  assert.equal(anthropicToChat({ model: 'muse-web', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'none' } }).tool_choice, 'none');
});

test('rejects malformed roles, mismatched tool ids, server tools, and non-text media', () => {
  assert.throws(() => anthropicToChat({ model: 'm', max_tokens: 10, messages: [{ role: 'system', content: 'no' }] }), /unsupported role/);
  assert.throws(() => normalizeRequest(anthropicToChat({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] }] })), /does not match/);
  assert.throws(() => anthropicToChat({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }), /text blocks only|unsupported content/);
  assert.throws(() => anthropicToChat({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }), /unsupported/);
  assert.throws(() => anthropicToChat({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'tool', name: 'missing' } }), /unavailable/);
});

test('maps text and tool calls to Message blocks with honest estimated usage', () => {
  const message = chatToAnthropic({ id: 'chatcmpl-test', model: 'muse-web', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4 }, muse_usage: { estimated: true } });
  assert.match(message.id, /^msg_/);
  assert.deepEqual(message.content, [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.txt' } }]);
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.usage, { input_tokens: 12, output_tokens: 4 });
  assert.deepEqual(message.muse_usage, { estimated: true });
  const text = chatToAnthropic({ model: 'muse-web', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage: {} });
  assert.deepEqual(text.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(text.stop_reason, 'end_turn');
});

test('writes a complete named Anthropic SSE lifecycle and waits for drain', async () => {
  class FakeResponse extends EventEmitter {
    frames = [];
    writableEnded = false;
    destroyed = false;
    status = null;
    writeHead(status, headers) { this.status = status; this.headers = headers; }
    write(frame) { this.frames.push(frame); setImmediate(() => this.emit('drain')); return false; }
    end() { this.writableEnded = true; }
  }
  const response = new FakeResponse();
  await sendAnthropicSSE(response, { id: 'msg_test', type: 'message', role: 'assistant', model: 'muse-web', content: [
    { type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } },
  ], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } });
  const events = response.frames.map(frame => frame.match(/^event: ([^\n]+)/)?.[1]);
  assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(response.status, 200);
  assert.match(response.headers['Content-Type'], /text\/event-stream/);
  assert.equal(response.writableEnded, true);
  assert.equal(response.frames.some(frame => frame.includes('[DONE]')), false);
  assert.match(response.frames[5], /"partial_json":"\{\\"path\\":\\"a\\"\}"/);
});

test('stops an SSE lifecycle when the client disconnects during backpressure', async () => {
  class FakeResponse extends EventEmitter {
    frames = [];
    writableEnded = false;
    destroyed = false;
    writeHead() {}
    write(frame) { this.frames.push(frame); if (this.frames.length === 1) setImmediate(() => { this.destroyed = true; this.emit('close'); }); return false; }
    end() { this.writableEnded = true; }
  }
  const response = new FakeResponse();
  await assert.rejects(sendAnthropicSSE(response, {
    id: 'msg_abort', type: 'message', role: 'assistant', model: 'muse-web', content: [],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
  }), /client_disconnected/);
  assert.equal(response.frames.length, 1);
  assert.equal(response.writableEnded, false);
});

test('returns bounded Anthropic error envelopes without unsafe control text', () => {
  assert.deepEqual(anthropicError(401, 'invalid_api_key', 'Authentication failed.'), {
    type: 'error', error: { type: 'authentication_error', message: 'Authentication failed.', code: 'invalid_api_key' },
  });
  assert.equal(anthropicError(400, 'x\nprivate', 'x\nsecret').error.message, 'The request could not be completed.');
});

test('Anthropic tool-choice parallel restriction survives conversion and null choice is a typed client error', () => {
  const body={model:'muse-web',max_tokens:20,messages:[{role:'user',content:'hello'}],tool_choice:{type:'auto',disable_parallel_tool_use:true}};
  assert.equal(normalizeRequest(anthropicToChat(body)).generationHints.parallel_tool_calls,false);
  assert.throws(()=>anthropicToChat({...body,tool_choice:null}),error=>error.name==='AnthropicProtocolError');
});
