import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountStore } from '../src/accounts/store.mjs';
import { createApplication } from '../src/application.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolveValue => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

function makeFakes({ pool, browser = null, bootstrapper = null, onClose = [] } = {}) {
  const fakePool = pool ?? {
    status: () => ({ ready: false, state: 'no_ready_account', mode: 'http', model: 'Muse app selection' }),
    accountState: () => ({ busy: false }),
    acquire: async () => null,
    release: async () => {},
    noteFailure: async () => ({ retryable: false }),
    runExclusive: async (_id, fn) => fn(),
    clearQuarantine: async (_id, options) => assert.equal(options?.verified, true),
    close: async () => { onClose.push('pool'); },
  };
  const sessionManager = {
    refresh: async () => ({ sessionRevision: 1 }),
    ensureValid: async () => {},
    close: async () => { onClose.push('sessionManager'); },
  };
  const fakeBrowser = browser ?? {
    status: () => ({ ready: false, state: 'browser_ready', mode: 'browser' }),
    generate: async () => { throw new Error('unexpected fake browser generation'); },
    login: async () => ({ ok: true }),
    close: async () => { onClose.push('browser'); },
  };
  const fakeTelemetry = {
    ready: async () => {}, init: async () => {},
    recordAttempt: async () => {}, recordResult: async () => {},
    listRequests: () => ({ records: [], nextCursor: null }),
    close: async () => { onClose.push('telemetry'); },
  };
  const fakeBootstrapper = bootstrapper ?? {
    login: async () => ({ schemaVersion: 1, cookies: [], tokens: { token: 'test-token' },
      device: { id: 'test-device' }, upstream: { gatewayUrl: 'https://muse.ai', vmName: 'test', vmId: 'test' }, expiresAt: null }),
  };
  return { pool: fakePool, sessionManager, browser: fakeBrowser, telemetry: fakeTelemetry, bootstrapper: fakeBootstrapper };
}

async function createHarness({ transport = 'browser', dependencies = {}, onClose = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'muse-application-test-'));
  const accountsDir = join(dir, 'accounts');
  const stateDir = join(dir, 'runtime');
  const port = 38143;
  const store = dependencies.store ?? new AccountStore({ rootDir: accountsDir });
  const deps = makeFakes({ ...dependencies, onClose });
  const wrappedStore = store;
  const closeStore = wrappedStore.close.bind(wrappedStore);
  wrappedStore.close = async () => { onClose.push('store'); await closeStore(); };
  const app = await createApplication({
    config: { transport, port, timeoutMs: 5_000, queueLimit: 4, maxActive: 1, accountsDir },
    root: ROOT, stateDir,
    dependencies: { ...deps, ...dependencies, store: wrappedStore },
  });
  // Exercise the real request handler with in-memory Node request/response fakes.
  // This keeps the integration test offline and avoids opening even loopback sockets.
  app.server.address = () => ({ port });
  return { app, port, dir, store: wrappedStore, close: async () => {
    try { await app.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  } };
}

async function jsonRequest(harness, pathname, { method = 'GET', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = pathname;
  req.headers = { host: `127.0.0.1:${harness.port}`, ...headers };
  req.aborted = false;
  const res = new class extends EventEmitter {
    constructor() { super(); this.headers = {}; this.statusCode = null; this.headersSent = false; this.writableEnded = false; this.destroyed = false; this.parts = []; }
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    writeHead(status, headers = {}) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))); }
    write(value) { this.parts.push(Buffer.from(value)); return true; }
    end(value = '') { if (value) this.parts.push(Buffer.from(value)); this.writableEnded = true; }
    destroy() { this.destroyed = true; this.emit('close'); }
    get bodyText() { return Buffer.concat(this.parts).toString('utf8'); }
  }();
  const handler = harness.app.server.listeners('request')[0];
  await handler(req, res);
  return { response: { status: res.statusCode, headers: res.headers }, body: JSON.parse(res.bodyText) };
}

