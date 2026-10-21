import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AccountStore } from '../src/accounts/store.mjs';
import { AccountPool, TransportFailure } from '../src/accounts/pool.mjs';

const TMP = join(dirname(dirname(fileURLToPath(import.meta.url))), '.test-tmp');

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: ms => { now += ms; } };
}

function sess(over = {}) {
  return { cookies: [{ name: 'sid', value: 'COOKIE_CANARY' }], tokens: { access: 'TOKEN_CANARY' }, device: { id: 'DEV' }, expiresAt: null, ...over };
}

let seq = 0;
async function newStore(t, clock) {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, 'pool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AccountStore({ rootDir: join(dir, 'accounts'), clock });
  t.after(() => store.close());
  await store.init();
  return store;
}

async function addAccounts(store, n, { withSession = true } = {}) {
  const entries = Array.from({ length: n }, () => {
    const k = seq += 1;
    return { email: `User${k}@Mail.test`, emailNormalized: `user${k}@mail.test`, provider: 'prov', mailAccessUrl: `https://mail.test/inbox/${k}?token=URLSECRET${k}` };
  });
  const { imported } = await store.importBatch(entries);
  const ids = imported.map(a => a.id);
  if (withSession) for (const id of ids) await store.replaceSession(id, 0, sess());
  return ids;
}

function recorder() {
  const created = [];
  return { created, factory: (account, session) => {
    const transport = { accountId: account.id, sessionRevision: session.sessionRevision, closed: false, async close() { this.closed = true; } };
    created.push(transport);
    return transport;
  } };
}

function makePool(t, store, clock, options = {}) {
  const rec = recorder();
  const pool = new AccountPool({ store, transportFactory: rec.factory, clock, ...options });
  t.after(() => pool.close());
  return { pool, created: rec.created };
}

test('status is account-neutral, leaks no secrets, and counts states correctly', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [active] = await addAccounts(store, 1);
  const [banned] = await addAccounts(store, 1);
  const [relogin] = await addAccounts(store, 1);
  const [disabled] = await addAccounts(store, 1);
  const [sessionless] = await addAccounts(store, 1, { withSession: false });
  await store.updateAccount(banned, 1, { status: 'banned' });
  await store.updateAccount(relogin, 1, { status: 'needs_relogin' });
  await store.updateAccount(disabled, 1, { enabled: false });
  const { pool } = makePool(t, store, clock);

  const status = pool.status();
  assert.equal(status.mode, 'http');
  assert.equal(status.model, 'Muse app selection');
  assert.equal(status.ready, true);
  assert.equal(status.state, 'ready');
  assert.equal(status.counts.total, 5);
  assert.equal(status.counts.eligible, 1);
  assert.equal(status.counts.banned, 1);
  assert.equal(status.counts.needsRelogin, 1);
  assert.equal(status.counts.disabled, 1);
  assert.equal(status.counts.noSession, 1);
  for (const secret of ['TOKEN_CANARY', 'URLSECRET', 'mail.test', active]) {
    assert.equal(JSON.stringify(status).includes(secret), false, `status leaked ${secret}`);
  }
});

test('acquire selects by rolling tokens, then lastAssignedAt, then id, and respects excludeIds', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const ids = (await addAccounts(store, 3)).slice().sort();
  const { pool } = makePool(t, store, clock);

  const first = await pool.acquire({ estimatedInputTokens: 1000 });
  assert.equal(first.accountId, ids[0], 'all equal -> smallest id wins');
  await pool.release(first, { ok: true });

  clock.advance(1);
  const second = await pool.acquire({ estimatedInputTokens: 0 });
  assert.equal(second.accountId, ids[1], 'heavy id[0] is skipped for a zero-token account');
  await pool.release(second, { ok: true });

  clock.advance(1);
  const third = await pool.acquire();
  assert.equal(third.accountId, ids[2]);
  await pool.release(third, { ok: true });

  clock.advance(1);
  const fourth = await pool.acquire();
  assert.equal(fourth.accountId, ids[1], 'tokens tie -> earlier lastAssignedAt wins');
  await pool.release(fourth, { ok: true });

  const excluded = await pool.acquire({ excludeIds: [ids[1]] });
  assert.notEqual(excluded.accountId, ids[1]);
});

