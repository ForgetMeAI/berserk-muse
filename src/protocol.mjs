import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv2019 from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';

const options = { allErrors: true, strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false, addUsedSchema: false, logger: false };
const validators = [new Ajv(options), new Ajv2019(options), new Ajv2020(options)];
for (const validator of validators) addFormats(validator);
function compileSchema(schema) {
  const dialect = schema.$schema || '';
  return validators[dialect.includes('2020-12') ? 2 : dialect.includes('2019-09') ? 1 : 0].compile(schema);
}
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const SAFE_LABEL = /^[a-zA-Z0-9_.-]{1,80}$/;
const MAX_TOOLS = 128;
const MAX_MESSAGES = 4096;
const MAX_SCHEMA_CHARS = 65536;

export class ProtocolError extends Error {
  constructor(message, status = 400, code = 'invalid_request_error', param = null) {
    super(message);
    this.name = 'ProtocolError';
    this.status = status;
    this.code = code;
    this.param = param;
    this.type = 'invalid_request_error';
  }
}

function fail(message, param = null, code = 'invalid_request_error') {
  throw new ProtocolError(message, 400, code, param && SAFE_LABEL.test(param) ? param : null);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, required, param) {
  if (!isRecord(value)) fail('Expected an object.', param);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('Unexpected field.', `${param}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail('Missing required field.', `${param}.${key}`);
  }
}

function textContent(value, param, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part, index) => {
      const p = `${param}.${index}`;
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string' || Object.keys(part).some(k => !['type', 'text'].includes(k))) {
        fail('Only plain text message content is supported.', p);
      }
      return part.text;
    }).join('');
  }
  fail('Message content must be text.', param);
}

function normalizeToolDefinition(tool, index) {
  const p = `tools.${index}`;
  exactKeys(tool, ['type', 'function'], ['type', 'function'], p);
  if (tool.type !== 'function') fail('Only function tools are supported.', `${p}.type`);
  exactKeys(tool.function, ['name', 'description', 'parameters', 'strict'], ['name', 'parameters'], `${p}.function`);
  const { name, description, parameters, strict } = tool.function;
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) fail('Invalid function name.', `${p}.function.name`);
  if (description !== undefined && typeof description !== 'string') fail('Invalid function description.', `${p}.function.description`);
  if (strict !== undefined && typeof strict !== 'boolean') fail('Invalid strict setting.', `${p}.function.strict`);
  if (!isRecord(parameters) || parameters.type !== 'object') fail('Function parameters must be an object schema.', `${p}.function.parameters`);
  if (JSON.stringify(parameters).length > MAX_SCHEMA_CHARS) fail('Function parameter schema exceeds the configured limit.', `${p}.function.parameters`);
  try {
    compileSchema(parameters);
  } catch {
    fail('Invalid function parameter schema.', `${p}.function.parameters`);
  }
  return { type: 'function', function: structuredClone(tool.function) };
}

function normalizeToolChoice(choice, tools) {
  if (choice === undefined) return 'auto';
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  exactKeys(choice, ['type', 'function'], ['type', 'function'], 'tool_choice');
  if (choice.type !== 'function') fail('Unsupported tool choice.', 'tool_choice.type');
  exactKeys(choice.function, ['name'], ['name'], 'tool_choice.function');
  const name = choice.function.name;
  if (typeof name !== 'string' || !tools.some(t => t.function.name === name)) fail('Unknown function in tool choice.', 'tool_choice.function.name');
  return { type: 'function', function: { name } };
}

function normalizeHistoryToolCalls(calls, index, pending, seenIds) {
  if (!Array.isArray(calls)) fail('Assistant tool calls must be an array.', `messages.${index}.tool_calls`);
  for (let j = 0; j < calls.length; j += 1) {
    const call = calls[j];
    const p = `messages.${index}.tool_calls.${j}`;
    exactKeys(call, ['id', 'type', 'function'], ['id', 'type', 'function'], p);
    if (typeof call.id !== 'string' || !call.id || seenIds.has(call.id)) fail('Invalid or duplicate tool call ID.', `${p}.id`);
    if (call.type !== 'function') fail('Unsupported tool call type.', `${p}.type`);
    exactKeys(call.function, ['name', 'arguments'], ['name', 'arguments'], `${p}.function`);
    if (typeof call.function.name !== 'string' || call.function.name.length < 1 || call.function.name.length > 128) fail('Invalid historical function name.', `${p}.function.name`);
    if (typeof call.function.arguments !== 'string') fail('Tool arguments must be JSON text.', `${p}.function.arguments`);
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { fail('Tool arguments must be valid JSON.', `${p}.function.arguments`); }
    if (!isRecord(args)) fail('Tool arguments must be a JSON object.', `${p}.function.arguments`);
    pending.set(call.id, call.function.name);
    seenIds.add(call.id);
  }
}

function validateArguments(tools, name, args, param = 'arguments') {
  const schema = tools.find(t => t.function.name === name)?.function.parameters;
  if (!schema) fail('Unknown function.', param);
  let validator;
  try { validator = compileSchema(schema); } catch { fail('Invalid function parameter schema.', param); }
  if (!validator(args)) fail('Function arguments do not match the declared schema.', param);
}

export function normalizeRequest(body, { maxChars = 250000 } = {}) {
  if (!isRecord(body)) fail('Request body must be an object.');
  exactKeys(body, ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'parallel_tool_calls', 'n', 'user'], ['model', 'messages'], 'request');
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be a positive safe integer');
  let rawChars;
  try { rawChars = JSON.stringify(body).length; } catch { fail('Request body must be JSON serializable.'); }
  if (rawChars > maxChars) throw new ProtocolError('Request context exceeds the configured limit.', 413, 'context_length_exceeded', 'messages');
  if (typeof body.model !== 'string' || !body.model.trim()) fail('A model is required.', 'model');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('stream must be a boolean.', 'stream');
  if (!Array.isArray(body.messages) || body.messages.length === 0) fail('At least one message is required.', 'messages');
  if (body.messages.length > MAX_MESSAGES) fail('Message count exceeds the configured limit.', 'messages');
  if (body.tools !== undefined && !Array.isArray(body.tools)) fail('tools must be an array.', 'tools');
  if ((body.tools ?? []).length > MAX_TOOLS) fail('Tool count exceeds the configured limit.', 'tools');
  const tools = (body.tools ?? []).map(normalizeToolDefinition);
  if (new Set(tools.map(t => t.function.name)).size !== tools.length) fail('Tool names must be unique.', 'tools');
  const toolChoice = normalizeToolChoice(body.tool_choice, tools);
  if (toolChoice !== 'auto' && toolChoice !== 'none' && tools.length === 0) fail('tool_choice requires tools.', 'tool_choice');
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) fail(`${key} must be a positive integer.`, key);
  }
  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) fail('temperature must be between 0 and 2.', 'temperature');
  if (body.top_p !== undefined && (typeof body.top_p !== 'number' || !Number.isFinite(body.top_p) || body.top_p < 0 || body.top_p > 1)) fail('top_p must be between 0 and 1.', 'top_p');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls must be a boolean.', 'parallel_tool_calls');
  if (body.n !== undefined && body.n !== 1) fail('Only one completion is supported.', 'n');
  if (body.user !== undefined && typeof body.user !== 'string') fail('user must be a string.', 'user');
  let includeUsage = false;
  if (body.stream_options !== undefined) {
    exactKeys(body.stream_options, ['include_usage'], [], 'stream_options');
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean') fail('include_usage must be a boolean.', 'stream_options.include_usage');
    includeUsage = body.stream_options.include_usage === true;
  }

  const pending = new Map();
  const seenIds = new Set();
  const messages = body.messages.map((message, index) => {
    const p = `messages.${index}`;
    if (!isRecord(message) || !ROLES.has(message.role)) fail('Invalid message role.', `${p}.role`);
    if (message.role === 'tool') {
      exactKeys(message, ['role', 'tool_call_id', 'content', 'name'], ['role', 'tool_call_id', 'content'], p);
      if (typeof message.tool_call_id !== 'string' || !pending.has(message.tool_call_id)) fail('Tool result does not match a pending tool call.', `${p}.tool_call_id`);
      if (message.name !== undefined && message.name !== pending.get(message.tool_call_id)) fail('Tool result name does not match its tool call.', `${p}.name`);
      pending.delete(message.tool_call_id);
      return { role: 'tool', tool_call_id: message.tool_call_id, content: textContent(message.content, `${p}.content`) };
    }
    const allowed = message.role === 'assistant' ? ['role', 'content', 'name', 'tool_calls'] : ['role', 'content', 'name'];
    exactKeys(message, allowed, ['role', 'content'], p);
    if (message.name !== undefined && typeof message.name !== 'string') fail('Invalid message name.', `${p}.name`);
    const content = textContent(message.content, `${p}.content`, { nullable: message.role === 'assistant' && Array.isArray(message.tool_calls) });
    const normalized = { role: message.role, content };
    if (message.name !== undefined) normalized.name = message.name;
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      normalizeHistoryToolCalls(message.tool_calls, index, pending, seenIds);
      normalized.tool_calls = structuredClone(message.tool_calls);
    }
    return normalized;
  });
  if (pending.size) fail('Conversation history ends before all tool calls have results.', 'messages');
  const generationHints = {};
  for (const key of ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'parallel_tool_calls', 'n', 'user']) {
    if (body[key] !== undefined) generationHints[key] = body[key];
  }
  const request = { model: body.model, messages, tools, toolChoice, stream: body.stream === true, includeUsage, generationHints };
  const chars = JSON.stringify(request).length;
  if (chars > maxChars) throw new ProtocolError('Request context exceeds the configured limit.', 413, 'context_length_exceeded', 'messages');
  return request;
}

export function buildPrompt(request, { nonce } = {}) {
  if (typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 200) fail('A valid request nonce is required.', 'nonce');
  const context = {
    request_id: nonce,
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.toolChoice,
    generation_hints: request.generationHints ?? {},
  };
  return [
    'You are a decision planner for a local API adapter. Read the complete canonical context below.',
    'Never execute, simulate, or claim to execute a tool. Do not use Muse built-in tools, create goals or tasks, schedule actions, or interact with connected services. You may only select the next local tool call; the client executes all actions.',
    'Return exactly one JSON object with exactly these fields: request_id, content, tool_calls.',
    'Set request_id to the supplied request_id exactly. Set content to a plain text string for a user-facing reply, or null when selecting tools.',
    'Set tool_calls to an array. Each item has exactly name and arguments; arguments must be a JSON object matching that tool schema. Use [] when replying with content.',
    'Respect tool_choice. For none, return text and no calls. For required, select at least one tool. For a named choice, call only that function.',
    'Do not add commentary, markdown, or fields outside the JSON envelope.',
    'CANONICAL_CONTEXT_JSON:',
    JSON.stringify(context),
  ].join('\n');
}

function rejectDuplicateJsonKeys(source) {
  let index = 0;
  const whitespace = () => { while (index < source.length && /\s/.test(source[index])) index += 1; };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (char === '\\') index += 2;
      else index += 1;
    }
    throw new SyntaxError();
  };
  const parseValue = depth => {
    if (depth > 512) throw new SyntaxError();
    whitespace();
    const char = source[index];
    if (char === '{') {
      index += 1;
      whitespace();
      const keys = new Set();
      if (source[index] === '}') { index += 1; return; }
      while (index < source.length) {
        whitespace();
        if (source[index] !== '"') throw new SyntaxError();
        const key = readString();
        if (keys.has(key)) throw new SyntaxError();
        keys.add(key);
        whitespace();
        if (source[index] !== ':') throw new SyntaxError();
        index += 1;
        parseValue(depth + 1);
        whitespace();
        if (source[index] === '}') { index += 1; return; }
        if (source[index] !== ',') throw new SyntaxError();
        index += 1;
      }
      throw new SyntaxError();
    }
    if (char === '[') {
      index += 1;
      whitespace();
      if (source[index] === ']') { index += 1; return; }
      while (index < source.length) {
        parseValue(depth + 1);
        whitespace();
        if (source[index] === ']') { index += 1; return; }
        if (source[index] !== ',') throw new SyntaxError();
        index += 1;
      }
      throw new SyntaxError();
    }
    if (char === '"') { readString(); return; }
    const start = index;
    while (index < source.length && !/[\s,\]}]/.test(source[index])) index += 1;
    if (index === start) throw new SyntaxError();
  };

  parseValue(0);
  whitespace();
  if (index !== source.length) throw new SyntaxError();
}

function parseModelJson(text) {
  if (typeof text !== 'string') fail('Model response must be text.', null, 'invalid_model_response');
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1];
  try {
    rejectDuplicateJsonKeys(candidate);
    return JSON.parse(candidate);
  } catch {
    throw new ProtocolError('Model returned an invalid decision envelope.', 502, 'invalid_model_response');
  }
}

export function parseDecision(text, request, { nonce } = {}) {
  const envelope = parseModelJson(text);
  try { exactKeys(envelope, ['request_id', 'content', 'tool_calls'], ['request_id', 'content', 'tool_calls'], 'response'); }
  catch { throw new ProtocolError('Model returned an invalid decision envelope.', 502, 'invalid_model_response'); }
  if (envelope.request_id !== nonce) throw new ProtocolError('Model response does not match this request.', 502, 'invalid_model_response');
  if (envelope.content !== null && typeof envelope.content !== 'string') throw new ProtocolError('Model returned an invalid decision envelope.', 502, 'invalid_model_response');
  if (!Array.isArray(envelope.tool_calls)) throw new ProtocolError('Model returned an invalid decision envelope.', 502, 'invalid_model_response');
  const choice = request.toolChoice ?? 'auto';
  if (request.generationHints?.parallel_tool_calls === false && envelope.tool_calls.length > 1) throw new ProtocolError('Model returned too many tool calls.', 502, 'invalid_model_response');
  if (!request.tools?.length && envelope.tool_calls.length) throw new ProtocolError('Model selected an unavailable tool.', 502, 'invalid_model_response');
  if (choice === 'none' && envelope.tool_calls.length) throw new ProtocolError('Model selected a disallowed tool.', 502, 'invalid_model_response');
  if (choice === 'required' && envelope.tool_calls.length === 0) throw new ProtocolError('Model did not select a required tool.', 502, 'invalid_model_response');
  if (typeof choice === 'object' && envelope.tool_calls.length === 0) throw new ProtocolError('Model did not select the required function.', 502, 'invalid_model_response');
  if (typeof choice === 'object' && envelope.tool_calls.some(call => call?.name !== choice.function.name)) throw new ProtocolError('Model selected a disallowed tool.', 502, 'invalid_model_response');
  if (envelope.tool_calls.length > 0 && envelope.content !== null) throw new ProtocolError('Tool decisions must have null content.', 502, 'invalid_model_response');
  if (envelope.tool_calls.length === 0 && typeof envelope.content !== 'string') throw new ProtocolError('A text decision must contain content.', 502, 'invalid_model_response');
  const toolCalls = envelope.tool_calls.map((call, index) => {
    const param = `tool_calls.${index}`;
    try { exactKeys(call, ['name', 'arguments'], ['name', 'arguments'], param); }
    catch { throw new ProtocolError('Model returned an invalid tool decision.', 502, 'invalid_model_response'); }
    if (typeof call.name !== 'string' || !request.tools.some(t => t.function.name === call.name)) throw new ProtocolError('Model selected an unknown tool.', 502, 'invalid_model_response');
    if (!isRecord(call.arguments)) throw new ProtocolError('Model returned invalid tool arguments.', 502, 'invalid_model_response');
    try { validateArguments(request.tools, call.name, call.arguments, param); }
    catch { throw new ProtocolError('Model returned tool arguments that violate the declared schema.', 502, 'invalid_model_response'); }
    return {
      id: `call_${randomUUID().replaceAll('-', '')}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    };
  });
  return toolCalls.length
    ? { content: null, tool_calls: toolCalls, finish_reason: 'tool_calls' }
    : { content: envelope.content, finish_reason: 'stop' };
}
