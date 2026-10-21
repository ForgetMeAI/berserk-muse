import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAccountService } from '../src/accounts/service.mjs';
import { JobManager } from '../src/accounts/jobs.mjs';

const ID_A = '123e4567-e89b-42d3-a456-426614174000';
const ID_B = '223e4567-e89b-42d3-a456-426614174000';
const SESSION = Object.freeze({ schemaVersion: 1, cookies: [{ name: 'muse', value: 'private-cookie' }],
  tokens: { accessToken: 'private-token' }, device: { id: 'device-1', headers: { accept: 'application/json' } },
  upstream: { gatewayUrl: 'https://private-gateway.test', vmName: 'vm-private', vmId: 'vm-1' }, expiresAt: null });

function emailMask(email) {
  const [local, domain] = email.split('@');
  return `${local[0]}***@${domain[0]}***.${domain.split('.').at(-1)}`;
}

class FakeStore extends EventEmitter {
  constructor(records = []) {
    super();
    this.records = new Map(records.map(record => [record.id, structuredClone(record)]));
  }

  publicRecord(record) {
    return {
      id: record.id, maskedEmail: emailMask(record.emailNormalized), provider: record.provider,
      status: record.status, reasonCode: record.reasonCode, enabled: record.enabled, revision: record.revision,
      cooldownUntil: record.cooldownUntil, quarantined: record.quarantined, hasSession: Boolean(record.session),
      sessionRevision: record.session?.sessionRevision || 0, sessionExpiresAt: record.session?.expiresAt ?? null,
      updatedAt: record.updatedAt,
    };
  }

  listPublic() { return [...this.records.values()].map(record => this.publicRecord(record)); }
  getPrivate(id) {
    const record = this.records.get(id);
    if (!record) throw Object.assign(new Error('private email and URL must not escape'), { code: 'account_not_found' });
    return structuredClone({ ...record, mail: { mailAccessUrl: record.mailAccessUrl } });
  }

  async importBatch(entries) {
    const seenEmail = new Map([...this.records.values()].map(record => [record.emailNormalized, record.mailAccessUrl]));
    const seenUrl = new Map([...this.records.values()].map(record => [record.mailAccessUrl, record.emailNormalized]));
    let skipped = 0;
    const fresh = [];
    for (const entry of entries) {
      const url = seenEmail.get(entry.emailNormalized);
      const email = seenUrl.get(entry.mailAccessUrl);
      if (url === undefined && email === undefined) {
        seenEmail.set(entry.emailNormalized, entry.mailAccessUrl);
        seenUrl.set(entry.mailAccessUrl, entry.emailNormalized);
        fresh.push(entry);
      } else if (url === entry.mailAccessUrl && email === entry.emailNormalized) skipped++;
      else throw Object.assign(new Error('conflict'), { code: 'import_conflict' });
    }
    const imported = fresh.map((entry, index) => {
      const id = index === 0 && !this.records.has(ID_A) ? ID_A : index === 0 && !this.records.has(ID_B) ? ID_B : `323e4567-e89b-42d3-a456-${String(this.records.size + 1).padStart(12, '0')}`;
      const record = { id, email: entry.email, emailNormalized: entry.emailNormalized, provider: entry.provider,
        mailAccessUrl: entry.mailAccessUrl, status: 'active', reasonCode: null, enabled: true, revision: 1,
        updatedAt: 1, cooldownUntil: null, quarantined: false, session: null };
      this.records.set(id, record);
      return this.publicRecord(record);
    });
    if (imported.length) this.emit('change', { type: 'import', accountIds: imported.map(item => item.id) });
    return { imported, skipped, indexRevision: 1 };
  }

  async updateAccount(id, expectedRevision, patch, { expectedSessionRevision } = {}) {
    const record = this.records.get(id);
    if (!record) throw Object.assign(new Error(), { code: 'account_not_found' });
    if (record.revision !== expectedRevision) throw Object.assign(new Error(), { code: 'revision_conflict' });
    if (expectedSessionRevision !== undefined && (record.session?.sessionRevision ?? 0) !== expectedSessionRevision) {
      throw Object.assign(new Error(), { code: 'session_conflict' });
    }
    Object.assign(record, patch, { revision: record.revision + 1, updatedAt: record.updatedAt + 1 });
    this.emit('change', { type: 'account', accountIds: [id] });
    return this.publicRecord(record);
  }

