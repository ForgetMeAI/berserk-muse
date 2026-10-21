import { randomUUID } from 'node:crypto';

const UNSUPPORTED_OPTION = Symbol.for('berserk.anthropic.unsupportedOptions');
const MAX_CONTENT_BLOCKS = 4096;
const MAX_SSE_CHARS = 1024 * 1024;

export class AnthropicProtocolError extends Error {
  constructor(message, code = 'invalid_request_error', status = 400) {
    super(message);
    this.name = 'AnthropicProtocolError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code) { throw new AnthropicProtocolError(message, code); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function textOnly(value, label) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length > MAX_CONTENT_BLOCKS) fail(`${label} must contain text blocks only.`);
  return value.map(block => {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') fail(`${label} supports text blocks only.`);
    return block.text;
  }).join('');
}

function systemText(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length > MAX_CONTENT_BLOCKS) fail('system must be text or text blocks.');
  return value.map(block => {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') fail('system supports text blocks only.');
    return block.text;
  }).join('');
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4096) fail('messages must be a non-empty array.');
  const out = [];
  const seenIds = new Set();
  for (const [index, message] of messages.entries()) {
    if (!record(message) || !['user', 'assistant'].includes(message.role)) fail(`messages[${index}] has an unsupported role.`);
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content) || message.content.length > MAX_CONTENT_BLOCKS) fail(`messages[${index}].content must be text or supported content blocks.`);
    if (message.role === 'assistant') {
      const text = [];
      const calls = [];
      for (const block of message.content) {
        if (!record(block)) fail(`messages[${index}].content contains an invalid block.`);
        if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
        else if (block.type === 'tool_use') {
          if (typeof block.id !== 'string' || !block.id || block.id.length > 128 || seenIds.has(block.id) ||
              typeof block.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(block.name) || !record(block.input)) {
            fail(`messages[${index}] contains an invalid tool_use block.`);
          }
          seenIds.add(block.id);
          calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
        } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') {
          fail(`messages[${index}] uses unsupported content.`);
        }
      }
      out.push({ role: 'assistant', content: calls.length ? (text.join('') || null) : text.join(''), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Keep text and tool results in their original order. Splitting a user turn
    // into adjacent messages is supported by the internal prompt protocol.
    let text = [];
    const flushText = () => { if (text.length) { out.push({ role: 'user', content: text.join('') }); text = []; } };
    for (const block of message.content) {
      if (!record(block)) fail(`messages[${index}].content contains an invalid block.`);
      if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      else if (block.type === 'tool_result') {
        if (typeof block.tool_use_id !== 'string' || !block.tool_use_id || block.tool_use_id.length > 128) fail(`messages[${index}] contains an invalid tool_result block.`);
        flushText();
        const content = textOnly(block.content, `messages[${index}].tool_result.content`);
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.is_error === true ? `Tool error: ${content}` : content });
      } else fail(`messages[${index}] uses unsupported content.`);
    }
    flushText();
    if (message.content.length === 0) out.push({ role: 'user', content: '' });
  }
  return out;
}

function normalizeTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.length > 128) fail('tools must be an array.');
  return tools.map((tool, index) => {
    if (!record(tool) || (tool.type !== undefined && tool.type !== 'custom') || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
        !record(tool.input_schema) || tool.input_schema.type !== 'object') fail(`tools[${index}] is unsupported.`);
    return { type: 'function', function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.input_schema } };
  });
}

function normalizeChoice(choice, tools) {
  if (choice === undefined) return 'auto';
  if (!record(choice)) fail('tool_choice must be an object.');
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string' && tools?.some(t => t.function.name === choice.name)) {
    return { type: 'function', function: { name: choice.name } };
  }
  fail('tool_choice is unsupported or names an unavailable tool.');
}

