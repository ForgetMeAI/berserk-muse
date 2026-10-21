import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BridgeError, abortError, checkAbort } from '../errors.mjs';
import { ACCOUNT_ID, assertAccountId } from './store.mjs';

const WINDOW_MS = 5 * 60_000;
export const DELIVERY = Object.freeze(['not_sent', 'rejected_before_acceptance', 'accepted', 'unknown']);
export const FAILURE_SCOPE = Object.freeze(['account', 'service', 'request']);
export const FAILURE_ACCOUNT_STATUS = Object.freeze(['needs_relogin', 'expired', 'banned']);
const RETRYABLE_DELIVERY = new Set(['not_sent', 'rejected_before_acceptance']);
const CODE = /^[a-z0-9_]{1,64}$/;

const shuttingDown = () => new BridgeError('The account pool is shutting down.', 503, 'shutting_down');

// Only a delivery of 'not_sent' or 'rejected_before_acceptance' may ever be retried, because
// anything accepted/unknown risks a duplicate upstream generation.
export function isRetryableDelivery(delivery) {
  return RETRYABLE_DELIVERY.has(delivery);
}

// Branded, validated, frozen transport failure. Retry eligibility and account effects are read
// only from these fields, never inferred from a status code or model text (upstreamStatus is
// informational). The message is fixed and carries no upstream body.
export class TransportFailure extends BridgeError {
  #brand = true;

  constructor({ code, scope, delivery, recoverable, refreshable, quarantine = false, accountStatus = null, upstreamStatus = null } = {}) {
    if (typeof code !== 'string' || !CODE.test(code)) throw new TypeError('TransportFailure code must match /^[a-z0-9_]{1,64}$/');
    if (!FAILURE_SCOPE.includes(scope)) throw new TypeError('TransportFailure scope is invalid');
    if (!DELIVERY.includes(delivery)) throw new TypeError('TransportFailure delivery is invalid');
    for (const flag of [recoverable, refreshable]) {
      if (flag !== undefined && typeof flag !== 'boolean') throw new TypeError('TransportFailure recoverable/refreshable must be boolean');
    }
    if (recoverable !== undefined && refreshable !== undefined && recoverable !== refreshable) {
      throw new TypeError('TransportFailure recoverable and refreshable disagree');
    }
    if (typeof quarantine !== 'boolean') throw new TypeError('TransportFailure quarantine must be boolean');
    if (accountStatus !== null && !FAILURE_ACCOUNT_STATUS.includes(accountStatus)) throw new TypeError('TransportFailure accountStatus is invalid');
    if (accountStatus !== null && scope !== 'account') throw new TypeError('TransportFailure accountStatus requires account scope');
    if (quarantine && scope === 'service') throw new TypeError('A service-scoped TransportFailure cannot quarantine an account');
    if (upstreamStatus !== null && !(Number.isSafeInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599)) {
      throw new TypeError('TransportFailure upstreamStatus is invalid');
    }
    super('The Muse transport failed to complete the request.', scope === 'service' ? 503 : 502, 'transport_failed');
    this.name = 'TransportFailure';
    this.transportCode = code;
    this.scope = scope;
    this.delivery = delivery;
    this.recoverable = (recoverable ?? refreshable) === true;
    this.refreshable = this.recoverable;
    this.quarantine = quarantine;
    this.accountStatus = accountStatus;
    this.upstreamStatus = upstreamStatus;
    Object.freeze(this);
  }

  static is(value) {
    return value !== null && typeof value === 'object' && #brand in value;
  }
}

export function transportFailure(fields) {
  return new TransportFailure(fields);
}

const usableView = pub => pub.enabled && pub.status === 'active' && pub.hasSession && !pub.quarantined;
const usableAccount = account => account.enabled && account.status === 'active' && account.quarantinedAt === null && !!account.session;

