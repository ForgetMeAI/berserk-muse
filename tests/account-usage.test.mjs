import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountUsageService } from '../src/accounts/usage.mjs';

const ID_A = '123e4567-e89b-42d3-a456-426614174000';
const ID_B = '123e4567-e89b-42d3-a456-426614174001';
const ID_C = '123e4567-e89b-42d3-a456-426614174002';
const IDS = [ID_A, ID_B, ID_C];

function sample(revision, observedAt = 1_000) {
  return {
    source: 'muse_subscription', observedAt, sessionRevision: revision,
    tier: { code: 'plus', name: 'Plus', isPaid: true, privateCanary: 'must-not-escape' },
    weekly: { state: 'active', percentUsed: 4, resetsAt: 1_700_000_000_000, quotaStatus: 'available', raw: 'private' },
    additional: { remaining: 40_000_000, limit: 40_000_000, used: 0, percentUsed: 0, raw: 'private' },
    raw: 'must-not-escape',
  };
}

function fixture({ ids = [ID_A], clockStart = 1_000, protocol, maxActive, maxQueued, refreshMs = 100, minRefreshMs = 20 } = {}) {
  let now = clockStart;
  const records = new Map(ids.map(id => [id, { id, status: 'active', hasSession: true, sessionRevision: 1 }]));
  const store = {
    listPublic: () => [...records.values()].map(record => ({ ...record })),
    getPublic: id => {
      const record = records.get(id);
      if (!record) throw Object.assign(new Error('missing'), { code: 'account_not_found' });
      return { ...record };
    },
    getPrivate: id => {
      const record = records.get(id);
      if (!record) throw Object.assign(new Error('missing'), { code: 'account_not_found' });
      return { ...record, session: record.hasSession ? { sessionRevision: record.sessionRevision, cookies: [{ name: 'sid', value: 'synthetic' }] } : null };
    },
    set(id, values) { Object.assign(records.get(id), values); },
  };
  let active = 0;
  let highWater = 0;
  const pool = {
    accountState: () => ({ busy: false }),
    async runExclusive(id, callback, { signal } = {}) {
      active += 1;
      highWater = Math.max(highWater, active);
      try { return await callback(signal); }
      finally { active -= 1; }
    },
    get active() { return active; },
    get highWater() { return highWater; },
  };
  const reads = [];
  const protocolApi = protocol ?? { async readUsage(account, session) { reads.push(account.id); return sample(session.sessionRevision, now); } };
  const events = [];
  const eventBus = { publish(...args) { events.push(args); } };
  const service = new AccountUsageService({ store, pool, protocol: protocolApi, eventBus, clock: () => now,
    refreshMs, tickMs: 100_000, minRefreshMs, maxActive, maxQueued });
  return { service, store, pool, reads, events, now: () => now, advance: ms => { now += ms; } };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
}

test('coalesces requests, strips untrusted fields, and enforces TTL plus force cooldown', async t => {
  const f = fixture();
  t.after(() => f.service.close());
  assert.deepEqual(f.service.request(ID_A), { queued: 1, skipped: 0, pending: 1 });
  assert.deepEqual(f.service.request(ID_A, { force: true }), { queued: 0, skipped: 1, pending: 1 });
  await settle();
  const ready = f.service.getPublic(ID_A);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.sample.additional.remaining, 40_000_000);
  assert.deepEqual(Object.keys(ready.sample).sort(), ['additional', 'observedAt', 'source', 'tier', 'weekly']);
  assert.deepEqual(Object.keys(ready.sample.tier).sort(), ['code', 'isPaid', 'name']);
  assert.equal(JSON.stringify(ready).includes('must-not-escape'), false);
  assert.deepEqual(f.service.request(ID_A), { queued: 0, skipped: 1, pending: 0 });
  assert.deepEqual(f.service.request(ID_A, { force: true }), { queued: 0, skipped: 1, pending: 0 }, 'force respects minimum refresh interval');
  f.advance(20);
  assert.equal(f.service.request(ID_A, { force: true }).queued, 1);
  await settle();
  assert.equal(f.reads.length, 2);
  assert.ok(f.events.every(([name, data]) => name === 'accounts' && Object.keys(data).length === 0));
});

test('projects uppercase provider tier, weekly state, and quota status identifiers', async t => {
  const providerSample = {
    source: 'muse_subscription', observedAt: 1_000, sessionRevision: 1,
    tier: { code: 'HATCH_FREE', name: 'Muse Free', isPaid: false },
    weekly: { state: 'METERED', percentUsed: 4, resetsAt: 1_792_799_625, quotaStatus: 'SUFFICIENT' },
    additional: { remaining: 40_000_000, limit: 40_000_000, used: 0, percentUsed: 0 },
  };
  const f = fixture({ protocol: { async readUsage() { return providerSample; } } });
  t.after(() => f.service.close());
  f.service.request(ID_A);
  await settle();
  const result = f.service.getPublic(ID_A);
  assert.equal(result.state, 'ready');
  assert.equal(result.sample.tier.code, 'HATCH_FREE');
  assert.equal(result.sample.weekly.state, 'METERED');
  assert.equal(result.sample.weekly.quotaStatus, 'SUFFICIENT');
});