/** Converts the supported Anthropic Messages request subset to the bridge's OpenAI-style raw request. */
export function anthropicToChat(body, { countOnly = false } = {}) {
  if (!record(body)) fail('Request body must be an object.');
  if (typeof body.model !== 'string' || !body.model.trim()) fail('model is required.');
  if (!countOnly && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) fail('max_tokens must be a positive integer.');
  if (countOnly && body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) fail('max_tokens must be a positive integer.');
  const tools = normalizeTools(body.tools);
  if (body.tool_choice?.disable_parallel_tool_use !== undefined && typeof body.tool_choice.disable_parallel_tool_use !== 'boolean') fail('disable_parallel_tool_use must be a boolean.');
  const messages = normalizeMessages(body.messages);
  const system = systemText(body.system);
  if (system !== undefined) messages.unshift({ role: 'system', content: system });
  const out = {
    model: body.model,
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(body.tool_choice === undefined ? {} : { tool_choice: normalizeChoice(body.tool_choice, tools) }),
    ...(body.tool_choice?.disable_parallel_tool_use === true ? { parallel_tool_calls: false } : {}),
    ...(countOnly ? {} : { max_tokens: body.max_tokens }),
    ...(body.stream === undefined || countOnly ? {} : { stream: body.stream }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
  };
  for (const key of ['temperature', 'top_p']) {
    if (out[key] !== undefined && (typeof out[key] !== 'number' || !Number.isFinite(out[key]) || out[key] < 0 || out[key] > (key === 'temperature' ? 2 : 1))) fail(`${key} is outside the supported range.`);
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('stream must be a boolean.');
  if (body.metadata !== undefined && !record(body.metadata)) fail('metadata must be an object.');
  // Thinking and output_config are accepted for Claude Code compatibility but
  // do not affect the Muse generation. Mark that loss without pretending to
  // produce Anthropic reasoning or constrained-format output.
  const unsupported = [];
  if (body.thinking !== undefined && body.thinking?.type !== 'disabled') unsupported.push('thinking');
  if (body.output_config !== undefined) unsupported.push('output_config');
  if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || body.stop_sequences.some(x => typeof x !== 'string'))) fail('stop_sequences must be an array of strings.');
  if (body.stop_sequences?.length) unsupported.push('stop_sequences');
  Object.defineProperty(out, UNSUPPORTED_OPTION, { value: unsupported, enumerable: false });
  return out;
}

export function anthropicUnsupportedOptions(body) {
  return body?.[UNSUPPORTED_OPTION] ?? [];
}

/** Converts a validated OpenAI-style completion into the Anthropic Message response shape. */
export function chatToAnthropic(response) {
  const choice = response?.choices?.[0];
  const source = choice?.message;
  if (!record(source)) fail('Completion response is invalid.', 'invalid_model_response');
  const content = [];
  if (typeof source.content === 'string' && source.content.length) content.push({ type: 'text', text: source.content });
  for (const call of source.tool_calls ?? []) {
    let input;
    try { input = JSON.parse(call.function.arguments); } catch { fail('Completion tool arguments are invalid.', 'invalid_model_response'); }
    if (!record(input)) fail('Completion tool arguments are invalid.', 'invalid_model_response');
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  const usage = response.usage ?? {};
  const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: typeof response.id === 'string' && response.id.startsWith('msg_') ? response.id : `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message', role: 'assistant', content, model: response.model,
    stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : 0,
      output_tokens: Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : 0 },
    ...(response.muse_usage ? { muse_usage: response.muse_usage } : {}),
  };
}

function sse(res, event, data) {
  if (res.destroyed || res.writableEnded) throw new Error('client_disconnected');
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (Buffer.byteLength(frame) > MAX_SSE_CHARS) throw new Error('anthropic_sse_frame_too_large');
  if (res.write(frame)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.removeListener('drain', onDrain); res.removeListener('close', onClose); res.removeListener('error', onClose); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('client_disconnected')); };
    res.once('drain', onDrain); res.once('close', onClose); res.once('error', onClose);
  });
}

/** Sends one buffered Anthropic SSE lifecycle. Muse itself does not stream model tokens. */
export async function sendAnthropicSSE(res, message) {
  const textSize = (message?.content ?? []).reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : JSON.stringify(block.input ?? {}).length), 0);
  if (!Number.isSafeInteger(textSize) || textSize > MAX_SSE_CHARS) throw new Error('anthropic_response_too_large');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Muse-Streaming': 'buffered' });
  const startMessage = { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } };
  await sse(res, 'message_start', { type: 'message_start', message: startMessage });
  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index];
    if (block.type === 'text') {
      await sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      if (block.text) await sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'tool_use') {
      await sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      await sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else throw new Error('unsupported_anthropic_response_block');
    await sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  }
  await sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  await sse(res, 'message_stop', { type: 'message_stop' });
  if (!res.destroyed && !res.writableEnded) res.end();
}

export function anthropicError(status, code, message) {
  const type = status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
  const safeCode = typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(code) ? code : 'request_failed';
  const safeMessage = typeof message === 'string' && message.length <= 240 && !/[\u0000-\u001f\u007f]/.test(message) ? message : 'The request could not be completed.';
  return { type: 'error', error: { type, message: safeMessage, code: safeCode } };
}
