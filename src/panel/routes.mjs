import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPanelAuth } from './auth.mjs';
import { parseTokenBalanceLabel } from '../muse/usage.mjs';
import { previewAccountImport } from './import.mjs';
import { JOB_PHASES } from '../accounts/jobs.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/panel');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ERROR_TEXT = {
  invalid_host: 'Invalid local host.', invalid_origin: 'Cross-origin request rejected.',
  unauthorized: 'Authentication required.', invalid_ticket: 'Ticket is invalid or expired.',
  csrf: 'Request validation failed.', invalid_json: 'Request body must be valid JSON.', invalid_cursor: 'The requested page is invalid.',
  request_too_large: 'Request body is too large.', invalid_content_type: 'Content-Type must be application/json.',
  invalid_input: 'Check the account lines and supported mailbox links, then try again.',
  invalid_account_input: 'Check the account lines and try again.',
  unsupported_provider: 'A mailbox link uses an unsupported provider.',
  import_conflict: 'Two lines pair the same email or mailbox link differently. Resolve the conflict and preview again.',
  service_unavailable: 'The account import service is unavailable.',
  usage_auth_required: 'Muse usage requires a signed-in account.',
  usage_forbidden: 'Muse usage is unavailable for this account.',
  usage_unavailable: 'Muse usage could not be fetched.',
  usage_response_invalid: 'Muse returned an invalid usage response.',
  usage_session_changed: 'The Muse session changed during the usage refresh.',
  usage_cancelled: 'The Muse usage refresh was cancelled.',
  session_changed: 'The Muse session changed during the usage refresh.',
  cancelled: 'The Muse usage refresh was cancelled.',
  usage_refresh_unavailable: 'Muse usage refresh is unavailable.',
  account_busy: 'The account is busy.',
  session_unavailable: 'The Muse session is unavailable.',
  not_found: 'Item not found.', internal_error: 'The local panel could not complete this request.',
};
const USAGE_ERROR_CODES = new Set(['usage_auth_required', 'usage_forbidden', 'usage_unavailable', 'usage_response_invalid',
  'usage_session_changed', 'usage_cancelled', 'session_changed', 'cancelled', 'account_busy', 'session_unavailable', 'internal_error']);
const USAGE_STATES = new Set(['unknown', 'refreshing', 'ready', 'stale', 'error']);

function json(res, status, body, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(body));
}

