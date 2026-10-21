#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 1024 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,120}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function write(target, message) {
  if (typeof target === 'function') target(message);
  else target?.write?.(message);
}

function safeStatus(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_. -]{1,64}$/.test(value) ? value : 'unknown';
}

function accountLine(account) {
  const id = typeof account?.id === 'string' && UUID_V4.test(account.id) ? `${account.id} · ` : '';
  const email = typeof account?.emailMasked === 'string' && account.emailMasked.length <= 254 &&
    account.emailMasked.includes('@') && /[•*]/.test(account.emailMasked.slice(0, account.emailMasked.indexOf('@')))
    ? account.emailMasked : 'masked email unavailable';
  return `${id}${email} · ${safeStatus(account?.status)}`;
}

function jobLine(label, job) {
  const id = typeof job?.id === 'string' && UUID_V4.test(job.id) ? ` · ${job.id}` : '';
  return `${label}: ${safeStatus(job?.status)}${id}`;
}

function validCount(value) { return Number.isSafeInteger(value) && value >= 0; }

async function resolveConfig(root, port, stateDir) {
  if (Number.isSafeInteger(port) && typeof stateDir === 'string' && stateDir) return { port, stateDir };
  const module = await import(pathToFileURL(path.join(root, 'src/config.mjs')));
  const config = module.settings();
  return { port: Number.isSafeInteger(port) ? port : config.port, stateDir: stateDir || module.STATE };
}

async function parseImportFor(root, injected) {
  if (typeof injected === 'function') return injected;
  const module = await import(pathToFileURL(path.join(root, 'src/mail/index.mjs')));
  if (typeof module.parseImport !== 'function') throw new Error('missing parser');
  return module.parseImport;
}

async function panelAuthFor(root, injected) {
  if (typeof injected === 'function') return injected;
  const module = await import(pathToFileURL(path.join(root, 'src/panel/auth.mjs')));
  if (typeof module.createPanelAuth !== 'function') throw new Error('missing panel auth');
  return module.createPanelAuth;
}

export async function runAccountCLI({ args = [], input = '', fetchImpl = globalThis.fetch, port, stateDir,
  stdout = process.stdout, stderr = process.stderr, root = path.resolve(SCRIPT_DIR, '..'), parseImportImpl,
  createPanelAuthImpl } = {}) {
  const fail = message => { write(stderr, `${message}\n`); return 1; };
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) return fail('Invalid command.');
  const [command, ...rest] = args;
  if (!['add', 'list', 'health', 'login', 'jobs'].includes(command)) {
    return fail('Usage: account add | list | health <id> | login <id> | jobs <id>');
  }
  if (!['add', 'list'].includes(command) && (rest.length !== 1 || !SAFE_ID.test(rest[0]))) return fail(`Usage: account ${command} <id>`);
  if (['add', 'list'].includes(command) && rest.length) return fail(`Usage: account ${command}`);

  let parsedImport;
  let body;
  if (command === 'add') {
    const inputText = typeof input === 'string' ? input : Buffer.isBuffer(input) ? input.toString('utf8') : '';
    if (Buffer.byteLength(inputText, 'utf8') > MAX_BODY_BYTES) return fail('Account import exceeds the 1 MiB limit.');
    try { parsedImport = await parseImportFor(root, parseImportImpl); }
    catch { return fail('Account import is unavailable in this project setup.'); }
    let records;
    try { records = parsedImport(inputText); }
    catch (error) {
      const code = error?.code === 'unsupported_provider' ? 'Unsupported mail provider.' : 'Invalid account import. Check the file format and try again.';
      return fail(code);
    }
    if (!Array.isArray(records) || records.length < 1 || records.length > 100) return fail('Invalid account import. Check the file format and try again.');
    if (records.some(record => typeof record?.email !== 'string' || typeof record?.provider !== 'string' || typeof record?.mailAccessUrl !== 'string')) {
      return fail('Invalid account import. Check the file format and try again.');
    }
    // The service contract is the canonical newline-separated import string;
    // the service reparses and validates it before committing anything.
    body = { accounts: inputText };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) return fail('Account import exceeds the 1 MiB limit.');
  }

  let config;
  try { config = await resolveConfig(root, port, stateDir); }
  catch { return fail('The local account service configuration is unavailable.'); }
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) return fail('The local account service configuration is invalid.');

  let bearer;
  try {
    const createPanelAuth = await panelAuthFor(root, createPanelAuthImpl);
    bearer = await createPanelAuth({ stateDir: config.stateDir }).adminBearer();
  }
  catch { return fail('The local account service key is unavailable.'); }

  let route;
  let method = 'GET';
  const headers = { Authorization: `Bearer ${bearer}` };
  if (command === 'add') {
    route = '/control/accounts/import'; method = 'POST'; headers['Content-Type'] = 'application/json';
  } else if (command === 'list') route = '/control/accounts';
  else if (command === 'jobs') route = `/control/jobs/${encodeURIComponent(rest[0])}`;
  else route = `/control/accounts/${encodeURIComponent(rest[0])}/${command === 'health' ? 'health-check' : 'relogin'}`, method = 'POST';

  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${config.port}${route}`, {
      method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
  } catch { return fail('The local account service is unavailable.'); }

  let result;
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return fail('The local service returned an invalid response.');
    result = JSON.parse(raw);
  } catch { return fail('The local service returned an invalid response.'); }
  if (!response.ok || !result || typeof result !== 'object') return fail('The local account request failed.');

  if (command === 'list') {
    if (!Array.isArray(result.data) || result.data.length > 10_000) return fail('The local service returned an invalid account list.');
    for (const account of result.data) write(stdout, `${accountLine(account)}\n`);
    write(stdout, `Accounts: ${result.data.length}\n`);
    return 0;
  }
  if (command === 'add') {
    if (!validCount(result.imported) || !validCount(result.duplicates) || !Array.isArray(result.accounts) ||
      result.accounts.length > 100 || !Array.isArray(result.jobs) || result.jobs.length > 100) {
      return fail('The local service returned an invalid import result.');
    }
    for (const account of result.accounts) write(stdout, `${accountLine(account)}\n`);
    for (const job of result.jobs) {
      if (typeof job?.status === 'string') write(stdout, `${jobLine('Job', job)}\n`);
    }
    write(stdout, `Imported: ${result.imported}; duplicates: ${result.duplicates}; accounts: ${result.accounts.length}; jobs: ${result.jobs.length}\n`);
    return 0;
  }
  const job = result.job || result;
  if (!job || typeof job !== 'object' || typeof job.status !== 'string') return fail('The local service returned an invalid job result.');
  write(stdout, `${jobLine(command === 'jobs' ? 'Job' : command === 'health' ? 'Health check' : 'Relogin', job)} (1 job)\n`);
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; }
  catch { return false; }
}

if (isDirectExecution()) {
  const args = process.argv.slice(2);
  const input = args[0] === 'add' ? await (async () => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    try {
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { oversized = true; continue; }
        chunks.push(chunk);
      }
      return oversized ? Buffer.alloc(MAX_BODY_BYTES + 1) : Buffer.concat(chunks).toString('utf8');
    } catch { return ''; }
  })() : '';
  process.exitCode = await runAccountCLI({ args, input });
}
