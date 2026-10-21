import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTerminalToolResult, verifyResult } from './client-scripted-driver.mjs';

const artifact = {
  kind: 'synthetic-invoice-proof',
  checks: { standard: true, fractional: true, zero: true },
};

test('unwraps a successful Hermes terminal result envelope for proof verification', () => {
  const raw = JSON.stringify({ output: JSON.stringify(artifact), exit_code: 0, error: null });
  const decoded = parseTerminalToolResult(raw);
  assert.equal(decoded.text, JSON.stringify(artifact));
  assert.deepEqual(decoded.envelope, { exitCode: 0, error: null });
  assert.equal(verifyResult({ label: 'proof-read' }, decoded), true);
});

test('proof verification requires exit code zero, null error, and exactly three true checks', () => {
  const raw = proof => JSON.stringify({ output: JSON.stringify(proof), exit_code: 0, error: null });
  assert.equal(verifyResult({ label: 'proof-read' }, raw({ ...artifact, checks: {} })), false);
  assert.equal(verifyResult({ label: 'proof-read' }, raw({ ...artifact, checks: { standard: true, fractional: true } })), false);
  assert.equal(verifyResult({ label: 'proof-read' }, raw({ ...artifact, checks: { ...artifact.checks, extra: true } })), false);
  assert.equal(verifyResult({ label: 'proof-read' }, raw({ ...artifact, checks: { ...artifact.checks, zero: false } })), false);
  assert.equal(verifyResult({ label: 'proof-read' }, JSON.stringify({ output: JSON.stringify(artifact), exit_code: 1, error: null })), false);
  assert.equal(verifyResult({ label: 'proof-read' }, JSON.stringify({ output: JSON.stringify(artifact), exit_code: 0, error: 'read failed' })), false);
});

test('validates terminal exit status for red, read, green, and edit stages', () => {
  const envelope = (output, exit_code, error = null) => JSON.stringify({ output, exit_code, error });
  assert.equal(verifyResult({ label: 'red' }, envelope('ERR_ASSERTION: not ok 1', 1)), true);
  assert.equal(verifyResult({ label: 'red' }, envelope('ERR_ASSERTION: not ok 1', 0)), false);
  assert.equal(verifyResult({ label: 'read' }, envelope('return Math.round(subtotal * (1 + taxPercent));', 0)), true);
  assert.equal(verifyResult({ label: 'read' }, envelope('return Math.round(subtotal * (1 + taxPercent));', 0, 'error')), false);
  assert.equal(verifyResult({ label: 'green' }, envelope('pass 3 fail 0', 0)), true);
  assert.equal(verifyResult({ label: 'green' }, envelope('pass 3 fail 0', 1)), false);
  assert.equal(verifyResult({ label: 'edit' }, envelope('', 0)), true);
  assert.equal(verifyResult({ label: 'edit' }, envelope('', 1)), false);
});
