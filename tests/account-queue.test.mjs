import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AccountStore } from '../src/accounts/store.mjs';
import { AccountPool, TransportFailure } from '../src/accounts/pool.mjs';
import { SessionManager } from '../src/muse/session.mjs';
import { AccountQueue } from '../src/queue.mjs';

const TMP = join(dirname(dirname(fileURLToPath(import.meta.url))), '.test-tmp');

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: ms => { now += ms; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const sess = over => ({ cookies: [{ name: 'sid', value: 'C' }], tokens: { access: 'T' }, device: { id: 'D' }, expiresAt: null, ...over });

let seq = 0;
async function setup(t, { accounts = 1, maxActive = 1, limit = 4, maxAttempts = 3, sessionManager = null, protocol = null } = {}) {
  const clock = makeClock();
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, 'queue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AccountStore({ rootDir: join(dir, 'accounts'), clock });
  t.after(() => store.close());
  await store.init();
  const entries = Array.from({ length: accounts }, () => {
    const k = seq += 1;
    return { email: `User${k}@Mail.test`, emailNormalized: `user${k}@mail.test`, provider: 'prov', mailAccessUrl: `https://mail.test/${k}` };
  });
  const ids = accounts ? (await store.importBatch(entries)).imported.map(a => a.id) : [];
  for (const id of ids) await store.replaceSession(id, 0, sess());

  const log = [];
  const factory = account => {
    log.push({ op: 'create', accountId: account.id });
    return { accountId: account.id, async close() { log.push({ op: 'close', accountId: account.id }); } };
  };
  const sessions = protocol ? new SessionManager({ store, protocol, clock }) : sessionManager;
  if (protocol) t.after(() => sessions.close());
  const pool = new AccountPool({ store, transportFactory: factory, clock, sessionManager: sessions });
  t.after(() => pool.close());
  const queue = new AccountQueue({ pool, maxActive, limit, maxAttempts, clock });
  t.after(() => queue.close());
  return { clock, store, pool, queue, log, ids: ids.slice().sort() };
}

function maxConcurrentOpen(log) {
  let open = 0;
  let peak = 0;
  for (const event of log) { open += event.op === 'create' ? 1 : -1; peak = Math.max(peak, open); }
  return peak;
}

test('runs a single request to completion and frees the account', async t => {
  const { queue, pool } = await setup(t);
  const result = await queue.run(async (signal, lease) => ({ served: lease.accountId }), undefined, { requestId: 'r1', estimatedInputTokens: 50 });
  assert.ok(result.served);
  assert.equal(pool.status().counts.busy, 0);
  assert.equal(queue.status.activeCount, 0);
});

test('aborted transport cancellation persists explicit quarantine and status, then releases once', async t => {
  const refreshes = [];
  const sessionManager = {
    async ensureValid() {},
    async refresh(id) { refreshes.push(id); },
  };
  const { queue, pool, store, ids, log } = await setup(t, { sessionManager });
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(queue.run(async () => {
    calls += 1;
    controller.abort();
    throw new TransportFailure({
      code: 'cancel_unconfirmed', scope: 'account', delivery: 'unknown',
      quarantine: true, accountStatus: 'needs_relogin',
    });
  }, controller.signal, { requestId: 'cancel-quarantine' }), error => error.code === 'request_cancelled');

  const account = store.getPublic(ids[0]);
  assert.equal(calls, 1, 'an uncertain delivery is never replayed');
  assert.equal(account.quarantined, true);
  assert.equal(account.status, 'needs_relogin');
  assert.deepEqual(refreshes, [], 'aborted cancellation does not refresh or retry');
  assert.equal(log.filter(event => event.op === 'close').length, 1);
  assert.equal(pool.status().counts.busy, 0);
});

test('ordinary cancellation has no account penalty', async t => {
  const { queue, pool, store, ids, log } = await setup(t);
  const controller = new AbortController();
  await assert.rejects(queue.run(async () => {
    controller.abort();
    throw new Error('caller cancelled during local work');
  }, controller.signal, { requestId: 'ordinary-cancel' }), error => error.code === 'request_cancelled');

  const account = store.getPublic(ids[0]);
  assert.equal(account.quarantined, false);
  assert.equal(account.cooldownUntil, null);
  assert.equal(account.status, 'active');
  assert.equal(log.filter(event => event.op === 'close').length, 1);
  assert.equal(pool.status().counts.busy, 0);
});

test('fails fast when all accounts only have transient preflight cooldowns', async t => {
  const sessionManager = { async ensureValid() { throw new Error('synthetic transient preflight'); } };
  const { queue } = await setup(t, { sessionManager });
  let generationCalls = 0;
  const started = Date.now();
  await assert.rejects(queue.run(async () => { generationCalls += 1; }), error => error.code === 'no_ready_account');
  assert.ok(Date.now() - started < 500, 'does not sleep through the transient cooldown');
  assert.equal(generationCalls, 0);
});

test('continues waiting when one account is busy and another has transient cooldown', async t => {
  let failingId;
  const sessionManager = { async ensureValid(id) { if (id === failingId) throw new Error('synthetic transient preflight'); } };
  const { queue, pool, ids } = await setup(t, { accounts: 2, sessionManager });
  failingId = ids[1];
  assert.equal(await pool.acquire({ excludeIds: [ids[0]] }), null, 'sets a transient cooldown on account two');
  const held = await pool.acquire({ excludeIds: [ids[1]] });
  assert.equal(held.accountId, ids[0]);
  const before = pool.availability();
  assert.equal(before.busy, 1);
  assert.equal(before.transientCooldown, 1);

  let started = false;
  const waiting = queue.run(async (_signal, lease) => { started = true; return lease.accountId; }, undefined, { requestId: 'busy-and-cooling' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(started, false, 'busy account is not bypassed by fast-fail');
  await pool.release(held, { ok: true });
  assert.equal(await waiting, ids[0]);
  assert.equal(started, true);
});

test('holds one global permit, queues in FIFO order, and rejects overflow with 429', async t => {
  const { queue } = await setup(t, { accounts: 1, maxActive: 1, limit: 2 });
  const gate = deferred();
  const started = [];
  const run = id => queue.run(async () => { started.push(id); if (id === 'r1') await gate.promise; return id; }, undefined, { requestId: id });

  const first = run('r1');
  await tick();
  const second = run('r2');
  const third = run('r3');
  assert.equal(queue.status.activeCount, 1);
  assert.equal(queue.status.waiting, 2);
  await assert.rejects(run('r4'), e => e.status === 429 && e.code === 'queue_full');

  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ['r1', 'r2', 'r3']);
  assert.deepEqual(started, ['r1', 'r2', 'r3'], 'waiting requests start in FIFO order');
});

test('allows maxActive logical requests to run concurrently on distinct accounts', async t => {
  const { queue } = await setup(t, { accounts: 2, maxActive: 2 });
  const gate = deferred();
  const inside = [];
  const make = id => queue.run(async (signal, lease) => { inside.push(lease.accountId); await gate.promise; return id; }, undefined, { requestId: id });
  const a = make('a');
  const b = make('b');
  await tick();
  assert.equal(queue.status.activeCount, 2);
  assert.equal(inside.length, 2, 'both requests are inside their callbacks at once');
  assert.equal(new Set(inside).size, 2, 'on two different accounts');
  gate.resolve();
  await Promise.all([a, b]);
});

test('a second permit-holder waits for an account and proceeds once one frees', async t => {
  const { queue, pool } = await setup(t, { accounts: 1, maxActive: 2 });
  const gate = deferred();
  const calls = [];
  const first = queue.run(async (signal, lease) => { calls.push(lease.accountId); await gate.promise; return 'first'; }, undefined, { requestId: 'r1' });
  await tick();
  const second = queue.run(async (signal, lease) => { calls.push(lease.accountId); return 'second'; }, undefined, { requestId: 'r2' });
  await tick();
  assert.equal(calls.length, 1, 'the second holds a permit but is waiting for the busy account');
  assert.equal(pool.status().counts.busy, 1);
  gate.resolve();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.equal(calls.length, 2);
});

test('surfaces 503 no_ready_account when nothing is usable', async t => {
  const { queue } = await setup(t, { accounts: 0 });
  await assert.rejects(queue.run(async () => 'x'), e => e.status === 503 && e.code === 'no_ready_account');
});

test('falls back to another account, releasing the first lease before acquiring the second', async t => {
  const { queue, log } = await setup(t, { accounts: 2 });
  let call = 0;
  const seen = [];
  const result = await queue.run(async (signal, lease) => {
    seen.push(lease.accountId);
    if (++call === 1) throw new TransportFailure({ code: 'net_reset', scope: 'account', delivery: 'not_sent' });
    return 'ok';
  }, undefined, { requestId: 'r1' });
  assert.equal(result, 'ok');
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'the retry used a different account');
  assert.equal(maxConcurrentOpen(log), 1, 'never more than one lease open at a time');
  assert.equal(log[0].op, 'create');
  assert.equal(log[1].op, 'close');
  assert.equal(log[1].accountId, log[0].accountId, 'the first lease is closed before the next opens');
  assert.equal(log[2].op, 'create');
});

test('stops after maxAttempts generation attempts across at most that many accounts', async t => {
  const { queue } = await setup(t, { accounts: 4, maxAttempts: 3 });
  const used = [];
  const failure = await queue.run(async (signal, lease) => {
    used.push(lease.accountId);
    throw new TransportFailure({ code: 'net_reset', scope: 'account', delivery: 'not_sent' });
  }, undefined, { requestId: 'r1' }).then(() => null, e => e);
  assert.equal(used.length, 3, 'exactly three generation attempts');
  assert.equal(new Set(used).size, 3, 'on three distinct accounts, leaving the fourth untouched');
  assert.ok(failure instanceof TransportFailure);
  assert.equal(failure.status, 502);
});

test('never replays an accepted, unknown, or protocol-malformed failure', async t => {
  for (const delivery of ['accepted', 'unknown']) {
    const { queue } = await setup(t, { accounts: 3 });
    let calls = 0;
    await queue.run(async () => { calls += 1; throw new TransportFailure({ code: 'x', scope: 'account', delivery }); }, undefined, { requestId: 'r' })
      .then(() => null, () => null);
    assert.equal(calls, 1, `${delivery} must not be replayed`);
  }
  const { queue } = await setup(t, { accounts: 3 });
  let calls = 0;
  const protocolError = Object.assign(new Error('malformed'), { name: 'ProtocolError', status: 502, code: 'invalid_model_response' });
  const error = await queue.run(async () => { calls += 1; throw protocolError; }, undefined, { requestId: 'r' }).then(() => null, e => e);
  assert.equal(calls, 1);
  assert.equal(error.code, 'invalid_model_response');
});

test('a recoverable failure refreshes and retries the same account, counting toward the attempt budget', async t => {
  const store = { ref: null };
  const sessionManager = {
    async ensureValid() { return { refreshed: false }; },
    async refresh(accountId) {
      const current = store.ref.getPrivate(accountId).session.sessionRevision;
      await store.ref.replaceSession(accountId, current, sess({ tokens: { access: 'ROTATED' } }));
      return { accountId, refreshed: true };
    },
  };
  const context = await setup(t, { accounts: 2, sessionManager });
  store.ref = context.store;
  const { queue } = context;
  const seen = [];
  const result = await queue.run(async (signal, lease) => {
    seen.push({ accountId: lease.accountId, rev: lease.sessionRevision });
    if (seen.length === 1) throw new TransportFailure({ code: 'auth', scope: 'account', delivery: 'not_sent', recoverable: true });
    return 'ok';
  }, undefined, { requestId: 'r1' });
  assert.equal(result, 'ok');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].accountId, seen[1].accountId, 'the same account is retried after a refresh');
  assert.equal(seen[0].rev, 1);
  assert.equal(seen[1].rev, 2, 'the retry uses the refreshed session revision');
});

