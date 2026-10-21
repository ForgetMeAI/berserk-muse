import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPanelAuth } from '../src/panel/auth.mjs';
import { createPanelEventBus } from '../src/panel/events.mjs';
import { createPanelRouter } from '../src/panel/routes.mjs';

async function fixture(t, overrides = {}) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'panel-routes-'));
  const stateDir = path.join(stateRoot, '.state');
  const eventBus = createPanelEventBus({ epoch: 'testepoch' });
  let now = Date.now();
  const auth = createPanelAuth({ stateDir, now: () => now });
  const values = {
    status: 'ready', queue: { active: false, activeCount: 0, waiting: 2, capacity: 4 },
    accounts: overrides.accounts ?? [{ id: 'acct-1', emailMasked: 'pr•••@example.test', status: 'ready', estimatedUsage: { inputTokens: 2, outputTokens: 5, totalTokens: 7, requests: 1, unknownRequests: 0, secret: 'must-never-leak' },
      upstreamQuota: { unit: 'tokens', remaining: 9, limit: 10, used: 1, observedAt: '2026-10-18T12:00:00Z', secret: 'quota-secret' },
      capabilities: { relogin: true, healthCheck: false, private: 'must-not-appear' }, secret: 'must-never-leak' }],
    requests: [{ requestId: 'req-1', status: 'failed', startedAt: '2026-10-18T12:00:00Z', errorCode: 'nope', privateText: 'secret traceback text' }],
  };
  const jobs = new Map();
  const requestCalls = [];
  const fallbackCalls = [];
  let router;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
    void router.handle(req, res, url).then(handled => {
      if (handled) return;
      fallbackCalls.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('root server fallback');
    }).catch(() => { if (!res.destroyed) res.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  router = createPanelRouter({ stateDir, port, auth, eventBus,
    getSnapshot: overrides.getSnapshot ?? (async () => structuredClone(values)),
    listAccounts: async () => values.accounts,
    listRequests: async options => {
      requestCalls.push(options);
      return options.cursor ? { data: [{ requestId: 'req-2', status: 'complete', startedAt: '2026-10-18T12:01:00Z' }], nextCursor: null }
        : { data: values.requests, nextCursor: 'opaque-page-2' };
    },
    relogin: async id => { const job = { id: `job-${id}`, type: 'relogin', status: 'queued', progress: 0 }; jobs.set(job.id, job); return job; },
    healthCheck: async id => ({ job: { id: `check-${id}`, kind: 'health-check', state: 'queued' } }),
    getJob: async id => jobs.get(id) || null,
    importAccounts: overrides.importAccounts ?? (async () => ({ id: 'import-1', type: 'import', status: 'queued' })),
    refreshUsage: overrides.refreshUsage,
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await router.close();
    await new Promise(resolve => server.close(resolve));
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { base, auth, eventBus, requestCalls, fallbackCalls, router, advance: ms => { now += ms; } };
}

async function createSession(base) {
  const response = await fetch(`${base}/panel/api/bootstrap`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  return { csrf: (await response.json()).csrf };
}

function requestWithHost(base, host) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: '/panel/api/bootstrap', headers: { Host: host } }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
}

test('panel exposes manual-login phases but drops arbitrary phase text and private job fields', async t => {
  const { base } = await fixture(t, { getSnapshot: async () => ({ status: 'ready', jobs: [
    { id: 'job-manual', type: 'relogin', status: 'running', phase: 'waiting_for_user', progress: 25, mailAccessUrl: 'PRIVATE_ACCESS_CANARY' },
    { id: 'job-unsafe', type: 'relogin', status: 'running', phase: 'private@example.test|https://mail.example/secret' },
  ] }) });
  const response = await fetch(`${base}/panel/api/bootstrap`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const jobs = JSON.parse(text).snapshot.jobs;
  assert.equal(jobs[0].phase, 'waiting_for_user');
  assert.equal(Object.hasOwn(jobs[1], 'phase'), false);
  assert.equal(text.includes('PRIVATE_ACCESS_CANARY'), false);
  assert.equal(text.includes('private@example'), false);
});

test('panel is cookie-free on loopback; reads are public locally and mutations use origin plus router nonce', async t => {
  const { base, auth, eventBus } = await fixture(t);
  const bootstrapResponse = await fetch(`${base}/panel/api/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  assert.equal(bootstrapResponse.headers.get('set-cookie'), null);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.snapshot.accounts[0].emailMasked, 'pr•••@example.test');
  assert.equal(bootstrap.snapshot.accounts[0].remaining, null);
  assert.deepEqual(bootstrap.snapshot.accounts[0].estimatedUsage, { inputTokens: 2, outputTokens: 5, totalTokens: 7, requests: 1, unknownRequests: 0, estimated: true });
  assert.deepEqual(bootstrap.snapshot.accounts[0].upstreamQuota, { unit: 'tokens', remaining: 9, limit: 10, used: 1, observedAt: '2026-10-18T12:00:00Z' });
  assert.deepEqual(bootstrap.snapshot.accounts[0].capabilities, { relogin: true, healthCheck: false });
  assert.equal(bootstrap.snapshot.requests[0].error.message, 'The local panel could not complete this request.');
  assert.equal(JSON.stringify(bootstrap).includes('must-never-leak'), false);
  assert.equal(JSON.stringify(bootstrap).includes('secret traceback'), false);
  assert.equal(JSON.stringify(bootstrap).includes('quota-secret'), false);

  const missingCsrf = await fetch(`${base}/panel/api/accounts/acct-1/relogin`, { method: 'POST', headers: { Origin: base } });
  assert.equal(missingCsrf.status, 403);
  const actionResponse = await fetch(`${base}/panel/api/accounts/acct-1/relogin`, { method: 'POST', headers: { Origin: base, 'X-Panel-CSRF': bootstrap.csrf } });
  assert.equal(actionResponse.status, 202);
  const action = await actionResponse.json();
  assert.equal(action.job.id, 'job-acct-1');
  const jobResponse = await fetch(`${base}/panel/api/jobs/job-acct-1`);
  assert.equal((await jobResponse.json()).job.status, 'queued');

  const foreign = await fetch(`${base}/panel/api/bootstrap`, { headers: { Origin: 'https://elsewhere.test' } });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${base}/panel/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(await requestWithHost(base, 'evil.test'), 403);
  assert.equal((await fetch(`${base}/panel/api/session`, { method: 'POST', headers: { Origin: base } })).status, 404);
  assert.equal((await fetch(`${base}/panel/api/logout`, { method: 'POST', headers: { Origin: base } })).status, 404);
  assert.equal((await fetch(`${base}/control/panel-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${await auth.adminBearer()}` } })).status, 404);
  const oldCsrf = bootstrap.csrf;
  const newRouterResponse = await fetch(`${base}/panel/api/bootstrap`);
  assert.equal((await newRouterResponse.json()).csrf, oldCsrf, 'nonce remains stable for this router lifetime');
  eventBus.publish('status', { private: 'never delivered' });
});

test('panel shell has a restrictive CSP and event endpoint starts with a snapshot reset', async t => {
  const { base, auth, router } = await fixture(t);
  const shell = await fetch(`${base}/panel`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(shell.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await shell.text(), /\/panel\/app\.js/);
  const linkedNavigation = await fetch(`${base}/panel`, { headers: { Origin: 'https://elsewhere.test', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(linkedNavigation.status, 200, 'shell navigation is not treated as an API request');

  const { csrf } = await createSession(base);
  const stream = await fetch(`${base}/panel/api/events`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: reset/);
  assert.equal(csrf.length > 0, true);
  assert.equal(router.activeStreams, 1, 'event stream is not tied to a login session');
  await router.close();
  assert.equal(router.activeStreams, 0, 'router shutdown closes the event stream');
  await reader.cancel().catch(() => {});
});

test('admin control API requires the separate panel key and returns only sanitized account fields', async t => {
  const { base, auth } = await fixture(t);
  assert.equal((await fetch(`${base}/control/accounts`)).status, 401);
  const response = await fetch(`${base}/control/accounts`, { headers: { Authorization: `Bearer ${await auth.adminBearer()}` } });
  assert.equal(response.status, 200);
  const foreignOrigin = await fetch(`${base}/control/accounts`, { headers: {
    Authorization: `Bearer ${await auth.adminBearer()}`, Origin: 'https://elsewhere.test',
  } });
  assert.equal(foreignOrigin.status, 403);
  const raw = await response.text();
  assert.match(raw, /pr•••@example\.test/);
  assert.equal(raw.includes('must-never-leak'), false);
  const imported = await fetch(`${base}/control/accounts/import`, { method: 'POST', headers: { Authorization: `Bearer ${await auth.adminBearer()}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(imported.status, 202);
  assert.equal((await imported.json()).job.id, 'import-1');
});

test('router returns false for root-owned paths so the root handler can continue', async t => {
  const { base, fallbackCalls } = await fixture(t);
  const response = await fetch(`${base}/control/login`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'root server fallback');
  assert.deepEqual(fallbackCalls, ['/control/login']);
});

test('requests endpoint forwards bounded cursor pagination and returns only sanitized page fields', async t => {
  const { base, requestCalls } = await fixture(t);
  const response = await fetch(`${base}/panel/api/requests?limit=37&cursor=opaque-2`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data[0].id, 'req-2');
  assert.equal(result.nextCursor, null);
  assert.deepEqual(requestCalls.at(-1), { limit: 37, cursor: 'opaque-2' });
  assert.equal((await fetch(`${base}/panel/api/requests?limit=101`)).status, 400);
  assert.equal((await fetch(`${base}/panel/api/requests?cursor=${'x'.repeat(129)}`)).status, 400);
});

test('SSE streams keep delivering after eight hours without session expiry', async t => {
  const { base, eventBus, router, advance } = await fixture(t);
  const stream = await fetch(`${base}/panel/api/events`);
  const reader = stream.body.getReader();
  await reader.read();
  advance(8 * 60 * 60 * 1000 + 1);
  eventBus.publish('queue.updated', { public: 'delivered' });
  const delivery = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('stream did not deliver')), 1000))]);
  assert.match(new TextDecoder().decode(delivery.value), /event: queue\.updated/);
  assert.equal(router.activeStreams, 1);
  await reader.cancel().catch(() => {});
});