// AccountPool({ store, transportFactory, clock, sessionManager?, accountCooldownMs?, serviceCooldownMs?, transientCooldownMs? })
//
// One gate per account, owned by exactly one of: an acquisition in progress, a lease (through its
// recover and release cleanup), or an exclusive job. Leases are only granted when the gate is free
// and no exclusive job is queued; exclusive jobs start only after the current owner fully settles.
//
//   acquire({ requestId, excludeIds, signal, estimatedInputTokens }) -> lease | null
//   release(lease, outcome)        -> true once; closes the transport, persists effects, then frees the gate
//   noteFailure(lease, failure, { allowRefresh }) -> { retryable, retrySameAccount, retryOtherAccount, scope, delivery }
//   recover(lease, { signal })     -> fresh lease on the SAME account (old transport closed, then refresh, then new transport)
//   runExclusive(accountId, fn, { signal }) / refreshAccount(accountId, { signal })
//   waitForAvailability(signal, { excludeIds, sinceVersion }) / availability({ excludeIds }) / version
//   accountState(accountId) -> { busy, quarantined, quarantineReason } ; status() ; quarantine() ; clearQuarantine(id, { verified: true })
//   close() -> waits for in-flight work, retires owned leases, never returns a lease afterwards
// Lease shape: { id, accountId, sessionRevision, transport }; transport = transportFactory(privateAccount, session).
export class AccountPool {
  #store;
  #transportFactory;
  #clock;
  #sessionManager;
  #accountCooldownMs;
  #serviceCooldownMs;
  #transientCooldownMs;
  #gates = new Map();
  #leases = new Map();
  #transient = new Map();
  #localQuarantine = new Set();
  #rolling = new Map();
  #lastAssignedAt = new Map();
  #ops = new Set();
  #serviceBlockedUntil = 0;
  #events = new EventEmitter();
  #version = 0;
  #closed = false;
  #closing = null;
  #onChange;