function fail(res, status, code) {
  json(res, status, { error: { code, message: ERROR_TEXT[code] || ERROR_TEXT.internal_error } });
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function safeId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : null; }
function safeTime(value) { return typeof value === 'string' && value.length <= 64 ? value : Number.isFinite(value) ? value : null; }
function safeState(value) { return typeof value === 'string' && /^[a-zA-Z0-9 _.-]{1,64}$/.test(value) ? value : 'unknown'; }
function safeCode(value) { return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : null; }
function safeUsageNumber(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
function safeUsageState(value) { return USAGE_STATES.has(value) ? value : 'unknown'; }
function safeUsageEnum(value) { return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null; }
function safeUsageLabel(value) { return typeof value === 'string' && /^[\p{L}\p{N} ._-]{1,64}$/u.test(value) ? value : null; }
function publicMuseUsage(value) {
  if (!isRecord(value)) return null;
  let sample = null;
  if (isRecord(value.sample) && value.sample.source === 'muse_subscription'
    && Number.isFinite(value.sample.observedAt) && value.sample.observedAt >= 0
    && isRecord(value.sample.tier) && safeUsageEnum(value.sample.tier.code)
    && safeUsageLabel(value.sample.tier.name) && typeof value.sample.tier.isPaid === 'boolean'
    && isRecord(value.sample.weekly) && isRecord(value.sample.additional)) {
    const weekly = value.sample.weekly;
    const additional = value.sample.additional;
    const hasCanonicalTopup = ['approximate', 'displayLabel', 'raw'].some(key => Object.hasOwn(additional, key));
    const parsedLabel = typeof additional.displayLabel === 'string' ? parseTokenBalanceLabel(additional.displayLabel) : null;
    const raw = isRecord(additional.raw) && Number.isFinite(additional.raw.remaining) && additional.raw.remaining >= 0
      && Number.isFinite(additional.raw.limit) && additional.raw.limit >= 0
      && additional.raw.remaining <= additional.raw.limit && additional.raw.unit === 'muse_quota_units'
      ? { remaining: additional.raw.remaining, limit: additional.raw.limit, unit: 'muse_quota_units' } : null;
    sample = {
      source: 'muse_subscription', observedAt: value.sample.observedAt,
      tier: { code: safeUsageEnum(value.sample.tier.code), name: safeUsageLabel(value.sample.tier.name), isPaid: value.sample.tier.isPaid },
      weekly: {
        state: safeUsageEnum(weekly.state) || 'unknown',
        percentUsed: Number.isFinite(weekly.percentUsed) && weekly.percentUsed >= 0 && weekly.percentUsed <= 100 ? weekly.percentUsed : null,
        resetsAt: safeUsageNumber(weekly.resetsAt),
        quotaStatus: safeUsageEnum(weekly.quotaStatus),
      },
      additional: {
        ...(hasCanonicalTopup ? {
          remaining: parsedLabel?.remaining ?? null,
          limit: null,
          used: null,
          percentUsed: raw && raw.limit > 0 ? ((raw.limit - raw.remaining) / raw.limit) * 100 : null,
          approximate: parsedLabel?.approximate ?? false,
          displayLabel: parsedLabel?.displayLabel ?? null,
          ...(raw ? { raw } : {}),
        } : {
          remaining: safeUsageNumber(additional.remaining), limit: safeUsageNumber(additional.limit),
          used: safeUsageNumber(additional.used),
          percentUsed: Number.isFinite(additional.percentUsed) && additional.percentUsed >= 0 && additional.percentUsed <= 100 ? additional.percentUsed : null,
        }),
      },
    };
  }
  return {
    state: safeUsageState(value.state), pending: typeof value.pending === 'boolean' ? value.pending : false,
    observedAt: safeUsageNumber(value.observedAt), attemptedAt: safeUsageNumber(value.attemptedAt),
    errorCode: typeof value.errorCode === 'string' && USAGE_ERROR_CODES.has(value.errorCode) ? value.errorCode : null,
    sample,
  };
}
function safeError(value) {
  const code = isRecord(value) ? safeCode(value.code) || 'internal_error' : 'internal_error';
  const text = ERROR_TEXT[code] || ERROR_TEXT.internal_error;
  return { code, message: text };
}

function publicAccount(account) {
  if (!isRecord(account)) return null;
  const masked = typeof account.emailMasked === 'string' && account.emailMasked.length <= 254 && account.emailMasked.includes('@') && /[•*]/.test(account.emailMasked.slice(0, account.emailMasked.indexOf('@')))
    ? account.emailMasked : null;
  const usage = Number.isFinite(account.estimatedUsage) ? account.estimatedUsage : isRecord(account.estimatedUsage) ? {
    ...(Number.isFinite(account.estimatedUsage.inputTokens) ? { inputTokens: account.estimatedUsage.inputTokens } : {}),
    ...(Number.isFinite(account.estimatedUsage.outputTokens) ? { outputTokens: account.estimatedUsage.outputTokens } : {}),
    ...(Number.isFinite(account.estimatedUsage.totalTokens) ? { totalTokens: account.estimatedUsage.totalTokens } : {}),
    ...(Number.isFinite(account.estimatedUsage.requests) ? { requests: account.estimatedUsage.requests } : {}),
    ...(Number.isFinite(account.estimatedUsage.unknownRequests) ? { unknownRequests: account.estimatedUsage.unknownRequests } : {}),
    estimated: true,
  } : null;
  const quota = isRecord(account.upstreamQuota) && typeof account.upstreamQuota.unit === 'string' && /^[a-zA-Z0-9_.-]{1,32}$/.test(account.upstreamQuota.unit) &&
    (typeof account.upstreamQuota.observedAt === 'string' ? Number.isFinite(Date.parse(account.upstreamQuota.observedAt)) : Number.isFinite(account.upstreamQuota.observedAt)) &&
    [account.upstreamQuota.remaining, account.upstreamQuota.limit, account.upstreamQuota.used].some(Number.isFinite) ? {
    unit: account.upstreamQuota.unit,
    ...(Number.isFinite(account.upstreamQuota.remaining) ? { remaining: account.upstreamQuota.remaining } : {}),
    ...(Number.isFinite(account.upstreamQuota.limit) ? { limit: account.upstreamQuota.limit } : {}),
    ...(Number.isFinite(account.upstreamQuota.used) ? { used: account.upstreamQuota.used } : {}),
    observedAt: safeTime(account.upstreamQuota.observedAt),
  } : null;
  const capabilityNames = ['relogin', 'healthCheck', 'import'];
  const capabilities = isRecord(account.capabilities) ? Object.fromEntries(capabilityNames.filter(key => typeof account.capabilities[key] === 'boolean').map(key => [key, account.capabilities[key]])) : {};
  const result = {
    id: safeId(account.id), emailMasked: masked,
    mailProvider: typeof account.mailProvider === 'string' && /^[a-zA-Z0-9_. -]{1,64}$/.test(account.mailProvider) ? account.mailProvider : null,
    status: safeState(account.status), cooldownUntil: safeTime(account.cooldownUntil),
    reasonCode: safeCode(account.reasonCode), enabled: typeof account.enabled === 'boolean' ? account.enabled : null,
    busy: typeof account.busy === 'boolean' ? account.busy : null, quarantined: typeof account.quarantined === 'boolean' ? account.quarantined : null,
    lastVerifiedAt: safeTime(account.lastVerifiedAt), lastUsedAt: safeTime(account.lastUsedAt),
    estimatedUsage: usage,
    upstreamQuota: quota,
    capabilities,
    lastErrorCode: safeCode(account.lastErrorCode),
    remaining: null,
  };
  if (typeof account.hasSession === 'boolean') result.hasSession = account.hasSession;
  if (isRecord(account.museUsage)) result.museUsage = publicMuseUsage(account.museUsage);
  return result;
}

function publicRequest(request) {
  if (!isRecord(request)) return null;
  const errorCode = safeCode(request.errorCode);
  return { id: safeId(request.requestId ?? request.id), attemptId: safeId(request.attemptId),
    startedAt: safeTime(request.startedAt ?? request.createdAt ?? request.at), finishedAt: safeTime(request.finishedAt),
    status: safeState(request.status), accountId: safeId(request.accountId), delivery: safeState(request.delivery),
    error: errorCode ? safeError({ code: errorCode }) : null,
    estimatedInputTokens: Number.isFinite(request.estimatedInputTokens) ? request.estimatedInputTokens : null,
    estimatedOutputTokens: Number.isFinite(request.estimatedOutputTokens) ? request.estimatedOutputTokens : null };
}

function publicJob(job) {
  if (!isRecord(job)) return null;
  return { id: safeId(job.id), type: safeState(job.type ?? job.kind), status: safeState(job.status ?? job.state),
    createdAt: safeTime(job.createdAt), updatedAt: safeTime(job.updatedAt), progress: Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : null,
    error: job.error ? safeError(job.error) : safeCode(job.errorCode) ? safeError({ code: job.errorCode }) : null,
    ...(JOB_PHASES.includes(job.phase) ? { phase: job.phase } : {}) };
}

function publicStatistics(value) {
  if (!isRecord(value)) return null;
  const count = item => Number.isSafeInteger(item) && item >= 0 ? item : null;
  const totals = isRecord(value.totals) ? value.totals : {};
  const byStatus = isRecord(value.byStatus) ? value.byStatus : null;
  const statusCount = key => byStatus && !Object.hasOwn(byStatus, key) ? 0 : count(byStatus?.[key]);
  const failedParts = byStatus ? ['error', 'cancelled', 'timeout', 'rejected'].map(statusCount) : null;
  const failedTotal = failedParts?.every(item => item !== null) ? failedParts.reduce((sum, item) => sum + item, 0) : null;
  const sumStatuses = Number.isSafeInteger(failedTotal) ? failedTotal : null;
  const input = isRecord(value.estimatedInputTokens) ? value.estimatedInputTokens : {};
  const output = isRecord(value.estimatedOutputTokens) ? value.estimatedOutputTokens : {};
  return {
    requests: count(value.requests),
    attempts: count(totals.attempts),
    completed: statusCount('ok'),
    failed: sumStatuses,
    inputTokens: count(input.sum),
    outputTokens: count(output.sum),
    inputUnknown: count(input.unknownCount),
    outputUnknown: count(output.unknownCount),
    windowMs: count(value.windowMs),
    generatedAt: safeTime(value.generatedAt),
    bounded: true,
  };
}

function panelImportResult(result) {
  if (!Number.isSafeInteger(result?.imported) || result.imported < 0
    || !Number.isSafeInteger(result?.duplicates) || result.duplicates < 0
    || !Array.isArray(result.accounts) || !Array.isArray(result.jobs)) return null;
  return { imported: result.imported, duplicates: result.duplicates,
    accounts: result.accounts.map(publicAccount).filter(Boolean), jobs: result.jobs.map(publicJob).filter(Boolean) };
}

function importErrorStatus(code) {
  if (['invalid_json', 'invalid_input', 'invalid_account_input', 'unsupported_provider'].includes(code)) return 400;
  if (code === 'import_conflict') return 409;
  if (code === 'request_too_large') return 413;
  if (code === 'invalid_content_type') return 415;
  if (code === 'service_unavailable') return 503;
  return 500;
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error(), { code: 'invalid_content_type' });
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error(), { code: 'request_too_large' });
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw Object.assign(new Error(), { code: 'invalid_json' }); }
}

