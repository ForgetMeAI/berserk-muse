import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTerminalCommand, createAuditLedger, finalSummaryComplete, hermesLiveChildEnv,
  parseHermesLiveOptions, parseHermesVersion, parseSseCompletion, readsProofAfterWrite,
} from '../scripts/verify-hermes-live.mjs';
import { clientSettings } from '../src/agent-clients.mjs';

test('separates Hermes package version from its dotted release date', () => {
  assert.deepEqual(parseHermesVersion('Hermes Agent v0.16.0 (2026.6.5) · upstream abcdef\nPython: 3.11.15'), { version: '0.16.0', releaseDate: '2026.6.5' });
  assert.equal(parseHermesVersion('2026.6.5\nPython: 3.11.15'), null);
});

test('combined proof write/read is only an offline-review hint; separate verified read remains required', () => {
  const command = "node -e \"const fs=require('fs');fs.writeFileSync('proof.json',JSON.stringify(proof));console.log(fs.readFileSync('proof.json','utf8'))\"";
  assert.equal(readsProofAfterWrite(command), true);
  assert.equal(readsProofAfterWrite("fs.readFileSync('proof.json');fs.writeFileSync('proof.json',value)"), false);
  assert.equal(readsProofAfterWrite("fs.writeFileSync('proof.json',value);console.log(value)"), false);
  const deadRead = "node -e \"const fs=require('fs');const proof={kind:'synthetic-invoice-proof',checks:{standard:true,fractional:true,zero:true}};fs.writeFileSync('proof.json',JSON.stringify(proof));if(false)fs.readFileSync('proof.json','utf8');console.log(JSON.stringify(proof))\"";
  const inMemoryOutput = "node -e \"const fs=require('fs');const proof={kind:'synthetic-invoice-proof',checks:{standard:true,fractional:true,zero:true}};fs.writeFileSync('proof.json',JSON.stringify(proof));const ignored=fs.readFileSync('proof.json','utf8');console.log(JSON.stringify(proof))\"";
  assert.equal(readsProofAfterWrite(deadRead), true, 'the regex hint is not proof that a read ran');
  assert.equal(readsProofAfterWrite(inMemoryOutput), true, 'the regex hint does not prove stdout came from the read');
  const ledger = createAuditLedger();
  const messages = [];
  const calls = [
    ['node --test tests/invoice.test.mjs', 'ERR_ASSERTION not ok 1', 1],
    ['cat invoice.mjs', 'return Math.round(subtotal * (1 + taxPercent));', 0],
    ["node -e \"writeFileSync('invoice.mjs',corrected)\"", '', 0],
    ['node --test tests/invoice.test.mjs', 'pass 3 fail 0', 0],
    [command, JSON.stringify({ kind: 'synthetic-invoice-proof', checks: { standard: true, fractional: true, zero: true } }), 0],
  ];
  calls.forEach(([command, output, exit_code], index) => {
    messages.push({ role: 'assistant', tool_calls: [{ id: `combined-${index}`, function: { name: 'terminal', arguments: JSON.stringify({ command }) } }] });
    messages.push({ role: 'tool', tool_call_id: `combined-${index}`, content: JSON.stringify({ output, exit_code, error: null }) });
  });
  assert.equal(ledger.inspectBody(JSON.stringify({ messages })).forward, true);
  assert.equal(ledger.snapshot().toolActions.length, 5);
  assert.equal(ledger.snapshot().toolActions[4].stage, 'proof-create');
  assert.equal(ledger.snapshot().toolActions[4].proofReadRequiresOfflineReview, true);
  assert.equal(ledger.snapshot().requiredStagesVerified, false);

  for (const [decoy, label] of [[deadRead, 'dead read'], [inMemoryOutput, 'unused read']]) {
    const decoyLedger = createAuditLedger();
    const decoyMessages = [];
    calls.slice(0, 4).forEach(([stageCommand, output, exit_code], index) => {
      const id = `${label}-${index}`;
      decoyMessages.push({ role: 'assistant', tool_calls: [{ id, function: { name: 'terminal', arguments: JSON.stringify({ command: stageCommand }) } }] });
      decoyMessages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ output, exit_code, error: null }) });
    });
    const id = `${label}-proof`;
    decoyMessages.push({ role: 'assistant', tool_calls: [{ id, function: { name: 'terminal', arguments: JSON.stringify({ command: decoy }) } }] });
    decoyMessages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ output: JSON.stringify({ kind: 'synthetic-invoice-proof', checks: { standard: true, fractional: true, zero: true } }), exit_code: 0, error: null }) });
    assert.equal(decoyLedger.inspectBody(JSON.stringify({ messages: decoyMessages })).forward, true);
    const snapshot = decoyLedger.snapshot();
    assert.equal(snapshot.toolActions.length, 5);
    assert.equal(snapshot.toolActions[4].proofReadRequiresOfflineReview, true);
    assert.equal(snapshot.toolActions.some(action => action.stage === 'proof-read'), false);
    assert.equal(snapshot.requiredStagesVerified, false);
  }
});

test('Hermes live options require macOS, an explicit absolute binary, and the isolated approval flag', () => {
  assert.deepEqual(parseHermesLiveOptions(['--hermes-bin', '/opt/hermes', '--approve-isolated-hermes'], 'darwin'), {
    hermesBin: '/opt/hermes', approveIsolatedHermes: true,
  });
  assert.throws(() => parseHermesLiveOptions(['--hermes-bin', '/opt/hermes'], 'darwin'), /approve-isolated-hermes/);
  assert.throws(() => parseHermesLiveOptions(['--approve-isolated-hermes'], 'darwin'), /absolute executable/);
  assert.throws(() => parseHermesLiveOptions(['--hermes-bin', 'hermes', '--approve-isolated-hermes'], 'darwin'), /absolute executable/);
  assert.throws(() => parseHermesLiveOptions(['--hermes-bin', '/opt/hermes', '--approve-isolated-hermes'], 'linux'), /requires macOS/);
});

