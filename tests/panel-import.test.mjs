import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_PANEL_IMPORT_BYTES, MAX_PANEL_IMPORT_LINES, previewAccountImport } from '../src/panel/import.mjs';
import { createPanelAuth } from '../src/panel/auth.mjs';
import { createPanelRouter } from '../src/panel/routes.mjs';

test('preview normalizes and masks emails, ignores blank physical lines, and counts exact batch duplicates', () => {
  const source = '\nUser+Tag@Example.test|https://mail.google.com/mail/u/0/\n\nuser+tag@example.test|https://mail.google.com/mail/u/0/\n';
  const result = previewAccountImport(source);
  assert.deepEqual(result, {
    valid: true, total: 2, ready: 1, duplicates: 1, errors: 0,
    rows: [
      { line: 2, emailMasked: 'u***@e***.test', provider: 'gmail', status: 'ready', code: null },
      { line: 4, emailMasked: 'u***@e***.test', provider: 'gmail', status: 'duplicate', code: null },
    ],
  });
  assert.equal(JSON.stringify(result).includes('User+Tag@Example.test'), false);
  assert.equal(JSON.stringify(result).includes('mail.google.com'), false);
});

test('preview collects per-line parse errors and detects conflicting batch pairings without echoing input', () => {
  const source = [
    'first@example.test|https://mail.google.com/mail/u/0/',
    'first@example.test|https://outlook.live.com/mail/',
    'second@example.test|https://mail.unknown.test/inbox',
  ].join('\n');
  const result = previewAccountImport(source);
  assert.equal(result.valid, false);
  assert.equal(result.total, 3);
  assert.equal(result.ready, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(result.errors, 2);
  assert.deepEqual(result.rows.map(({ line, status, code }) => ({ line, status, code })), [
    { line: 1, status: 'ready', code: null },
    { line: 2, status: 'error', code: 'import_conflict' },
    { line: 3, status: 'error', code: 'unsupported_provider' },
  ]);
  const serialized = JSON.stringify(result);
  for (const raw of ['first@example.test', 'second@example.test', 'mail.google.com', 'outlook.live.com', 'mail.unknown.test']) {
    assert.equal(serialized.includes(raw), false);
  }
});

test('preview reports malformed lines with safe codes and no raw values', () => {
  const result = previewAccountImport('plain-user@example.test|not-a-link');
  assert.equal(result.valid, false);
  assert.equal(result.errors, 1);
  assert.deepEqual(result.rows, [{ line: 1, emailMasked: 'p***@e***.test', provider: null, status: 'error', code: 'invalid_input' }]);
  assert.equal(JSON.stringify(result).includes('plain-user@example.test'), false);
});

test('preview masks numbered imports and mismatch errors without exposing the address or URL', () => {
  const input = [
    '143 | demo.inbox@sample.test | https://generator.email/demo.inbox@sample.test',
    '144 | private.box@sample.test | https://generator.email/another.box@sample.test',
    'oops | hidden.box@sample.test | https://generator.email/hidden.box@sample.test',
  ].join('\n');
  const result = previewAccountImport(input);
  assert.deepEqual(result.rows, [
    { line: 1, emailMasked: 'd***@s***.test', provider: 'generator', status: 'ready', code: null },
    { line: 2, emailMasked: 'p***@s***.test', provider: null, status: 'error', code: 'invalid_input' },
    { line: 3, emailMasked: null, provider: null, status: 'error', code: 'invalid_input' },
  ]);
  const serialized = JSON.stringify(result);
  for (const raw of ['demo.inbox@sample.test', 'private.box@sample.test', 'hidden.box@sample.test', 'generator.email', 'another.box@sample.test']) {
    assert.equal(serialized.includes(raw), false);
  }
});

test('preview enforces exported byte, nonempty-line, and blank-batch limits', () => {
  assert.equal(MAX_PANEL_IMPORT_BYTES, 64 * 1024);
  assert.equal(MAX_PANEL_IMPORT_LINES, 100);
  assert.throws(() => previewAccountImport('x'.repeat(MAX_PANEL_IMPORT_BYTES + 1)), error => error.code === 'request_too_large');
  assert.throws(() => previewAccountImport(Array.from({ length: MAX_PANEL_IMPORT_LINES + 1 }, () => 'x@y.test|https://mail.google.com/').join('\n')),
    error => error.code === 'invalid_input');
  assert.throws(() => previewAccountImport('\n \r\n'), error => error.code === 'invalid_input');
  assert.throws(() => previewAccountImport(null), error => error.code === 'invalid_input');
});

async function fixture(t, importAccounts) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'panel-import-'));
  const auth = createPanelAuth({ stateDir: path.join(stateRoot, '.state') });
  const port = 31337;
  const router = createPanelRouter({ stateDir: path.join(stateRoot, '.state'), port, auth, importAccounts });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await router.close();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { base, auth, router };
}

async function call(router, base, pathname, { method = 'GET', csrf, origin = base, accounts } = {}) {
  const headers = { host: new URL(base).host };
  if (method !== 'GET') headers['content-type'] = 'application/json';
  if (csrf) headers['x-panel-csrf'] = csrf;
  if (origin !== null) headers.origin = origin;
  const req = { method, url: pathname, headers,
    async *[Symbol.asyncIterator]() { if (method !== 'GET') yield Buffer.from(JSON.stringify({ accounts })); } };
  const res = { destroyed: false, writableEnded: false, writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
    end(body = '') { this.body = String(body); this.writableEnded = true; } };
  await router.handle(req, res, new URL(req.url, base));
  return { status: res.status, text: async () => res.body, json: async () => JSON.parse(res.body) };
}

