import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAccountCLI as runAccountCLIImpl } from '../scripts/account.mjs';
import { parseImport } from '../src/mail/index.mjs';
import { createAccountService } from '../src/accounts/service.mjs';

const testAuth = () => ({ adminBearer: async () => 'dGVzdC1hZG1pbi1iZWFyZXI' });
function runAccountCLI(options) {
  return runAccountCLIImpl({ ...options, createPanelAuthImpl: testAuth });
}

async function withState(run) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'account-cli-'));
  try { return await run(path.join(base, '.state')); }
  finally { await rm(base, { recursive: true, force: true }); }
}

function outputSink() {
  let value = '';
  return { stream: { write: chunk => { value += chunk; } }, get value() { return value; } };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('add parses and validates the complete import before POSTing only the required fields', async () => withState(async stateDir => {
  const stdout = outputSink();
  const stderr = outputSink();
  const requests = [];
  const importedEntries = [];
  const records = new Map();
  const jobsById = new Map();
  const service = createAccountService({
    store: {
      listPublic: () => [...records.values()],
      getPrivate: id => records.get(id),
      replaceSession: async () => {},
      updateAccount: async (id, _revision, patch) => {
        const record = records.get(id);
        Object.assign(record, patch, { revision: record.revision + 1 });
        return record;
      },
      importBatch: async entries => {
        importedEntries.push(...entries);
        const imported = entries.map((entry, index) => {
          const record = {
            id: `123e4567-e89b-42d3-a456-42661417400${index}`,
            ...entry, mail: { mailAccessUrl: entry.mailAccessUrl }, maskedEmail: 'sa•••@example.test',
            revision: 1, status: 'new', reasonCode: null, cooldownUntil: null, enabled: true,
            quarantined: false, hasSession: false, session: null,
          };
          records.set(record.id, record);
          return record;
        });
        return { imported, skipped: 0 };
      },
    },
    pool: { status: () => ({}), runExclusive: (_id, operation) => operation(), clearQuarantine: async () => {} },
    sessionManager: { refresh: async () => ({ sessionRevision: 0 }) },
    bootstrapper: { login: async () => ({}) },
    jobs: {
      start: (type, _accountId, _operation) => {
        const job = { id: '123e4567-e89b-42d3-a456-426614174010', type, status: 'queued', progress: 0 };
        jobsById.set(job.id, job);
        return job;
      },
      get: id => jobsById.get(id), cancel: () => false,
    },
  });
  const result = await runAccountCLI({
    args: ['add'], input: 'Safe.Person@example.test|https://mail.google.com/mail/u/0/\n',
    port: 8787, stateDir, parseImportImpl: parseImport, stdout: stdout.stream, stderr: stderr.stream,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const serviceResult = await service.importAccounts(JSON.parse(options.body));
      return jsonResponse(serviceResult, 202);
    },
  });
  assert.equal(result, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:8787/control/accounts/import');
  assert.equal(requests[0].options.method, 'POST');
  assert.match(requests[0].options.headers.Authorization, /^Bearer [A-Za-z0-9_-]+$/);
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(Object.keys(body), ['accounts']);
  assert.equal(typeof body.accounts, 'string');
  assert.equal(body.accounts, 'Safe.Person@example.test|https://mail.google.com/mail/u/0/\n');
  const cliRecords = parseImport(body.accounts);
  assert.deepEqual(importedEntries, [{
    email: 'safe.person@example.test', emailNormalized: 'safe.person@example.test', provider: 'gmail',
    mailAccessUrl: 'https://mail.google.com/mail/u/0/',
  }]);
  assert.equal(cliRecords[0].provider, 'gmail');
  assert.equal(stdout.value.includes('Safe.Person@example.test'), false);
  assert.equal(stdout.value.includes('mail.google.com'), false);
  assert.match(stdout.value, /123e4567-e89b-42d3-a456-426614174000/);
  assert.match(stdout.value, /123e4567-e89b-42d3-a456-426614174010/);
  assert.match(stdout.value, /sa•••@example\.test · needs_relogin/);
  assert.match(stdout.value, /Imported: 1; duplicates: 0; accounts: 1; jobs: 1/);
  assert.equal(stderr.value, '');
}));

test('duplicate-only import reports duplicate counts without inventing IDs', async () => withState(async stateDir => {
  const stdout = outputSink();
  const stderr = outputSink();
  const result = await runAccountCLI({
    args: ['add'], input: 'safe@example.test|https://mail.google.com/mail/u/0/',
    port: 8787, stateDir, parseImportImpl: parseImport, stdout: stdout.stream, stderr: stderr.stream,
    fetchImpl: async () => jsonResponse({ imported: 0, duplicates: 1, accounts: [], jobs: [] }),
  });
  assert.equal(result, 0);
  assert.equal(stdout.value, 'Imported: 0; duplicates: 1; accounts: 0; jobs: 0\n');
  assert.equal(stderr.value, '');
}));

test('invalid batch is rejected before key creation or network access', async () => withState(async stateDir => {
  const stdout = outputSink();
  const stderr = outputSink();
  let networkCalls = 0;
  const result = await runAccountCLI({ args: ['add'], input: 'invalid line with private text', port: 8787, stateDir,
    parseImportImpl: parseImport, stdout: stdout.stream, stderr: stderr.stream,
    fetchImpl: async () => { networkCalls += 1; return jsonResponse({}); },
  });
  assert.equal(result, 1);
  assert.equal(networkCalls, 0);
  assert.equal(stdout.value, '');
  assert.doesNotMatch(stderr.value, /private text|invalid line/);
}));

test('add rejects batches above 1 MiB without making a request', async () => withState(async stateDir => {
  let networkCalls = 0;
  const stderr = outputSink();
  const result = await runAccountCLI({ args: ['add'], input: 'x'.repeat(1024 * 1024 + 1), port: 8787, stateDir,
    parseImportImpl: parseImport, stderr: stderr.stream,
    fetchImpl: async () => { networkCalls += 1; return jsonResponse({}); },
  });
  assert.equal(result, 1);
  assert.equal(networkCalls, 0);
  assert.match(stderr.value, /1 MiB/);
}));

test('list, health, login and jobs use the local admin routes and print only safe status fields', async () => withState(async stateDir => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/control/accounts')) return jsonResponse({ data: [
      { id: '123e4567-e89b-42d3-a456-426614174002', emailMasked: 'sa•••@example.test', status: 'ready', email: 'hidden@example.test', url: 'private-url' },
      { id: 'private-account-id', emailMasked: 'ot•••@example.test', status: 'ready' },
    ] });
    const id = url.endsWith('/control/jobs/job-1') ? '123e4567-e89b-42d3-a456-426614174003' : 'private-job-id';
    return jsonResponse({ job: { id, status: 'queued', secret: 'private-job-secret' } }, 202);
  };
  const outputs = [];
  for (const args of [['list'], ['health', 'acct-1'], ['login', 'acct-1'], ['jobs', 'job-1']]) {
    const stdout = outputSink();
    const stderr = outputSink();
    assert.equal(await runAccountCLI({ args, port: 8787, stateDir, stdout: stdout.stream, stderr: stderr.stream, fetchImpl: fakeFetch }), 0);
    outputs.push(stdout.value);
    assert.equal(stderr.value, '');
  }
  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:8787/control/accounts',
    'http://127.0.0.1:8787/control/accounts/acct-1/health-check',
    'http://127.0.0.1:8787/control/accounts/acct-1/relogin',
    'http://127.0.0.1:8787/control/jobs/job-1',
  ]);
  for (const output of outputs) {
    assert.equal(output.includes('hidden@example.test'), false);
    assert.equal(output.includes('private-url'), false);
    assert.equal(output.includes('private-job'), false);
    assert.equal(output.includes('private-account-id'), false);
  }
  assert.match(outputs[0], /123e4567-e89b-42d3-a456-426614174002/);
  assert.match(outputs[3], /123e4567-e89b-42d3-a456-426614174003/);
  assert.match(outputs[0], /sa•••@example\.test · ready/);
  assert.match(outputs[0], /Accounts: 2/);
  assert.match(outputs[1], /Health check: queued \(1 job\)/);
  assert.match(outputs[2], /Relogin: queued \(1 job\)/);
  assert.match(outputs[3], /Job: queued · 123e4567-e89b-42d3-a456-426614174003 \(1 job\)/);
}));

test('invalid ids and failed local requests never print server response bodies', async () => withState(async stateDir => {
  const stderr = outputSink();
  let calls = 0;
  const invalidId = await runAccountCLI({ args: ['login', 'bad/email'], port: 8787, stateDir, stderr: stderr.stream,
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
  });
  assert.equal(invalidId, 1);
  assert.equal(calls, 0);
  const failed = await runAccountCLI({ args: ['list'], port: 8787, stateDir, stderr: stderr.stream,
    fetchImpl: async () => jsonResponse({ error: { message: 'private response body' } }, 500),
  });
  assert.equal(failed, 1);
  assert.equal(stderr.value.includes('private response body'), false);
}));
