import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AccountStore } from '../src/accounts/store.mjs';
import { SessionManager, SessionError } from '../src/muse/session.mjs';

const TMP = join(dirname(dirname(fileURLToPath(import.meta.url))), '.test-tmp');

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: ms => { now += ms; } };
}

function sess(over = {}) {
  return { cookies: [{ name: 'sid', value: 'COOKIE' }], tokens: { access: 'TOKEN_CANARY' }, device: { id: 'DEV' }, expiresAt: null, ...over };
}

async function storeFor(t, clock) {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, 'session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AccountStore({ rootDir: join(dir, 'accounts'), clock });
  t.after(() => store.close());
  await store.init();
  return store;
}

let seedCounter = 0;
async function seed(store, { status = 'active', expiresAt = null } = {}) {
  const n = seedCounter += 1;
  const { imported } = await store.importBatch([{
    email: `User${n}@Mail.test`, emailNormalized: `user${n}@mail.test`, provider: 'prov', mailAccessUrl: `https://mail.test/inbox/${n}`,
  }]);
  const id = imported[0].id;
  await store.replaceSession(id, 0, sess({ expiresAt }));
  if (status !== 'active') await store.updateAccount(id, 1, { status });
  return id;
}

function fakeProtocol({ probe, refresh } = {}) {
  const calls = { probe: 0, refresh: 0 };
  return {
    calls,
    async probe(account, session, options) { calls.probe += 1; return probe ? probe(account, session, options) : { valid: true }; },
    async refresh(account, session, options) { calls.refresh += 1; return refresh ? refresh(account, session, options) : { ok: true, session: sess({ tokens: { access: 'REFRESHED' } }) }; },
  };
}

test('ensureValid trusts a successful probe without refreshing', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  const protocol = fakeProtocol();
  const manager = new SessionManager({ store, protocol, clock });
  const descriptor = await manager.ensureValid(id);
  assert.equal(descriptor.refreshed, false);
  assert.equal(descriptor.sessionRevision, 1);
  assert.equal(protocol.calls.probe, 1);
  assert.equal(protocol.calls.refresh, 0);
});

test('ensureValid refreshes proactively inside the 60s expiry margin and skips the probe', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store, { expiresAt: clock.now() + 30_000 });
  const protocol = fakeProtocol();
  const manager = new SessionManager({ store, protocol, clock });
  const descriptor = await manager.ensureValid(id);
  assert.equal(descriptor.refreshed, true);
  assert.equal(descriptor.sessionRevision, 2);
  assert.equal(protocol.calls.probe, 0);
  assert.equal(protocol.calls.refresh, 1);
});

test('ensureValid refreshes when the probe reports the session invalid', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  const protocol = fakeProtocol({ probe: async () => ({ valid: false }) });
  const manager = new SessionManager({ store, protocol, clock });
  const descriptor = await manager.ensureValid(id);
  assert.equal(descriptor.refreshed, true);
  assert.equal(protocol.calls.probe, 1);
  assert.equal(protocol.calls.refresh, 1);
});

test('a successful refresh persists the complete bundle and reactivates an expired account', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store, { status: 'expired' });
  const protocol = fakeProtocol();
  const manager = new SessionManager({ store, protocol, clock });
  const descriptor = await manager.ensureValid(id);
  assert.equal(descriptor.refreshed, true);
  assert.equal(protocol.calls.probe, 0, 'a known-expired status goes straight to refresh');
  assert.equal(store.getPublic(id).status, 'active');
  assert.equal(store.getPrivate(id).session.tokens.access, 'REFRESHED');
});

test('an unrefreshable session yields a typed needs_relogin/expired state and records it', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const relogin = await seed(store);
  const reloginManager = new SessionManager({ store, protocol: fakeProtocol({ refresh: async () => ({ ok: false, reason: 'needs_relogin' }) }), clock });
  await assert.rejects(reloginManager.refresh(relogin), e => e instanceof SessionError && e.code === 'needs_relogin');
  assert.equal(store.getPublic(relogin).status, 'needs_relogin');

  const expired = await seed(store);
  const expiredManager = new SessionManager({ store, protocol: fakeProtocol({ refresh: async () => ({ ok: false, reason: 'expired' }) }), clock });
  await assert.rejects(expiredManager.refresh(expired), e => e.code === 'expired');
  assert.equal(store.getPublic(expired).status, 'expired');
});

