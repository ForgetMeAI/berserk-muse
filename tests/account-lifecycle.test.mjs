import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/accounts/store.mjs';
import { AccountPool } from '../src/accounts/pool.mjs';
import { SessionManager } from '../src/muse/session.mjs';
import { JobManager } from '../src/accounts/jobs.mjs';
import { createAccountService } from '../src/accounts/service.mjs';

const ACCOUNT = Object.freeze({ email: 'lifecycle@example.test', emailNormalized: 'lifecycle@example.test',
  provider: 'luuvan', mailAccessUrl: 'https://luuvan.site/inbox?email=lifecycle%40example.test' });
const TEST_SESSION = () => ({ cookies: [{ name: 'test-session', value: 'synthetic-only', domain: '.muse.ai', path: '/' }],
  tokens: { accessToken: 'synthetic-only' }, device: { id: 'test-device', headers: {} }, expiresAt: null });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function setup(t, { transportFactory, sessionManager, protocol, accountCount = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'berserk-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AccountStore({ rootDir: join(directory, 'accounts') });
  await store.init();
  const imported = await store.importBatch(Array.from({ length: accountCount }, (_, index) => ({
    ...ACCOUNT,
    email: `lifecycle${index}@example.test`, emailNormalized: `lifecycle${index}@example.test`,
    mailAccessUrl: `https://luuvan.site/inbox?email=lifecycle${index}%40example.test`,
  })));
  const ids = imported.imported.map(account => account.id);
  for (const id of ids) await store.replaceSession(id, 0, TEST_SESSION());
  const session = sessionManager ?? new SessionManager({
    store,
    protocol: protocol ?? { probe: async () => ({ valid: true }), refresh: async () => ({ ok: true, session: TEST_SESSION() }) },
  });
  const pool = new AccountPool({ store, sessionManager: session,
    transportFactory: transportFactory ?? (async () => ({ async close() {} })) });
  return { directory, store, ids, session, pool };
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

async function waitJob(jobs, id) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = jobs.get(id);
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Test job did not settle before its bounded deadline.');
}

test('a lease remains busy through delayed transport close and excludes relogin', async t => {
  const closeStarted = deferred();
  const closeGate = deferred();
  let transportNumber = 0;
  const { ids: [id], pool, store } = await setup(t, { transportFactory: async () => {
    transportNumber += 1;
    const current = transportNumber;
    return { async close() {
      if (current === 1) { closeStarted.resolve(); await closeGate.promise; }
    } };
  } });
  const lease = await pool.acquire({ requestId: 'lifecycle-test' });
  const releasing = pool.release(lease);
  let exclusiveStarted = false;
  let exclusive;
  let followupLease;
  try {
    await closeStarted.promise;
    const busyDuringClose = pool.status().counts.busy;
    exclusive = pool.runExclusive(id, async () => { exclusiveStarted = true; });
    followupLease = await pool.acquire({ requestId: 'must-wait-for-cleanup' });
    await tick();
    assert.equal(busyDuringClose, 1, 'account must remain unavailable until its transport cleanup settles');
    assert.equal(followupLease, null, 'generation cannot take a replacement lease during cleanup');
    assert.equal(exclusiveStarted, false, 'relogin/refresh work must wait for the active lease cleanup');
  } finally {
    closeGate.resolve();
    await Promise.allSettled([releasing, exclusive, followupLease && pool.release(followupLease)]);
    await pool.close();
    await store.close();
  }
});

test('runExclusive excludes new generation until its callback completes', async t => {
  const workStarted = deferred();
  const workGate = deferred();
  const { ids: [id], pool, store } = await setup(t);
  let unexpectedLease;
  const exclusive = pool.runExclusive(id, async () => { workStarted.resolve(); await workGate.promise; });
  try {
    await workStarted.promise;
    unexpectedLease = await pool.acquire({ requestId: 'blocked-by-exclusive' });
    assert.equal(unexpectedLease, null, 'an exclusive login or refresh must prevent generation acquisition');
  } finally {
    if (unexpectedLease) await pool.release(unexpectedLease);
    workGate.resolve();
    await exclusive;
    const after = await pool.acquire({ requestId: 'after-exclusive' });
    assert.ok(after, 'generation becomes available after the exclusive callback settles');
    await pool.release(after);
    await pool.close();
    await store.close();
  }
});

test('a stale authentication refresh failure cannot demote a newer stored session', async t => {
  const refreshStarted = deferred();
  const refreshResult = deferred();
  const { ids: [id], store, session: sessionManager } = await setup(t, { protocol: {
    probe: async () => ({ valid: true }),
    refresh: async () => { refreshStarted.resolve(); return refreshResult.promise; },
  } });
  // Force the real refresh to read revision 1 before a newer interactive session wins the CAS.
  const refresh = sessionManager.refresh(id);
  try {
    const recovered = await Promise.race([refreshStarted.promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
    assert.equal(recovered, true, 'recoverable auth delivery should enter the session refresh hook');
    const current = store.getPrivate(id);
    await store.replaceSession(id, current.session.sessionRevision, TEST_SESSION());
    refreshResult.reject(Object.assign(new Error('old session rejected'), { scope: 'account' }));
    await assert.rejects(refresh);
    const latest = store.getPrivate(id);
    assert.equal(latest.session.sessionRevision, 2);
    assert.equal(latest.status, 'active', 'an obsolete refresh failure must not mark the newer session for re-login');
  } finally {
    await store.close();
  }
});

test('a transient service failure during health check preserves account status', async t => {
  const { ids: [id], store, pool } = await setup(t);
  const session = { async refresh() { throw Object.assign(new Error('synthetic service outage'), { code: 'refresh_failed' }); } };
  const jobs = new JobManager();
  const service = createAccountService({ store, pool, sessionManager: session, jobs,
    bootstrapper: { async login() { throw new Error('not used'); } } });
  try {
    const started = service.healthCheck(id);
    const job = await waitJob(jobs, started.id);
    assert.equal(job.status, 'failed');
    const account = store.getPrivate(id);
    assert.equal(account.status, 'active');
    assert.equal(account.reasonCode, null);
  } finally {
    await service.close();
    await jobs.close();
    await pool.close();
    await store.close();
  }
});

test('health check and relogin clear quarantine after releasing the account gate', async t => {
  const { ids: [id], store, pool, session } = await setup(t);
  const jobs = new JobManager();
  const service = createAccountService({ store, pool, sessionManager: session, jobs,
    bootstrapper: { async login() { return { ...TEST_SESSION(), upstream: {
      gatewayUrl: 'https://muse.example.test', vmName: 'synthetic', vmId: 'synthetic',
    } }; } } });
  try {
    await pool.quarantine(id, 'synthetic_cleanup_failure');
    const health = service.healthCheck(id);
    assert.equal((await waitJob(jobs, health.id)).status, 'succeeded');
    assert.equal(store.getPublic(id).quarantined, false, 'verified health check clears quarantine');

    await pool.quarantine(id, 'synthetic_cleanup_failure');
    const relogin = service.relogin(id);
    const reloginJob = await waitJob(jobs, relogin.id);
    assert.equal(reloginJob.status, 'succeeded', `relogin job result: ${JSON.stringify(reloginJob)}`);
    assert.equal(store.getPublic(id).quarantined, false, 'verified relogin clears quarantine');
  } finally {
    await service.close();
    await jobs.close();
    await pool.close();
    await store.close();
  }
});

test('abort during session recovery drains the request and releases its account lease', async t => {
  const refreshStarted = deferred();
  const refreshGate = deferred();
  const refreshSettled = deferred();
  const cleanupSettled = deferred();
  let closeCount = 0;
  const protocol = {
    probe: async () => ({ valid: true }),
    refresh: async () => {
      refreshStarted.resolve();
      try { return await refreshGate.promise; }
      finally { refreshSettled.resolve(); }
    },
  };
  const { pool, session, ids: [id] } = await setup(t, { protocol,
    transportFactory: async () => ({ async close() { closeCount += 1; cleanupSettled.resolve(); } }) });
  const controller = new AbortController();
  let lease;
  let recovery;
  try {
    lease = await pool.acquire({ requestId: 'abort-recovery' });
    assert.ok(lease);
    recovery = pool.recover(lease, { signal: controller.signal });
    await refreshStarted.promise;
    controller.abort();
    let recoverySettled = false;
    recovery.then(() => { recoverySettled = true; }, () => { recoverySettled = true; });
    await tick();
    assert.equal(recoverySettled, false, 'recovery drains the shared refresh before releasing its account gate');
    refreshGate.resolve({ ok: true, session: TEST_SESSION() });
    await refreshSettled.promise;
    await assert.rejects(recovery, error => error?.code === 'request_cancelled' || error?.name === 'AbortError');
    await pool.release(lease).catch(() => {});
    await cleanupSettled.promise;
    assert.equal(pool.status().counts.busy, 0, 'cancelled recovery must not strand the account lease');
    assert.ok(closeCount >= 1, 'the active transport must be closed while draining the aborted request');
  } finally {
    controller.abort();
    refreshGate.resolve({ ok: true, session: TEST_SESSION() });
    if (recovery) await Promise.allSettled([recovery]);
    if (lease) await pool.release(lease).catch(() => {});
    await pool.close();
    await session.close?.();
  }
});

test('transport cleanup failure quarantines the account durably across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'berserk-cleanup-quarantine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootDir = join(directory, 'accounts');
  const store = new AccountStore({ rootDir });
  await store.init();
  const { imported: [publicAccount] } = await store.importBatch([ACCOUNT]);
  const id = publicAccount.id;
  await store.replaceSession(id, 0, TEST_SESSION());
  const pool = new AccountPool({ store, transportFactory: async () => ({ async close() { throw new Error('synthetic cleanup failure'); } }) });
  try {
    const lease = await pool.acquire({ requestId: 'cleanup-failure' });
    await pool.release(lease).catch(() => {});
    assert.equal(store.getPublic(id).quarantined, true, 'failed cleanup must make the account ineligible');
    await pool.close();
    await store.close();
    const reopened = new AccountStore({ rootDir });
    await reopened.init();
    assert.equal(reopened.getPublic(id).quarantined, true, 'quarantine must survive a process restart');
    await reopened.close();
  } finally {
    await pool.close();
    await store.close();
  }
});
