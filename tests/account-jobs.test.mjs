import test from 'node:test';
import assert from 'node:assert/strict';
import { JobManager, JobManagerError } from '../src/accounts/jobs.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function updateWaiter() {
  const updates = [];
  const watchers = new Set();
  const onUpdate = job => {
    updates.push(job);
    for (const watcher of [...watchers]) if (watcher.id === job.id && watcher.status === job.status) {
      watchers.delete(watcher);
      watcher.resolve(job);
    }
  };
  const waitFor = (id, status) => {
    const previous = [...updates].reverse().find(job => job.id === id && job.status === status);
    if (previous) return Promise.resolve(previous);
    return new Promise(resolve => watchers.add({ id, status, resolve }));
  };
  return { onUpdate, updates, waitFor };
}

test('start returns a safe queued view, then progress and completion transitions are observable', async () => {
  let now = Date.parse('2026-10-18T12:00:00.000Z');
  const updates = updateWaiter();
  const manager = new JobManager({ clock: () => now++, onUpdate: updates.onUpdate });
  const complete = deferred();
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const returned = manager.start('health-check', 'private-account-id', async ({ setProgress }) => {
    setProgress(43);
    started();
    return complete.promise;
  });
  assert.equal(returned.status, 'queued');
  assert.equal(returned.progress, 0);
  assert.equal('accountId' in returned, false);
  assert.equal(Object.isFrozen(returned), true);
  await running;
  assert.equal((await updates.waitFor(returned.id, 'running')).status, 'running');
  assert.equal(manager.get(returned.id).progress, 43);
  const succeeded = updates.waitFor(returned.id, 'succeeded');
  complete.resolve({ accessUrl: 'private-url', secret: 'private-result' });
  const final = await succeeded;
  assert.equal(final.status, 'succeeded');
  assert.equal(final.progress, 100);
  assert.equal(JSON.stringify(manager.get(returned.id)).includes('private'), false);
  assert.deepEqual(manager.list(), [manager.get(returned.id)]);
  await manager.close();
});

test('same type/account duplicates return one job and other jobs for that account are serialized', async () => {
  const updates = updateWaiter();
  const manager = new JobManager({ maxActive: 3, onUpdate: updates.onUpdate });
  const release = new Map();
  const started = new Map();
  const activeCounts = new Map();
  const makeTask = key => async () => {
    activeCounts.set(key, (activeCounts.get(key) || 0) + 1);
    assert.equal(activeCounts.get(key), 1, 'an account must never have concurrent jobs');
    const signal = deferred();
    started.set(key, signal);
    await new Promise(resolve => { release.set(key, resolve); });
    activeCounts.set(key, activeCounts.get(key) - 1);
  };

  const firstA = manager.start('relogin', 'account-a', makeTask('a1'));
  const duplicateA = manager.start('relogin', 'account-a', async () => assert.fail('duplicate function must not run'));
  const secondA = manager.start('health-check', 'account-a', makeTask('a2'));
  const firstB = manager.start('relogin', 'account-b', makeTask('b1'));
  assert.equal(duplicateA.id, firstA.id);
  assert.equal(secondA.status, 'queued');
  await Promise.all([updates.waitFor(firstA.id, 'running'), updates.waitFor(firstB.id, 'running')]);
  assert.equal(started.has('a2'), false);
  release.get('b1')();
  await updates.waitFor(firstB.id, 'succeeded');
  assert.equal(started.has('a2'), false, 'account A remains busy while its first job runs');
  const secondRunning = updates.waitFor(secondA.id, 'running');
  release.get('a1')();
  await secondRunning;
  release.get('a2')();
  await updates.waitFor(secondA.id, 'succeeded');
  await manager.close();
});

