import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialQueue } from '../src/queue.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('runs one task at a time in FIFO order and rejects work beyond the waiting limit', async () => {
  const queue = new SerialQueue(1);
  const firstGate = deferred();
  const secondGate = deferred();
  const firstStarted = deferred();
  const order = [];
  const first = queue.run(async () => {
    order.push('first-start');
    firstStarted.resolve();
    await firstGate.promise;
    order.push('first-end');
    return 'first';
  });
  await firstStarted.promise;
  const second = queue.run(async () => {
    order.push('second-start');
    await secondGate.promise;
    order.push('second-end');
    return 'second';
  });
  assert.throws(() => queue.run(async () => 'overflow'), error => error.status === 429 && error.code === 'queue_full');
  assert.deepEqual(order, ['first-start']);
  firstGate.resolve();
  assert.equal(await first, 'first');
  while (!order.includes('second-start')) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
  secondGate.resolve();
  assert.equal(await second, 'second');
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('removes an aborted queued task and waits for active-task cleanup before starting the next', async () => {
  const queue = new SerialQueue(2);
  const activeAbort = new AbortController();
  const queuedAbort = new AbortController();
  const activeStarted = deferred();
  const abortObserved = deferred();
  const finishCleanup = deferred();
  const order = [];

  const active = queue.run(async signal => {
    order.push('active-start');
    activeStarted.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    order.push('cleanup-start');
    abortObserved.resolve();
    await finishCleanup.promise;
    order.push('cleanup-complete');
    return 'cleaned';
  }, activeAbort.signal);
  await activeStarted.promise;

  const cancelled = queue.run(async () => {
    order.push('cancelled-task-started');
  }, queuedAbort.signal).catch(error => error);
  assert.equal(queue.status.waiting, 1);
  queuedAbort.abort();
  const cancelledError = await cancelled;
  assert.equal(cancelledError.code, 'request_cancelled');
  assert.equal(queue.status.waiting, 0);

  const next = queue.run(async () => {
    order.push('next-start');
    return 'next';
  });
  activeAbort.abort();
  await abortObserved.promise;
  assert.deepEqual(order, ['active-start', 'cleanup-start']);
  assert.equal(queue.status.active, true);

  finishCleanup.resolve();
  assert.equal(await active, 'cleaned');
  assert.equal(await next, 'next');
  assert.deepEqual(order, ['active-start', 'cleanup-start', 'cleanup-complete', 'next-start']);
});
