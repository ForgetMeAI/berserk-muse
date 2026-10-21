import test from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../src/main.mjs';

test('shutdown closes the owned service once and shares its completion', async () => {
  let calls = 0;
  const exits = [];
  const stop = createShutdown({ close: async () => { calls++; }, exit: code => exits.push(code) });
  assert.equal(stop(), stop());
  await stop();
  assert.equal(calls, 1);
  assert.deepEqual(exits, []);
});

test('shutdown handles cleanup rejection with a fixed message and failure exit', async () => {
  const messages = [], exits = [];
  const stop = createShutdown({ close: async () => { throw new Error('PRIVATE_CLEANUP_DETAIL'); }, log: text => messages.push(text), exit: code => exits.push(code) });
  await stop();
  assert.deepEqual(exits, [1]);
  assert.equal(messages.length, 1);
  assert.equal(messages.join('').includes('PRIVATE_CLEANUP_DETAIL'), false);
});

test('shutdown watchdog bounds a stuck owned cleanup', async () => {
  let release;
  let timeoutFired;
  const fired = new Promise(resolve => { timeoutFired = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const exits = [];
  const stop = createShutdown({ close: () => pending, timeoutMs: 10, log: () => {}, exit: code => { exits.push(code); timeoutFired(); } });
  const stopped = stop();
  const alive = setTimeout(() => {}, 1_000);
  try { await fired; assert.deepEqual(exits, [1]); }
  finally { release(); clearTimeout(alive); await stopped; }
});