test('queued cancellation never invokes work and close aborts active work and waits for settlement', async () => {
  const updates = updateWaiter();
  const manager = new JobManager({ maxActive: 1, onUpdate: updates.onUpdate });
  let activeStarted;
  const activeReady = new Promise(resolve => { activeStarted = resolve; });
  let cleanup = false;
  let queuedCalls = 0;
  const active = manager.start('health-check', 'account-a', ({ signal }) => new Promise(resolve => {
    activeStarted();
    signal.addEventListener('abort', () => { cleanup = true; resolve(); }, { once: true });
  }));
  const cancelled = manager.start('relogin', 'account-b', async () => { queuedCalls += 1; });
  await activeReady;
  assert.equal(manager.cancel(cancelled.id).status, 'cancelled');
  assert.equal(queuedCalls, 0);
  const queuedAtClose = manager.start('import', null, async () => { queuedCalls += 1; });
  const closing = manager.close();
  await closing;
  assert.equal(cleanup, true);
  assert.equal(queuedCalls, 0);
  assert.equal(manager.get(active.id).status, 'cancelled');
  assert.equal(manager.get(queuedAtClose.id).status, 'cancelled');
  assert.equal(manager.cancel(active.id), null);
});

test('errors expose only allowlisted codes and never retain raw exception messages or results', async () => {
  const updates = updateWaiter();
  const manager = new JobManager({ onUpdate: updates.onUpdate });
  const allowed = manager.start('mail-fetch', 'account-a', async () => { throw Object.assign(new Error('private URL and token'), { code: 'mail_auth_failed' }); });
  const failedAllowed = await updates.waitFor(allowed.id, 'failed');
  assert.equal(failedAllowed.errorCode, 'mail_auth_failed');
  assert.equal(JSON.stringify(failedAllowed).includes('private'), false);

  const unknown = manager.start('mail-fetch', 'account-b', async () => { throw Object.assign(new Error('private URL'), { code: 'secret-account@example.test' }); });
  const failedUnknown = await updates.waitFor(unknown.id, 'failed');
  assert.equal(failedUnknown.errorCode, 'internal_error');
  assert.equal(JSON.stringify(manager.list()).includes('secret-account'), false);
  await manager.close();
});

test('queue and retained history stay bounded while completed entries are evicted first', async () => {
  const updates = updateWaiter();
  const manager = new JobManager({ maxJobs: 2, maxActive: 1, maxQueued: 1, onUpdate: updates.onUpdate });
  const firstRun = deferred();
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const first = manager.start('health-check', 'account-a', async () => { started(); await firstRun.promise; });
  await running;
  const second = manager.start('health-check', 'account-b', async () => {});
  assert.throws(() => manager.start('health-check', 'account-c', async () => {}), error => error instanceof JobManagerError && error.code === 'job_queue_full');
  const firstDone = updates.waitFor(first.id, 'succeeded');
  firstRun.resolve();
  await firstDone;
  await updates.waitFor(second.id, 'succeeded');
  const third = manager.start('health-check', 'account-c', async () => {});
  assert.equal(manager.list().length, 2);
  assert.equal(manager.get(first.id), null, 'oldest completed entry is evicted to make room');
  await updates.waitFor(third.id, 'succeeded');
  await manager.close();
});

test('invalid capacities are rejected', () => {
  assert.throws(() => new JobManager({ maxActive: 0 }), /maxActive/);
  assert.throws(() => new JobManager({ maxQueued: -1 }), /maxQueued/);
});

test('manual login phases are observable, allowlisted, cleared on completion, and cannot update settled jobs', async () => {
  const updates = updateWaiter();
  const manager = new JobManager({ onUpdate: updates.onUpdate });
  const ready = deferred();
  const complete = deferred();
  let setPhase;
  const job = manager.start('relogin', 'account-a', async context => {
    setPhase = context.setPhase;
    assert.equal(setPhase('opening_browser'), true);
    assert.equal(setPhase('secret@example.test|https://private.example/token'), false);
    assert.equal(setPhase('waiting_for_user'), true);
    ready.resolve();
    await complete.promise;
  });
  await ready.promise;
  assert.equal(manager.get(job.id).phase, 'waiting_for_user');
  assert.ok(updates.updates.some(update => update.phase === 'waiting_for_user'));
  assert.equal(JSON.stringify(manager.list()).includes('secret@example'), false);
  const finished = updates.waitFor(job.id, 'succeeded');
  complete.resolve();
  await finished;
  assert.equal(Object.hasOwn(manager.get(job.id), 'phase'), false);
  assert.equal(setPhase('reading_mail'), false);
  await manager.close();
});