async function waitForJob(harness, jobId, admin, { timeoutMs = 10_000, pollMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastJob = null;
  while (true) {
    const current = await jsonRequest(harness, `/control/jobs/${jobId}`, { headers: { authorization: admin } });
    assert.equal(current.response.status, 200, 'job status endpoint should remain available while waiting');
    lastJob = current.body.job ?? null;
    if (['succeeded', 'failed', 'cancelled'].includes(lastJob?.status)) return lastJob;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return lastJob;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

async function waitFor(promise, description, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} did not occur before its bounded deadline`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function addSyntheticSession(harness, suffix = 'usage') {
  const email = `${suffix}@example.test`;
  const imported = await harness.store.importBatch([{
    email, emailNormalized: email.toLowerCase(), provider: 'synthetic',
    mailAccessUrl: `https://mail.example.test/inbox?case=${suffix}`,
  }]);
  const account = imported.imported[0];
  await harness.store.replaceSession(account.id, 0, {
    cookies: [{ name: 'muse_session', value: `synthetic-${suffix}`, domain: 'muse.ai', path: '/', secure: true, httpOnly: true }],
    tokens: {}, device: { id: `synthetic-device-${suffix}`, headers: { 'user-agent': 'Synthetic test browser' } },
    expiresAt: null,
  });
  return account.id;
}

async function waitForUsageState(app, accountId, expected, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const usage = app.usageService.getPublic(accountId);
    if (usage.state === expected) return usage;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`usage state ${expected} was not reached before the bounded deadline`);
}

test('browser rollback starts and reports health without materializing HTTP vendor transport', async () => {
  let browserStatus = 0;
  let browserClosed = 0;
  const protocol = new Proxy({}, { get() { throw new Error('HTTP protocol must remain dormant in browser mode'); } });
  const harness = await createHarness({ transport: 'browser', dependencies: {
    protocol,
    browser: {
      status: () => { browserStatus += 1; return { ready: true, state: 'browser_ready', mode: 'browser' }; },
      generate: async () => { throw new Error('not used'); }, login: async () => ({}),
      close: async () => { browserClosed += 1; },
    },
  } });
  try {
    const { response, body } = await jsonRequest(harness, '/health');
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'browser');
    assert.equal(browserStatus, 1);
    assert.equal(browserClosed, 0);
  } finally { await harness.close(); }
  assert.equal(browserClosed, 1);
});

test('HTTP composition forwards the acquired account lease to its own transport', async () => {
  const seen = [];
  const closed = [];
  const lease = {
    id: 'lease-a', accountId: 'account-a', sessionRevision: 7,
    transport: {
      async generate(_prompt, options) {
        seen.push({ accountId: lease.accountId, lease: options.lease, requestId: options.requestId, nonce: options.nonce });
        return { text: JSON.stringify({ request_id: options.nonce, content: 'from account A', tool_calls: [] }) };
      },
      async close() { closed.push('transport-a'); },
    },
  };
  const pool = {
    status: () => ({ ready: true, state: 'ready', mode: 'http', model: 'Muse app selection' }),
    accountState: () => ({ busy: false }),
    acquire: async () => lease,
    release: async released => { assert.equal(released, lease); closed.push('lease-a'); await lease.transport.close(); },
    noteFailure: async () => ({ retryable: false }),
    runExclusive: async (_id, fn) => fn(), clearQuarantine: async () => {}, close: async () => {},
  };
  const harness = await createHarness({ transport: 'http', dependencies: { pool } });
  try {
    const { response, body } = await jsonRequest(harness, '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer muse-local', 'content-type': 'application/json' },
      body: { model: 'muse', messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(response.status, 200);
    assert.equal(body.choices[0].message.content, 'from account A');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].accountId, 'account-a');
    assert.equal(seen[0].lease, lease);
    assert.equal(typeof seen[0].requestId, 'string');
    assert.equal(typeof seen[0].nonce, 'string');
    assert.deepEqual(closed, ['lease-a', 'transport-a']);
  } finally { await harness.close(); }
});