test('derives canonical token balance from the provider label and keeps raw quota units separate', async t => {
  const providerSample = {
    source: 'muse_subscription', observedAt: 1_000, sessionRevision: 1,
    tier: { code: 'HATCH_FREE', name: 'Muse Free', isPaid: false },
    weekly: { state: 'METERED', percentUsed: 4, resetsAt: 1_792_799_625, quotaStatus: 'SUFFICIENT' },
    additional: {
      remaining: 40_000_000, limit: 40_000_000, used: 0, percentUsed: 99,
      approximate: true, displayLabel: '0% used (1B tokens left)',
      raw: { remaining: 40_000_000, limit: 40_000_000, unit: 'muse_quota_units', sessionRevision: 77,
        url: 'https://poison.test', token: 'POISON_TOKEN' },
    },
  };
  const f = fixture({ protocol: { async readUsage() { return providerSample; } } });
  t.after(() => f.service.close());
  f.service.request(ID_A);
  await settle();
  const result = f.service.getPublic(ID_A);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.sample.additional, {
    remaining: 1_000_000_000, limit: null, used: null, percentUsed: 0,
    approximate: true, displayLabel: '0% used (1B tokens left)',
    raw: { remaining: 40_000_000, limit: 40_000_000, unit: 'muse_quota_units' },
  });
  const serialized = JSON.stringify(result);
  for (const poison of ['POISON_TOKEN', 'poison.test', 'sessionRevision', '"unit":"tokens"']) assert.equal(serialized.includes(poison), false);
});

test('rejects noncanonical top-up units and unsafe display labels', async t => {
  const f = fixture({ protocol: { async readUsage(account, session) {
    return {
      ...sample(session.sessionRevision, f.now()),
      additional: { remaining: 40, limit: 40, used: 0, percentUsed: 0, approximate: true,
        displayLabel: 'contact@example.test', raw: { remaining: 40, limit: 40, unit: 'tokens' } },
    };
  } } });
  t.after(() => f.service.close());
  f.service.request(ID_A);
  await settle();
  const result = f.service.getPublic(ID_A);
  assert.equal(result.state, 'error');
  assert.equal(result.errorCode, 'usage_response_invalid');
  assert.equal(result.sample, null);
});

test('rejects canonical raw counters that are negative or exceed their limit', async t => {
  for (const raw of [
    { remaining: -1, limit: 40, unit: 'muse_quota_units' },
    { remaining: 41, limit: 40, unit: 'muse_quota_units' },
  ]) {
    const f = fixture({ protocol: { async readUsage(account, session) {
      return { ...sample(session.sessionRevision, f.now()), additional: {
        remaining: 1, approximate: true, displayLabel: '0% used (1B tokens left)', raw,
      } };
    } } });
    t.after(() => f.service.close());
    f.service.request(ID_A);
    await settle();
    const result = f.service.getPublic(ID_A);
    assert.equal(result.state, 'error');
    assert.equal(result.errorCode, 'usage_response_invalid');
    assert.equal(result.sample, null);
  }
});

test('keeps last good sample as stale on safe failures without exposing provider messages', async t => {
  let fail = false;
  const f = fixture({ protocol: { async readUsage(account, session) {
    if (fail) throw Object.assign(new Error('secret cookie and provider body'), { code: 'usage_forbidden' });
    return sample(session.sessionRevision, f.now());
  } } });
  t.after(() => f.service.close());
  f.service.request(ID_A);
  await settle();
  f.advance(101);
  fail = true;
  assert.equal(f.service.request(ID_A).queued, 1);
  await settle();
  const result = f.service.getPublic(ID_A);
  assert.equal(result.state, 'stale');
  assert.equal(result.errorCode, 'usage_forbidden');
  assert.equal(result.sample.observedAt, 1_000);
  assert.equal(JSON.stringify(result).includes('secret cookie'), false);
  assert.equal(JSON.stringify(result).includes('provider body'), false);
});

test('drops the sample when the session revision changes during the read', async t => {
  let f;
  f = fixture({ protocol: { async readUsage(_account, session) {
    const result = sample(session.sessionRevision, f.now());
    f.store.set(ID_A, { sessionRevision: session.sessionRevision + 1 });
    return result;
  } } });
  t.after(() => f.service.close());
  f.service.request(ID_A);
  await settle();
  const result = f.service.getPublic(ID_A);
  assert.equal(result.state, 'error');
  assert.equal(result.errorCode, 'session_changed');
  assert.equal(result.sample, null);
  assert.equal(result.attemptedAt, null, 'a new session is not held behind the old session cooldown');
});