async function createSession(base, router) {
  const response = await call(router, base, '/panel/api/bootstrap');
  assert.equal(response.status, 200);
  assert.equal(response.headers?.['Set-Cookie'], undefined);
  return { csrf: (await response.json()).csrf };
}

async function post(router, base, route, options = {}) {
  return call(router, base, `/panel/api/accounts/${route}`, { ...options, method: 'POST' });
}

test('preview and import are public local reads and mutations require same-origin router CSRF nonce', async t => {
  let calls = 0;
  const { base, router } = await fixture(t, async () => { calls += 1; return { imported: 1, duplicates: 0, accounts: [], jobs: [] }; });
  const input = 'first@example.test|https://mail.google.com/mail/u/0/';
  const { csrf } = await createSession(base, router);
  assert.equal((await post(router, base, 'preview', { accounts: input })).status, 403);
  assert.equal((await post(router, base, 'preview', { csrf, origin: 'http://localhost:1', accounts: input })).status, 403);
  assert.equal((await post(router, base, 'import', { accounts: input })).status, 403);
  assert.equal((await post(router, base, 'preview', { csrf, accounts: input })).status, 200);
  assert.equal(calls, 0);
});

test('router nonce changes after restart so an old browser token cannot mutate', async t => {
  const { base, router, auth } = await fixture(t, async () => ({ imported: 0, duplicates: 0, accounts: [], jobs: [] }));
  const oldNonce = (await createSession(base, router)).csrf;
  await router.close();
  const restarted = createPanelRouter({ port: 31337, auth });
  t.after(() => restarted.close());
  const freshNonce = (await createSession(base, restarted)).csrf;
  assert.notEqual(freshNonce, oldNonce);
  assert.equal((await post(restarted, base, 'preview', { csrf: oldNonce, accounts: 'first@example.test|https://mail.google.com/mail/u/0/' })).status, 403);
  assert.equal((await post(restarted, base, 'preview', { csrf: freshNonce, accounts: 'first@example.test|https://mail.google.com/mail/u/0/' })).status, 200);
});

test('preview returns safe per-line metadata; valid import forwards canonical text unchanged and sanitizes its result', async t => {
  const calls = [];
  const input = '\nFirst.User@example.test|https://mail.google.com/mail/u/0/\n';
  const { base, router } = await fixture(t, async body => {
    calls.push(body);
    return {
      imported: 1, duplicates: 0,
      accounts: [{ id: 'account-1', emailMasked: 'f***@e***.test', status: 'needs_relogin', mailAccessUrl: 'PRIVATE_CANARY_LINK', email: 'PRIVATE_CANARY_EMAIL', cookies: 'PRIVATE_CANARY_COOKIE' }],
      jobs: [{ id: 'job-1', type: 'relogin', status: 'queued', token: 'PRIVATE_CANARY_TOKEN' }],
    };
  });
  const session = await createSession(base, router);
  const previewResponse = await post(router, base, 'preview', { ...session, accounts: input });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.deepEqual(preview, {
    valid: true, total: 1, ready: 1, duplicates: 0, errors: 0,
    rows: [{ line: 2, emailMasked: 'f***@e***.test', provider: 'gmail', status: 'ready', code: null }],
  });
  assert.equal(JSON.stringify(preview).includes('First.User@example.test'), false);
  assert.equal(JSON.stringify(preview).includes('mail.google.com'), false);
  assert.equal(calls.length, 0);

  const importResponse = await post(router, base, 'import', { ...session, accounts: input });
  assert.equal(importResponse.status, 202);
  assert.deepEqual(calls, [{ accounts: input }]);
  const raw = await importResponse.text();
  assert.equal(raw.includes('PRIVATE_CANARY'), false);
  assert.equal(raw.includes('First.User@example.test'), false);
  assert.equal(raw.includes('mail.google.com'), false);
  assert.deepEqual(JSON.parse(raw), {
    imported: 1, duplicates: 0,
    accounts: [{ id: 'account-1', emailMasked: 'f***@e***.test', mailProvider: null, status: 'needs_relogin', cooldownUntil: null,
      reasonCode: null, enabled: null, busy: null, quarantined: null, lastVerifiedAt: null, lastUsedAt: null,
      estimatedUsage: null, upstreamQuota: null, capabilities: {}, lastErrorCode: null, remaining: null }],
    jobs: [{ id: 'job-1', type: 'relogin', status: 'queued', createdAt: null, updatedAt: null, progress: null, error: null }],
  });
});

test('invalid preview stays detailed, invalid import never reaches the service, and unavailable imports return 503', async t => {
  let calls = 0;
  const { base, router } = await fixture(t, async () => { calls += 1; return { imported: 0, duplicates: 0, accounts: [], jobs: [] }; });
  const session = await createSession(base, router);
  const invalid = 'not-an-email|https://mail.google.com/mail/u/0/';
  const previewResponse = await post(router, base, 'preview', { ...session, accounts: invalid });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.valid, false);
  assert.equal(preview.rows[0].status, 'error');
  assert.equal(JSON.stringify(preview).includes('not-an-email'), false);
  assert.equal(JSON.stringify(preview).includes('mail.google.com'), false);

  const importResponse = await post(router, base, 'import', { ...session, accounts: invalid });
  assert.equal(importResponse.status, 400);
  const importBody = await importResponse.text();
  assert.equal(importBody.includes('not-an-email'), false);
  assert.equal(importBody.includes('mail.google.com'), false);
  assert.equal(calls, 0);

  const unavailable = await fixture(t, null);
  const unavailableSession = await createSession(unavailable.base, unavailable.router);
  const result = await post(unavailable.router, unavailable.base, 'import', { ...unavailableSession, accounts: 'first@example.test|https://mail.google.com/mail/u/0/' });
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error.code, 'service_unavailable');
});
