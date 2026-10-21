import { BridgeError, abortError, checkAbort } from './errors.mjs';

// The running task keeps its lease until its cleanup completes, even on abort.
export class SerialQueue {
  #pending = [];
  #running = false;
  constructor(limit = 4) { this.limit = limit; }
  get status() { return { active: this.#running, waiting: this.#pending.length }; }
  run(fn, signal) {
    checkAbort(signal);
    if (this.#pending.length >= this.limit) {
      throw new BridgeError('The local Muse queue is full. Try again later.', 429, 'queue_full');
    }
    return new Promise((resolve, reject) => {
      const job = { fn, signal, resolve, reject };
      job.onAbort = () => {
        const index = this.#pending.indexOf(job);
        if (index !== -1) {
          this.#pending.splice(index, 1);
          signal?.removeEventListener('abort', job.onAbort);
          reject(abortError());
        }
      };
      signal?.addEventListener('abort', job.onAbort, { once: true });
      this.#pending.push(job);
      this.#next();
    });
  }
  async #next() {
    if (this.#running) return;
    const job = this.#pending.shift();
    if (!job) return;
    job.signal?.removeEventListener('abort', job.onAbort);
    this.#running = true;
    try { checkAbort(job.signal); job.resolve(await job.fn(job.signal)); }
    catch (error) { job.reject(error); }
    finally { this.#running = false; this.#next(); }
  }
}

// AccountQueue layers a global admission limit over an AccountPool.
//
// A "logical request" holds exactly one global permit for its whole lifetime (including every
// retry). Within that permit it leases ONE account at a time for ONE generation attempt; the
// pool is never asked for the global permit. Fallback always releases the current lease (and
// awaits its cleanup) before acquiring the next, so there are never nested leases.
//
// Retries are driven solely by the pool's branded decision: only a transport failure delivered
// 'not_sent' or 'rejected_before_acceptance' is retryable. A refreshed same-account retry and an
// other-account retry both count toward maxAttempts (<= 3) generation attempts; a session refresh is
// not an attempt, and a logical request performs at most one refresh. The shared external signal is
// reused across every attempt, so a deadline persists.
//
// run(fn, signal, { requestId, estimatedInputTokens }) -> fn(signal, lease)
// status -> { active, activeCount, waiting, capacity }
export class AccountQueue {
  #pool;
  #limit;
  #maxActive;
  #maxAttempts;
  #clock;
  #active = 0;
  #waiters = [];
  #closed = false;

  constructor({ pool, limit = 4, maxActive = 1, maxAttempts = 3, clock = { now: () => Date.now() } } = {}) {
    if (!pool || typeof pool.acquire !== 'function' || typeof pool.release !== 'function' || typeof pool.noteFailure !== 'function') {
      throw new TypeError('AccountQueue requires a pool with acquire/release/noteFailure');
    }
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative integer');
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new TypeError('maxActive must be a positive integer');
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new TypeError('maxAttempts must be an integer from 1 to 3');
    this.#pool = pool;
    this.#limit = limit;
    this.#maxActive = maxActive;
    this.#maxAttempts = maxAttempts;
    this.#clock = clock;
  }

  get status() {
    return { active: this.#active > 0, activeCount: this.#active, waiting: this.#waiters.length, capacity: this.#limit };
  }

  async run(fn, signal, { requestId, estimatedInputTokens = 0 } = {}) {
    if (typeof fn !== 'function') throw new TypeError('run requires a function');
    checkAbort(signal);
    if (this.#closed) throw new BridgeError('Service is stopping.', 503, 'shutting_down');
    const immediate = this.#active < this.#maxActive && this.#waiters.length === 0;
    if (!immediate && this.#waiters.length >= this.#limit) {
      throw new BridgeError('The local Muse queue is full. Try again later.', 429, 'queue_full');
    }
    await this.#acquirePermit(signal);
    try {
      return await this.#execute(fn, signal, { requestId, estimatedInputTokens });
    } finally {
      this.#active -= 1;
      this.#pump();
    }
  }

  async close() {
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new BridgeError('Service is stopping.', 503, 'shutting_down'));
    }
  }

  #acquirePermit(signal) {
    if (this.#active < this.#maxActive && this.#waiters.length === 0) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) {
          this.#waiters.splice(index, 1);
          reject(abortError());
        }
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #pump() {
    while (this.#active < this.#maxActive && this.#waiters.length) {
      const waiter = this.#waiters.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      this.#active += 1;
      waiter.resolve();
    }
  }

  // Every exit path releases the held lease exactly once (awaiting its cleanup) before the global
  // permit is returned by run(); fallback and recovery never overlap two leases.
  async #execute(fn, signal, meta) {
    const excluded = new Set();
    let attempt = 0;
    let refreshed = false;
    let lease = null;
    const releaseHeld = async () => {
      const held = lease;
      lease = null;
      if (held) await this.#pool.release(held, { ok: false });
    };
    try {
      while (true) {
        checkAbort(signal);
        if (!lease) lease = await this.#acquireLease(signal, excluded, meta);
        attempt += 1;
        let failure;
        try {
          const result = await fn(signal, lease);
          const done = lease;
          lease = null;
          await this.#pool.release(done, { ok: true });
          return result;
        } catch (error) { failure = error; }

        // The attempt's fn (including its own cleanup) has settled; the finally releases the lease.
        if (signal?.aborted) {
          // Preserve explicit branded account effects (for example, an
          // unconfirmed cancellation quarantine) even when caller cancellation
          // wins the response race. Do not record ordinary aborts as failures.
          if (failure?.quarantine === true || failure?.accountStatus != null) {
            try { await this.#pool.noteFailure(lease, failure, { allowRefresh: false }); }
            catch { /* Pool retains an in-memory quarantine when persistence fails. */ }
          }
          throw abortError();
        }
        let decision;
        try { decision = await this.#pool.noteFailure(lease, failure, { allowRefresh: !refreshed }); }
        catch { decision = null; }
        const canAttemptAgain = decision?.retryable === true && attempt < this.#maxAttempts;

        if (canAttemptAgain && decision.retrySameAccount === true && !refreshed && this.#pool.canRecover) {
          refreshed = true;
          const accountId = lease.accountId;
          try {
            lease = await this.#pool.recover(lease, { signal });
            continue;
          } catch {
            // recover() has already closed/drained what it touched; the original lease is still ours.
            await releaseHeld();
            if (signal?.aborted) throw abortError();
            excluded.add(accountId);
            if (this.#hasAlternative(excluded)) continue;
            throw this.#map(failure);
          }
        }
        if (canAttemptAgain && decision.retryOtherAccount === true && this.#hasAlternative(new Set([...excluded, lease.accountId]))) {
          excluded.add(lease.accountId);
          await releaseHeld();
          continue;
        }
        await releaseHeld();
        throw this.#map(failure);
      }
    } finally {
      if (lease) await releaseHeld().catch(() => {});
    }
  }

  // The pool version is captured before each acquire so a release landing between a null acquire and
  // the waiter registration is not missed.
  async #acquireLease(signal, excluded, meta) {
    while (true) {
      checkAbort(signal);
      const version = this.#pool.version;
      let lease;
      try {
        lease = await this.#pool.acquire({
          requestId: meta.requestId, excludeIds: [...excluded], signal, estimatedInputTokens: meta.estimatedInputTokens,
        });
      } catch (error) {
        throw signal?.aborted ? abortError() : this.#map(error);
      }
      if (lease) return lease;
      const availability = this.#pool.availability({ excludeIds: [...excluded] });
      if (availability.usable === 0) throw new BridgeError('No account is ready to serve this request.', 503, 'no_ready_account');
      // Do not wait through transient cooldowns when every usable account has
      // failed its preflight and none is occupied. If any account is busy,
      // retain the normal wait: it may become available before cooldown expiry.
      if (availability.eligible === 0 && availability.busy === 0 &&
          availability.serviceBlocked === false && availability.accountCooldown === 0 &&
          availability.transientCooldown === availability.usable) {
        throw new BridgeError('No account is ready to serve this request.', 503, 'no_ready_account');
      }
      await this.#pool.waitForAvailability(signal, { excludeIds: [...excluded], sinceVersion: version });
    }
  }

  #hasAlternative(excluded) {
    return this.#pool.availability({ excludeIds: [...excluded] }).usable > 0;
  }

  #map(error) {
    if (error instanceof BridgeError) return error;
    if (error?.name === 'ProtocolError' && Number.isSafeInteger(error.status)) return error;
    return new BridgeError('The request could not be completed by any account.', 502, 'upstream_error');
  }
}