test('marks a cached sample stale immediately when the account is banned or loses its session', async t => {
  const f = fixture();
  t.after(() => f.service.close());
  f.service.request(ID_A);
  await settle();
  assert.equal(f.service.getPublic(ID_A).state, 'ready');
  f.store.set(ID_A, { status: 'banned' });
  assert.equal(f.service.getPublic(ID_A).state, 'stale');
  f.store.set(ID_A, { status: 'active', hasSession: false });
  const result = f.service.getPublic(ID_A);
  assert.equal(result.state, 'stale');
  assert.ok(result.sample, 'the prior sample may remain for explicit stale display');
});

test('start refreshes eligible session accounts, including disabled or quarantined records, but skips banned/sessionless', async t => {
  const f = fixture({ ids: IDS });
  f.store.set(ID_B, { status: 'banned' });
  f.store.set(ID_C, { enabled: false, quarantined: true });
  const idD = '123e4567-e89b-42d3-a456-426614174003';
  // Add a public sessionless record after fixture construction.
  f.store.listPublic = () => [
    { id: ID_A, status: 'active', hasSession: true, sessionRevision: 1 },
    { id: ID_B, status: 'banned', hasSession: true, sessionRevision: 1 },
    { id: ID_C, status: 'disabled', hasSession: true, sessionRevision: 1 },
    { id: idD, status: 'active', hasSession: false, sessionRevision: 0 },
  ];
  f.store.getPublic = id => {
    if (id === idD) return { id, status: 'active', hasSession: false, sessionRevision: 0 };
    return { ...f.store.getPrivate(id), hasSession: id !== idD };
  };
  t.after(() => f.service.close());
  f.service.start();
  await settle();
  assert.deepEqual(f.reads.sort(), [ID_A, ID_C].sort());
  assert.equal(f.store.getPrivate(ID_B).status, 'banned', 'usage reads never change account status');
  assert.equal(f.store.getPrivate(ID_C).quarantined, true, 'usage reads never clear quarantine');
});

test('bounds concurrent reads and queued work, then close aborts active calls and drains', async () => {
  const started = [];
  const f = fixture({ ids: IDS, maxActive: 2, maxQueued: 1, protocol: { readUsage(_account, _session, { signal }) {
    started.push(signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true });
    });
  } } });
  assert.deepEqual(f.service.requestAll(), { queued: 3, skipped: 0, pending: 3 });
  await settle();
  assert.equal(started.length, 2);
  assert.equal(f.pool.highWater, 2);
  assert.equal(f.service.pending, 3);
  assert.deepEqual(f.service.requestAll(), { queued: 0, skipped: 3, pending: 3 });
  await f.service.close();
  assert.equal(f.service.pending, 0);
  assert.equal(f.pool.active, 0);
  assert.equal(f.service.getPublic(ID_A).pending, false);
});

test('zero wait-queue still admits work whenever an active slot is immediately available', async t => {
  const f = fixture({ ids: IDS, maxActive: 2, maxQueued: 0 });
  t.after(() => f.service.close());
  assert.equal(f.service.request(ID_A).queued, 1);
  assert.equal(f.service.request(ID_B).queued, 1);
  assert.equal(f.service.request(ID_C).skipped, 1);
  await settle();
  assert.deepEqual(f.reads.sort(), [ID_A, ID_B].sort());
});

test('does not touch a lazy protocol until a session-bearing account actually needs a read', async () => {
  const f = fixture({ ids: [] });
  const guardedProtocol = new Proxy({}, { get() { throw new Error('protocol accessed too early'); } });
  const lazy = new AccountUsageService({ store: f.store, pool: f.pool, protocol: guardedProtocol,
    clock: f.now, tickMs: 100_000 });
  lazy.start();
  assert.deepEqual(lazy.requestAll(), { queued: 0, skipped: 0, pending: 0 });
  await lazy.close();
  await f.service.close();
});

test('maps provider cancellation and session-change codes to safe public codes', async t => {
  let code = 'usage_cancelled';
  const f = fixture({ protocol: { async readUsage() { throw Object.assign(new Error('private details'), { code }); } } });
  t.after(() => f.service.close());
  f.service.request(ID_A);
  await settle();
  assert.equal(f.service.getPublic(ID_A).errorCode, 'cancelled');
  f.advance(20);
  code = 'usage_session_changed';
  f.service.request(ID_A, { force: true });
  await settle();
  assert.equal(f.service.getPublic(ID_A).errorCode, 'session_changed');
});