test('concurrent refreshes share a single in-flight operation', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  let release;
  let entered = 0;
  const protocol = fakeProtocol({ refresh: () => new Promise(resolve => { entered += 1; release = () => resolve({ ok: true, session: sess() }); }) });
  const manager = new SessionManager({ store, protocol, clock });
  const first = manager.refresh(id);
  const second = manager.refresh(id);
  assert.equal(entered, 1, 'the protocol refresh runs once for both callers');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.sessionRevision, b.sessionRevision);
  assert.equal(protocol.calls.refresh, 1);
});

test('an aborted caller does not poison the shared refresh for other waiters', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  let release;
  const protocol = fakeProtocol({ refresh: () => new Promise(resolve => { release = () => resolve({ ok: true, session: sess() }); }) });
  const manager = new SessionManager({ store, protocol, clock });
  const controller = new AbortController();
  const aborted = manager.refresh(id, { signal: controller.signal }).then(() => null, e => e);
  const survivor = manager.refresh(id).then(ok => ok, e => e);
  controller.abort();
  const abortResult = await aborted;
  assert.equal(abortResult.code, 'request_cancelled');
  release();
  const survivorResult = await survivor;
  assert.equal(survivorResult.refreshed, true);
  assert.equal(protocol.calls.refresh, 1);
});

test('a stale refresh result loses the CAS and never clobbers a newer session', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  const protocol = fakeProtocol({ refresh: async () => {
    // A competing writer advances the session while this refresh is still running.
    await store.replaceSession(id, 1, sess({ tokens: { access: 'COMPETING' } }));
    return { ok: true, session: sess({ tokens: { access: 'LATE' } }) };
  } });
  const manager = new SessionManager({ store, protocol, clock });
  await assert.rejects(manager.refresh(id), e => e.code === 'session_conflict');
  assert.equal(store.getPrivate(id).session.tokens.access, 'COMPETING');
  assert.equal(store.getPublic(id).sessionRevision, 2);
});

test('unknown expiry stays null through probe and refresh', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store, { expiresAt: null });
  const probeManager = new SessionManager({ store, protocol: fakeProtocol({ probe: async () => ({ valid: true }) }), clock });
  assert.equal((await probeManager.ensureValid(id)).expiresAt, null);
  const refreshManager = new SessionManager({ store, protocol: fakeProtocol({ refresh: async () => ({ ok: true, session: sess({ expiresAt: null }) }) }), clock });
  assert.equal((await refreshManager.refresh(id)).expiresAt, null);
  assert.equal(store.getPublic(id).sessionExpiresAt, null);
});

test('banned accounts are never probed or refreshed and needs_relogin short-circuits', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const banned = await seed(store, { status: 'banned' });
  const protocol = fakeProtocol();
  const manager = new SessionManager({ store, protocol, clock });
  await assert.rejects(manager.ensureValid(banned), e => e.code === 'account_banned');
  await assert.rejects(manager.refresh(banned), e => e.code === 'account_banned');
  assert.equal(protocol.calls.probe, 0);
  assert.equal(protocol.calls.refresh, 0);

  const relogin = await seed(store, { status: 'needs_relogin' });
  await assert.rejects(manager.ensureValid(relogin), e => e.code === 'needs_relogin');
  assert.equal(protocol.calls.probe, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('transient, malformed, or unexplained refresh failures are refresh_failed and never mark auth state', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  let behaviour;
  const manager = new SessionManager({ store, protocol: fakeProtocol({ refresh: async () => behaviour() }), clock });
  const outcomes = [
    () => { throw Object.assign(new Error('503 upstream TOKEN_CANARY'), { status: 503 }); },
    () => { throw new Error('ETIMEDOUT'); },
    () => ({ ok: false, reason: 'rate_limited' }),
    () => ({ ok: false }),
    () => 'garbage',
    () => ({ ok: true, session: { cookies: 'not-an-array', tokens: {}, device: {} } }),
  ];
  for (const outcome of outcomes) {
    behaviour = outcome;
    const error = await manager.refresh(id).then(() => null, e => e);
    assert.ok(error instanceof SessionError);
    assert.equal(error.code, 'refresh_failed');
    assert.equal(error.message.includes('TOKEN_CANARY'), false);
    assert.equal(store.getPublic(id).status, 'active', 'auth state untouched');
    assert.equal(store.getPublic(id).sessionRevision, 1, 'nothing persisted');
  }
});

test('a malformed probe result is probe_failed rather than a refresh trigger', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  const protocol = fakeProtocol({ probe: async () => ({ valid: 'yes' }) });
  const manager = new SessionManager({ store, protocol, clock });
  await assert.rejects(manager.ensureValid(id), e => e.code === 'probe_failed');
  assert.equal(protocol.calls.refresh, 0);
});