test('admin-protected panel import queues relogin for a newly imported account without a session', async () => {
  const loginStarted = deferred();
  const calls = [];
  const harness = await createHarness({ transport: 'browser', dependencies: {
    bootstrapper: { login: async account => {
      calls.push(account);
      loginStarted.resolve();
      return { schemaVersion: 1, cookies: [], tokens: { token: 'fake-token' }, device: { id: 'fake-device' },
        upstream: { gatewayUrl: 'https://muse.ai', vmName: 'fake-vm', vmId: 'fake-vm-id' }, expiresAt: null };
    } },
  } });
  try {
    const admin = `Bearer ${await harness.app.auth.adminBearer()}`;
    const denied = await jsonRequest(harness, '/control/accounts/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: { accounts: 'unused' },
    });
    assert.equal(denied.response.status, 401);

    const imported = await jsonRequest(harness, '/control/accounts/import', {
      method: 'POST', headers: { authorization: admin, 'content-type': 'application/json' },
      body: { accounts: 'new.user@example.test|https://luuvan.site/inbox?email=new.user%40example.test' },
    });
    assert.equal(imported.response.status, 202, JSON.stringify(imported.body));
    const importJob = imported.body.jobs?.[0] ?? imported.body.job;
    assert.ok(importJob?.id, JSON.stringify(imported.body));
    await waitFor(loginStarted.promise, 'relogin job start');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].email, 'new.user@example.test');
    const job = await waitForJob(harness, importJob.id, admin);
    assert.equal(job?.status, 'succeeded', `relogin job did not succeed before deadline: ${JSON.stringify({ id: job?.id, status: job?.status, errorCode: job?.errorCode })}`);
    const accountRows = await jsonRequest(harness, '/control/accounts', { headers: { authorization: admin } });
    assert.equal(accountRows.response.status, 200);
    assert.equal(accountRows.body.data[0].status, 'active');
    assert.equal(accountRows.body.data[0].hasSession, undefined);
  } finally { await harness.close(); }
});

test('application shutdown waits for owned pool cleanup before resolving', async () => {
  const gate = deferred();
  const closeOrder = [];
  const fakes = makeFakes({ onClose: closeOrder });
  fakes.pool.close = async () => { closeOrder.push('pool-start'); await gate.promise; closeOrder.push('pool-done'); };
  const harness = await createHarness({ transport: 'browser', dependencies: fakes, onClose: closeOrder });
  let finished = false;
  try {
    const closing = harness.app.close().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.deepEqual(closeOrder.slice(0, 2), ['pool-start']);
    gate.resolve();
    await closing;
    assert.equal(finished, true);
    assert.ok(closeOrder.indexOf('pool-done') < closeOrder.indexOf('sessionManager'));
    assert.ok(closeOrder.includes('store'));
  } finally { gate.resolve(); await rm(harness.dir, { recursive: true, force: true }); }
});

