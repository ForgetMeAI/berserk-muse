import { appendFile } from 'node:fs/promises';
import { BridgeError } from '../src/errors.mjs';

const safeToolName = /^[a-zA-Z0-9_-]{1,64}$/;

async function event(path, kind, fields = {}) {
  if (!path) return;
  const row = { at: new Date().toISOString(), kind, ...fields };
  await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function canonicalContext(prompt) {
  const marker = 'CANONICAL_CONTEXT_JSON:\n';
  const offset = prompt.indexOf(marker);
  if (offset < 0) throw new Error('Bridge prompt omitted canonical context.');
  const line = prompt.slice(offset + marker.length).split('\n', 1)[0];
  const context = JSON.parse(line);
  if (!context?.request_id || !Array.isArray(context.tools) || !Array.isArray(context.messages)) throw new Error('Bridge prompt has invalid canonical context.');
  return context;
}

function toolMap(context) {
  const result = new Map();
  for (const definition of context.tools) {
    const fn = definition?.function;
    if (typeof fn?.name === 'string' && safeToolName.test(fn.name) && fn.parameters?.type === 'object') result.set(fn.name, fn);
  }
  return result;
}

function resolveTool(tools, candidates) {
  for (const candidate of candidates) if (tools.has(candidate)) return [candidate, tools.get(candidate)];
  throw new Error(`OpenCode did not expose a required local tool (${candidates.join('/')}).`);
}

function schemaArgs(schema, values) {
  const properties = schema.properties ?? {};
  const args = {};
  for (const [name, value] of Object.entries(values)) if (Object.hasOwn(properties, name)) args[name] = value;
  for (const required of schema.required ?? []) {
    if (Object.hasOwn(args, required)) continue;
    if (Object.hasOwn(properties, required) && typeof properties[required].default === 'string') args[required] = properties[required].default;
    else throw new Error(`Cannot form the required ${required} argument from this OpenCode tool schema.`);
  }
  return args;
}

function toolHistory(messages) {
  const pending = new Map();
  const observed = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        try { pending.set(call.id, { name: call.function.name, args: JSON.parse(call.function.arguments) }); } catch {}
      }
    } else if (message.role === 'tool' && pending.has(message.tool_call_id)) {
      const call = pending.get(message.tool_call_id);
      observed.push({ ...call, result: String(message.content ?? '') });
      pending.delete(message.tool_call_id);
    }
  }
  return observed;
}

function extractOldReturn(readResult) {
  const line = readResult.split('\n').find(item => /return\s+[^;]+;/.test(item));
  const match = line?.match(/return\s+[^;]+;/);
  if (!match || !match[0].includes('price') || !match[0].includes('discount')) throw new Error('Read tool result did not contain the expected invoice calculation.');
  return match[0];
}

function summarizeEvidence(history) {
  for (const item of [...history].reverse()) {
    if (item.name === 'bash') {
      if (String(item.args.command ?? '').includes('node --test') && /16\.5/.test(item.result) && /37/.test(item.result)) return 'red-failure';
      if (String(item.args.command ?? '').includes('node --test') && /pass\s+1/.test(item.result)) return 'green-pass';
    }
    if (item.name === 'read' && String(item.args.filePath ?? '').endsWith('PROOF.txt') && item.result.includes('BERSERK_AGENT_E2E_OK')) return 'proof-read';
  }
  return null;
}

export function createScriptedDriver({ evidencePath }) {
  let previousHistory = [];
  let calls = 0;
  return {
    async status() { return { ready: true, state: 'scripted-test' }; },
    async generate(prompt, { signal, nonce }) {
      if (calls >= 16) throw new BridgeError('Scripted test did not progress within its tool budget.', 422, 'scripted_progress_failure');
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const context = canonicalContext(prompt);
      if (context.request_id !== nonce) throw new Error('Bridge nonce mismatch.');
      const history = toolHistory(context.messages);
      const historyKey = JSON.stringify(history.map(({ name, args }) => ({ name, args })));
      const previousKey = JSON.stringify(previousHistory.map(({ name, args }) => ({ name, args })));
      if (historyKey !== previousKey) {
        previousHistory = history;
        const summary = summarizeEvidence(history);
        if (summary) await event(evidencePath, 'observed', { stage: summary });
      }
      const tools = toolMap(context);
      const initialRead = history.find(item => item.name === 'read' && String(item.args.filePath ?? '').endsWith('src/invoice.mjs'));
      const redRun = history.find(item => item.name === 'bash' && String(item.args.command ?? '').includes('node --test') && /16\.5/.test(item.result) && /37/.test(item.result));
      const edit = history.find(item => item.name === 'edit' && String(item.args.filePath ?? '').endsWith('src/invoice.mjs'));
      const greenRun = history.find(item => item.name === 'bash' && String(item.args.command ?? '').includes('node --test') && /pass\s+1/.test(item.result));
      const proofWrite = history.find(item => ['write', 'edit'].includes(item.name) && String(item.args.filePath ?? '').endsWith('PROOF.txt'));
      const proofRead = history.find(item => item.name === 'read' && String(item.args.filePath ?? '').endsWith('PROOF.txt') && item.result.includes('BERSERK_AGENT_E2E_OK'));
      let selected;
      if (!initialRead) {
        const [name, def] = resolveTool(tools, ['read']);
        selected = { name, args: schemaArgs(def.parameters, { filePath: 'src/invoice.mjs' }) };
      } else if (!redRun) {
        const [name, def] = resolveTool(tools, ['bash']);
        selected = { name, args: schemaArgs(def.parameters, { command: 'node --test tests/invoice.test.mjs', description: 'Run the immutable invoice test and observe the current failure.' }) };
      } else if (!edit) {
        const [name, def] = resolveTool(tools, ['edit']);
        const oldString = extractOldReturn(initialRead.result);
        selected = { name, args: schemaArgs(def.parameters, { filePath: 'src/invoice.mjs', oldString, newString: 'return price * quantity - discount;' }) };
      } else if (!greenRun) {
        const [name, def] = resolveTool(tools, ['bash']);
        selected = { name, args: schemaArgs(def.parameters, { command: 'node --test tests/invoice.test.mjs', description: 'Run the unchanged invoice test after the source edit.' }) };
      } else if (!proofWrite) {
        const [name, def] = resolveTool(tools, ['write']);
        selected = { name, args: schemaArgs(def.parameters, { filePath: 'PROOF.txt', content: 'BERSERK_AGENT_E2E_OK\n' }) };
      } else if (!proofRead) {
        const [name, def] = resolveTool(tools, ['read']);
        selected = { name, args: schemaArgs(def.parameters, { filePath: 'PROOF.txt' }) };
      }
      calls += 1;
      if (selected) {
        await event(evidencePath, 'selected', { ordinal: calls, name: selected.name, stage: selected.args.command?.includes('node --test') ? (redRun ? 'green-test' : 'red-test') : selected.name === 'edit' ? 'source-edit' : String(selected.args.filePath ?? '').endsWith('PROOF.txt') ? (selected.name === 'read' ? 'proof-read' : 'proof') : 'source-read' });
        return { text: JSON.stringify({ request_id: nonce, content: null, tool_calls: [{ name: selected.name, arguments: selected.args }] }) };
      }
      await event(evidencePath, 'selected', { ordinal: calls, name: 'text', stage: 'final' });
      return { text: JSON.stringify({ request_id: nonce, content: 'Invoice calculation fixed; the unchanged test passed and the proof file was read back.', tool_calls: [] }) };
    },
  };
}