test('acquire returns a lease with the expected shape and null when nothing is eligible', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [only] = await addAccounts(store, 1);
  const { pool, created } = makePool(t, store, clock);

  const lease = await pool.acquire({ requestId: 'r1', estimatedInputTokens: 10 });
  assert.deepEqual(Object.keys(lease).sort(), ['accountId', 'id', 'sessionRevision', 'transport']);
  assert.equal(lease.accountId, only);
  assert.equal(lease.sessionRevision, 1);
  assert.equal(created[0], lease.transport);
  assert.equal(await pool.acquire({ requestId: 'r2' }), null, 'the only account is busy');

  await pool.release(lease, { ok: true });
  assert.equal(lease.transport.closed, true, 'release closes the transport');
  assert.notEqual(await pool.acquire({ requestId: 'r3' }), null);
});

test('leases on different accounts are isolated; a cooldown on one does not affect the other', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [a, b] = (await addAccounts(store, 2)).slice().sort();
  const { pool } = makePool(t, store, clock);

  const leaseA = await pool.acquire();
  const leaseB = await pool.acquire();
  assert.deepEqual([leaseA.accountId, leaseB.accountId].sort(), [a, b]);

  await pool.noteFailure(leaseA, new TransportFailure({ code: 'net_reset', scope: 'account', delivery: 'not_sent' }));
  await pool.release(leaseA, { ok: false });
  await pool.release(leaseB, { ok: true });

  // A is cooling down; B is immediately eligible again.
  const next = await pool.acquire();
  assert.equal(next.accountId, b);
});

test('noteFailure only treats not_sent / rejected_before_acceptance as retryable', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  await addAccounts(store, 1);
  const { pool } = makePool(t, store, clock);
  const lease = await pool.acquire();

  const neutral = await pool.noteFailure(lease, new Error('not branded'));
  assert.deepEqual(neutral, { retryable: false, retrySameAccount: false, retryOtherAccount: false, scope: 'unknown', delivery: 'unknown' });

  for (const delivery of ['accepted', 'unknown']) {
    const decision = await pool.noteFailure(lease, new TransportFailure({ code: 'x', scope: 'account', delivery }));
    assert.equal(decision.retryable, false, `${delivery} must never retry`);
    assert.equal(decision.retrySameAccount, false);
    assert.equal(decision.retryOtherAccount, false);
  }

  const safe = await pool.noteFailure(lease, new TransportFailure({ code: 'net', scope: 'account', delivery: 'not_sent' }));
  assert.equal(safe.retryable, true);
  assert.equal(safe.retryOtherAccount, true);
});

test('an account-scoped 403-like failure cools down but never auto-bans', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  const { pool } = makePool(t, store, clock);
  const lease = await pool.acquire();

  const decision = await pool.noteFailure(lease, new TransportFailure({ code: 'http_403', scope: 'account', delivery: 'rejected_before_acceptance' }));
  assert.equal(decision.retryOtherAccount, true);
  assert.equal(decision.retrySameAccount, false);
  assert.equal(store.getPublic(id).status, 'active', '403 must not auto-ban');
  assert.notEqual(store.getPublic(id).cooldownUntil, null, 'the account was cooled down instead');
});

test('a service-scoped failure blocks every account until the service cooldown elapses', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  await addAccounts(store, 2);
  const { pool } = makePool(t, store, clock, { serviceCooldownMs: 5000 });
  const lease = await pool.acquire();
  await pool.release(lease, { ok: true });

  const decision = await pool.noteFailure(lease, new TransportFailure({ code: 'service_down', scope: 'service', delivery: 'not_sent' }));
  assert.equal(decision.retryOtherAccount, false);
  assert.equal(await pool.acquire(), null, 'service block hides all accounts');
  assert.equal(pool.availability().serviceBlocked, true);

  clock.advance(5001);
  assert.notEqual(await pool.acquire(), null, 'the block clears after the service cooldown');
});