test('classifies only the intended invoice workflow command shapes', () => {
  assert.equal(classifyTerminalCommand('node --test tests/invoice.test.mjs'), 'test');
  assert.equal(classifyTerminalCommand('cat invoice.mjs'), 'read');
  assert.equal(classifyTerminalCommand("node -e \"writeFileSync('invoice.mjs', next)\""), 'edit');
  assert.equal(classifyTerminalCommand("node -e \"writeFileSync('proof.json', value)\""), 'proof-create');
  assert.equal(classifyTerminalCommand('cat proof.json'), 'proof-read');
  assert.equal(classifyTerminalCommand("node -e \"import('fs').then(fs=>console.log(fs.readFileSync('proof.json','utf8')))\""), 'proof-read');
  assert.equal(classifyTerminalCommand("cat > invoice.mjs <<'EOF'\nupdated\nEOF"), 'edit');
  assert.equal(classifyTerminalCommand('pwd'), 'other');
});

test('scopes YOLO to the explicitly constructed child environment, never product settings', () => {
  const profile = clientSettings('hermes', {
    profileDir: '/tmp/hermes-live-test', workDir: '/tmp/invoice-fixture',
    platform: 'darwin', pathValue: '/usr/bin:/bin',
  });
  assert.equal(Object.hasOwn(profile.env, 'HERMES_YOLO_MODE'), false);
  assert.equal(profile.env.HERMES_STREAM_RETRIES, '0');
  const child = hermesLiveChildEnv(profile);
  assert.equal(child.HERMES_YOLO_MODE, '1');
  assert.equal(child.HERMES_STREAM_RETRIES, '0');
  assert.equal(child.HERMES_HOME, '/tmp/hermes-live-test/hermes');
});

test('audit ledger verifies the six actual tool-result stages and stores no command or output text', () => {
  const stages = [
    ['test', 'node --test tests/invoice.test.mjs', 'ERR_ASSERTION not ok 1', 1],
    ['read', 'cat invoice.mjs', 'return Math.round(subtotal * (1 + taxPercent));', 0],
    ['edit', "node -e \"writeFileSync('invoice.mjs', corrected)\"", '', 0],
    ['test', 'node --test tests/invoice.test.mjs', 'tests 3 pass 3 fail 0', 0],
    ['proof-create', "node -e \"writeFileSync('proof.json', proof)\"", 'proof written', 0],
    ['proof-read', 'cat proof.json', JSON.stringify({ kind: 'synthetic-invoice-proof', checks: { standard: true, fractional: true, zero: true } }), 0],
  ];
  const messages = [];
  for (let index = 0; index < stages.length; index += 1) {
    const [, stageCommand, stageOutput, exitCode] = stages[index];
    const id = `call-${index}`;
    messages.push({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: stageCommand }) } }] });
    messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ output: stageOutput, exit_code: exitCode, error: null }) });
  }
  const ledger = createAuditLedger();
  assert.equal(ledger.inspectBody(JSON.stringify({ model: 'muse-web', messages })).forward, true);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.requiredStagesVerified, true);
  assert.deepEqual(snapshot.toolActions.map(action => action.stage), ['red', 'read', 'edit', 'green', 'proof-create', 'proof-read']);
  assert.ok(snapshot.toolActions.every(action => action.verified));
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('writeFileSync'), false);
  assert.equal(serialized.includes('synthetic-invoice-proof'), false);
  assert.equal(serialized.includes('invoice.mjs'), false);
});

test('audit relay halts forwarding after a permission denial, duplicate body, or unsupported tool', () => {
  const denied = createAuditLedger();
  const blockedBody = JSON.stringify({ messages: [
    { role: 'assistant', tool_calls: [{ id: 'blocked-call', function: { name: 'terminal', arguments: JSON.stringify({ command: 'node --test tests/invoice.test.mjs' }) } }] },
    { role: 'tool', tool_call_id: 'blocked-call', content: JSON.stringify({ output: 'BLOCKED: Permission denied', exit_code: 1, error: null }) },
  ] });
  assert.equal(denied.inspectBody(blockedBody).reason, 'tool_permission_denied');
  assert.equal(denied.inspectBody(JSON.stringify({ messages: [] })).forward, false);

  const duplicate = createAuditLedger();
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'fixture task' }] });
  assert.equal(duplicate.inspectBody(body).forward, true);
  assert.equal(duplicate.inspectBody(body).reason, 'duplicate_request_body');

  const unsupported = createAuditLedger();
  assert.equal(unsupported.inspectBody(JSON.stringify({ messages: [
    { role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'Bash', arguments: '{}' } }] },
  ] })).reason, 'unsupported_tool');
});

test('parses a complete buffered SSE response without retaining its text in a report', () => {
  const stream = [
    'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-x","function":{"name":"terminal","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const parsed = parseSseCompletion(Buffer.from(stream));
  assert.equal(parsed.complete, true);
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.deepEqual(parsed.toolCalls.map(call => call.name), ['terminal']);
  assert.equal(Object.hasOwn(parsed, 'content'), true);
});

test('final summary check requires every stage and all three proof checks', () => {
  assert.equal(finalSummaryComplete('RED failure reproduced, read and corrected source, GREEN 3 passed, proof standard fractional zero are true.'), true);
  assert.equal(finalSummaryComplete('Tests pass and proof is done.'), false);
});