  constructor({ store, transportFactory, clock = { now: () => Date.now() }, sessionManager = null,
    accountCooldownMs = 30_000, serviceCooldownMs = 15_000, transientCooldownMs = 5_000 } = {}) {
    if (!store || ['listPublic', 'getPublic', 'getPrivate', 'updateAccount'].some(name => typeof store[name] !== 'function')) {
      throw new TypeError('store with listPublic/getPublic/getPrivate/updateAccount is required');
    }
    if (typeof transportFactory !== 'function') throw new TypeError('transportFactory must be a function');
    if (typeof clock?.now !== 'function') throw new TypeError('clock.now must be a function');
    for (const [name, value] of Object.entries({ accountCooldownMs, serviceCooldownMs, transientCooldownMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    this.#store = store;
    this.#transportFactory = transportFactory;
    this.#clock = clock;
    this.#sessionManager = sessionManager;
    this.#accountCooldownMs = accountCooldownMs;
    this.#serviceCooldownMs = serviceCooldownMs;
    this.#transientCooldownMs = transientCooldownMs;
    this.#events.setMaxListeners(0);
    this.#onChange = () => this.#signal();
    if (typeof store.on === 'function') store.on('change', this.#onChange);
  }

  get version() { return this.#version; }

  get canRecover() { return !!this.#sessionManager; }

  accountState(accountId) {
    assertAccountId(accountId);
    let account = null;
    try { account = this.#store.getPublic(accountId); } catch { /* Local quarantine remains observable. */ }
    const localQuarantine = this.#localQuarantine.has(accountId);
    const persistedQuarantine = account?.quarantined === true;
    const quarantineReason = localQuarantine ? 'local_quarantine'
      : persistedQuarantine ? (typeof account.reasonCode === 'string' && CODE.test(account.reasonCode) ? account.reasonCode : 'quarantined')
      : null;
    return { busy: this.#occupied(accountId), quarantined: localQuarantine || persistedQuarantine, quarantineReason };
  }

  status() {
    const now = this.#clock.now();
    const counts = { total: 0, usable: 0, eligible: 0, busy: 0, cooldown: 0, quarantined: 0,
      disabled: 0, needsRelogin: 0, expired: 0, banned: 0, noSession: 0 };
    let list;
    try { list = this.#store.listPublic(); }
    catch { return { ready: false, state: 'unavailable', mode: 'http', model: 'Muse app selection', counts }; }
    for (const pub of list) {
      counts.total += 1;
      if (!pub.enabled) counts.disabled += 1;
      if (pub.status === 'banned') counts.banned += 1;
      if (pub.status === 'needs_relogin') counts.needsRelogin += 1;
      if (pub.status === 'expired') counts.expired += 1;
      if (!pub.hasSession) counts.noSession += 1;
      if (pub.quarantined || this.#localQuarantine.has(pub.id)) counts.quarantined += 1;
      if (this.#occupied(pub.id)) counts.busy += 1;
      if (this.#cooling(pub, now)) counts.cooldown += 1;
      if (this.#usable(pub)) {
        counts.usable += 1;
        if (this.#available(pub, now)) counts.eligible += 1;
      }
    }
    const blocked = this.#serviceBlocked(now);
    const ready = !this.#closed && !blocked && counts.eligible > 0;
    const state = this.#closed ? 'closed'
      : ready ? 'ready'
      : blocked ? 'service_blocked'
      : counts.usable === 0 ? 'no_ready_account'
      : counts.busy > 0 ? 'all_busy'
      : counts.cooldown > 0 ? 'cooldown' : 'all_busy';
    return { ready, state, mode: 'http', model: 'Muse app selection', counts };
  }

  availability({ excludeIds = [] } = {}) {
    const now = this.#clock.now();
    const exclude = new Set(excludeIds);
    const blocked = this.#serviceBlocked(now);
    let usable = 0;
    let eligible = 0;
    let busy = 0;
    let cooldown = 0;
    let accountCooldown = 0;
    let transientCooldown = 0;
    for (const pub of this.#store.listPublic()) {
      if (exclude.has(pub.id) || !this.#usable(pub)) continue;
      usable += 1;
      const occupied = this.#occupied(pub.id);
      const accountCooling = pub.cooldownUntil !== null && pub.cooldownUntil > now;
      const transient = (this.#transient.get(pub.id) ?? 0) > now;
      if (occupied) busy += 1;
      if (accountCooling || transient) cooldown += 1;
      if (accountCooling) accountCooldown += 1;
      if (transient) transientCooldown += 1;
      if (!blocked && !occupied && !accountCooling && !transient) eligible += 1;
    }
    return { usable, eligible, busy, cooldown, accountCooldown, transientCooldown, serviceBlocked: blocked, version: this.#version };
  }

  acquire(options = {}) {
    return this.#track(this.#acquire(options));
  }

  release(lease, outcome = {}) {
    const entry = this.#leases.get(lease?.id);
    if (!entry) return Promise.resolve(false);
    entry.releasing ??= this.#track((async () => {
      if (entry.recovering) await entry.recovering;
      if (entry.replaced) return false;
      await this.#retire(entry, outcome);
      return true;
    })());
    return entry.releasing;
  }

  async noteFailure(lease, failure, { allowRefresh = true } = {}) {
    const neutral = { retryable: false, retrySameAccount: false, retryOtherAccount: false, scope: 'unknown', delivery: 'unknown' };
    if (!TransportFailure.is(failure)) return neutral;
    const entry = this.#leases.get(lease?.id);
    const accountId = entry?.accountId ?? (typeof lease?.accountId === 'string' && ACCOUNT_ID.test(lease.accountId) ? lease.accountId : null);
    const sessionRevision = entry?.lease.sessionRevision ?? (Number.isSafeInteger(lease?.sessionRevision) ? lease.sessionRevision : null);
    const deliverySafe = RETRYABLE_DELIVERY.has(failure.delivery);
    // Explicit, branded account effects persist regardless of delivery or retry outcome.
    if (accountId && failure.quarantine) await this.#quarantine(accountId, failure.transportCode);
    if (accountId && failure.accountStatus && sessionRevision !== null) {
      await this.#persistStatus(accountId, sessionRevision, failure.accountStatus, failure.transportCode);
    }
    if (failure.scope === 'service') {
      this.#serviceBlockedUntil = Math.max(this.#serviceBlockedUntil, this.#clock.now() + this.#serviceCooldownMs);
      this.#signal();
      return { retryable: deliverySafe, retrySameAccount: false, retryOtherAccount: false, scope: 'service', delivery: failure.delivery };
    }
    if (failure.scope === 'account') {
      const terminal = failure.quarantine || failure.accountStatus === 'needs_relogin' || failure.accountStatus === 'banned';
      const retrySameAccount = deliverySafe && failure.recoverable && allowRefresh === true && !terminal && !!this.#sessionManager;
      if (!retrySameAccount && !terminal && failure.accountStatus === null && accountId) {
        await this.#cooldown(accountId, this.#accountCooldownMs);
      }
      return { retryable: deliverySafe, retrySameAccount, retryOtherAccount: deliverySafe && !retrySameAccount,
        scope: 'account', delivery: failure.delivery };
    }
    return { ...neutral, scope: failure.scope, delivery: failure.delivery };
  }

  recover(lease, options = {}) {
    return this.#track(this.#recover(lease, options));
  }

  runExclusive(accountId, fn, options = {}) {
    return this.#track(this.#runExclusive(accountId, fn, options));
  }

  refreshAccount(accountId, { signal } = {}) {
    if (!this.#sessionManager) return Promise.reject(new BridgeError('Session recovery is not configured.', 500, 'recover_unavailable'));
    return this.runExclusive(accountId, async () => {
      try { return await this.#sessionManager.refresh(accountId, { signal }); }
      catch (error) {
        await this.#drain(accountId);
        throw error;
      }
    }, { signal });
  }

  waitForAvailability(signal, { excludeIds = [], sinceVersion } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      if (this.#closed) return resolve();
      if (sinceVersion !== undefined && sinceVersion !== this.#version) return resolve();
      let wake;
      try {
        if (this.availability({ excludeIds }).eligible > 0) return resolve();
        wake = this.#nearestWake(excludeIds, this.#clock.now());
      } catch { return resolve(); }
      let timer = null;
      const cleanup = () => {
        this.#events.removeListener('availability', onEvent);
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };
      const onEvent = () => { cleanup(); resolve(); };
      const onAbort = () => { cleanup(); reject(abortError()); };
      this.#events.on('availability', onEvent);
      signal?.addEventListener('abort', onAbort, { once: true });
      // A ref'd timer: a waiting request is real pending work. cleanup() always clears it.
      if (Number.isFinite(wake)) timer = setTimeout(onEvent, Math.max(0, wake));
    });
  }

  async quarantine(accountId, reasonCode = 'quarantined') {
    assertAccountId(accountId);
    await this.#quarantine(accountId, reasonCode);
  }

  // Quarantine is cleared only by an explicit, verified operator action, never by a timer. It runs
  // under the account gate so it cannot race an in-flight cleanup.
  clearQuarantine(accountId, { verified, signal } = {}) {
    try { assertAccountId(accountId); } catch (error) { return Promise.reject(error); }
    if (verified !== true) {
      return Promise.reject(new BridgeError('Quarantine is only cleared by an explicit verified action.', 400, 'quarantine_requires_verification'));
    }
    return this.runExclusive(accountId, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = this.#store.getPublic(accountId);
        if (!current.quarantined) break;
        try { await this.#store.updateAccount(accountId, current.revision, { quarantinedAt: null }); break; }
        catch (error) { if (error?.code !== 'revision_conflict') throw error; }
      }
      this.#localQuarantine.delete(accountId);
    }, { signal });
  }

  close() {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #acquire({ excludeIds = [], signal, estimatedInputTokens = 0 } = {}) {
    if (this.#closed) throw shuttingDown();
    checkAbort(signal);
    const startedAt = this.#clock.now();
    if (this.#serviceBlocked(startedAt)) return null;
    const exclude = new Set(excludeIds);
    const candidates = this.#store.listPublic()
      .filter(pub => !exclude.has(pub.id) && this.#usable(pub) && this.#available(pub, startedAt))
      .sort((a, b) => this.#compare(a, b, startedAt));

    for (const candidate of candidates) {
      if (this.#closed) throw shuttingDown();
      checkAbort(signal);
      const now = this.#clock.now();
      if (this.#serviceBlocked(now)) return null;
      let current;
      try { current = this.#store.getPublic(candidate.id); } catch { continue; }
      if (!this.#usable(current) || !this.#available(current, now)) continue;
      const gate = this.#gate(candidate.id);
      gate.owner = { kind: 'acquire' };
      let entry;
      try { entry = await this.#open(candidate.id, signal); }
      catch {
        await this.#abandon(candidate.id, signal);
        if (signal?.aborted) throw abortError();
        if (this.#closed) throw shuttingDown();
        continue;
      }
      if (!entry) { this.#releaseGate(candidate.id); continue; }
      gate.owner = { kind: 'lease', leaseId: entry.lease.id };
      if (signal?.aborted || this.#closed) {
        // Never hand out a lease after an abort or shutdown; its transport is closed first.
        await this.#retire(entry);
        throw signal?.aborted ? abortError() : shuttingDown();
      }
      this.#leases.set(entry.lease.id, entry);
      this.#lastAssignedAt.set(candidate.id, now);
      this.#record(candidate.id, estimatedInputTokens, now);
      this.#bump();
      return entry.lease;
    }
    return null;
  }

  async #open(accountId, signal) {
    if (this.#sessionManager) await this.#sessionManager.ensureValid(accountId, { signal });
    const account = this.#store.getPrivate(accountId);
    if (!usableAccount(account) || this.#localQuarantine.has(accountId)) return null;
    const transport = await this.#transportFactory(account, account.session);
    return this.#entry(account, transport);
  }

  #entry(account, transport) {
    const lease = Object.freeze({ id: randomUUID(), accountId: account.id, sessionRevision: account.session.sessionRevision, transport });
    return { lease, accountId: account.id, transport, transportClosed: false, cleanupFailed: false,
      releasing: null, recovering: null, replaced: false };
  }

  // A failed acquisition keeps the gate until any refresh it joined has settled; a transient failure on
  // a still-usable account gets an explicit bounded cooldown so waiters wake on a timer, never forever.
  async #abandon(accountId, signal) {
    await this.#drain(accountId);
    if (!signal?.aborted && !this.#closed) {
      let usable = false;
      try { usable = this.#usable(this.#store.getPublic(accountId)); } catch { usable = false; }
      if (usable) this.#transient.set(accountId, this.#clock.now() + this.#transientCooldownMs);
    }
    this.#releaseGate(accountId);
  }

  async #recover(lease, { signal } = {}) {
    const entry = this.#leases.get(lease?.id);
    if (!entry || entry.releasing || entry.recovering || entry.replaced) throw new BridgeError('No active lease to recover.', 409, 'invalid_lease');
    if (!this.#sessionManager) throw new BridgeError('Session recovery is not configured.', 500, 'recover_unavailable');
    let settle;
    entry.recovering = new Promise(resolve => { settle = resolve; });
    try { return await this.#recoverEntry(entry, signal); }
    finally {
      entry.recovering = null;
      settle();
    }
  }

  // Runs under the caller's own lease (the gate is already held), so it cannot deadlock against queued
  // exclusive work. Order: confirm the old transport closed -> refresh -> build the new transport.
  async #recoverEntry(entry, signal) {
    if (this.#closed) throw shuttingDown();
    await this.#closeEntry(entry);
    if (entry.cleanupFailed) {
      await this.#quarantine(entry.accountId, 'cleanup_unconfirmed');
      throw new BridgeError('The previous attempt could not be cleaned up; the account was quarantined.', 503, 'cleanup_unconfirmed');
    }
    try { await this.#sessionManager.refresh(entry.accountId, { signal }); }
    catch (error) {
      await this.#drain(entry.accountId);
      if (signal?.aborted) throw abortError();
      throw error instanceof BridgeError ? error : new BridgeError('The session could not be refreshed.', 503, 'refresh_failed');
    }
    checkAbort(signal);
    if (this.#closed) throw shuttingDown();
    const account = this.#store.getPrivate(entry.accountId);
    if (!usableAccount(account) || this.#localQuarantine.has(entry.accountId)) {
      throw new BridgeError('The refreshed account is not usable.', 503, 'session_unavailable');
    }
    const next = this.#entry(account, await this.#transportFactory(account, account.session));
    if (signal?.aborted || this.#closed) {
      await this.#closeEntry(next);
      if (next.cleanupFailed) await this.#quarantine(entry.accountId, 'cleanup_unconfirmed');
      throw signal?.aborted ? abortError() : shuttingDown();
    }
    entry.replaced = true;
    this.#leases.delete(entry.lease.id);
    this.#leases.set(next.lease.id, next);
    this.#gate(entry.accountId).owner = { kind: 'lease', leaseId: next.lease.id };
    this.#bump();
    return next.lease;
  }

  async #runExclusive(accountId, fn, { signal } = {}) {
    assertAccountId(accountId);
    if (typeof fn !== 'function') throw new TypeError('runExclusive requires a function');
    if (this.#closed) throw shuttingDown();
    checkAbort(signal);
    const gate = this.#gate(accountId);
    if (gate.owner === null && gate.queue.length === 0) gate.owner = { kind: 'exclusive' };
    else {
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal };
        waiter.onAbort = () => {
          const index = gate.queue.indexOf(waiter);
          if (index === -1) return;
          gate.queue.splice(index, 1);
          reject(abortError());
          this.#signal();
        };
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        gate.queue.push(waiter);
      });
    }
    try { return await fn(signal); }
    finally { this.#releaseGate(accountId); }
  }

  // Closes the transport, persists cleanup/cooldown effects, and only then frees the gate.
  async #retire(entry, { cooldownMs } = {}) {
    try {
      await this.#closeEntry(entry);
      if (entry.cleanupFailed) await this.#quarantine(entry.accountId, 'cleanup_unconfirmed');
      else if (Number.isSafeInteger(cooldownMs) && cooldownMs > 0) await this.#cooldown(entry.accountId, cooldownMs);
    } finally {
      this.#leases.delete(entry.lease.id);
      if (this.#gates.get(entry.accountId)?.owner?.leaseId === entry.lease.id) this.#releaseGate(entry.accountId);
      else this.#signal();
    }
  }

  async #closeEntry(entry) {
    if (entry.transportClosed) return;
    entry.transportClosed = true;
    const transport = entry.transport;
    try {
      if (transport && typeof transport.close === 'function') await transport.close();
      else if (transport && typeof transport.release === 'function') await transport.release();
    } catch {
      entry.cleanupFailed = true;
    }
  }

  async #drain(accountId) {
    if (this.#sessionManager && typeof this.#sessionManager.drain === 'function') {
      await Promise.resolve(this.#sessionManager.drain(accountId)).catch(() => {});
    }
  }

  // Fail-safe: if the store cannot record the quarantine, the account is still held out in memory.
  async #quarantine(accountId, reasonCode) {
    const code = typeof reasonCode === 'string' && CODE.test(reasonCode) ? reasonCode : 'quarantined';
    let persisted = false;
    for (let attempt = 0; attempt < 3 && !persisted; attempt += 1) {
      let current;
      try { current = this.#store.getPublic(accountId); } catch { break; }
      if (current.quarantined) { persisted = true; break; }
      try {
        await this.#store.updateAccount(accountId, current.revision, { quarantinedAt: this.#clock.now(), reasonCode: code });
        persisted = true;
      } catch (error) {
        if (error?.code !== 'revision_conflict') break;
      }
    }
    if (!persisted) this.#localQuarantine.add(accountId);
    this.#signal();
  }

  // Explicit status from a branded failure, written only while the lease's session is still current.
  async #persistStatus(accountId, sessionRevision, status, reasonCode) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let current;
      try { current = this.#store.getPublic(accountId); } catch { return; }
      if (current.sessionRevision !== sessionRevision) return;
      if (current.status === 'banned' || (current.status === status && current.reasonCode === reasonCode)) return;
      try {
        await this.#store.updateAccount(accountId, current.revision, { status, reasonCode }, { expectedSessionRevision: sessionRevision });
        this.#signal();
        return;
      } catch (error) {
        if (error?.code === 'session_conflict') return;
        if (error?.code !== 'revision_conflict') {
          this.#transient.set(accountId, this.#clock.now() + this.#transientCooldownMs);
          this.#signal();
          return;
        }
      }
    }
  }

  async #cooldown(accountId, ms) {
    const until = this.#clock.now() + ms;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let current;
      try { current = this.#store.getPublic(accountId); } catch { return; }
      if (current.cooldownUntil !== null && current.cooldownUntil >= until) return;
      try { await this.#store.updateAccount(accountId, current.revision, { cooldownUntil: until }); return; }
      catch (error) {
        if (error?.code !== 'revision_conflict') {
          this.#transient.set(accountId, until);
          return;
        }
      }
    }
  }

  async #shutdown() {
    this.#closed = true;
    if (typeof this.#store.off === 'function') this.#store.off('change', this.#onChange);
    for (const gate of this.#gates.values()) {
      for (const waiter of gate.queue.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(shuttingDown());
      }
    }
    this.#signal();
    while (this.#ops.size) await Promise.allSettled([...this.#ops]);
    for (const entry of [...this.#leases.values()]) {
      entry.releasing ??= this.#retire(entry).then(() => true);
      await entry.releasing;
    }
    while (this.#ops.size) await Promise.allSettled([...this.#ops]);
  }

  #track(promise) {
    this.#ops.add(promise);
    const forget = () => { this.#ops.delete(promise); };
    promise.then(forget, forget);
    return promise;
  }

  #gate(accountId) {
    let gate = this.#gates.get(accountId);
    if (!gate) {
      gate = { owner: null, queue: [] };
      this.#gates.set(accountId, gate);
    }
    return gate;
  }

  #releaseGate(accountId) {
    const gate = this.#gates.get(accountId);
    if (gate) {
      gate.owner = null;
      const waiter = gate.queue.shift();
      if (waiter) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        gate.owner = { kind: 'exclusive' };
        waiter.resolve();
      }
    }
    this.#signal();
  }

  #occupied(accountId) {
    const gate = this.#gates.get(accountId);
    return !!gate && (gate.owner !== null || gate.queue.length > 0);
  }

  #usable(pub) { return usableView(pub) && !this.#localQuarantine.has(pub.id); }

  #cooling(pub, now) {
    return (pub.cooldownUntil !== null && pub.cooldownUntil > now) || (this.#transient.get(pub.id) ?? 0) > now;
  }

  #available(pub, now) { return !this.#cooling(pub, now) && !this.#occupied(pub.id); }

  #serviceBlocked(now) { return this.#serviceBlockedUntil > now; }

  #nearestWake(excludeIds, now) {
    const exclude = new Set(excludeIds);
    let nearest = this.#serviceBlockedUntil > now ? this.#serviceBlockedUntil - now : Infinity;
    for (const pub of this.#store.listPublic()) {
      if (exclude.has(pub.id) || !this.#usable(pub) || this.#occupied(pub.id)) continue;
      if (pub.cooldownUntil !== null && pub.cooldownUntil > now) nearest = Math.min(nearest, pub.cooldownUntil - now);
      const transient = this.#transient.get(pub.id) ?? 0;
      if (transient > now) nearest = Math.min(nearest, transient - now);
    }
    return nearest;
  }

  #compare(a, b, now) {
    const ra = this.#rollingTokens(a.id, now);
    const rb = this.#rollingTokens(b.id, now);
    if (ra !== rb) return ra - rb;
    const la = this.#lastAssignedAt.get(a.id) ?? 0;
    const lb = this.#lastAssignedAt.get(b.id) ?? 0;
    if (la !== lb) return la - lb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  #rollingTokens(accountId, now) {
    const entries = this.#rolling.get(accountId);
    if (!entries) return 0;
    const cutoff = now - WINDOW_MS;
    let sum = 0;
    const kept = [];
    for (const entry of entries) if (entry.at > cutoff) { sum += entry.tokens; kept.push(entry); }
    if (kept.length !== entries.length) this.#rolling.set(accountId, kept);
    return sum;
  }

  #record(accountId, tokens, now) {
    const amount = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    const entries = this.#rolling.get(accountId) ?? [];
    entries.push({ at: now, tokens: amount });
    this.#rolling.set(accountId, entries);
  }

  #bump() { this.#version += 1; }

  #signal() {
    this.#bump();
    this.#events.emit('availability');
  }
}