test('recover refreshes the session and returns a fresh lease for the same account', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  const sessionManager = {
    async ensureValid() { return { refreshed: false }; },
    async refresh(accountId) {
      const current = store.getPrivate(accountId).session.sessionRevision;
      await store.replaceSession(accountId, current, sess({ tokens: { access: 'ROTATED' } }));
      return { accountId, refreshed: true };
    },
  };
  const { pool } = makePool(t, store, clock, { sessionManager });

  const lease = await pool.acquire();
  assert.equal(lease.sessionRevision, 1);
  const recovered = await pool.recover(lease, {});
  assert.equal(recovered.accountId, id);
  assert.equal(recovered.sessionRevision, 2);
  assert.notEqual(recovered.id, lease.id);
  assert.equal(lease.transport.closed, true, 'the stale transport is closed on recover');
  assert.equal(pool.status().counts.busy, 1, 'the account stays leased across recover');

  await pool.release(recovered, { ok: true });
  assert.equal(pool.status().counts.busy, 0);
});

test('acquire skips accounts whose ensureValid rejects and leases a healthy one', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const ids = await addAccounts(store, 3);
  const healthy = ids[2];
  const sessionManager = {
    async ensureValid(accountId) { if (accountId !== healthy) throw new Error('needs relogin'); return { refreshed: false }; },
    async refresh() { throw new Error('unused'); },
  };
  const { pool } = makePool(t, store, clock, { sessionManager });

  const lease = await pool.acquire();
  assert.equal(lease.accountId, healthy);
});

test('quarantine excludes an account and is cleared only by an explicit verified action', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  const { pool } = makePool(t, store, clock);

  await pool.quarantine(id, 'suspicious');
  assert.equal(pool.status().counts.quarantined, 1);
  assert.deepEqual(pool.accountState(id), { busy: false, quarantined: true, quarantineReason: 'suspicious' });
  assert.equal(await pool.acquire(), null, 'quarantined accounts are not eligible');

  clock.advance(60 * 60_000);
  assert.equal(await pool.acquire(), null, 'time never clears a quarantine');
  await assert.rejects(pool.clearQuarantine(id, {}), e => e.code === 'quarantine_requires_verification');
  assert.equal(await pool.acquire(), null);

  await pool.clearQuarantine(id, { verified: true });
  assert.notEqual(await pool.acquire(), null);
});

test('waitForAvailability resolves when an account frees and rejects on abort', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  await addAccounts(store, 1);
  const { pool } = makePool(t, store, clock);

  const lease = await pool.acquire();
  assert.equal(await pool.acquire(), null);
  const controller = new AbortController();
  const aborted = pool.waitForAvailability(controller.signal).then(() => 'resolved', e => e.code);
  controller.abort();
  assert.equal(await aborted, 'request_cancelled');

  const waiter = pool.waitForAvailability().then(() => 'freed');
  await pool.release(lease, { ok: true });
  assert.equal(await waiter, 'freed');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('waitForAvailability returns at once for a stale version or an already-eligible account', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  await addAccounts(store, 1);
  const { pool } = makePool(t, store, clock);

  await pool.waitForAvailability(undefined, { sinceVersion: pool.version });
  const before = pool.version;
  const lease = await pool.acquire();
  await pool.waitForAvailability(undefined, { sinceVersion: before - 1 });

  let settled = false;
  const pending = pool.waitForAvailability(undefined, { sinceVersion: pool.version }).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'a current version with nothing eligible really waits');
  await pool.release(lease, { ok: true });
  await pending;
  assert.equal(settled, true);
});