test('account import returns CLI counts while removing private account and job fields', async t => {
  const { base, auth } = await fixture(t, { importAccounts: async () => ({
    imported: 1, duplicates: 2,
    accounts: [{ id: 'account-1', emailMasked: 'a***@e***.test', status: 'needs_relogin', mailAccessUrl: 'PRIVATE_CANARY_MAIL', cookies: 'PRIVATE_CANARY_COOKIE' }],
    jobs: [{ id: 'job-1', type: 'relogin', status: 'queued', errorCode: 'invalid_input', token: 'PRIVATE_CANARY_TOKEN' }],
  }) });
  const response = await fetch(`${base}/control/accounts/import`, { method: 'POST', headers: {
    Authorization: `Bearer ${await auth.adminBearer()}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ accounts: [] }) });
  assert.equal(response.status, 202);
  const raw = await response.text();
  assert.equal(raw.includes('PRIVATE_CANARY'), false);
  const result = JSON.parse(raw);
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 2);
  assert.equal(result.accounts[0].emailMasked, 'a***@e***.test');
  assert.equal(result.jobs[0].error.code, 'invalid_input');
});

test('snapshot exposes only bounded statistics fields and up to 200 sanitized jobs', async t => {
  const { base } = await fixture(t, { getSnapshot: async () => ({
    status: 'ready', accounts: [], requests: [],
    statistics: {
      requests: 9, generatedAt: 123456, windowMs: 60000,
      totals: { attempts: 12, results: 9, private: 'never-public' },
      byStatus: { ok: 5, error: 2, cancelled: 1, timeout: 1, rejected: 0, private: 7 },
      estimatedInputTokens: { sum: 120, unknownCount: 2, secret: 'never-public' },
      estimatedOutputTokens: { sum: 80, unknownCount: 3, secret: 'never-public' },
      upstream: { remaining: 4, private: 'never-public' },
      persistence: { errorCode: 'private_storage_detail' },
      secret: 'never-public',
    },
    jobs: Array.from({ length: 205 }, (_, index) => ({ id: `job-${index}`, type: 'relogin', status: 'queued', token: 'never-public' })),
  }) });
  const response = await fetch(`${base}/panel/api/bootstrap`);
  const snapshot = (await response.json()).snapshot;
  assert.deepEqual(snapshot.statistics, {
    requests: 9, attempts: 12, completed: 5, failed: 4,
    inputTokens: 120, outputTokens: 80, inputUnknown: 2, outputUnknown: 3,
    windowMs: 60000, generatedAt: 123456, bounded: true,
  });
  assert.equal(snapshot.jobs.length, 200);
  assert.deepEqual(snapshot.jobs[0], {
    id: 'job-0', type: 'relogin', status: 'queued', createdAt: null, updatedAt: null, progress: null, error: null,
  });
  const raw = JSON.stringify(snapshot);
  assert.equal(raw.includes('never-public'), false);
  assert.equal(raw.includes('private_storage_detail'), false);
});

test('bootstrap exposes only the bounded Muse usage projection when present', async t => {
  const accounts = [{ id: 'acct-1', emailMasked: 'a***@e***.test', status: 'ready', hasSession: false,
    museUsage: {
      state: 'ready', pending: false, observedAt: 100, attemptedAt: 99, errorCode: 'usage_unavailable',
      sample: {
        source: 'muse_subscription', observedAt: 100,
        tier: { code: 'HATCH_FREE', name: 'Muse Free', isPaid: false, agreement: 'poison', paymentLabel: 'poison' },
        weekly: { state: 'METERED', percentUsed: 30, resetsAt: 200, quotaStatus: 'SUFFICIENT', url: 'https://poison.test' },
        additional: { remaining: 8, limit: 10, used: 2, percentUsed: 20, token: 'poison' },
        sessionRevision: 'POISON_REVISION', rawError: 'POISON_ERROR', accessToken: 'POISON_TOKEN',
      }, sessionRevision: 'POISON_REVISION', cookies: 'POISON_COOKIE',
    } },
    { id: 'acct-2', status: 'ready', hasSession: 'false', museUsage: { state: 'error', pending: false,
      observedAt: null, attemptedAt: 101, errorCode: 'session_changed', sample: null } },
    { id: 'acct-3', status: 'ready', museUsage: { state: 'error', pending: false,
      observedAt: null, attemptedAt: 102, errorCode: 'cancelled', sample: null } },
  ];
  const { base } = await fixture(t, { accounts });
  const response = await fetch(`${base}/panel/api/bootstrap`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.snapshot.accounts[0].museUsage, {
    state: 'ready', pending: false, observedAt: 100, attemptedAt: 99, errorCode: 'usage_unavailable',
    sample: {
      source: 'muse_subscription', observedAt: 100,
      tier: { code: 'HATCH_FREE', name: 'Muse Free', isPaid: false },
      weekly: { state: 'METERED', percentUsed: 30, resetsAt: 200, quotaStatus: 'SUFFICIENT' },
      additional: { remaining: 8, limit: 10, used: 2, percentUsed: 20 },
    },
  });
  assert.equal(body.snapshot.accounts[0].hasSession, false);
  assert.equal(Object.hasOwn(body.snapshot.accounts[1], 'hasSession'), false, 'non-boolean session hints are omitted');
  assert.equal(Object.hasOwn(body.snapshot.accounts[2], 'hasSession'), false, 'missing session hints are omitted');
  assert.deepEqual(body.snapshot.accounts[1].museUsage, {
    state: 'error', pending: false, observedAt: null, attemptedAt: 101, errorCode: 'session_changed', sample: null,
  });
  assert.deepEqual(body.snapshot.accounts[2].museUsage, {
    state: 'error', pending: false, observedAt: null, attemptedAt: 102, errorCode: 'cancelled', sample: null,
  });
  const raw = JSON.stringify(body);
  for (const poison of ['POISON_REVISION', 'POISON_ERROR', 'POISON_TOKEN', 'POISON_COOKIE', 'poison', 'https://poison.test']) assert.equal(raw.includes(poison), false);
});

test('Muse usage projection drops invalid percentages, timestamps, labels, and unknown error codes', async t => {
  const { base } = await fixture(t, { accounts: [{ id: 'acct-1', status: 'ready', museUsage: {
    state: 'invalid', pending: 'yes', observedAt: -1, attemptedAt: Infinity, errorCode: 'https://private.test',
    sample: { source: 'muse_subscription', observedAt: -4,
      tier: { code: 'bad:code', name: 'tier@example.test', isPaid: true },
      weekly: { state: 'ready', percentUsed: 101, resetsAt: -5, quotaStatus: 'https://private.test' },
      additional: { remaining: -1, limit: Infinity, used: 3, percentUsed: -1 } },
  } }] });
  const account = (await (await fetch(`${base}/panel/api/bootstrap`)).json()).snapshot.accounts[0];
  assert.deepEqual(account.museUsage, {
    state: 'unknown', pending: false, observedAt: null, attemptedAt: null, errorCode: null, sample: null,
  });
});

test('Muse additional balance derives tokens from its safe label and exposes only valid raw quota units', async t => {
  const accounts = [
    { id: 'acct-1', status: 'ready', museUsage: { state: 'ready', pending: false,
      sample: { source: 'muse_subscription', observedAt: 100,
        tier: { code: 'HATCH_FREE', name: 'Muse Free', isPaid: false },
        weekly: { state: 'METERED', percentUsed: 4, resetsAt: 200, quotaStatus: 'SUFFICIENT' },
        additional: { remaining: 40_000_000, limit: 40_000_000, used: 0, percentUsed: 99,
          approximate: true, displayLabel: '0% used (1B tokens left)',
          raw: { remaining: 40_000_000, limit: 40_000_000, unit: 'muse_quota_units', sessionRevision: 7,
            token: 'POISON_TOKEN', url: 'https://poison.test', headers: { authorization: 'POISON_AUTH' } },
          rawTopup: 'POISON_RAW' },
      } } },
    { id: 'acct-2', status: 'ready', museUsage: { state: 'ready', pending: false,
      sample: { source: 'muse_subscription', observedAt: 100,
        tier: { code: 'HATCH_FREE', name: 'Muse Free', isPaid: false },
        weekly: { state: 'METERED', percentUsed: 4, resetsAt: 200, quotaStatus: 'SUFFICIENT' },
        additional: { remaining: 1, limit: 2, used: 1, percentUsed: 50, approximate: true,
          displayLabel: 'owner@example.test https://private.test',
          raw: { remaining: 1, limit: 2, unit: 'tokens', accessToken: 'POISON_TOKEN' } },
      } } },
    { id: 'acct-3', status: 'ready', museUsage: { state: 'ready', pending: false,
      sample: { source: 'muse_subscription', observedAt: 100,
        tier: { code: 'HATCH_FREE', name: 'Muse Free', isPaid: false },
        weekly: { state: 'METERED', percentUsed: 4, resetsAt: 200, quotaStatus: 'SUFFICIENT' },
        additional: { remaining: 5, approximate: false, displayLabel: '0% used (5M tokens left)',
          raw: { remaining: 41, limit: 40, unit: 'muse_quota_units' } },
      } } },
  ];
  const { base } = await fixture(t, { accounts });
  const result = (await (await fetch(`${base}/panel/api/bootstrap`)).json()).snapshot.accounts;
  assert.deepEqual(result[0].museUsage.sample.additional, {
    remaining: 1_000_000_000, limit: null, used: null, percentUsed: 0,
    approximate: true, displayLabel: '0% used (1B tokens left)',
    raw: { remaining: 40_000_000, limit: 40_000_000, unit: 'muse_quota_units' },
  });
  assert.deepEqual(result[1].museUsage.sample.additional, {
    remaining: null, limit: null, used: null, percentUsed: null,
    approximate: false, displayLabel: null,
  });
  assert.deepEqual(result[2].museUsage.sample.additional, {
    remaining: 5_000_000, limit: null, used: null, percentUsed: null,
    approximate: true, displayLabel: '0% used (5M tokens left)',
  });
  const serialized = JSON.stringify(result);
  for (const poison of ['POISON_TOKEN', 'POISON_AUTH', 'POISON_RAW', 'poison.test', 'owner@example.test', 'sessionRevision', '"unit":"tokens"']) {
    assert.equal(serialized.includes(poison), false);
  }
});

test('usage refresh endpoints validate loopback origin and CSRF before calling the queue callback', async t => {
  const calls = [];
  const { base } = await fixture(t, { refreshUsage: async id => { calls.push(id); return { queued: 2, skipped: 1, pending: 3, secret: 'private' }; } });
  const { csrf } = await createSession(base);
  const headers = { Origin: base, 'X-Panel-CSRF': csrf };
  const all = await fetch(`${base}/panel/api/usage/refresh`, { method: 'POST', headers });
  assert.equal(all.status, 202);
  assert.deepEqual(await all.json(), { queued: 2, skipped: 1, pending: 3 });
  const one = await fetch(`${base}/panel/api/accounts/acct-1/usage-refresh`, { method: 'POST', headers });
  assert.equal(one.status, 202);
  assert.deepEqual(await one.json(), { queued: 2, skipped: 1, pending: 3 });
  assert.deepEqual(calls, [null, 'acct-1']);

  const noCsrf = await fetch(`${base}/panel/api/usage/refresh`, { method: 'POST', headers: { Origin: base } });
  assert.equal(noCsrf.status, 403);
  const foreign = await fetch(`${base}/panel/api/accounts/acct-1/usage-refresh`, { method: 'POST', headers: {
    Origin: 'https://foreign.test', 'X-Panel-CSRF': csrf,
  } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(calls, [null, 'acct-1']);
});

test('usage refresh returns safe unavailable and internal errors without callback details', async t => {
  const unavailable = await fixture(t);
  const session = await createSession(unavailable.base);
  const post = (base, csrf) => fetch(`${base}/panel/api/usage/refresh`, { method: 'POST', headers: { Origin: base, 'X-Panel-CSRF': csrf } });
  const missing = await post(unavailable.base, session.csrf);
  assert.equal(missing.status, 503);
  assert.deepEqual((await missing.json()).error, { code: 'usage_refresh_unavailable', message: 'Muse usage refresh is unavailable.' });

  for (const refreshUsage of [async () => { throw new Error('PRIVATE_CALLBACK_TRACE'); }, async () => ({ queued: -1, skipped: 0, pending: 0, private: 'PRIVATE_CALLBACK_TRACE' })]) {
    const fixtureWithCallback = await fixture(t, { refreshUsage });
    const { csrf } = await createSession(fixtureWithCallback.base);
    const response = await post(fixtureWithCallback.base, csrf);
    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.equal(raw.includes('PRIVATE_CALLBACK_TRACE'), false);
    assert.equal(raw.includes('The local panel could not complete this request.'), true);
  }
});