  async replaceSession(id, expectedRevision, session) {
    const record = this.records.get(id);
    const currentRevision = record.session?.sessionRevision || 0;
    if (currentRevision !== expectedRevision) throw Object.assign(new Error(), { code: 'session_conflict' });
    record.session = { ...structuredClone(session), sessionRevision: currentRevision + 1 };
    this.emit('change', { type: 'session', accountIds: [id] });
    return { accountId: id, sessionRevision: record.session.sessionRevision, expiresAt: record.session.expiresAt };
  }
}

function initialRecord(id, email, { session = null, status = 'active' } = {}) {
  return { id, email, emailNormalized: email.toLowerCase(), provider: 'luuvan', mailAccessUrl: `https://luuvan.site/?address=${encodeURIComponent(email.toLowerCase())}`,
    status, reasonCode: status === 'active' ? null : status, enabled: true, revision: 1, updatedAt: 10,
    cooldownUntil: 99, quarantined: true, session: session ? { ...structuredClone(session), sessionRevision: 1 } : null };
}

function dependencies({ records = [], login = async () => structuredClone(SESSION), refresh = async () => ({ sessionRevision: 2 }), telemetry = null, jobOptions = {} } = {}) {
  const store = new FakeStore(records);
  const active = new Set();
  const pool = {
    status() { return { ready: true, mode: 'http', counts: { total: store.records.size, busy: active.size } }; },
    isActive(id) { return active.has(id); },
    async runExclusive(id, fn) {
      if (active.has(id)) throw new Error('nested account operation');
      active.add(id);
      try { return await fn(); } finally { active.delete(id); }
    },
    async clearQuarantine(id, options) {
      assert.equal(options.verified, true);
      const record = store.records.get(id);
      record.quarantined = false;
    },
  };
  const sessionManager = { refresh };
  const bootstrapper = { login };
  const eventBus = { events: [], publish(type, data) { this.events.push({ type, data }); } };
  const jobs = new JobManager({ maxActive: 2, maxQueued: 8, ...jobOptions });
  const service = createAccountService({ store, pool, sessionManager, bootstrapper, jobs, telemetry, eventBus });
  return { store, pool, sessionManager, bootstrapper, jobs, service, eventBus };
}

async function waitJob(jobs, job, timeoutMs = 1_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const current = jobs.get(job.id);
    if (current && ['succeeded', 'failed', 'cancelled'].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('job did not settle');
}

test('validates the full import before mutation and deduplicates exact email and URL pairs', async () => {
  const fake = dependencies();
  const valid = 'First@example.com|https://luuvan.site/?address=first%40example.com';
  await assert.rejects(fake.service.importAccounts({ accounts: `${valid}\ninvalid-line` }), { code: 'invalid_input' });
  assert.equal(fake.store.records.size, 0);
  const result = await fake.service.importAccounts({ accounts: `${valid}\n${valid}` });
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].emailMasked, 'f***@e***.com');
  assert.equal(result.accounts[0].mailProvider, 'luuvan');
  assert.equal(result.accounts[0].status, 'needs_relogin');
  assert.equal(result.accounts[0].reasonCode, 'session_missing');
  assert.equal(fake.store.records.size, 1);
  const job = result.jobs[0];
  assert.equal((await waitJob(fake.jobs, job)).status, 'succeeded');
  assert.equal(fake.store.getPrivate(result.accounts[0].id).session.sessionRevision, 1);
  assert.equal(fake.eventBus.events.some(event => JSON.stringify(event).includes('private-cookie')), false);
  await fake.service.close();
  await fake.jobs.close();
});

test('new numbered imports forward manual-login phases and remain inactive until the browser session completes', async () => {
  let finish;
  let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  const fake = dependencies({ login: async (account, { setPhase }) => {
    assert.equal(account.provider, 'generator');
    setPhase('waiting_for_user');
    ready();
    await release;
    return structuredClone(SESSION);
  } });
  const result = await fake.service.importAccounts({ accounts: '143 | demo@example.test | https://generator.email/demo@example.test' });
  await entered;
  const job = result.jobs[0];
  assert.equal(fake.service.getJob(job.id).phase, 'waiting_for_user');
  assert.equal(fake.service.listAccounts()[0].status, 'needs_relogin');
  assert.equal(fake.store.records.get(result.accounts[0].id).session, null);
  finish();
  assert.equal((await waitJob(fake.jobs, job)).status, 'succeeded');
  assert.equal(fake.service.listAccounts()[0].status, 'active');
  assert.equal(fake.store.records.get(result.accounts[0].id).session.sessionRevision, 1);
  assert.equal(Object.hasOwn(fake.service.getJob(job.id), 'phase'), false);
  await fake.service.close();
  await fake.jobs.close();
});