test('an abort during recovery drains the shared refresh and releases the original lease exactly once', async t => {
  const refreshGate = deferred();
  const protocol = {
    async probe() { return { valid: true }; },
    async refresh() { await refreshGate.promise; return { ok: true, session: sess({ tokens: { access: 'ROTATED' } }) }; },
  };
  const { queue, pool, store, log, ids } = await setup(t, { accounts: 1, protocol });
  const controller = new AbortController();
  let attempts = 0;
  const running = queue.run(async () => {
    attempts += 1;
    throw new TransportFailure({ code: 'auth_expired', scope: 'account', delivery: 'not_sent', recoverable: true });
  }, controller.signal, { requestId: 'r1' }).then(() => null, e => e);

  while (!log.some(event => event.op === 'close')) await tick();
  controller.abort();
  await tick();
  assert.equal(queue.status.activeCount, 1, 'the global slot is held while the refresh drains');
  assert.equal(pool.accountState(ids[0]).busy, true, 'and so is the account');

  refreshGate.resolve();
  const error = await running;
  assert.equal(error.code, 'request_cancelled');
  assert.equal(attempts, 1);
  assert.equal(log.filter(event => event.op === 'create').length, 1, 'no new transport after the abort');
  assert.equal(log.filter(event => event.op === 'close').length, 1, 'the original transport closed exactly once');
  assert.equal(pool.accountState(ids[0]).busy, false, 'the original lease was released');
  assert.equal(queue.status.activeCount, 0);
  assert.equal(store.getPublic(ids[0]).sessionRevision, 2, 'the shared refresh still completed and persisted');
});