test('an old refresh that fails explicitly never invalidates a freshly re-logged session', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  const gate = deferred();
  const manager = new SessionManager({ store, protocol: fakeProtocol({ refresh: async () => { await gate.promise; return { ok: false, reason: 'needs_relogin' }; } }), clock });

  const pending = manager.refresh(id).then(() => null, e => e);
  await tick();
  await store.replaceSession(id, 1, sess({ tokens: { access: 'RELOGGED' } }));
  gate.resolve();
  assert.equal((await pending).code, 'needs_relogin', 'the old session really was rejected');
  assert.equal(store.getPublic(id).status, 'active', 'but the newer session is not marked invalid');
  assert.equal(store.getPrivate(id).session.tokens.access, 'RELOGGED');
});

test('drain waits for a shared refresh that an aborted caller abandoned', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  const gate = deferred();
  const manager = new SessionManager({ store, protocol: fakeProtocol({ refresh: async () => { await gate.promise; return { ok: true, session: sess({ tokens: { access: 'LATE' } }) }; } }), clock });

  const controller = new AbortController();
  const joined = manager.refresh(id, { signal: controller.signal }).then(() => null, e => e);
  controller.abort();
  assert.equal((await joined).code, 'request_cancelled', 'the caller returns at once');
  let drained = false;
  const draining = manager.drain(id).then(() => { drained = true; });
  await tick();
  assert.equal(drained, false, 'the shared flight is still running');
  gate.resolve();
  await draining;
  assert.equal(store.getPrivate(id).session.tokens.access, 'LATE', 'drain resolves only after the flight persisted');
  await manager.drain(id);
});

test('close aborts in-flight refreshes, waits for them, persists nothing, and rejects new work', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  let seen;
  const manager = new SessionManager({ store, clock, protocol: fakeProtocol({ refresh: (account, session, { signal }) => new Promise((resolve, reject) => {
    seen = signal;
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) }) });

  const pending = manager.refresh(id).then(() => null, e => e);
  await tick();
  await manager.close();
  assert.equal(seen.aborted, true);
  assert.equal((await pending).code, 'refresh_failed');
  assert.equal(store.getPublic(id).sessionRevision, 1);
  assert.equal(store.getPublic(id).status, 'active');
  await assert.rejects(manager.refresh(id), e => e.code === 'shutting_down');
  await assert.rejects(manager.ensureValid(id), e => e.code === 'shutting_down');
});

test('probe failures surface a sanitized error that never serializes token material', async t => {
  const clock = makeClock();
  const store = await storeFor(t, clock);
  const id = await seed(store);
  const protocol = fakeProtocol({ probe: async () => { throw new Error('upstream blew up with TOKEN_CANARY in it'); } });
  const manager = new SessionManager({ store, protocol, clock });
  const error = await manager.ensureValid(id).then(() => null, e => e);
  assert.ok(error instanceof SessionError);
  assert.equal(error.code, 'probe_failed');
  assert.equal(error.message.includes('TOKEN_CANARY'), false);
  assert.equal(JSON.stringify(error).includes('TOKEN_CANARY'), false);
});