test('rejects unsupported or oversized import batches before store mutation', async () => {
  const fake = dependencies();
  await assert.rejects(fake.service.importAccounts({ accounts: 'a@example.com|https://unknown.example/inbox' }), { code: 'invalid_input' });
  await assert.rejects(fake.service.importAccounts({ accounts: 'x'.repeat(1_048_577) }), { code: 'invalid_input' });
  assert.equal(fake.store.records.size, 0);
  await fake.service.close();
  await fake.jobs.close();
});

test('relogin persists the whole session with upstream nested under device and clears verified state', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { status: 'needs_relogin' });
  const fake = dependencies({ records: [record] });
  const job = fake.service.relogin(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'succeeded');
  const stored = fake.store.getPrivate(ID_A);
  assert.equal(stored.session.sessionRevision, 1);
  assert.deepEqual(stored.session.device.upstream, SESSION.upstream);
  assert.equal(stored.session.device.headers.accept, 'application/json');
  assert.equal(stored.status, 'active');
  assert.equal(stored.reasonCode, null);
  assert.equal(stored.cooldownUntil, null);
  assert.equal(stored.quarantined, false);
  await fake.service.close();
  await fake.jobs.close();
});

test('serializes relogin and health-check jobs for the same account', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION });
  const order = [];
  let releaseLogin;
  const gate = new Promise(resolve => { releaseLogin = resolve; });
  const fake = dependencies({ records: [record], login: async () => { order.push('login-start'); await gate; order.push('login-end'); return structuredClone(SESSION); },
    refresh: async () => { order.push('health-start'); return { sessionRevision: 2 }; } });
  const loginJob = fake.service.relogin(ID_A);
  await new Promise(resolve => setImmediate(resolve));
  const healthJob = fake.service.healthCheck(ID_A);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['login-start']);
  releaseLogin();
  assert.equal((await waitJob(fake.jobs, loginJob)).status, 'succeeded');
  assert.equal((await waitJob(fake.jobs, healthJob)).status, 'succeeded');
  assert.deepEqual(order, ['login-start', 'login-end', 'health-start']);
  await fake.service.close();
  await fake.jobs.close();
});

test('health check uses only SessionManager refresh and does not open a browser', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { status: 'needs_relogin', session: SESSION });
  let loginCalls = 0;
  let refreshCalls = 0;
  const fake = dependencies({ records: [record], login: async () => { loginCalls++; return structuredClone(SESSION); },
    refresh: async () => { refreshCalls++; return { sessionRevision: 2 }; } });
  const job = fake.service.healthCheck(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'succeeded');
  assert.equal(refreshCalls, 1);
  assert.equal(loginCalls, 0);
  assert.equal(fake.store.records.get(ID_A).status, 'active');
  await fake.service.close();
  await fake.jobs.close();
});

test('public view includes pool-local quarantine and verified health check clears it once outside the gate', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION });
  record.quarantined = false;
  const fake = dependencies({ records: [record] });
  let localQuarantine = true;
  let clearCalls = 0;
  fake.pool.accountState = id => ({
    busy: fake.pool.isActive(id),
    quarantined: localQuarantine,
    quarantineReason: localQuarantine ? 'cleanup_unconfirmed' : null,
  });
  fake.pool.clearQuarantine = async (id, options) => {
    assert.equal(id, ID_A);
    assert.equal(options.verified, true);
    assert.equal(fake.pool.isActive(id), false, 'quarantine clearing must run after the exclusive gate');
    clearCalls += 1;
    localQuarantine = false;
  };
  let [account] = fake.service.listAccounts();
  assert.equal(account.quarantined, true);
  assert.equal(account.reasonCode, 'cleanup_unconfirmed');
  const job = fake.service.healthCheck(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'succeeded');
  assert.equal(clearCalls, 1);
  [account] = fake.service.listAccounts();
  assert.equal(account.quarantined, false);
  await fake.service.close();
  await fake.jobs.close();
});

test('stale relogin CAS failure does not demote a newer successful session', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION });
  const fake = dependencies({ records: [record] });
  fake.bootstrapper.login = async () => {
    const current = fake.store.records.get(ID_A);
    current.session = { ...structuredClone(SESSION), sessionRevision: 2, tokens: { accessToken: 'new-session-token' } };
    current.status = 'active';
    current.reasonCode = null;
    return structuredClone(SESSION);
  };
  const job = fake.service.relogin(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'failed');
  const current = fake.store.getPrivate(ID_A);
  assert.equal(current.session.sessionRevision, 2);
  assert.equal(current.session.tokens.accessToken, 'new-session-token');
  assert.equal(current.status, 'active');
  assert.equal(current.reasonCode, null);
  await fake.service.close();
  await fake.jobs.close();
});