function writeSse(res, event, data, id = null) {
  const frame = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (res.destroyed || res.writableEnded) return Promise.reject(new Error('closed'));
  if (res.write(frame)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('slow')); }, 10_000);
    timer.unref?.();
    const cleanup = () => { clearTimeout(timer); res.removeListener('drain', drained); res.removeListener('close', closed); res.removeListener('error', closed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('closed')); };
    res.once('drain', drained); res.once('close', closed); res.once('error', closed);
  });
}

export function createPanelRouter({ root, stateDir, port, getSnapshot, listAccounts, listRequests, relogin,
  healthCheck, getJob, importAccounts, refreshUsage, eventBus, auth = createPanelAuth({ stateDir }) } = {}) {
  if (!Number.isSafeInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new TypeError('A valid local port is required');
  const listenPort = Number(port);
  const streams = new Set();
  // This nonce is a request-forgery guard for this router lifetime, not a login token.
  const csrfNonce = randomBytes(32).toString('base64url');
  let closed = false;

  async function shell(name, res) {
    const file = path.join(PANEL_DIR, name);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': name.endsWith('.html') ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    res.end(data);
  }

  async function snapshot() {
    let source = {};
    try { source = typeof getSnapshot === 'function' ? (await getSnapshot()) || {} : {}; }
    catch { source = {}; }
    let accounts = Array.isArray(source.accounts) ? source.accounts : [];
    let requestsPage = { data: Array.isArray(source.requests) ? source.requests : [], nextCursor: null };
    try { if (typeof listAccounts === 'function') accounts = await listAccounts(); } catch { accounts = []; }
    try { if (typeof listRequests === 'function') requestsPage = await requestPage(50, null, requestsPage.data); } catch { requestsPage = { data: [], nextCursor: null }; }
    return { status: safeState(source.status), queue: isRecord(source.queue) ? {
      active: typeof source.queue.active === 'boolean' ? source.queue.active : Number.isSafeInteger(source.queue.active) ? source.queue.active > 0 : null,
      activeCount: Number.isSafeInteger(source.queue.activeCount) ? source.queue.activeCount : Number.isSafeInteger(source.queue.active) ? source.queue.active : null,
      waiting: Number.isSafeInteger(source.queue.waiting) ? source.queue.waiting : Number.isSafeInteger(source.queue.pending) ? source.queue.pending : null,
      capacity: Number.isSafeInteger(source.queue.capacity) ? source.queue.capacity : null,
    } : null,
    accounts: (Array.isArray(accounts) ? accounts : []).map(publicAccount).filter(Boolean),
    requests: requestsPage.data.map(publicRequest).filter(Boolean), requestsNextCursor: requestsPage.nextCursor,
    error: source.error ? safeError(source.error) : null,
    statistics: publicStatistics(source.statistics),
    jobs: (Array.isArray(source.jobs) ? source.jobs : []).slice(0, 200).map(publicJob).filter(Boolean),
    usage: { estimated: true, remaining: null } };
  }

  async function requestPage(limit, cursor, fallback = []) {
    if (typeof listRequests !== 'function') return { data: Array.isArray(fallback) ? fallback : [], nextCursor: null };
    const result = await listRequests({ limit, cursor });
    if (Array.isArray(result)) return { data: result, nextCursor: null };
    if (!isRecord(result)) return { data: [], nextCursor: null };
    return { data: Array.isArray(result.data) ? result.data : [],
    nextCursor: typeof result.nextCursor === 'string' && result.nextCursor.length <= 128 ? result.nextCursor : null };
  }

  function localRequest(req, parsedURL) {
    const allowedHosts = new Set([`127.0.0.1:${listenPort}`, `localhost:${listenPort}`]);
    if (!allowedHosts.has(req.headers.host)) return 'invalid_host';
    if (parsedURL.origin !== `http://${req.headers.host}`) return 'invalid_host';
    return null;
  }

  function originRequired(req) { return req.headers.origin === `http://${req.headers.host}`; }

  function csrfValid(req) {
    const supplied = req.headers['x-panel-csrf'];
    if (typeof supplied !== 'string') return false;
    const expected = Buffer.from(csrfNonce);
    const actual = Buffer.from(supplied);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async function handleApi(req, res, pathname) {
    // Retired panel login surface. The CLI /control API keeps its independent admin key.
    if (pathname === '/control/panel-ticket') return fail(res, 404, 'not_found');
    if (pathname === '/control/accounts' && req.method === 'GET') {
      if (!auth.adminAuthorized(req)) return fail(res, 401, 'unauthorized');
      let accounts = [];
      try { accounts = typeof listAccounts === 'function' ? await listAccounts() : []; } catch { return fail(res, 500, 'internal_error'); }
      return json(res, 200, { data: (Array.isArray(accounts) ? accounts : []).map(publicAccount).filter(Boolean) });
    }
    if ((pathname === '/control/accounts' || pathname === '/control/accounts/import') && req.method === 'POST') {
      if (!auth.adminAuthorized(req)) return fail(res, 401, 'unauthorized');
      try {
        const body = await readJson(req);
        const result = typeof importAccounts === 'function' ? await importAccounts(body) : null;
        if (Number.isSafeInteger(result?.imported) && result.imported >= 0 && Number.isSafeInteger(result?.duplicates) && result.duplicates >= 0 && Array.isArray(result.accounts) && Array.isArray(result.jobs)) {
          return json(res, 202, { imported: result.imported, duplicates: result.duplicates,
            accounts: result.accounts.map(publicAccount).filter(Boolean), jobs: result.jobs.map(publicJob).filter(Boolean) });
        }
        return json(res, 202, { job: publicJob(result?.job ?? result) });
      } catch (error) {
        const status = ['invalid_json', 'invalid_input', 'invalid_account_input', 'unsupported_provider'].includes(error?.code) ? 400 : error?.code === 'import_conflict' ? 409 : error?.code === 'request_too_large' ? 413 : error?.code === 'invalid_content_type' ? 415 : 500;
        return fail(res, status, error?.code || 'internal_error');
      }
    }
    const controlJob = /^\/control\/jobs\/([a-zA-Z0-9_.:-]{1,120})$/.exec(pathname);
    if (controlJob && req.method === 'GET') {
      if (!auth.adminAuthorized(req)) return fail(res, 401, 'unauthorized');
      return getJobResponse(res, controlJob[1]);
    }
    const controlAction = /^\/control\/accounts\/([a-zA-Z0-9_.:-]{1,120})\/(relogin|health-check)$/.exec(pathname);
    if (controlAction && req.method === 'POST') {
      if (!auth.adminAuthorized(req)) return fail(res, 401, 'unauthorized');
      return actionResponse(res, controlAction[1], controlAction[2]);
    }

    if (!pathname.startsWith('/panel/api/')) return false;
    if (pathname === '/panel/api/session' || pathname === '/panel/api/logout') return fail(res, 404, 'not_found');
    if (req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'invalid_origin');
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && !originRequired(req)) return fail(res, 403, 'invalid_origin');
    if (mutating && !csrfValid(req)) return fail(res, 403, 'csrf');
    if (['/panel/api/accounts/preview', '/panel/api/accounts/import'].includes(pathname) && req.method === 'POST') {
      let body;
      try { body = await readJson(req); }
      catch (error) { return fail(res, importErrorStatus(error?.code), error?.code || 'internal_error'); }

      let preview;
      try { preview = previewAccountImport(isRecord(body) ? body.accounts : null); }
      catch (error) { return fail(res, importErrorStatus(error?.code), error?.code || 'invalid_input'); }

      if (pathname === '/panel/api/accounts/preview') return json(res, 200, preview);
      if (!preview.valid) return json(res, 400, {
        error: { code: 'invalid_input', message: ERROR_TEXT.invalid_input }, preview,
      });
      if (typeof importAccounts !== 'function') return fail(res, 503, 'service_unavailable');
      try {
        const result = await importAccounts(body);
        const safeResult = panelImportResult(result);
        if (!safeResult) return fail(res, 500, 'internal_error');
        return json(res, 202, safeResult);
      } catch (error) { return fail(res, importErrorStatus(error?.code), error?.code || 'internal_error'); }
    }
    if (pathname === '/panel/api/usage/refresh' && req.method === 'POST') return usageRefreshResponse(res, null);
    const usageRefresh = /^\/panel\/api\/accounts\/([a-zA-Z0-9_.:-]{1,120})\/usage-refresh$/.exec(pathname);
    if (usageRefresh && req.method === 'POST') return usageRefreshResponse(res, usageRefresh[1]);
    if (pathname === '/panel/api/bootstrap' && req.method === 'GET') return json(res, 200, { csrf: csrfNonce, snapshot: await snapshot() });
    if (pathname === '/panel/api/accounts' && req.method === 'GET') {
      const value = await snapshot();
      return json(res, 200, { data: value.accounts });
    }
    if (pathname === '/panel/api/requests' && req.method === 'GET') {
      const url = new URL(req.url, `http://127.0.0.1:${listenPort}`);
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      const cursor = url.searchParams.get('cursor');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && cursor.length > 128)) return fail(res, 400, 'invalid_cursor');
      try {
        const page = await requestPage(limit, cursor);
        return json(res, 200, { data: page.data.map(publicRequest).filter(Boolean), nextCursor: page.nextCursor });
      } catch { return fail(res, 500, 'internal_error'); }
    }
    if (pathname === '/panel/api/events' && req.method === 'GET') return startEvents(req, res);
    const jobMatch = /^\/panel\/api\/jobs\/([a-zA-Z0-9_.:-]{1,120})$/.exec(pathname);
    if (jobMatch && req.method === 'GET') return getJobResponse(res, jobMatch[1]);
    const action = /^\/panel\/api\/accounts\/([a-zA-Z0-9_.:-]{1,120})\/(relogin|health-check)$/.exec(pathname);
    if (action && req.method === 'POST') {
      return actionResponse(res, action[1], action[2]);
    }
    return fail(res, 404, 'not_found');
  }

  async function getJobResponse(res, id) {
    if (typeof getJob !== 'function') return fail(res, 404, 'not_found');
    try {
      const job = await getJob(id);
      if (!job) return fail(res, 404, 'not_found');
      return json(res, 200, { job: publicJob(job) });
    } catch { return fail(res, 500, 'internal_error'); }
  }

  async function actionResponse(res, id, action) {
    const callback = action === 'relogin' ? relogin : healthCheck;
    if (typeof callback !== 'function') return fail(res, 404, 'not_found');
    try {
      const result = await callback(id);
      const job = result?.job ?? result;
      if (!job || !safeId(job.id)) return fail(res, 500, 'internal_error');
      return json(res, 202, { job: publicJob(job) });
    } catch { return fail(res, 500, 'internal_error'); }
  }

  async function usageRefreshResponse(res, accountId) {
    if (typeof refreshUsage !== 'function') return fail(res, 503, 'usage_refresh_unavailable');
    try {
      const result = await refreshUsage(accountId);
      if (!isRecord(result) || !Number.isSafeInteger(result.queued) || result.queued < 0
        || !Number.isSafeInteger(result.skipped) || result.skipped < 0
        || !Number.isSafeInteger(result.pending) || result.pending < 0) return fail(res, 500, 'internal_error');
      return json(res, 202, { queued: result.queued, skipped: result.skipped, pending: result.pending });
    } catch { return fail(res, 500, 'internal_error'); }
  }

  async function startEvents(req, res) {
    if (!eventBus?.subscribe || !eventBus?.replay) return fail(res, 503, 'internal_error');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    const stream = { res, queue: [], lastSent: null, pumping: false, closed: false, unsubscribe: null, heartbeat: null };
    streams.add(stream);
    const remove = () => {
      if (stream.closed) return;
      stream.closed = true;
      clearInterval(stream.heartbeat);
      stream.unsubscribe?.();
      streams.delete(stream);
      stream.queue.length = 0;
    };
    stream.remove = remove;
    res.once('close', remove);
    req.once('aborted', remove);
    const enqueue = event => {
      if (!isRecord(event) || !['snapshot', 'account.updated', 'request.finished', 'job.updated', 'queue.updated', 'server.shutdown', 'accounts', 'requests', 'jobs', 'status', 'error', 'reset', 'heartbeat'].includes(event.type)) return;
      if (event.id != null && (typeof event.id !== 'string' || !/^[a-zA-Z0-9_-]{1,48}:\d+$/.test(event.id))) return;
      if (stream.closed || (event.id && event.id === stream.lastSent)) return;
      if (event.id && stream.queue.some(item => item.id === event.id)) return;
      if (stream.queue.length >= 256) { res.destroy(); remove(); return; }
      stream.queue.push(event);
      void pump(stream);
    };
    const lastId = req.headers['last-event-id'] || '';
    stream.unsubscribe = eventBus.subscribe(event => enqueue(event));
    const replay = eventBus.replay(lastId);
    if (replay.reset) enqueue({ id: null, type: 'reset', data: null });
    else for (const event of replay.events) enqueue(event);
    stream.heartbeat = setInterval(() => enqueue({ id: null, type: 'heartbeat', data: { at: Date.now() } }), 15_000);
    stream.heartbeat.unref?.();
    if (stream.queue.length) void pump(stream);
    return true;
  }

  async function pump(stream) {
    if (stream.pumping || stream.closed) return;
    stream.pumping = true;
    try {
      while (!stream.closed && stream.queue.length) {
        const event = stream.queue.shift();
        if (event.type === 'heartbeat') { await writeSse(stream.res, 'heartbeat', event.data); continue; }
        if (event.type === 'reset') {
          const currentSnapshot = await snapshot();
          await writeSse(stream.res, 'reset', { snapshot: currentSnapshot });
          continue;
        }
        const current = await snapshot();
        const payload = { snapshot: current };
        if ((event.type === 'jobs' || event.type === 'job.updated') && isRecord(event.data)) {
          const jobId = safeId(event.data.jobId ?? event.data.id ?? (isRecord(event.data.job) ? event.data.job.id : null));
          if (jobId && typeof getJob === 'function') {
            try { const job = await getJob(jobId); if (job) payload.job = publicJob(job); } catch { /* Keep job callback failures private. */ }
          }
        }
        if (!stream.closed) await writeSse(stream.res, event.type, payload, event.id);
        stream.lastSent = event.id || stream.lastSent;
        if (event.type === 'server.shutdown') { stream.res.end(); stream.remove(); break; }
      }
    } catch { stream.res.destroy(); }
    finally {
      stream.pumping = false;
      if (stream.queue.length && !stream.closed) void pump(stream);
    }
  }

  return {
    async handle(req, res, parsedURL) {
      if (closed) return false;
      const url = parsedURL instanceof URL ? parsedURL : new URL(req.url, `http://127.0.0.1:${listenPort}`);
      if (!['/panel', '/panel/', '/panel/index.html', '/panel/app.js', '/panel/model.js', '/panel/style.css'].includes(url.pathname) && !url.pathname.startsWith('/panel/api/') && !url.pathname.startsWith('/control/')) return false;
      const invalid = localRequest(req, url);
      if (invalid) { fail(res, 403, invalid); return true; }
      if ((url.pathname.startsWith('/panel/api/') || url.pathname.startsWith('/control/'))
        && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { fail(res, 403, 'invalid_origin'); return true; }
      if (url.pathname.startsWith('/panel/api/') && req.headers['sec-fetch-site'] === 'cross-site') { fail(res, 403, 'invalid_origin'); return true; }
      if (url.pathname === '/panel' || url.pathname === '/panel/' || url.pathname === '/panel/index.html') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'not_found'); return true; }
        await shell('index.html', res);
        return true;
      }
      if (url.pathname === '/panel/app.js' || url.pathname === '/panel/model.js' || url.pathname === '/panel/style.css') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'not_found'); return true; }
        await shell(url.pathname.endsWith('.js') ? path.basename(url.pathname) : 'style.css', res);
        return true;
      }
      if (url.pathname.startsWith('/control/')) await auth.ready();
      const handled = await handleApi(req, res, url.pathname);
      return handled === false ? false : true;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const stream of [...streams]) { stream.res.destroy(); stream.unsubscribe?.(); clearInterval(stream.heartbeat); stream.closed = true; stream.queue.length = 0; }
      streams.clear();
      eventBus?.closeAll?.();
    },
    get activeStreams() { return streams.size; },
  };
}
