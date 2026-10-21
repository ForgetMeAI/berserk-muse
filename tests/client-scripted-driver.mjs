import { createBridge } from '../src/server.mjs';

const STEPS = [
  { label: 'red', command: 'node --test /FIXTURE/tests/invoice.test.mjs' },
  { label: 'read', command: 'cat /FIXTURE/invoice.mjs' },
  { label: 'edit', command: `node -e "const fs=require('node:fs');const p='/FIXTURE/invoice.mjs';const s=fs.readFileSync(p,'utf8');const before='return Math.round(subtotal * (1 + taxPercent));';if(!s.includes(before))process.exit(2);fs.writeFileSync(p,s.replace(before,'return Math.round(subtotal * (1 + taxPercent / 100));'));"` },
  { label: 'green', command: 'node --test /FIXTURE/tests/invoice.test.mjs' },
  { label: 'proof-create', command: `node --input-type=module -e "import fs from 'node:fs';import assert from 'node:assert/strict';import {totalWithTax} from '/FIXTURE/invoice.mjs';const checks={standard:totalWithTax(1200,10)===1320,fractional:totalWithTax(100,7.25)===107,zero:totalWithTax(99,0)===99};assert.ok(Object.values(checks).every(Boolean));fs.writeFileSync('/FIXTURE/proof.json',JSON.stringify({kind:'synthetic-invoice-proof',checks})+'\\n');console.log('PROOF artifact written');"` },
  { label: 'proof-read', command: 'cat /FIXTURE/proof.json' },
];

function contextFromPrompt(prompt) {
  const marker = 'CANONICAL_CONTEXT_JSON:\n';
  const at = prompt.lastIndexOf(marker);
  if (at < 0) throw new Error('Canonical context missing');
  return JSON.parse(prompt.slice(at + marker.length));
}

function commandTool(request) {
  for (const tool of request.tools ?? []) {
    const name = tool.function.name;
    if (!/^(bash|terminal)$/i.test(name)) continue;
    const schema = tool.function.parameters;
    const props = schema.properties ?? {};
    const key = ['command', 'cmd', 'script'].find(candidate => candidate in props);
    if (!key) continue;
    const args = { [key]: '' };
    for (const required of schema.required ?? []) {
      if (required === key) continue;
      const property = props[required] ?? {};
      if (property.type === 'string') args[required] = required === 'description' ? 'Run a fixed synthetic verification step' : '';
      else if (property.type === 'integer' || property.type === 'number') args[required] = property.minimum ?? 1;
      else if (property.type === 'boolean') args[required] = false;
      else if (property.type === 'array') args[required] = [];
      else if (property.type === 'object') args[required] = {};
      else return null;
    }
    return { name, key, args };
  }
  return null;
}

export function parseTerminalToolResult(raw) {
  if (typeof raw !== 'string') return { raw: '', text: '', envelope: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        typeof parsed.output === 'string' && Number.isInteger(parsed.exit_code) &&
        Object.hasOwn(parsed, 'error')) {
      return { raw, text: parsed.output, envelope: { exitCode: parsed.exit_code, error: parsed.error } };
    }
  } catch {}
  return { raw, text: raw, envelope: null };
}

export function latestToolResult(context) {
  const message = [...(context.messages ?? [])].reverse().find(item => item?.role === 'tool');
  if (!message) return parseTerminalToolResult('');
  if (typeof message.content === 'string') return parseTerminalToolResult(message.content);
  if (Array.isArray(message.content)) return parseTerminalToolResult(message.content.map(item => typeof item?.text === 'string' ? item.text : '').join('\n'));
  return parseTerminalToolResult('');
}