test('failed relogin preserves an existing session even when the login reports an auth verdict', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION });
  const fake = dependencies({ records: [record], login: async () => {
    throw Object.assign(new Error('private auth response'), { code: 'expired' });
  } });
  const job = fake.service.relogin(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'failed');
  const current = fake.store.getPrivate(ID_A);
  assert.equal(current.status, 'active');
  assert.equal(current.reasonCode, null);
  assert.equal(current.session.sessionRevision, 1);
  assert.equal(current.session.tokens.accessToken, SESSION.tokens.accessToken);
  await fake.service.close();
  await fake.jobs.close();
});

test('explicit auth verdict marks an account that began without a usable session', async () => {
  const record = initialRecord(ID_A, 'first@example.com');
  const fake = dependencies({ records: [record], login: async () => {
    throw Object.assign(new Error('private auth response'), { code: 'expired' });
  } });
  const job = fake.service.relogin(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'failed');
  const current = fake.store.getPrivate(ID_A);
  assert.equal(current.status, 'needs_relogin');
  assert.equal(current.reasonCode, 'expired');
  assert.equal(current.session, null);
  await fake.service.close();
  await fake.jobs.close();
});

test('relogin auth verdict cannot demote a fresh session installed while login was pending', async () => {
  const record = initialRecord(ID_A, 'first@example.com');
  const fake = dependencies({ records: [record], login: async () => {
    const current = fake.store.records.get(ID_A);
    current.session = { ...structuredClone(SESSION), sessionRevision: 1 };
    current.status = 'active';
    current.reasonCode = null;
    current.revision += 1;
    throw Object.assign(new Error('stale login verdict'), { code: 'needs_relogin' });
  } });
  const job = fake.service.relogin(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'failed');
  const current = fake.store.getPrivate(ID_A);
  assert.equal(current.status, 'active');
  assert.equal(current.reasonCode, null);
  assert.equal(current.session.sessionRevision, 1);
  await fake.service.close();
  await fake.jobs.close();
});

test('relogin auth status write includes atomic session revision guard', async () => {
  const record = initialRecord(ID_A, 'first@example.com');
  const fake = dependencies({ records: [record], login: async () => {
    throw Object.assign(new Error('auth verdict'), { code: 'needs_relogin' });
  } });
  const update = fake.store.updateAccount.bind(fake.store);
  let injectedRace = false;
  fake.store.updateAccount = async (id, revision, patch, options) => {
    if (patch.status === 'needs_relogin' && options?.expectedSessionRevision === 0 && !injectedRace) {
      injectedRace = true;
      fake.store.records.get(id).session = { ...structuredClone(SESSION), sessionRevision: 1 };
    }
    return update(id, revision, patch, options);
  };
  const job = fake.service.relogin(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'failed');
  const current = fake.store.getPrivate(ID_A);
  assert.equal(injectedRace, true);
  assert.equal(current.status, 'active');
  assert.equal(current.reasonCode, null);
  assert.equal(current.session.sessionRevision, 1);
  await fake.service.close();
  await fake.jobs.close();
});

test('failed quarantine clear preserves its reason after a verified health refresh', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION });
  record.reasonCode = 'cleanup_unconfirmed';
  const fake = dependencies({ records: [record] });
  fake.pool.accountState = id => ({ busy: fake.pool.isActive(id), quarantined: id === ID_A, quarantineReason: 'cleanup_unconfirmed' });
  fake.pool.clearQuarantine = async () => { throw Object.assign(new Error('private cancellation'), { code: 'cancelled' }); };
  const job = fake.service.healthCheck(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'failed');
  const current = fake.store.getPrivate(ID_A);
  assert.equal(current.status, 'active');
  assert.equal(current.reasonCode, 'cleanup_unconfirmed');
  assert.equal(current.quarantined, true);
  await fake.service.close();
  await fake.jobs.close();
});

