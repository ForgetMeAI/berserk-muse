import { parseImport } from '../mail/index.mjs';
import { JOB_PHASES } from './jobs.mjs';

const MAX_IMPORT_BYTES = 1_048_576;
const MAX_IMPORT_ACCOUNTS = 100;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const JOB_ERROR_CODES = new Set([
  'invalid_input', 'unsupported_provider', 'mail_auth_failed', 'mail_rate_limited', 'mail_timeout',
  'mail_unavailable', 'mail_response_invalid', 'aborted', 'cancelled', 'account_busy',
  'job_queue_full', 'job_capacity', 'internal_error',
  'needs_relogin', 'expired', 'refresh_failed', 'probe_failed', 'session_unavailable',
  'needs_user_interaction', 'needs_mail_auth', 'login_timeout', 'token_exchange_failed',
  'invalid_token_response', 'browser_unavailable', 'account_mismatch', 'muse_session_unavailable',
  'browser_launch_failed', 'browser_launch_timeout', 'browser_permission_denied',
  'muse_navigation_failed', 'muse_navigation_timeout', 'muse_dns_error', 'muse_proxy_error', 'muse_tls_error',
  'unsafe_workspace', 'login_workspace_exists',
]);

export class AccountServiceError extends Error {
  constructor(code, status = 400) {
    const safeCode = SAFE_CODE.test(code || '') ? code : 'internal_error';
    super(safeCode);
    this.name = 'AccountServiceError';
    this.code = safeCode;
    this.status = Number.isInteger(status) ? status : 400;
  }
}

function safeCode(value, fallback = 'internal_error') {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}

function publicJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    ...(JOB_PHASES.includes(job.phase) ? { phase: job.phase } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  };
}

function assertId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new AccountServiceError('invalid_input', 400);
  }
  return id;
}

function normalizeSession(bundle) {
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.cookies)
    || !bundle.tokens || typeof bundle.tokens !== 'object' || Array.isArray(bundle.tokens)
    || !bundle.device || typeof bundle.device !== 'object' || Array.isArray(bundle.device)
    || !bundle.upstream || typeof bundle.upstream !== 'object' || Array.isArray(bundle.upstream)) {
    throw new AccountServiceError('internal_error', 500);
  }
  return {
    cookies: bundle.cookies,
    tokens: bundle.tokens,
    device: { ...bundle.device, upstream: bundle.upstream },
    expiresAt: bundle.expiresAt ?? null,
  };
}

function terminal(job) { return !job || ['succeeded', 'failed', 'cancelled'].includes(job.status); }

function jobError(error) {
  const code = safeCode(error?.code);
  if (JOB_ERROR_CODES.has(code)) return code;
  if (code === 'needs_mail_auth') return 'mail_auth_failed';
  if (code === 'login_timeout') return 'mail_timeout';
  if (code === 'aborted' || code === 'cancelled') return 'cancelled';
  return 'internal_error';
}


function privateAccount(store, id) {
  try { return store.getPrivate(id); }
  catch (error) {
    if (error?.code === 'account_not_found') throw new AccountServiceError('invalid_input', 404);
    throw new AccountServiceError('internal_error', 500);
  }
}

function publicAccount(record, { busy = null, estimatedUsage = null, upstreamQuota = null,
  quarantined = record.quarantined, quarantineReason = null } = {}) {
  const missingSession = record.hasSession === false;
  const status = missingSession && record.status === 'active' ? 'needs_relogin' : record.status;
  const reasonCode = missingSession && record.status === 'active'
    ? 'session_missing'
    : record.reasonCode ?? (quarantined ? quarantineReason : null);
  return {
    id: record.id,
    emailMasked: record.maskedEmail,
    mailProvider: record.provider,
    status,
    cooldownUntil: record.cooldownUntil,
    reasonCode,
    enabled: record.enabled,
    busy,
    quarantined: record.quarantined === true || quarantined === true,
    lastVerifiedAt: null,
    estimatedUsage,
    upstreamQuota,
    capabilities: { relogin: true, healthCheck: true, import: false },
    lastErrorCode: reasonCode,
    remaining: null,
  };
}

function accountStatusReason(error) {
  const code = safeCode(error?.code, 'needs_relogin');
  return code === 'account_banned' ? 'account_banned' : code;
}

const RELOGIN_AUTH_VERDICTS = new Set(['needs_relogin', 'expired', 'session_unavailable']);

function hasUsableStoredSession(account) {
  return Boolean(account?.session && Number.isSafeInteger(account.session.sessionRevision)
    && account.session.sessionRevision > 0);
}

function statusForError(error) {
  if (error instanceof AccountServiceError) return error;
  return new AccountServiceError('internal_error', 500);
}