test('release keeps the account reserved until transport close settles and is single-flight', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  const closeGate = deferred();
  let closes = 0;
  const pool = new AccountPool({ store, clock, transportFactory: () => ({ async close() { closes += 1; await closeGate.promise; } }) });
  t.after(() => pool.close());

  const lease = await pool.acquire();
  const first = pool.release(lease, { ok: true });
  const second = pool.release(lease, { ok: true });
  await tick();
  assert.equal(pool.accountState(id).busy, true, 'still reserved while close is pending');
  assert.equal(await pool.acquire(), null);
  assert.equal(pool.status().counts.busy, 1);

  closeGate.resolve();
  assert.equal(await first, true);
  assert.equal(await second, true, 'a concurrent release joins the in-flight release');
  assert.equal(closes, 1, 'the transport is closed exactly once');
  assert.equal(await pool.release(lease, { ok: true }), false, 'a later release is a no-op');
  assert.equal(pool.accountState(id).busy, false);
  assert.notEqual(await pool.acquire(), null);
});

test('a rejected transport close quarantines the account as cleanup_unconfirmed until verified', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  let fail = true;
  const pool = new AccountPool({ store, clock, transportFactory: () => ({ async close() { if (fail) throw new Error('socket stuck TOKEN_CANARY'); } }) });
  t.after(() => pool.close());

  const lease = await pool.acquire();
  assert.equal(await pool.release(lease, { ok: false }), true);
  const view = store.getPublic(id);
  assert.equal(view.quarantined, true);
  assert.equal(view.reasonCode, 'cleanup_unconfirmed');
  assert.equal(JSON.stringify(view).includes('TOKEN_CANARY'), false);
  assert.equal(await pool.acquire(), null);

  clock.advance(7 * 24 * 60 * 60_000);
  assert.equal(await pool.acquire(), null, 'no timer ever makes it eligible again');
  fail = false;
  await pool.clearQuarantine(id, { verified: true });
  assert.equal((await pool.acquire()).accountId, id);
});

test('a cleanup failure stays held out in memory when the quarantine write also fails', async t => {
  const clock = makeClock();
  const real = await newStore(t, clock);
  const [id] = await addAccounts(real, 1);
  const store = {
    listPublic: () => real.listPublic(), getPublic: x => real.getPublic(x), getPrivate: x => real.getPrivate(x),
    updateAccount: async () => { throw Object.assign(new Error('disk full'), { code: 'store_io_error' }); },
  };
  const pool = new AccountPool({ store, clock, transportFactory: () => ({ async close() { throw new Error('stuck'); } }) });
  t.after(() => pool.close());

  await pool.release(await pool.acquire(), {});
  assert.equal(real.getPublic(id).quarantined, false, 'the store write failed');
  assert.equal(await pool.acquire(), null, 'but the account stays held out');
  assert.equal(pool.status().counts.quarantined, 1);
  assert.deepEqual(pool.accountState(id), { busy: false, quarantined: true, quarantineReason: 'local_quarantine' });
});

test('exclusive work waits for lease cleanup and blocks new leases while queued or running', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  const closeGate = deferred();
  const order = [];
  const pool = new AccountPool({ store, clock, transportFactory: () => ({
    async close() { order.push('close-start'); await closeGate.promise; order.push('close-end'); },
  }) });
  t.after(() => pool.close());

  const lease = await pool.acquire();
  const jobGate = deferred();
  const job = pool.runExclusive(id, async () => { order.push('exclusive-start'); await jobGate.promise; return 'relogged'; });
  await tick();
  assert.deepEqual(order, [], 'exclusive work waits for the active lease');
  const releasing = pool.release(lease, { ok: true });
  await tick();
  assert.deepEqual(order, ['close-start'], 'and for its cleanup');
  assert.equal(await pool.acquire(), null, 'queued exclusive work blocks new leases');
  closeGate.resolve();
  await releasing;
  await tick();
  assert.deepEqual(order, ['close-start', 'close-end', 'exclusive-start']);
  assert.equal(await pool.acquire(), null, 'no lease while exclusive work runs');
  assert.equal(pool.accountState(id).busy, true);
  jobGate.resolve();
  assert.equal(await job, 'relogged');
  assert.equal(pool.accountState(id).busy, false);
  assert.notEqual(await pool.acquire(), null);
});