test('initial synthetic subscription read reaches panel bootstrap and manual refresh is CSRF protected without account mutations', async () => {
  const reads = [];
  let generations = 0;
  const pool = {
    status: () => ({ ready: true, state: 'ready', mode: 'http', model: 'Muse app selection' }),
    accountState: () => ({ busy: false }),
    acquire: async () => null,
    release: async () => {},
    noteFailure: async () => ({ retryable: false }),
    runExclusive: async (_id, fn, { signal } = {}) => fn(signal),
    clearQuarantine: async () => {},
    close: async () => {},
  };
  const protocol = {
    async readUsage(account, session) {
      reads.push({ accountId: account.id, sessionRevision: session.sessionRevision });
      const observedAt = Date.now();
      return {
        source: 'muse_subscription', observedAt, sessionRevision: session.sessionRevision,
        tier: { code: 'power', name: 'Power', isPaid: true },
        weekly: { state: 'active', percentUsed: 4, resetsAt: 1_800_000_000, quotaStatus: 'available' },
        additional: { remaining: 1_000_000_000, limit: null, used: null, percentUsed: 20, approximate: true, displayLabel: '20% used (1B tokens left)', raw: { remaining: 40_000_000, limit: 50_000_000, unit: 'muse_quota_units' } },
      };
    },
  };
  const sessionManager = { refresh: async () => ({ sessionRevision: 1 }), ensureValid: async () => {}, close: async () => {} };
  const browser = {
    status: () => ({ ready: true, state: 'browser_ready', mode: 'browser' }),
    async generate() { generations++; throw new Error('unexpected generation'); },
    login: async () => ({}), close: async () => {},
  };
  const harness = await createHarness({ transport: 'browser', dependencies: { pool, protocol, sessionManager, browser } });
  try {
    const accountId = await addSyntheticSession(harness, 'initial-usage');
    await waitForUsageState(harness.app, accountId, 'ready');

    const bootstrap = await jsonRequest(harness, '/panel/api/bootstrap');
    assert.equal(bootstrap.response.status, 200);
    const account = bootstrap.body.snapshot.accounts.find(row => row.id === accountId);
    assert.ok(account);
    assert.equal(account.status, 'active');
    assert.equal(account.museUsage.state, 'ready');
    assert.deepEqual(account.museUsage.sample.weekly, {
      state: 'active', percentUsed: 4, resetsAt: 1_800_000_000, quotaStatus: 'available',
    });
    assert.deepEqual(account.museUsage.sample.additional, {
      remaining: 1_000_000_000, limit: null, used: null, percentUsed: 20, approximate: true, displayLabel: '20% used (1B tokens left)', raw: { remaining: 40_000_000, limit: 50_000_000, unit: 'muse_quota_units' },
    });
    assert.deepEqual(account.upstreamQuota, {
      unit: 'tokens', remaining: 1_000_000_000,
      observedAt: account.museUsage.sample.observedAt,
    });
    assert.deepEqual(reads, [{ accountId, sessionRevision: 1 }]);

    const origin = `http://127.0.0.1:${harness.port}`;
    const missingNonce = await jsonRequest(harness, `/panel/api/accounts/${accountId}/usage-refresh`, {
      method: 'POST', headers: { origin },
    });
    assert.equal(missingNonce.response.status, 403);
    const refreshed = await jsonRequest(harness, `/panel/api/accounts/${accountId}/usage-refresh`, {
      method: 'POST', headers: { origin, 'x-panel-csrf': bootstrap.body.csrf },
    });
    assert.equal(refreshed.response.status, 202);
    assert.equal(reads.length, 1, 'the minimum refresh interval prevents an immediate duplicate read');
    assert.equal(harness.store.getPublic(accountId).status, 'active');
    assert.equal(generations, 0);
  } finally { await harness.close(); }
});

test('an initial usage failure leaves panel APIs and account status available', async () => {
  let reads = 0;
  const pool = {
    status: () => ({ ready: true, state: 'ready', mode: 'http', model: 'Muse app selection' }),
    accountState: () => ({ busy: false }), acquire: async () => null, release: async () => {},
    noteFailure: async () => ({ retryable: false }), runExclusive: async (_id, fn, { signal } = {}) => fn(signal),
    clearQuarantine: async () => {}, close: async () => {},
  };
  const protocol = { async readUsage() { reads++; throw Object.assign(new Error('private upstream response'), { code: 'usage_unavailable' }); } };
  const sessionManager = { refresh: async () => ({ sessionRevision: 1 }), ensureValid: async () => {}, close: async () => {} };
  const harness = await createHarness({ transport: 'browser', dependencies: { pool, protocol, sessionManager } });
  try {
    const accountId = await addSyntheticSession(harness, 'failed-usage');
    await waitForUsageState(harness.app, accountId, 'error');

    const bootstrap = await jsonRequest(harness, '/panel/api/bootstrap');
    assert.equal(bootstrap.response.status, 200);
    const account = bootstrap.body.snapshot.accounts.find(row => row.id === accountId);
    assert.equal(account.status, 'active');
    assert.equal(account.museUsage.state, 'error');
    assert.equal(account.museUsage.errorCode, 'usage_unavailable');
    assert.equal(JSON.stringify(bootstrap.body).includes('private upstream response'), false);
    const accounts = await jsonRequest(harness, '/panel/api/accounts');
    assert.equal(accounts.response.status, 200);
    assert.equal(accounts.body.data.find(row => row.id === accountId).status, 'active');
    assert.equal(reads, 1);
  } finally { await harness.close(); }
});
