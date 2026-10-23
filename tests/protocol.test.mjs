import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest, buildPrompt, parseDecision, ProtocolError } from '../src/protocol.mjs';

const add = {
  type: 'function',
  function: {
    name: 'add',
    description: 'Add two integers',
    parameters: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
};

function req(overrides = {}) {
  return normalizeRequest({ model: 'local-model', messages: [{ role: 'user', content: 'Calculate 2 + 3' }], tools: [add], ...overrides });
}

function envelope(nonce, fields = {}) {
  return JSON.stringify({ request_id: nonce, content: 'Done', tool_calls: [], ...fields });
}

test('preserves full textual history and all parallel tool results with matching IDs', () => {
  const messages = [
    { role: 'system', content: 'Rules' },
    { role: 'developer', content: 'Use tools when needed' },
    { role: 'user', content: [{ type: 'text', text: 'First ' }, { type: 'text', text: 'question' }] },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'one', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":2}' } },
      { id: 'two', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } },
    ] },
    { role: 'tool', tool_call_id: 'two', content: '5' },
    { role: 'tool', tool_call_id: 'one', content: '3' },
    { role: 'assistant', content: 'Both results received.' },
    { role: 'user', content: 'Now explain.' },
  ];
  const request = req({ messages });
  assert.equal(request.messages.length, messages.length);
  assert.equal(request.messages[2].content, 'First question');
  assert.deepEqual(request.messages.slice(4, 6).map(m => m.tool_call_id), ['two', 'one']);
  const prompt = buildPrompt(request, { nonce: 'nonce-1' });
  assert.ok(prompt.includes('Both results received.'));
  assert.ok(prompt.includes('"tool_call_id":"one"'));
  assert.match(prompt, /Never execute, simulate, or claim to execute a tool/);
});

test('accepts a valid text decision and fenced JSON, but rejects a stale nonce', () => {
  const request = req();
  assert.deepEqual(parseDecision(envelope('current'), request, { nonce: 'current' }), { content: 'Done', finish_reason: 'stop' });
  assert.deepEqual(parseDecision(`\`\`\`json\n${envelope('current')}\n\`\`\``, request, { nonce: 'current' }).finish_reason, 'stop');
  assert.throws(() => parseDecision(envelope('old'), request, { nonce: 'current' }), e => e instanceof ProtocolError && e.status === 502);
});

test('repairs only invalid JSON backslashes in model text while preserving JSON escape semantics', () => {
  const request = req();
  const raw = String.raw`{"request_id":"n","content":"C:\Users\alice\docs\draft.txt; regex \d+\s+\w+; math \(x\) \alpha; Markdown \*note\*","tool_calls":[]}`;
  const decision = parseDecision(raw, request, { nonce: 'n' });
  assert.equal(decision.content, String.raw`C:\Users\alice\docs\draft.txt; regex \d+\s+\w+; math \(x\) \alpha; Markdown \*note\*`);

  const validEscapes = String.raw`{"request_id":"n","content":"line\nnext\tquote\" slash\\ unicode\u0041","tool_calls":[]}`;
  assert.equal(parseDecision(validEscapes, request, { nonce: 'n' }).content, 'line\nnext\tquote" slash\\ unicodeA');
  assert.throws(() => parseDecision(raw, request, { nonce: 'stale' }), e => e.status === 502 && e.code === 'invalid_model_response');
});

test('keeps tool arguments strict and still validates their declared schema', () => {
  const pathTool = { type: 'function', function: { name: 'read_path', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  } } };
  const request = req({ tools: [pathTool], tool_choice: 'required' });
  const raw = String.raw`{"request_id":"n","content":null,"tool_calls":[{"name":"read_path","arguments":{"path":"C:\\Users\\alice\\docs\\draft.txt"}}]}`;
  const decision = parseDecision(raw, request, { nonce: 'n' });
  assert.equal(JSON.parse(decision.tool_calls[0].function.arguments).path, String.raw`C:\Users\alice\docs\draft.txt`);
  const malformedToolArgument = String.raw`{"request_id":"n","content":null,"tool_calls":[{"name":"read_path","arguments":{"path":"C:\Users\alice\docs\draft.txt"}}]}`;
  assert.throws(() => parseDecision(malformedToolArgument, request, { nonce: 'n' }), e => e.status === 502 && e.code === 'invalid_model_response');

  const invalidSchemaValue = String.raw`{"request_id":"n","content":null,"tool_calls":[{"name":"read_path","arguments":{"path":42}}]}`;
  assert.throws(() => parseDecision(invalidSchemaValue, request, { nonce: 'n' }), e => e.status === 502 && e.code === 'invalid_model_response');
});

