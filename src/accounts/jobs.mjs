import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
export const JOB_PHASES = Object.freeze(['opening_browser', 'requesting_code', 'reading_mail', 'waiting_for_user', 'saving_session']);
const ERROR_CODES = new Set([
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
const SAFE_LABEL = /^[a-zA-Z0-9_.:-]{1,80}$/;

export class JobManagerError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODES.has(code) ? code : 'internal_error';
    super(safeCode);
    this.name = 'JobManagerError';
    this.code = safeCode;
  }
}

function timestamp(clock) {
  let value;
  try { value = clock(); } catch { value = Date.now(); }
  if (!Number.isFinite(value)) value = Date.now();
  try { return new Date(value).toISOString(); } catch { return new Date().toISOString(); }
}

function safeErrorCode(error) {
  return error && typeof error === 'object' && ERROR_CODES.has(error.code) ? error.code : 'internal_error';
}

export class JobManager {
  constructor({ maxJobs = 200, maxActive = 2, maxQueued = 100, clock = Date.now, onUpdate = null } = {}) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) throw new TypeError('Invalid maxJobs');
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 64 || maxActive > maxJobs) throw new TypeError('Invalid maxActive');
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > maxJobs) throw new TypeError('Invalid maxQueued');
    if (typeof clock !== 'function') throw new TypeError('Invalid clock');
    if (onUpdate !== null && typeof onUpdate !== 'function') throw new TypeError('Invalid onUpdate');
    this.maxJobs = maxJobs;
    this.maxActive = maxActive;
    this.maxQueued = maxQueued;
    this.clock = clock;
    this.onUpdate = onUpdate;
    this.jobs = new Map();
    this.queue = [];
    this.active = new Set();
    this.activeAccounts = new Set();
    this.closing = false;
    this.closePromise = null;
  }

  start(type, accountId, fn) {
    if (this.closing) throw new JobManagerError('job_capacity');
    if (typeof type !== 'string' || !SAFE_LABEL.test(type)) throw new TypeError('Invalid job type');
    if (accountId !== null && accountId !== undefined && (typeof accountId !== 'string' || !SAFE_LABEL.test(accountId))) throw new TypeError('Invalid account ID');
    if (typeof fn !== 'function') throw new TypeError('Invalid job function');
    const normalizedAccountId = accountId ?? null;

    const duplicate = [...this.jobs.values()].find(job => job.type === type && job.accountId === normalizedAccountId && !job.settled);
    if (duplicate) return this.publicJob(duplicate);
    if (this.queue.length >= this.maxQueued) throw new JobManagerError('job_queue_full');
    this.makeRoom();

    const createdAt = timestamp(this.clock);
    const job = {
      id: randomUUID(), type, accountId: normalizedAccountId, status: 'queued', createdAt, updatedAt: createdAt,
      progress: 0, errorCode: null, fn, controller: null, promise: null, settled: false,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.notify(job);
    const initial = this.publicJob(job);
    queueMicrotask(() => this.schedule());
    return initial;
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => this.publicJob(job));
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.settled) return null;
    if (job.status === 'queued') {
      this.queue = this.queue.filter(queued => queued !== job);
      job.settled = true;
      this.transition(job, 'cancelled', 'cancelled');
      this.schedule();
      return this.publicJob(job);
    }
    if (job.status === 'running') {
      this.transition(job, 'cancelled', 'cancelled');
      job.controller?.abort();
    }
    return this.publicJob(job);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const job of [...this.queue]) this.cancel(job.id);
    for (const job of this.active) this.cancel(job.id);
    const pending = [...this.active].map(job => job.promise).filter(Boolean);
    this.closePromise = Promise.allSettled(pending).then(() => undefined);
    return this.closePromise;
  }

  makeRoom() {
    while (this.jobs.size >= this.maxJobs) {
      const expired = [...this.jobs.values()].find(job => job.settled && TERMINAL.has(job.status));
      if (!expired) throw new JobManagerError('job_capacity');
      this.jobs.delete(expired.id);
    }
  }

  schedule() {
    if (this.closing) return;
    while (this.active.size < this.maxActive) {
      const index = this.queue.findIndex(job => job.accountId === null || !this.activeAccounts.has(job.accountId));
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (job.settled || job.status !== 'queued') continue;
      job.controller = new AbortController();
      this.active.add(job);
      if (job.accountId !== null) this.activeAccounts.add(job.accountId);
      this.transition(job, 'running');
      job.promise = this.execute(job);
    }
  }

  async execute(job) {
    const context = {
      signal: job.controller.signal,
      setProgress: value => {
        if (job.status !== 'running' || !Number.isFinite(value)) return false;
        const progress = Math.max(0, Math.min(100, value));
        if (progress === job.progress) return true;
        job.progress = progress;
        this.touch(job);
        return true;
      },
      setPhase: value => {
        if (job.status !== 'running' || !JOB_PHASES.includes(value)) return false;
        if (job.phase === value) return true;
        job.phase = value;
        this.touch(job);
        return true;
      },
    };
    try {
      await job.fn(context);
      if (job.status === 'running') this.transition(job, 'succeeded');
    } catch (error) {
      if (job.status === 'running') {
        const code = safeErrorCode(error);
        this.transition(job, 'failed', code);
      }
    } finally {
      job.settled = true;
      this.active.delete(job);
      if (job.accountId !== null) this.activeAccounts.delete(job.accountId);
      job.controller = null;
      this.schedule();
    }
  }

  transition(job, status, errorCode = null) {
    job.status = status;
    job.errorCode = errorCode;
    if (TERMINAL.has(status)) delete job.phase;
    if (status === 'succeeded') job.progress = 100;
    this.touch(job);
  }

  touch(job) {
    job.updatedAt = timestamp(this.clock);
    this.notify(job);
  }

  notify(job) {
    if (!this.onUpdate) return;
    try { this.onUpdate(this.publicJob(job)); } catch { /* Notifications never affect job execution. */ }
  }

  publicJob(job) {
    return Object.freeze({
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress: job.progress,
      ...(JOB_PHASES.includes(job.phase) ? { phase: job.phase } : {}),
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    });
  }
}