test('recover closes the old transport, then refreshes, then builds the new one, without deadlocking queued exclusive work', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  const order = [];
  let created = 0;
  const sessionManager = {
    async ensureValid() { return {}; },
    async refresh(accountId) {
      order.push('refresh');
      await store.replaceSession(accountId, store.getPublic(accountId).sessionRevision, sess({ tokens: { access: 'ROTATED' } }));
      return {};
    },
  };
  const pool = new AccountPool({ store, clock, sessionManager, transportFactory: () => {
    const k = created += 1;
    order.push(`create-${k}`);
    return { async close() { order.push(`close-${k}`); } };
  } });
  t.after(() => pool.close());

  const lease = await pool.acquire();
  const job = pool.runExclusive(id, async () => { order.push('exclusive'); });
  await tick();
  const next = await pool.recover(lease, {});
  assert.deepEqual(order, ['create-1', 'close-1', 'refresh', 'create-2']);
  assert.equal(next.sessionRevision, 2);
  assert.equal(await pool.release(lease, {}), false, 'the replaced lease can no longer be released');
  await pool.release(next, { ok: true });
  await job;
  assert.deepEqual(order.slice(-2), ['close-2', 'exclusive']);
});

test('recover refuses to refresh when the old transport cannot be confirmed closed', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  let refreshes = 0;
  const sessionManager = { async ensureValid() { return {}; }, async refresh() { refreshes += 1; return {}; } };
  const pool = new AccountPool({ store, clock, sessionManager, transportFactory: () => ({ async close() { throw new Error('stuck'); } }) });
  t.after(() => pool.close());

  const lease = await pool.acquire();
  await assert.rejects(pool.recover(lease, {}), e => e.code === 'cleanup_unconfirmed');
  assert.equal(refreshes, 0);
  assert.equal(store.getPublic(id).quarantined, true);
  assert.equal(await pool.release(lease, {}), true, 'the original lease is still released by its owner');
  assert.equal(pool.accountState(id).busy, false);
});

test('noteFailure persists only explicit branded effects, guarded by the lease session revision', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const ids = await addAccounts(store, 3);
  const [a, b, c] = ids;
  const { pool } = makePool(t, store, clock);
  const leaseFor = id => pool.acquire({ excludeIds: ids.filter(other => other !== id) });

  const generic = await leaseFor(a);
  await pool.noteFailure(generic, new TransportFailure({ code: 'http_403', scope: 'account', delivery: 'rejected_before_acceptance', upstreamStatus: 403 }));
  assert.equal(store.getPublic(a).status, 'active', 'a generic 403 never bans');

  const explicit = await leaseFor(b);
  await pool.noteFailure(explicit, new TransportFailure({ code: 'account_banned', scope: 'account', delivery: 'rejected_before_acceptance', accountStatus: 'banned' }));
  assert.equal(store.getPublic(b).status, 'banned');

  const stale = await leaseFor(c);
  await store.replaceSession(c, 1, sess({ tokens: { access: 'RELOGGED' } }));
  await pool.noteFailure(stale, new TransportFailure({ code: 'auth_revoked', scope: 'account', delivery: 'not_sent', accountStatus: 'needs_relogin' }));
  assert.equal(store.getPublic(c).status, 'active', 'a stale lease cannot invalidate the newer session');

  const decision = await pool.noteFailure(stale, new TransportFailure({ code: 'suspicious', scope: 'account', delivery: 'accepted', quarantine: true, upstreamStatus: 401 }));
  assert.equal(decision.retryable, false, 'accepted never retries, even with a 401');
  assert.equal(decision.retryOtherAccount, false);
  assert.equal(store.getPublic(c).quarantined, true, 'explicit quarantine persists regardless of delivery');
});

