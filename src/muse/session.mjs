import { BridgeError, abortError, checkAbort } from '../errors.mjs';
import { assertAccountId, validateSessionInput } from '../accounts/store.mjs';

const MARGIN_MS = 60_000;
const AUTH_STATES = new Set(['needs_relogin', 'expired']);
const MESSAGES = {
  needs_relogin: 'This account needs an interactive re-login.',
  expired: 'This account session has expired.',
  account_banned: 'This account is banned and will not be refreshed.',
  session_unavailable: 'No stored session is available for this account.',
  refresh_failed: 'The session refresh did not complete. The account state was not changed.',
  probe_failed: 'The session could not be validated.',
  shutting_down: 'Session management is shutting down.',
};

// Typed, sanitized session outcome. The message is fixed text and never carries token material.
export class SessionError extends BridgeError {
  constructor(code, { cause } = {}) {
    const known = Object.hasOwn(MESSAGES, code) ? code : 'session_unavailable';
    super(MESSAGES[known], 503, known);
    this.name = 'SessionError';
    this.scope = 'session';
    // Non-enumerable so an upstream cause can aid debugging but never serializes into a response/log.
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, enumerable: false, configurable: true });
  }
}

// SessionManager({ store, protocol, clock })
//   ensureValid(accountId, { signal }) -> descriptor | throws SessionError
//   refresh(accountId, { signal })     -> descriptor | throws SessionError / AccountStoreError(session_conflict)
//   drain(accountId?)                  -> resolves once in-flight refresh(es) settle; never rejects
//   close()                            -> rejects new work, aborts and awaits in-flight refreshes
// descriptor shape: { accountId, sessionRevision, expiresAt, refreshed, validatedAt }
// Injected protocol (implemented by the real Muse HTTP layer, not here):
//   protocol.probe(privateAccount, session, { signal })
//     -> { valid: boolean, expiresAt?: number | null }
//   protocol.refresh(privateAccount, session, { signal })
//     -> { ok: true, session: { cookies, tokens, device, expiresAt? } }
//        | { ok: false, reason: 'needs_relogin' | 'expired' }
// Only that explicit { ok: false, reason } may change auth state, and only while the session it was
// decided against is still current. Thrown errors, timeouts and malformed results are refresh_failed
// with the account untouched. Token/JWT claims are never trusted; an unknown expiry stays null.
export class SessionManager {
  #store;
  #protocol;
  #clock;
  #flights = new Map();
  #closed = false;

  constructor({ store, protocol, clock = { now: () => Date.now() } } = {}) {
    if (!store || ['getPrivate', 'getPublic', 'replaceSession', 'updateAccount'].some(name => typeof store[name] !== 'function')) {
      throw new TypeError('store with getPrivate/getPublic/replaceSession/updateAccount is required');
    }
    if (!protocol || typeof protocol.probe !== 'function' || typeof protocol.refresh !== 'function') {
      throw new TypeError('protocol with probe/refresh functions is required');
    }
    if (typeof clock?.now !== 'function') throw new TypeError('clock.now must be a function');
    this.#store = store;
    this.#protocol = protocol;
    this.#clock = clock;
  }