test('a logical request refreshes at most once and still caps total attempts at three', async t => {
  let refreshes = 0;
  const holder = {};
  const sessionManager = {
    async ensureValid() { return {}; },
    async refresh(accountId) {
      refreshes += 1;
      await holder.store.replaceSession(accountId, holder.store.getPublic(accountId).sessionRevision, sess({ tokens: { access: `R${refreshes}` } }));
      return {};
    },
  };
  const context = await setup(t, { accounts: 2, sessionManager });
  holder.store = context.store;
  const seen = [];
  const error = await context.queue.run(async (signal, lease) => {
    seen.push(lease.accountId);
    throw new TransportFailure({ code: 'auth_expired', scope: 'account', delivery: 'rejected_before_acceptance', recoverable: true });
  }, undefined, { requestId: 'r1' }).then(() => null, e => e);
  assert.ok(error instanceof TransportFailure);
  assert.equal(refreshes, 1, 'only one refresh for the whole logical request');
  assert.equal(seen.length, 3, 'three generation attempts in total');
  assert.equal(seen[0], seen[1], 'the refreshed retry reused the same account');
  assert.notEqual(seen[2], seen[0], 'the next recoverable failure fell back to another account');
});

test('the queue does not miss an availability change between a null acquire and its wait', async () => {
  let version = 0;
  let acquireCalls = 0;
  const lease = { id: 'lease-1', accountId: '123e4567-e89b-42d3-a456-426614174000', sessionRevision: 1, transport: {} };
  const pool = {
    get version() { return version; },
    canRecover: false,
    async acquire() {
      acquireCalls += 1;
      if (acquireCalls === 1) { version += 1; return null; } // an account frees while this acquire runs
      return lease;
    },
    availability() { return { usable: 1, eligible: 0, serviceBlocked: false, version }; },
    waitForAvailability(signal, { sinceVersion } = {}) {
      return sinceVersion !== undefined && sinceVersion !== version ? Promise.resolve() : new Promise(() => {});
    },
    async release() { return true; },
    async noteFailure() { return { retryable: false }; },
  };
  assert.throws(() => new AccountQueue({ pool, maxAttempts: 4 }), TypeError);
  const queue = new AccountQueue({ pool });
  let timer;
  const result = await Promise.race([
    queue.run(async () => 'served'),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the queue missed the wakeup')), 1000); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(result, 'served');
  assert.equal(acquireCalls, 2);
});

test('an aborted deadline wins over an otherwise retryable failure', async t => {
  const { queue } = await setup(t, { accounts: 3 });
  const controller = new AbortController();
  let calls = 0;
  const error = await queue.run(async () => {
    calls += 1;
    controller.abort();
    throw new TransportFailure({ code: 'net', scope: 'account', delivery: 'not_sent' });
  }, controller.signal, { requestId: 'r1' }).then(() => null, e => e);
  assert.equal(calls, 1, 'the retryable failure is not replayed once the signal is aborted');
  assert.equal(error.code, 'request_cancelled');
});

test('an active request keeps its permit and lease until its callback cleanup settles', async t => {
  const { queue } = await setup(t, { accounts: 1, maxActive: 1 });
  const controller = new AbortController();
  const abortObserved = deferred();
  const cleanupGate = deferred();
  const started = [];
  const first = queue.run(async signal => {
    started.push('r1');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    abortObserved.resolve();
    await cleanupGate.promise;
    throw new Error('cancelled mid-cleanup');
  }, controller.signal, { requestId: 'r1' });
  await tick();
  const second = queue.run(async () => { started.push('r2'); return 'second'; }, undefined, { requestId: 'r2' });

  controller.abort();
  await abortObserved.promise;
  assert.deepEqual(started, ['r1'], 'the queued request has not started while cleanup is pending');
  assert.equal(queue.status.activeCount, 1);

  cleanupGate.resolve();
  await assert.rejects(first, e => e.code === 'request_cancelled');
  assert.equal(await second, 'second');
  assert.deepEqual(started, ['r1', 'r2']);
});

test('close aborts waiting requests while active ones finish, and queued aborts drop immediately', async t => {
  const shutdown = await setup(t, { accounts: 1, maxActive: 1 });
  const gate = deferred();
  const active = shutdown.queue.run(async () => { await gate.promise; return 'done'; }, undefined, { requestId: 'r1' });
  await tick();
  const waiter = shutdown.queue.run(async () => 'never', undefined, { requestId: 'r2' });
  await shutdown.queue.close();
  await assert.rejects(waiter, e => e.status === 503 && e.code === 'shutting_down');
  gate.resolve();
  assert.equal(await active, 'done');

  const cancel = await setup(t, { accounts: 1, maxActive: 1 });
  const gate2 = deferred();
  const busy = cancel.queue.run(async () => { await gate2.promise; return 'done'; }, undefined, { requestId: 'r1' });
  await tick();
  const controller = new AbortController();
  const queued = cancel.queue.run(async () => 'never', controller.signal, { requestId: 'r2' });
  await tick();
  assert.equal(cancel.queue.status.waiting, 1);
  controller.abort();
  await assert.rejects(queued, e => e.code === 'request_cancelled');
  assert.equal(cancel.queue.status.waiting, 0);
  gate2.resolve();
  assert.equal(await busy, 'done');
});


test('zero waiting capacity permits one active request and rejects a second immediately', async t => {
  const { queue } = await setup(t, { limit: 0 });
  const gate = deferred();
  const first = queue.run(async () => { await gate.promise; return 'done'; });
  await tick();
  await assert.rejects(queue.run(async () => 'unexpected'), error => error.code === 'queue_full' && error.status === 429);
  gate.resolve();
  assert.equal(await first, 'done');
  assert.equal(queue.status.waiting, 0);
});