test('TransportFailure validates its fields, is frozen, and is brand-checked', () => {
  const failure = new TransportFailure({ code: 'auth', scope: 'account', delivery: 'not_sent', refreshable: true });
  assert.equal(failure.recoverable, true);
  assert.ok(Object.isFrozen(failure));
  assert.equal(TransportFailure.is(failure), true);
  assert.equal(TransportFailure.is(Object.create(TransportFailure.prototype)), false, 'a forged prototype is not branded');
  assert.throws(() => new TransportFailure({ code: 'x', scope: 'service', delivery: 'not_sent', quarantine: true }), TypeError);
  assert.throws(() => new TransportFailure({ code: 'x', scope: 'request', delivery: 'not_sent', accountStatus: 'banned' }), TypeError);
  assert.throws(() => new TransportFailure({ code: 'x', scope: 'account', delivery: 'not_sent', recoverable: true, refreshable: false }), TypeError);
  assert.throws(() => new TransportFailure({ code: 'x', scope: 'account', delivery: 'not_sent', upstreamStatus: 99 }), TypeError);
});

test('a transient ensureValid failure applies a bounded cooldown whose timer wakes waiters', async t => {
  const clock = { now: () => Date.now() };
  const store = await newStore(t, clock);
  await addAccounts(store, 1);
  let failures = 1;
  const sessionManager = { async ensureValid() { if (failures-- > 0) throw new Error('probe timeout'); return {}; }, async refresh() { return {}; } };
  const { pool } = makePool(t, store, clock, { sessionManager, transientCooldownMs: 40 });

  assert.equal(await pool.acquire(), null);
  const availability = pool.availability();
  assert.equal(availability.usable, 1, 'the account is still usable');
  assert.equal(availability.eligible, 0, 'but cooling down');
  assert.equal(availability.busy, 0);
  assert.equal(availability.transientCooldown, 1);
  assert.equal(availability.serviceBlocked, false);
  const started = Date.now();
  await pool.waitForAvailability(undefined, { sinceVersion: pool.version });
  assert.ok(Date.now() - started >= 30, 'woken by the bounded cooldown timer');
  assert.notEqual(await pool.acquire(), null);
});

test('an aborted acquisition drains the joined refresh before freeing the account', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  const [id] = await addAccounts(store, 1);
  const flight = deferred();
  const sessionManager = {
    ensureValid(accountId, { signal }) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'request_cancelled' })), { once: true }));
    },
    drain: () => flight.promise,
    async refresh() { return {}; },
  };
  const { pool } = makePool(t, store, clock, { sessionManager });
  const controller = new AbortController();
  const acquiring = pool.acquire({ signal: controller.signal }).then(() => null, e => e);
  await tick();
  controller.abort();
  await tick();
  assert.equal(pool.accountState(id).busy, true, 'held until the shared refresh settles');
  flight.resolve();
  assert.equal((await acquiring).code, 'request_cancelled');
  assert.equal(pool.accountState(id).busy, false);
});

test('close waits for an in-flight acquisition and never hands out a lease afterwards', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  await addAccounts(store, 1);
  const gate = deferred();
  const sessionManager = { async ensureValid() { await gate.promise; return {}; }, async refresh() { return {}; } };
  const { pool, created } = makePool(t, store, clock, { sessionManager });

  const acquiring = pool.acquire().then(lease => lease, e => e);
  await tick();
  let closed = false;
  const closing = pool.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false, 'close waits for the pending acquisition');
  gate.resolve();
  assert.equal((await acquiring).code, 'shutting_down');
  await closing;
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, true, 'the transport built during shutdown was closed');
  await assert.rejects(pool.acquire(), e => e.code === 'shutting_down');
});

test('close retires leases still held by callers and awaits their transport close', async t => {
  const clock = makeClock();
  const store = await newStore(t, clock);
  await addAccounts(store, 1);
  const { pool, created } = makePool(t, store, clock);
  const lease = await pool.acquire();
  await pool.close();
  assert.equal(created[0].closed, true);
  assert.equal(await pool.release(lease, {}), false, 'the owner releasing later is a harmless no-op');
  assert.equal(pool.status().state, 'closed');
});
