import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, finalSummaryComplete, healthDeltas, isLiveRunSuccessful, liveClaudeArgs, parseOptions, summarizeConversation, waitForIdleHealth } from '../scripts/verify-claude-live.mjs';

test('classifies in-place sed as an edit while keeping inspection commands read-only', () => {
  assert.equal(classifyCommand("sed -n '1,20p' invoice.mjs"), 'read');
  assert.equal(classifyCommand("sed -i '' 's/taxPercent/percent/g' invoice.mjs"), 'edit');
  assert.equal(classifyCommand("node --test tests/invoice.test.mjs"), 'test');
  assert.equal(classifyCommand("cat > proof.json <<'EOF'"), 'proof-create');
  assert.equal(classifyCommand('cat proof.json'), 'proof-read');
  assert.equal(classifyCommand("cat > invoice.mjs <<'EOF'\ncorrect source\nEOF"), 'edit');
  assert.equal(classifyCommand('cat invoice.mjs'), 'read');
  assert.equal(classifyCommand("node -e \"console.log(require('fs').readFileSync('invoice.mjs','utf8'))\""), 'read');
  assert.equal(classifyCommand("node -e \"const fs=require('fs');fs.writeFileSync('invoice.mjs',fs.readFileSync('invoice.mjs','utf8').replace('a','b'))\""), 'edit');
});

test('health observation waits for cleanup and handles unavailable samples without dereferencing null', async () => {
  let calls = 0;
  const idle = { ready: true, queueActive: false, requests: 10, completed: 10, errors: 0 };
  const snapshot = await waitForIdleHealth(async () => ++calls < 3 ? { ...idle, queueActive: true } : idle, { timeoutMs: 100, pollMs: 0 });
  assert.deepEqual(snapshot, idle);
  assert.equal(calls, 3);
  assert.deepEqual(healthDeltas({ requests: 3, completed: 3, errors: 0 }, null), { requestDelta: null, completedDelta: null, errorsDelta: null });
  assert.deepEqual(healthDeltas({ requests: 3, completed: 3, errors: 0 }, idle), { requestDelta: 7, completedDelta: 7, errorsDelta: 0 });
  assert.equal(await waitForIdleHealth(async () => { throw new Error('offline'); }, { timeoutMs: 0 }), null);
});

test('final Claude summary must report RED, inspection, correction, GREEN, and all proof cases', () => {
  assert.equal(finalSummaryComplete('RED failure reproduced; read and corrected source; GREEN 3 passed; proof standard, fractional, zero all true.'), true);
  assert.equal(finalSummaryComplete('Synthetic task complete; tests and proof are fine.'), false);
  assert.equal(finalSummaryComplete('RED failure; read and fixed source; GREEN 3/3; proof standard, fractional, zero verified.'), true);
});

test('live decision uses verified stages and observed completions rather than obsolete exact sequence or fixed API count', () => {
  const report = {
    process: { exitCode: 0, failure: null },
    isolation: { externalNetworkDenied: true, personalReadDenied: true, outsideWriteDenied: true },
    conversation: { permissionDenied: false, requiredStagesVerified: true, steps: Array.from({ length: 6 }, () => ({ verified: true })), finalVerified: true },
    fixture: { testsImmutable: true, sourceHashBefore: 'before', sourceHashAfter: 'after', proofValid: true },
    sourceHashesUnchanged: true, parentNoNetworkVerifier: true,
    health: { requestDelta: 8, completedDelta: 8, errorsDelta: 0 },
  };
  assert.equal(isLiveRunSuccessful(report), true);
  for (const requestDelta of [3, 7, 9]) assert.equal(isLiveRunSuccessful({ ...report, health: { requestDelta, completedDelta: requestDelta, errorsDelta: 0 } }), true);
  assert.equal(isLiveRunSuccessful({ ...report, conversation: { ...report.conversation, requiredStagesVerified: false } }), false);
  assert.equal(isLiveRunSuccessful({ ...report, conversation: { ...report.conversation, permissionDenied: true } }), false);
  assert.equal(isLiveRunSuccessful({ ...report, fixture: { ...report.fixture, testsImmutable: false } }), false);
  assert.equal(isLiveRunSuccessful({ ...report, health: { requestDelta: 8, completedDelta: 7, errorsDelta: 1 } }), false);
});

test('live launch arguments restrict both registered and allowed tools to Bash', () => {
  const args = liveClaudeArgs({ args: ['--model', 'muse-web', '-p', 'fixture task'] });
  assert.deepEqual(args, ['--model', 'muse-web', '-p', 'fixture task', '--tools', 'Bash', '--allowedTools', 'Bash']);
  assert.equal(args.includes('Read'), false);
  assert.equal(args.includes('Edit'), false);
});

test('live options require an explicit absolute Claude binary and macOS without launching it', () => {
  assert.deepEqual(parseOptions(['--claude-bin', '/opt/claude'], {}, 'darwin'), { executable: '/opt/claude' });
  assert.deepEqual(parseOptions([], { MUSE_VERIFY_CLAUDE_BIN: '/opt/claude' }, 'darwin'), { executable: '/opt/claude' });
  assert.throws(() => parseOptions([], {}, 'darwin'), /Set MUSE_VERIFY_CLAUDE_BIN/);
  assert.throws(() => parseOptions([], { MUSE_VERIFY_CLAUDE_BIN: 'claude' }, 'darwin'), /absolute executable/);
  assert.throws(() => parseOptions([], { MUSE_VERIFY_CLAUDE_BIN: '/opt/claude' }, 'linux'), /requires macOS/);
});

test('conversation verification accepts extra calls but requires each executed stage and a complete final summary', () => {
  const calls = [
    ['a', 'node --test tests/invoice.test.mjs', 'not ok 1 - percentage tax\nERR_ASSERTION'],
    ['b', 'pwd', '/fixture'],
    ['c', 'sed -n "1,8p" invoice.mjs', 'export function totalWithTax() { return Math.round(subtotal * (1 + taxPercent)); }'],
    ['d', "sed -i '' 's/taxPercent/percent/g' invoice.mjs", ''],
    ['e', 'node --test tests/invoice.test.mjs', 'tests 3\npass 3\nfail 0'],
    ['f', 'cat > proof.json', ''],
    ['g', 'cat proof.json', '{"kind":"synthetic-invoice-proof","checks":{"standard":true,"fractional":true,"zero":true}}'],
  ];
  const events = [];
  for (const [id, command, result] of calls) {
    events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
  }
  events.push({ type: 'result', is_error: false, result: 'RED reproduced; read and inspected, corrected the source, GREEN 3 passed; proof standard, fractional, and zero checks are true.' });
  const result = summarizeConversation(events);
  assert.equal(result.calls, 7);
  assert.equal(result.requiredStagesVerified, true);
  assert.equal(result.finalVerified, true);
});

test('conversation verification rejects permission-denied stages and incomplete final summaries', () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit', name: 'Bash', input: { command: "sed -i '' 's/a/b/' invoice.mjs" } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'BLOCKED: permission denied' }] } },
    { type: 'result', is_error: false, result: 'Done; tests and proof look good.' },
  ];
  const result = summarizeConversation(events);
  assert.equal(result.permissionDenied, true);
  assert.equal(result.requiredStagesVerified, false);
  assert.equal(result.finalVerified, false);
});
