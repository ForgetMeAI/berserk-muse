import { parseTokenBalanceLabel } from '../muse/usage.mjs';
import { ACCOUNT_ID, assertAccountId } from './store.mjs';

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const SAFE_LABEL = /^[A-Za-z0-9_. -]{1,80}$/;
const ERROR_CODES = new Set([
  'usage_auth_required', 'usage_forbidden', 'usage_unavailable', 'usage_response_invalid',
  'session_changed', 'cancelled', 'account_busy',
]);

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function finiteNonnegative(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function safeLabel(value) { return typeof value === 'string' && value.length <= 80 && SAFE_LABEL.test(value) ? value : null; }
function safeCode(value) { return typeof value === 'string' && SAFE_CODE.test(value) ? value : null; }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function hasOwn(record, key) { return Object.hasOwn(record, key); }

function projectUsage(value) {
  if (!isRecord(value) || value.source !== 'muse_subscription' || count(value.observedAt) === null
    || count(value.sessionRevision) === null || value.sessionRevision < 1
    || !isRecord(value.tier) || !isRecord(value.weekly) || !isRecord(value.additional)) return null;

  const tier = value.tier;
  if (!(tier.code === null || safeLabel(tier.code) !== null)
    || !(tier.name === null || safeLabel(tier.name) !== null)
    || !(tier.isPaid === null || typeof tier.isPaid === 'boolean')) return null;

  const weekly = value.weekly;
  const weeklyState = weekly.state === null || (typeof weekly.state === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(weekly.state))
    ? weekly.state : undefined;
  const weeklyPercent = weekly.percentUsed === null ? null : finiteNonnegative(weekly.percentUsed);
  const resetsAt = weekly.resetsAt === null ? null : count(weekly.resetsAt);
  const quotaStatus = weekly.quotaStatus === null ? null
    : typeof weekly.quotaStatus === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(weekly.quotaStatus) ? weekly.quotaStatus : null;
  if (weeklyState === undefined || weeklyPercent === null && weekly.percentUsed !== null
    || resetsAt === null && weekly.resetsAt !== null || quotaStatus === null && weekly.quotaStatus !== null) return null;

  const additional = value.additional;
  const additionalNumbers = {};
  for (const key of ['remaining', 'limit', 'used', 'percentUsed']) {
    const raw = additional[key];
    const parsed = raw === null ? null : finiteNonnegative(raw);
    if (parsed === null && raw !== null) return null;
    additionalNumbers[key] = parsed;
  }
  const hasCanonicalTopup = hasOwn(additional, 'approximate') || hasOwn(additional, 'displayLabel')
    || isRecord(additional.raw) && ['remaining', 'limit', 'unit'].some(key => hasOwn(additional.raw, key));
  if (hasCanonicalTopup) {
    const parsedLabel = additional.displayLabel == null ? null
      : typeof additional.displayLabel === 'string' ? parseTokenBalanceLabel(additional.displayLabel) : undefined;
    const raw = additional.raw;
    if (parsedLabel === undefined || (additional.displayLabel !== null && parsedLabel === null)
      || !isRecord(raw) || finiteNonnegative(raw.remaining) === null || finiteNonnegative(raw.limit) === null
      || raw.remaining > raw.limit || raw.unit !== 'muse_quota_units') return null;
    // In canonical Muse samples, only the provider's validated display label
    // carries token units. The numeric balance fields are opaque quota units.
    additionalNumbers.remaining = parsedLabel?.remaining ?? null;
    additionalNumbers.limit = null;
    additionalNumbers.used = null;
    additionalNumbers.percentUsed = raw.limit > 0 ? ((raw.limit - raw.remaining) / raw.limit) * 100 : null;
    additionalNumbers.approximate = parsedLabel?.approximate ?? false;
    additionalNumbers.displayLabel = parsedLabel?.displayLabel ?? null;
    additionalNumbers.raw = {
      remaining: raw.remaining,
      limit: raw.limit,
      unit: 'muse_quota_units',
    };
  }

  return {
    source: 'muse_subscription',
    observedAt: value.observedAt,
    sessionRevision: value.sessionRevision,
    tier: { code: tier.code, name: tier.name, isPaid: tier.isPaid },
    weekly: { state: weeklyState, percentUsed: weeklyPercent, resetsAt, quotaStatus },
    additional: additionalNumbers,
  };
}

function safeFailure(error) {
  const code = safeCode(error?.code);
  if (ERROR_CODES.has(code)) return code;
  if (['authentication_expired', 'needs_relogin', 'expired', 'session_unavailable'].includes(code)) return 'usage_auth_required';
  if (code === 'upstream_forbidden') return 'usage_forbidden';
  if (code === 'aborted' || code === 'request_cancelled' || code === 'usage_cancelled') return 'cancelled';
  if (code === 'usage_session_changed') return 'session_changed';
  if (code === 'account_busy') return 'account_busy';
  return 'usage_unavailable';
}

function safeNow(clock) {
  let value;
  try { value = clock(); } catch { value = Date.now(); }
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function counts(queued, skipped, pending) { return { queued, skipped, pending }; }

/**
 * Coalesced, bounded, read-only refresh orchestration for provider usage.
 * It never changes account state and only publishes an account-neutral refresh event.
 */
export class AccountUsageService {
  #store;
  #pool;
  #protocol;
  #eventBus;
  #clock;
  #refreshMs;
  #tickMs;
  #minRefreshMs;
  #maxActive;
  #maxQueued;
  #states = new Map();
  #queue = [];
  #queued = new Set();
  #active = new Map();
  #timer = null;
  #started = false;
  #closed = false;

  constructor({ store, pool, protocol, eventBus = null, clock = Date.now, refreshMs = 300_000,
    tickMs = 60_000, minRefreshMs = 15_000, maxActive = 2, maxQueued = 200 } = {}) {
    if (!store || typeof store.listPublic !== 'function' || typeof store.getPublic !== 'function'
      || typeof store.getPrivate !== 'function') throw new TypeError('store listPublic/getPublic/getPrivate are required');
    if (!pool || typeof pool.runExclusive !== 'function') throw new TypeError('pool.runExclusive is required');
    if (!protocol || (typeof protocol !== 'object' && typeof protocol !== 'function')) throw new TypeError('protocol is required');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    for (const [name, value] of Object.entries({ refreshMs, tickMs, minRefreshMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
    }
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 64
      || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 10_000) throw new TypeError('Invalid usage queue limits');
    this.#store = store;
    this.#pool = pool;
    this.#protocol = protocol;
    this.#eventBus = eventBus;
    this.#clock = clock;
    this.#refreshMs = refreshMs;
    this.#tickMs = tickMs;
    this.#minRefreshMs = minRefreshMs;
    this.#maxActive = maxActive;
    this.#maxQueued = maxQueued;
  }

  start() {
    if (this.#closed) return this;
    if (this.#started) return this;
    this.#started = true;
    this.requestAll();
    this.#timer = setInterval(() => {
      try { this.requestAll(); } catch { /* A later tick retries transient store failures. */ }
    }, this.#tickMs);
    this.#timer.unref?.();
    return this;
  }

  request(accountId, { force = false } = {}) {
    assertAccountId(accountId);
    if (typeof force !== 'boolean') throw new TypeError('force must be a boolean');
    if (this.#closed) return counts(0, 1, 0);
    const pub = this.#store.getPublic(accountId);
    const state = this.#stateFor(accountId, pub.sessionRevision);
    if (!this.#eligible(pub) || this.#queued.has(accountId) || this.#active.has(accountId)
      || this.#poolBusy(accountId) || !this.#due(state, force)) return counts(0, 1, this.pending);
    if (this.#queue.length >= this.#maxQueued && this.#active.size >= this.#maxActive) return counts(0, 1, this.pending);
    this.#enqueue(accountId, pub.sessionRevision);
    return counts(1, 0, this.pending);
  }

  requestAll({ force = false } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('force must be a boolean');
    if (this.#closed) return counts(0, 0, 0);
    const accounts = this.#store.listPublic();
    const candidates = accounts.filter(account => this.#eligible(account)).map((account, index) => ({ account, index }));
    candidates.sort((left, right) => {
      const leftAttempt = this.#states.get(left.account.id)?.attemptedAt ?? -1;
      const rightAttempt = this.#states.get(right.account.id)?.attemptedAt ?? -1;
      return leftAttempt - rightAttempt || left.index - right.index || left.account.id.localeCompare(right.account.id);
    });
    let queued = 0, skipped = accounts.length - candidates.length;
    for (const { account } of candidates) {
      const result = this.request(account.id, { force });
      queued += result.queued;
      skipped += result.skipped;
    }
    return counts(queued, skipped, this.pending);
  }

  getPublic(accountId) {
    assertAccountId(accountId);
    const pub = this.#store.getPublic(accountId);
    const state = this.#stateFor(accountId, pub.sessionRevision);
    const sample = state.sample ? {
      source: state.sample.source, observedAt: state.sample.observedAt,
      tier: { ...state.sample.tier }, weekly: { ...state.sample.weekly }, additional: { ...state.sample.additional },
    } : null;
    const age = sample ? Math.max(0, safeNow(this.#clock) - sample.observedAt) : Infinity;
    const unavailable = pub.status === 'banned' || pub.hasSession !== true;
    const status = sample && unavailable ? 'stale' : state.pending ? 'refreshing'
      : sample && !state.errorCode && age < this.#refreshMs ? 'ready'
      : sample ? 'stale' : state.errorCode ? 'error' : 'unknown';
    return {
      state: status,
      pending: state.pending,
      observedAt: sample?.observedAt ?? null,
      attemptedAt: state.attemptedAt,
      errorCode: state.errorCode,
      sample,
    };
  }

  get pending() { return this.#queue.length + this.#active.size; }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = null;
    for (const id of this.#queue.splice(0)) {
      this.#queued.delete(id);
      const state = this.#states.get(id);
      if (state) {
        state.pending = false;
        state.state = state.sample ? 'stale' : 'unknown';
      }
    }
    for (const task of this.#active.values()) task.controller.abort();
    await Promise.allSettled([...this.#active.values()].map(task => task.promise));
  }

  #stateFor(accountId, revision) {
    let state = this.#states.get(accountId);
    if (!state) {
      state = { bindingRevision: revision, sample: null, sampleRevision: null, state: 'unknown', pending: false,
        attemptedAt: null, attemptedRevision: null, errorCode: null };
      this.#states.set(accountId, state);
    } else if (state.bindingRevision !== revision) {
      state.bindingRevision = revision;
      state.sample = null;
      state.sampleRevision = null;
      state.attemptedAt = null;
      state.attemptedRevision = null;
      state.errorCode = null;
      state.state = state.pending ? 'refreshing' : 'unknown';
    }
    return state;
  }

  #eligible(pub) { return isRecord(pub) && ACCOUNT_ID.test(pub.id) && pub.status !== 'banned' && pub.hasSession === true && count(pub.sessionRevision) > 0; }

  #poolBusy(accountId) {
    try { return this.#pool.accountState?.(accountId)?.busy === true; } catch { return false; }
  }

  #due(state, force) {
    const now = safeNow(this.#clock);
    if (state.attemptedAt !== null && now - state.attemptedAt < this.#minRefreshMs) return false;
    if (force) return true;
    return !state.sample || Math.max(0, now - state.sample.observedAt) >= this.#refreshMs;
  }

  #enqueue(accountId, revision) {
    const state = this.#stateFor(accountId, revision);
    state.pending = true;
    state.state = 'refreshing';
    state.errorCode = null;
    this.#queue.push({ accountId, revision, order: this.#queue.length });
    this.#queued.add(accountId);
    this.#publish();
    this.#pump();
  }

  #pump() {
    while (!this.#closed && this.#active.size < this.#maxActive && this.#queue.length) {
      const task = this.#queue.shift();
      this.#queued.delete(task.accountId);
      const controller = new AbortController();
      const active = { controller, promise: null };
      this.#active.set(task.accountId, active);
      active.promise = this.#run(task, controller.signal).catch(() => {}).finally(() => {
        this.#active.delete(task.accountId);
        this.#pump();
      });
    }
  }

  async #run(task, signal) {
    const state = this.#states.get(task.accountId);
    const attemptedAt = safeNow(this.#clock);
    if (state) { state.attemptedAt = attemptedAt; state.attemptedRevision = task.revision; state.errorCode = null; }
    try {
      const result = await this.#pool.runExclusive(task.accountId, async innerSignal => {
        if (signal.aborted || innerSignal?.aborted) throw Object.assign(new Error(), { code: 'cancelled' });
        const account = this.#store.getPrivate(task.accountId);
        if (account.status === 'banned' || !account.session) throw Object.assign(new Error(), { code: 'account_busy' });
        if (typeof this.#protocol.readUsage !== 'function') throw Object.assign(new Error(), { code: 'usage_unavailable' });
        return this.#protocol.readUsage(account, account.session, { signal: innerSignal ?? signal });
      }, { signal });
      const sample = projectUsage(result);
      if (!sample) throw Object.assign(new Error(), { code: 'usage_response_invalid' });
      const current = this.#store.getPublic(task.accountId);
      if (current.sessionRevision !== sample.sessionRevision || current.hasSession !== true || current.status === 'banned') {
        this.#invalidateForRevision(task.accountId, state, current.sessionRevision, 'session_changed');
        return;
      }
      if (!state) return;
      state.bindingRevision = current.sessionRevision;
      state.sample = sample;
      state.sampleRevision = sample.sessionRevision;
      state.state = 'ready';
      state.errorCode = null;
    } catch (error) {
      if (!state) return;
      const current = this.#safePublic(task.accountId);
      if (current && current.sessionRevision !== state.bindingRevision) {
        this.#invalidateForRevision(task.accountId, state, current.sessionRevision, 'session_changed');
      } else {
        state.errorCode = safeFailure(error);
        state.state = state.sample ? 'stale' : 'error';
      }
    } finally {
      if (state) state.pending = false;
      this.#publish();
    }
  }

  #safePublic(accountId) { try { return this.#store.getPublic(accountId); } catch { return null; } }

  #invalidateForRevision(accountId, state, revision, code) {
    if (!state) return;
    state.bindingRevision = revision;
    state.sample = null;
    state.sampleRevision = null;
    state.attemptedAt = null;
    state.attemptedRevision = revision;
    state.errorCode = ERROR_CODES.has(code) ? code : 'session_changed';
    state.state = 'error';
  }

  #publish() {
    try { this.#eventBus?.publish?.('accounts', {}); } catch { /* Notifications never affect refreshes. */ }
  }
}