export function verifyResult(action, result) {
  const decoded = typeof result === 'string' ? parseTerminalToolResult(result) : result;
  const { text, envelope } = decoded;
  const envelopeValid = expectedCode => envelope === null || (envelope.exitCode === expectedCode && envelope.error === null);
  if (action.label === 'red') return envelope === null ? /not ok|AssertionError|ERR_ASSERTION|fail(?:ed)?\s*[:=]?\s*[1-9]/i.test(text) : envelopeValid(1) && /not ok|AssertionError|ERR_ASSERTION|fail(?:ed)?\s*[:=]?\s*[1-9]/i.test(text);
  if (action.label === 'read') return envelopeValid(0) && text.includes('return Math.round(subtotal * (1 + taxPercent));') && !text.includes('taxPercent / 100');
  if (action.label === 'green') return envelopeValid(0) && /fail\s+0/i.test(text) && /pass\s+3/i.test(text);
  if (action.label === 'proof-read') {
    try {
      if (!envelopeValid(0)) return false;
      const artifact = JSON.parse(text);
      const expected = ['fractional', 'standard', 'zero'];
      const actual = artifact?.checks && typeof artifact.checks === 'object' && !Array.isArray(artifact.checks) ? Object.keys(artifact.checks).sort() : [];
      return artifact.kind === 'synthetic-invoice-proof' && actual.length === expected.length && actual.every((key, index) => key === expected[index]) && expected.every(key => artifact.checks[key] === true);
    } catch { return false; }
  }
  return envelopeValid(0);
}

export function scriptedDriver({ fixtureDir, evidence = [] }) {
  let step = 0;
  let generationCalls = 0;
  let closed = false;
  return {
    async status() { return { ready: !closed, mode: 'scripted-real-client-verification' }; },
    async generate(prompt) {
      if (closed) throw new Error('driver closed');
      generationCalls += 1;
      const context = contextFromPrompt(prompt);
      const nonce = context.request_id;
      if (step > 0) {
        const prior = STEPS[step - 1];
        const result = latestToolResult(context);
        const blocked = /BLOCKED:|User denied this command|"status"\s*:\s*"blocked"/i.test(`${result.raw}\n${result.text}`);
        const verified = verifyResult(prior, result);
        const excerpt = result.text.slice(-700).replaceAll(fixtureDir, '[fixture]').replace(/[\r\n]+/g, ' ').replace(/muse-local/g, '[local-key]');
        evidence[evidence.length - 1] = { ...evidence[evidence.length - 1], resultVerified: verified, resultBytes: Buffer.byteLength(result.raw), resultEnvelope: result.envelope !== null, resultExitCode: result.envelope?.exitCode ?? null, resultErrorIsNull: result.envelope === null ? null : result.envelope.error === null, resultExcerpt: excerpt };
        if (blocked) throw new Error(`Synthetic tool action ${prior.label} was blocked; stop this client run without retrying`);
        if (!verified) throw new Error(`Synthetic tool result for ${prior.label} did not meet the expected check`);
      }
      if (step >= STEPS.length) {
        return { text: JSON.stringify({ request_id: nonce, content: 'Synthetic verification complete: RED reproduced, source read and corrected, GREEN tests passed, and proof checks passed.', tool_calls: [] }) };
      }
      const tool = commandTool(context);
      if (!tool) throw new Error('No supported Bash/terminal command tool in client request');
      const action = STEPS[step++];
      const command = action.command.replaceAll('/FIXTURE', fixtureDir);
      tool.args[tool.key] = command;
      if ('description' in tool.args) tool.args.description = `Synthetic ${action.label} verification step`;
      evidence.push({ step: action.label, tool: tool.name, resultVerified: null });
      return { text: JSON.stringify({ request_id: nonce, content: null, tool_calls: [{ name: tool.name, arguments: tool.args }] }) };
    },
    async close() { closed = true; },
    get completedSteps() { return step; },
    get generationCalls() { return generationCalls; },
  };
}

export async function startScriptedBridge(options) {
  const driver = scriptedDriver(options);
  const bridge = createBridge({ driver, timeoutMs: 20000, queueLimit: 1, maxChars: 64000 });
  const port = await bridge.listen(0);
  return { bridge, driver, port };
}