test('does not guess malformed unicode, escaped quotes, or trailing backslashes', () => {
  const request = req();
  for (const raw of [
    String.raw`{"request_id":"n","content":"bad unicode \u12G4","tool_calls":[]}`,
    String.raw`{"request_id":"n","content":"bad "quote"","tool_calls":[]}`,
    String.raw`{"request_id":"n","content":"trailing slash \","tool_calls":[]}`,
  ]) {
    assert.throws(() => parseDecision(raw, request, { nonce: 'n' }), e => e.status === 502 && e.code === 'invalid_model_response');
  }
});

test('validates tool arguments and emits unique OpenAI tool call IDs', () => {
  const request = req({ tool_choice: 'required' });
  const decision = parseDecision(envelope('n', {
    content: null,
    tool_calls: [
      { name: 'add', arguments: { a: 2, b: 3 } },
      { name: 'add', arguments: { a: 4, b: 5 } },
    ],
  }), request, { nonce: 'n' });
  assert.equal(decision.finish_reason, 'tool_calls');
  assert.equal(decision.content, null);
  assert.equal(decision.tool_calls.length, 2);
  assert.notEqual(decision.tool_calls[0].id, decision.tool_calls[1].id);
  assert.equal(JSON.parse(decision.tool_calls[0].function.arguments).a, 2);
  assert.throws(() => parseDecision(envelope('n', { content: null, tool_calls: [{ name: 'add', arguments: { a: 'x', b: 3 } }] }), request, { nonce: 'n' }), ProtocolError);
});

test('enforces named, required, and none tool choices', () => {
  const named = req({ tool_choice: { type: 'function', function: { name: 'add' } } });
  assert.equal(parseDecision(envelope('n', { content: null, tool_calls: [{ name: 'add', arguments: { a: 1, b: 2 } }] }), named, { nonce: 'n' }).finish_reason, 'tool_calls');
  assert.throws(() => parseDecision(envelope('n'), named, { nonce: 'n' }), ProtocolError);
  const required = req({ tool_choice: 'required' });
  assert.throws(() => parseDecision(envelope('n'), required, { nonce: 'n' }), ProtocolError);
  const none = req({ tool_choice: 'none' });
  assert.equal(parseDecision(envelope('n'), none, { nonce: 'n' }).finish_reason, 'stop');
  assert.throws(() => parseDecision(envelope('n', { content: null, tool_calls: [{ name: 'add', arguments: { a: 1, b: 2 } }] }), none, { nonce: 'n' }), ProtocolError);
});

test('rejects malformed, multimodal, orphaned, incomplete, and oversized requests without truncation', () => {
  assert.throws(() => req({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] }] }), /plain text/);
  assert.throws(() => req({ messages: [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'orphan', content: 'x' }] }), /does not match/);
  assert.throws(() => req({ messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'pending', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":2}' } }] }] }), /ends before/);
  assert.throws(() => normalizeRequest({ model: 'm', messages: [{ role: 'user', content: 'a'.repeat(100) }] }, { maxChars: 32 }), e => e.status === 413 && e.code === 'context_length_exceeded');
  assert.equal(req({ stream: true }).stream, true);
});

test('does not leak prompt or schema values in validation errors', () => {
  assert.throws(() => req({ messages: [{ role: 'user', content: 'private words', image: 'secret payload' }] }), e => {
    assert.equal(e.message, 'Unexpected field.');
    assert.equal(JSON.stringify(e).includes('private words'), false);
    assert.equal(JSON.stringify(e).includes('secret payload'), false);
    return true;
  });
});

test('accepts actual OpenCode draft-2020-12 schemas and validates standard string formats', () => {
  const tool = structuredClone(add);
  tool.function.parameters.$schema = 'https://json-schema.org/draft/2020-12/schema';
  const request = req({ tools: [tool] });
  assert.equal(parseDecision(envelope('n', { content: null, tool_calls: [{ name: 'add', arguments: { a: 1, b: 2 } }] }), request, { nonce: 'n' }).finish_reason, 'tool_calls');
  const uriTool = { type: 'function', function: { name: 'fetch_url', parameters: { type: 'object',
    properties: { url: { type: 'string', format: 'uri' } }, required: ['url'], additionalProperties: false } } };
  const withUri = req({ tools: [uriTool] });
  assert.throws(() => parseDecision(envelope('n', { content: null, tool_calls: [{ name: 'fetch_url', arguments: { url: 'not a URL' } }] }), withUri, { nonce: 'n' }), ProtocolError);
});

test('accepts buffered streaming requests and preserves validated OpenCode generation hints', () => {
  const request = req({
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 120,
    max_completion_tokens: 100,
    temperature: 0.4,
    top_p: 0.9,
    parallel_tool_calls: false,
    n: 1,
    user: 'client-user',
  });
  assert.equal(request.stream, true);
  assert.equal(request.includeUsage, true);
  assert.deepEqual(request.generationHints, {
    max_tokens: 120,
    max_completion_tokens: 100,
    temperature: 0.4,
    top_p: 0.9,
    parallel_tool_calls: false,
    n: 1,
    user: 'client-user',
  });
  assert.match(buildPrompt(request, { nonce: 'n' }), /"temperature":0.4/);
  assert.match(buildPrompt(request, { nonce: 'n' }), /encode every literal backslash/);
  assert.throws(() => req({ temperature: 2.1 }), ProtocolError);
  assert.throws(() => req({ top_p: -0.1 }), ProtocolError);
  assert.throws(() => req({ max_tokens: 0 }), ProtocolError);
  assert.throws(() => req({ n: 2 }), ProtocolError);
  assert.throws(() => req({ parallel_tool_calls: 'false' }), ProtocolError);
});

test('does not revalidate historical tools against current definitions or apply none to past turns', () => {
  const request = req({
    tool_choice: 'none',
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'older', type: 'function', function: { name: 'removed_tool', arguments: '{"old":true}' } }] },
      { role: 'tool', tool_call_id: 'older', content: 'historical result' },
      { role: 'user', content: 'Respond now.' },
    ],
  });
  assert.equal(request.messages[0].tool_calls[0].function.name, 'removed_tool');
  assert.equal(parseDecision(envelope('n'), request, { nonce: 'n' }).finish_reason, 'stop');
});