test('relogin clear cancellation keeps the newly installed session active and quarantined', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION, status: 'needs_relogin' });
  record.reasonCode = 'cleanup_unconfirmed';
  const replacement = { ...structuredClone(SESSION), tokens: { accessToken: 'fresh-token' } };
  const fake = dependencies({ records: [record], login: async () => replacement });
  fake.pool.clearQuarantine = async () => { throw Object.assign(new Error('private cancellation'), { code: 'cancelled' }); };
  const job = fake.service.relogin(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'failed');
  const current = fake.store.getPrivate(ID_A);
  assert.equal(current.status, 'active');
  assert.equal(current.reasonCode, 'cleanup_unconfirmed');
  assert.equal(current.session.sessionRevision, 2);
  assert.equal(current.session.tokens.accessToken, 'fresh-token');
  assert.equal(current.quarantined, true);
  await fake.service.close();
  await fake.jobs.close();
});

test('aborted health refresh drains before releasing the account-exclusive gate', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION });
  let releaseDrain;
  let refreshStarted;
  const started = new Promise(resolve => { refreshStarted = resolve; });
  const draining = new Promise(resolve => { releaseDrain = resolve; });
  const fake = dependencies({ records: [record], refresh: async (_id, { signal }) => new Promise((_resolve, reject) => {
    refreshStarted();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('private refresh detail'), { code: 'aborted' })), { once: true });
  }) });
  fake.sessionManager.drain = async id => { assert.equal(id, ID_A); await draining; };
  const job = fake.service.healthCheck(ID_A);
  await started;
  fake.jobs.cancel(job.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.pool.isActive(ID_A), true, 'the pool gate must remain held during drain');
  releaseDrain();
  await fake.service.close();
  assert.equal(fake.jobs.get(job.id).status, 'cancelled');
  assert.equal(fake.pool.isActive(ID_A), false);
  await fake.jobs.close();
});

test('transient service refresh failure does not leave an active account marked for re-login', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION });
  const fake = dependencies({ records: [record] });
  fake.sessionManager.refresh = async () => {
    throw Object.assign(new Error('safe session error'), { code: 'refresh_failed', cause: { scope: 'service' } });
  };
  const job = fake.service.healthCheck(ID_A);
  assert.equal((await waitJob(fake.jobs, job)).status, 'failed');
  const current = fake.store.getPrivate(ID_A);
  assert.equal(current.status, 'active');
  assert.equal(current.reasonCode, null);
  assert.equal(current.session.sessionRevision, 1);
  await fake.service.close();
  await fake.jobs.close();
});

test('maps active accounts without sessions to needs_relogin and uses pool per-account busy when available', async () => {
  const record = initialRecord(ID_A, 'first@example.com');
  const fake = dependencies({ records: [record] });
  fake.pool.accountState = id => ({ busy: id === ID_A });
  const [account] = fake.service.listAccounts();
  assert.equal(account.status, 'needs_relogin');
  assert.equal(account.reasonCode, 'session_missing');
  assert.equal(account.busy, true);
  await fake.service.close();
  await fake.jobs.close();
});

test('estimated usage remains labeled as estimated and missing upstream counters stay unknown', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { session: SESSION });
  const telemetry = {
    listRequests() { return { records: [
      { kind: 'attempt', requestId: 'r1', accountId: ID_A, estimatedInputTokens: 12, upstreamRemaining: 9, at: 30 },
      { kind: 'result', requestId: 'r1', accountId: ID_A, estimatedOutputTokens: 5 },
      { kind: 'result', requestId: 'r2', accountId: ID_A, estimatedOutputTokens: null, rawPrompt: 'secret' },
    ], nextCursor: null }; },
    snapshot() { return { upstream: { remaining: null, reportedAt: null } }; },
  };
  const fake = dependencies({ records: [record], telemetry });
  const [account] = fake.service.listAccounts();
  assert.deepEqual(account.estimatedUsage, { inputTokens: 12, outputTokens: 5, totalTokens: 17, requests: 2, unknownRequests: 1, estimated: true });
  assert.deepEqual(account.upstreamQuota, { unit: 'tokens', remaining: 9, observedAt: 30 });
  assert.equal(account.remaining, null);
  assert.equal(JSON.stringify(account).includes('secret'), false);
  await fake.service.close();
  await fake.jobs.close();
});

test('close cancels and awaits a running service-owned browser login', async () => {
  const record = initialRecord(ID_A, 'first@example.com', { status: 'needs_relogin' });
  let cleanupFinished = false;
  const fake = dependencies({ records: [record], login: async (_account, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cleanupFinished = true; reject(Object.assign(new Error('private'), { code: 'aborted' })); }, { once: true });
  }) });
  fake.service.relogin(ID_A);
  await new Promise(resolve => setImmediate(resolve));
  await fake.service.close();
  assert.equal(cleanupFinished, true);
  await fake.jobs.close();
});