/**
 * Account-service integration boundary.
 * Dependencies are owned by the application root; close() cancels/awaits only jobs started here.
 * The pool's runExclusive(accountId, fn), store's CAS methods, and JobManager.start(type,id,fn)
 * are used as injected by the core/panel modules.
 */
export function createAccountService({ store, pool, sessionManager, bootstrapper, jobs, telemetry = null, eventBus = null } = {}) {
  if (!store || typeof store.listPublic !== 'function' || typeof store.getPrivate !== 'function'
    || typeof store.importBatch !== 'function' || typeof store.replaceSession !== 'function' || typeof store.updateAccount !== 'function') {
    throw new TypeError('store account methods are required');
  }
  if (!pool || typeof pool.status !== 'function' || typeof pool.runExclusive !== 'function'
    || typeof pool.clearQuarantine !== 'function') throw new TypeError('pool status/runExclusive/clearQuarantine are required');
  if (!sessionManager || typeof sessionManager.refresh !== 'function') throw new TypeError('sessionManager.refresh is required');
  if (!bootstrapper || typeof bootstrapper.login !== 'function') throw new TypeError('bootstrapper.login is required');
  if (!jobs || typeof jobs.start !== 'function' || typeof jobs.get !== 'function' || typeof jobs.cancel !== 'function') {
    throw new TypeError('jobs start/get/cancel are required');
  }

  const ownedJobs = new Map();
  const ownedTasks = new Set();
  let closed = false;

  function publish(type, data) {
    try { eventBus?.publish?.(type, data); } catch { /* Public events never affect account operations. */ }
  }

  function hasActiveJob(accountId) {
    for (const jobId of ownedJobs.get(accountId) || []) {
      const job = jobs.get(jobId);
      if (job && !terminal(job)) return true;
    }
    return false;
  }

  function accountBusy(accountId) {
    try {
      const state = pool.accountState?.(accountId);
      if (typeof state?.busy === 'boolean') return state.busy;
    } catch { /* An unavailable optional detail remains unknown. */ }
    return hasActiveJob(accountId) ? true : null;
  }

  function poolAccountState(accountId) {
    try { return pool.accountState?.(accountId) ?? null; } catch { return null; }
  }

  function isQuarantined(accountId) {
    if (poolAccountState(accountId)?.quarantined === true) return true;
    return store.listPublic().some(record => record.id === accountId && record.quarantined === true);
  }

  function poolQuarantineReason(accountId) {
    const reason = poolAccountState(accountId)?.quarantineReason;
    return typeof reason === 'string' && SAFE_CODE.test(reason) ? reason : null;
  }

  async function updateAccountRetry(id, patch) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = privateAccount(store, id);
      try { return await store.updateAccount(id, current.revision, patch); }
      catch (error) {
        if (error?.code !== 'revision_conflict' || attempt === 2) throw new AccountServiceError('internal_error', 500);
      }
    }
    throw new AccountServiceError('internal_error', 500);
  }

  async function updateVerifiedAccount(id) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = privateAccount(store, id);
      const quarantined = isQuarantined(id);
      const expectedSessionRevision = current.session?.sessionRevision ?? 0;
      try {
        return await store.updateAccount(id, current.revision, {
          status: 'active',
          reasonCode: quarantined ? current.reasonCode : null,
          cooldownUntil: null,
        }, { expectedSessionRevision });
      } catch (error) {
        if (error?.code === 'revision_conflict' && attempt < 2) continue;
        if (error?.code === 'session_conflict') throw new AccountServiceError('account_busy', 409);
        throw new AccountServiceError('internal_error', 500);
      }
    }
    throw new AccountServiceError('internal_error', 500);
  }

  async function clearQuarantineAfterVerification(id, signal) {
    if (!isQuarantined(id)) return;
    const before = privateAccount(store, id);
    await pool.clearQuarantine(id, { verified: true, signal });
    if (!before.reasonCode) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = privateAccount(store, id);
      if (current.status !== 'active' || current.reasonCode !== before.reasonCode || isQuarantined(id)) return;
      try {
        await store.updateAccount(id, current.revision, { reasonCode: null }, {
          expectedSessionRevision: current.session?.sessionRevision ?? 0,
        });
        return;
      } catch (error) {
        if (error?.code === 'revision_conflict' && attempt < 2) continue;
        if (error?.code === 'session_conflict') return;
        throw new AccountServiceError('internal_error', 500);
      }
    }
  }

  function trackJob(accountId, job) {
    const ids = ownedJobs.get(accountId) || new Set();
    ids.add(job.id);
    ownedJobs.set(accountId, ids);
    publish('job.updated', publicJob(job));
    return publicJob(job);
  }

  function startAccountJob(type, id, operation) {
    if (closed) throw new AccountServiceError('job_capacity', 503);
    const accountId = assertId(id);
    let startedJob;
    const job = jobs.start(type, accountId, async context => {
      const initialAccount = privateAccount(store, accountId);
      const task = Promise.resolve().then(() => operation(context));
      ownedTasks.add(task);
      try { await task; }
      catch (error) {
        // A failed interactive login says nothing about a separately stored working
        // session. Only retain an explicit auth verdict for an account that began
        // without a usable session, and only if neither its record nor session changed.
        if (type === 'relogin' && !hasUsableStoredSession(initialAccount)
          && RELOGIN_AUTH_VERDICTS.has(error?.code)
          && !context?.signal?.aborted) {
          try {
            const current = privateAccount(store, accountId);
            const initialSessionRevision = initialAccount.session?.sessionRevision ?? 0;
            const currentSessionRevision = current.session?.sessionRevision ?? 0;
            if (current.revision === initialAccount.revision && currentSessionRevision === initialSessionRevision
              && !hasUsableStoredSession(current) && current.status !== 'banned') {
              await store.updateAccount(accountId, initialAccount.revision, {
                status: 'needs_relogin', reasonCode: accountStatusReason(error), cooldownUntil: null,
              }, { expectedSessionRevision: initialSessionRevision });
            }
          } catch { /* Preserve the original sanitized job failure. */ }
        }
        throw Object.assign(new Error(jobError(error)), { code: jobError(error) });
      } finally {
        ownedTasks.delete(task);
        publish('job.updated', publicJob(jobs.get(startedJob?.id)));
      }
    });
    startedJob = job;
    return trackJob(accountId, job);
  }

  async function runRelogin(id, context) {
    const account = privateAccount(store, id);
    if (account.status === 'banned') throw new AccountServiceError('account_busy', 409);
    const signal = context?.signal;
    const setProgress = context?.setProgress;
    const setPhase = context?.setPhase;
    const execute = async () => {
      if (signal?.aborted) throw new AccountServiceError('cancelled', 499);
      const current = privateAccount(store, id);
      if (current.status === 'banned') throw new AccountServiceError('account_busy', 409);
      const bundle = await bootstrapper.login({
        id: current.id,
        email: current.emailNormalized,
        provider: current.provider,
        mailAccessUrl: current.mail.mailAccessUrl,
        deviceId: current.session?.device?.id,
      }, { signal, setProgress, setPhase });
      if (signal?.aborted) throw new AccountServiceError('cancelled', 499);
      const session = normalizeSession(bundle);
      const expectedSessionRevision = current.session?.sessionRevision ?? 0;
      try { await store.replaceSession(id, expectedSessionRevision, session); }
      catch (error) {
        if (error?.code === 'session_conflict') throw new AccountServiceError('account_busy', 409);
        throw new AccountServiceError('internal_error', 500);
      }
      await updateVerifiedAccount(id);
      return privateAccount(store, id);
    };
    const result = await pool.runExclusive(id, execute, { signal });
    // clearQuarantine takes its own pool gate. A persisted quarantine keeps the account
    // ineligible between verification and this explicit clear; never nest the gate.
    await clearQuarantineAfterVerification(id, signal);
    return result;
  }

  async function runHealthCheck(id, context) {
    const account = privateAccount(store, id);
    if (account.status === 'banned') throw new AccountServiceError('account_busy', 409);
    const checked = await pool.runExclusive(id, async () => {
      if (context?.signal?.aborted) throw new AccountServiceError('cancelled', 499);
      // Official HTTP refresh/probe is performed by SessionManager; this path never launches a browser.
      let result;
      try {
        result = await sessionManager.refresh(id, { signal: context?.signal });
      } catch (error) {
        if (context?.signal?.aborted || error?.code === 'aborted' || error?.code === 'cancelled') {
          // SessionManager owns refresh flights; drain while this account's pool gate
          // is still held so a cancelled request cannot outlive the exclusive lease.
          try { await sessionManager.drain?.(id); } catch { /* Preserve the original safe failure. */ }
        }
        throw error;
      }
      if (!result || typeof result.sessionRevision !== 'number') throw new AccountServiceError('internal_error', 500);
      await updateVerifiedAccount(id);
      return result;
    }, { signal: context?.signal });
    await clearQuarantineAfterVerification(id, context?.signal);
    return checked;
  }

  function accountIds(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.accounts !== 'string'
      || Buffer.byteLength(body.accounts, 'utf8') > MAX_IMPORT_BYTES) throw new AccountServiceError('invalid_input', 400);
    const parsed = parseImport(body.accounts);
    if (parsed.length > MAX_IMPORT_ACCOUNTS) throw new AccountServiceError('invalid_input', 400);
    return parsed.map(({ email, emailNormalized, provider, mailAccessUrl }) => ({ email, emailNormalized, provider, mailAccessUrl }));
  }

  function usageByAccount() {
    if (!telemetry || typeof telemetry.listRequests !== 'function') return new Map();
    const rows = [];
    let cursor = null;
    for (let pages = 0; pages < 100; pages += 1) {
      let page;
      try { page = telemetry.listRequests({ limit: 100, cursor }); } catch { break; }
      if (!page || !Array.isArray(page.records)) break;
      rows.push(...page.records);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const aggregate = new Map();
    for (const row of rows) {
      if (typeof row.accountId !== 'string') continue;
      const value = aggregate.get(row.accountId) || { inputTokens: 0, outputTokens: 0, requests: new Set(), known: new Set(), quota: null };
      if (typeof row.requestId === 'string') value.requests.add(row.requestId);
      if (row.kind === 'attempt' && Number.isSafeInteger(row.estimatedInputTokens)) {
        value.inputTokens += row.estimatedInputTokens;
        if (row.requestId) value.known.add(row.requestId);
      }
      if (row.kind === 'result' && Number.isSafeInteger(row.estimatedOutputTokens)) {
        value.outputTokens += row.estimatedOutputTokens;
        if (row.requestId) value.known.add(row.requestId);
      }
      if (Number.isFinite(row.upstreamRemaining) && Number.isFinite(row.at)
        && (!value.quota || row.at > value.quota.observedAt)) {
        value.quota = { unit: 'tokens', remaining: row.upstreamRemaining, observedAt: row.at };
      }
      aggregate.set(row.accountId, value);
    }
    return new Map([...aggregate].map(([id, value]) => [id, {
      estimatedUsage: {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        totalTokens: value.inputTokens + value.outputTokens,
        requests: value.requests.size,
        unknownRequests: [...value.requests].filter(requestId => !value.known.has(requestId)).length,
        estimated: true,
      },
      upstreamQuota: value.quota,
    }]));
  }

  return {
    listAccounts() {
      const usage = usageByAccount();
      return store.listPublic().map(record => {
        const state = poolAccountState(record.id);
        const quarantined = record.quarantined === true || state?.quarantined === true;
        return publicAccount(record, {
          busy: accountBusy(record.id),
          estimatedUsage: usage.get(record.id)?.estimatedUsage ?? null,
          upstreamQuota: usage.get(record.id)?.upstreamQuota ?? null,
          quarantined,
          quarantineReason: typeof state?.quarantineReason === 'string' && SAFE_CODE.test(state.quarantineReason)
            ? state.quarantineReason : null,
        });
      });
    },

    async importAccounts(body) {
      if (closed) throw new AccountServiceError('job_capacity', 503);
      let entries;
      try { entries = accountIds(body); }
      catch (error) { if (error instanceof AccountServiceError) throw error; throw new AccountServiceError('invalid_input', 400); }
      const committed = await store.importBatch(entries);
      const newAccounts = committed.imported || [];
      for (const account of newAccounts) {
        try { await updateAccountRetry(account.id, { status: 'needs_relogin', reasonCode: 'session_missing' }); }
        catch { /* Import remains durable; relogin availability is reported independently. */ }
      }
      const started = [];
      for (const account of newAccounts) {
        try { started.push(startAccountJob('relogin', account.id, context => runRelogin(account.id, context))); }
        catch (error) {
          if (error?.code !== 'job_queue_full' && error?.code !== 'job_capacity') throw error;
          try { await updateAccountRetry(account.id, { status: 'needs_relogin', reasonCode: 'job_queue_full' }); } catch { /* Durable account remains available for a later relogin action. */ }
        }
      }
      const accounts = this.listAccounts();
      return {
        imported: newAccounts.length,
        duplicates: committed.skipped,
        accounts,
        jobs: started,
        job: started[0] ?? null,
      };
    },

    relogin(id) {
      assertId(id);
      privateAccount(store, id);
      return startAccountJob('relogin', id, context => runRelogin(id, context));
    },

    healthCheck(id) {
      assertId(id);
      privateAccount(store, id);
      return startAccountJob('health_check', id, context => runHealthCheck(id, context));
    },

    getJob(id) {
      try { return publicJob(jobs.get(id)); } catch { return null; }
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const ids of ownedJobs.values()) {
        for (const id of ids) {
          const current = jobs.get(id);
          if (current && !terminal(current)) {
            try { jobs.cancel(id); } catch { /* Continue closing this service's jobs. */ }
          }
        }
      }
      await Promise.allSettled([...ownedTasks]);
      for (const ids of ownedJobs.values()) for (const id of ids) publish('job.updated', publicJob(jobs.get(id)));
      ownedJobs.clear();
    },
  };
}