test('rejects parallel calls when disabled and reports malformed model JSON as a 502', () => {
  const request = req({ parallel_tool_calls: false });
  assert.throws(() => parseDecision(envelope('n', {
    content: null,
    tool_calls: [
      { name: 'add', arguments: { a: 1, b: 2 } },
      { name: 'add', arguments: { a: 3, b: 4 } },
    ],
  }), request, { nonce: 'n' }), e => e.status === 502);
  assert.throws(() => parseDecision('not json', request, { nonce: 'n' }), e => e.status === 502 && e.code === 'invalid_model_response');
});

test('bounds message count, tool count, and individual schema size', () => {
  const tooManyTools = Array.from({ length: 129 }, (_, i) => ({ ...add, function: { ...add.function, name: `tool_${i}` } }));
  assert.throws(() => req({ tools: tooManyTools }), /Tool count/);
  assert.throws(() => req({ messages: Array.from({ length: 4097 }, () => ({ role: 'user', content: 'x' })) }), /Message count/);
  assert.throws(() => req({ tools: [{ ...add, function: { ...add.function, parameters: { type: 'object', description: 'x'.repeat(66000) } } }] }), /schema exceeds/);
});

test('rejects duplicate nonce members without echoing model output', () => {
  const request = req();
  const raw = '{"request_id":"stale","request_id":"current","content":"private model text","tool_calls":[]}';
  assert.throws(() => parseDecision(raw, request, { nonce: 'current' }), e => {
    assert.equal(e.status, 502);
    assert.equal(e.code, 'invalid_model_response');
    assert.equal(e.message.includes('private model text'), false);
    assert.equal(e.message.includes(raw), false);
    return true;
  });
});

test('rejects duplicate keys in nested tool arguments, including escaped-equivalent names', () => {
  const request = req();
  const raw = String.raw`{"request_id":"n","content":null,"tool_calls":[{"name":"add","arguments":{"a":1,"\u0061":2,"b":3}}]}`;
  assert.throws(() => parseDecision(raw, request, { nonce: 'n' }), e => e.status === 502 && e.code === 'invalid_model_response');
});

test('accepts Hermes optional tool-result name only when it agrees with the bound call', () => {
  const request = { model: 'muse-web', messages: [
    {role:'user',content:'inspect'},
    {role:'assistant',content:null,tool_calls:[{id:'named-call',type:'function',function:{name:'read_file',arguments:'{"path":"a.txt"}'}}]},
    {role:'tool',tool_call_id:'named-call',name:'read_file',content:'text'},
  ]};
  assert.equal(normalizeRequest(request).messages[2].content,'text');
  request.messages[2].name='another_tool';
  assert.throws(()=>normalizeRequest(request), /does not match/);
});