  async ensureValid(accountId, { signal } = {}) {
    assertAccountId(accountId);
    checkAbort(signal);
    if (this.#closed) throw new SessionError('shutting_down');
    const account = this.#store.getPrivate(accountId);
    if (account.status === 'banned') throw new SessionError('account_banned');
    if (account.status === 'needs_relogin') throw new SessionError('needs_relogin');
    const session = account.session;
    if (!session) throw new SessionError('session_unavailable');
    const now = this.#clock.now();
    const stale = account.status === 'expired' || (session.expiresAt !== null && session.expiresAt - now <= MARGIN_MS);
    if (stale) return this.refresh(accountId, { signal });

    let probe;
    try { probe = await this.#protocol.probe(account, session, { signal }); }
    catch (error) {
      if (signal?.aborted) throw abortError();
      throw new SessionError('probe_failed', { cause: error });
    }
    checkAbort(signal);
    if (probe === null || typeof probe !== 'object' || typeof probe.valid !== 'boolean') throw new SessionError('probe_failed');
    if (!probe.valid) return this.refresh(accountId, { signal });
    const expiresAt = Number.isSafeInteger(probe.expiresAt) && probe.expiresAt >= 0 ? probe.expiresAt : session.expiresAt;
    return { accountId, sessionRevision: session.sessionRevision, expiresAt, refreshed: false, validatedAt: now };
  }

  // Single-flight per account. A caller's abort rejects only that caller; the shared flight keeps
  // running (its internal signal aborts only on close()), so other joiners are never poisoned.
  // Callers that abandon a flight but own the account (the pool) must drain() before letting go.
  refresh(accountId, { signal } = {}) {
    try {
      assertAccountId(accountId);
      checkAbort(signal);
    } catch (error) { return Promise.reject(error); }
    if (this.#closed) return Promise.reject(new SessionError('shutting_down'));
    let flight = this.#flights.get(accountId);
    if (!flight) {
      const controller = new AbortController();
      const promise = this.#runRefresh(accountId, controller.signal);
      const settled = promise.then(() => undefined, () => undefined);
      flight = { promise, controller, settled };
      this.#flights.set(accountId, flight);
      settled.then(() => { if (this.#flights.get(accountId) === flight) this.#flights.delete(accountId); });
    }
    return this.#join(flight.promise, signal);
  }

  drain(accountId) {
    if (accountId === undefined) return Promise.all([...this.#flights.values()].map(flight => flight.settled)).then(() => undefined);
    assertAccountId(accountId);
    return this.#flights.get(accountId)?.settled ?? Promise.resolve();
  }

  async close() {
    this.#closed = true;
    for (const flight of this.#flights.values()) flight.controller.abort();
    await this.drain();
  }

  #join(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      if (signal.aborted) return reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  async #runRefresh(accountId, signal) {
    const account = this.#store.getPrivate(accountId);
    if (account.status === 'banned') throw new SessionError('account_banned');
    if (!account.session) throw new SessionError('session_unavailable');
    const expectedRevision = account.session.sessionRevision;
    let result;
    try { result = await this.#protocol.refresh(account, account.session, { signal }); }
    catch (error) { throw new SessionError('refresh_failed', { cause: error }); }
    // Shutting down: never persist or mark anything from a refresh nobody can observe.
    if (signal.aborted) throw new SessionError('refresh_failed');
    const explicit = result !== null && typeof result === 'object';
    if (explicit && result.ok === false && AUTH_STATES.has(result.reason)) {
      await this.#markStatus(accountId, expectedRevision, result.reason);
      throw new SessionError(result.reason);
    }
    if (!explicit || result.ok !== true) throw new SessionError('refresh_failed');
    let validated;
    try { validated = validateSessionInput(result.session); }
    catch { throw new SessionError('refresh_failed'); }
    if (validated.expiresAt !== null && validated.expiresAt <= this.#clock.now()) throw new SessionError('refresh_failed');
    let saved;
    try { saved = await this.#store.replaceSession(accountId, expectedRevision, validated); }
    catch (error) {
      // A CAS conflict means a newer session already won; surface it without clobbering.
      if (error?.code === 'session_conflict') throw error;
      throw new SessionError('refresh_failed', { cause: error });
    }
    await this.#reactivate(accountId, saved.sessionRevision);
    return { accountId, sessionRevision: saved.sessionRevision, expiresAt: saved.expiresAt, refreshed: true, validatedAt: this.#clock.now() };
  }

  // Both writes are conditional on the session revision they were decided against (store-level CAS),
  // so an old refresh can never mark a freshly re-logged session invalid or reactivate a stale one.
  async #markStatus(accountId, expectedSessionRevision, status) {
    await this.#conditionalStatus(accountId, expectedSessionRevision, current => current.status !== 'banned'
      && !(current.status === status && current.reasonCode === status), { status, reasonCode: status });
  }

  async #reactivate(accountId, sessionRevision) {
    await this.#conditionalStatus(accountId, sessionRevision, current => current.status === 'expired'
      || current.status === 'needs_relogin', { status: 'active', reasonCode: null });
  }

  async #conditionalStatus(accountId, expectedSessionRevision, applies, patch) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = this.#store.getPublic(accountId);
      if (current.sessionRevision !== expectedSessionRevision || !applies(current)) return;
      try {
        await this.#store.updateAccount(accountId, current.revision, patch, { expectedSessionRevision });
        return;
      } catch (error) {
        if (error?.code !== 'revision_conflict') return;
      }
    }
  }
}
