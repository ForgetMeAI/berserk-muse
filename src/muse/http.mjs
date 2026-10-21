import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createSessionHttpClient, SafeTransportError } from '../net/http.mjs';
import { createNetworkRuntime } from '../net/runtime.mjs';
import { createNoiseRuntime, NoiseRuntimeError } from './vendor-runtime.mjs';
import { MuseNoiseChannel } from './channel.mjs';
import { MuseRpcClient, MuseRpcError } from './rpc.mjs';
import { MuseUsageError, parseMuseSubscriptionFlight } from './usage.mjs';

const ORIGIN = 'https://muse.ai';
const FINGERPRINT = /^(?:user-agent|accept|accept-language|content-type|origin|referer|sec-fetch-[a-z-]+|sec-ch-[a-z-]+|x-hatch-[a-z-]+)$/;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const FAILURE_SCOPES = new Set(['account', 'service', 'request']);
const DELIVERY_STATES = new Set(['not_sent', 'rejected_before_acceptance', 'accepted', 'unknown']);
const ACCOUNT_STATUSES = new Set(['needs_relogin', 'expired', 'banned']);
const ownedFailures = new WeakMap();

export class MuseTransportError extends SafeTransportError {
  constructor(code, metadata = {}) {
    super(SAFE_CODE.test(code) ? code : 'muse_transport_failed', metadata);
    this.name = 'MuseTransportError';
    this.scope = metadata.scope ?? 'account';
    this.recoverable = metadata.recoverable === true || metadata.refreshable === true;
    this.refreshable = metadata.refreshable === true;
    this.quarantine = metadata.quarantine === true;
  }
}

function transportFailure(factory, code, metadata = {}) {
  const fields = {
    ...metadata,
    code: SAFE_CODE.test(code) ? code : 'muse_transport_failed',
    scope: metadata.scope ?? 'account',
    delivery: metadata.delivery ?? 'unknown',
    recoverable: metadata.recoverable === true || metadata.refreshable === true,
  };
  const error = factory(fields);
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    const safe = {
      code: fields.code,
      scope: FAILURE_SCOPES.has(fields.scope) ? fields.scope : 'account',
      delivery: DELIVERY_STATES.has(fields.delivery) ? fields.delivery : 'unknown',
      recoverable: fields.recoverable === true,
      quarantine: fields.quarantine === true,
    };
    if (ACCOUNT_STATUSES.has(fields.accountStatus)) safe.accountStatus = fields.accountStatus;
    if (Number.isSafeInteger(fields.status) && fields.status >= 100 && fields.status <= 599) safe.status = fields.status;
    if (Number.isSafeInteger(fields.upstreamStatus) && fields.upstreamStatus >= 100 && fields.upstreamStatus <= 599) {
      safe.upstreamStatus = fields.upstreamStatus;
    }
    ownedFailures.set(error, Object.freeze(safe));
  }
  return error;
}

function fingerprintHeaders(session, { json = false } = {}) {
  const headers = {};
  for (const [raw, value] of Object.entries(session?.device?.headers ?? {})) {
    const key = raw.toLowerCase();
    if (FINGERPRINT.test(key) && typeof value === 'string' && value.length < 16384 && !/[\r\n\0]/.test(value)) headers[key] = value;
  }
  headers.accept = 'application/json';
  headers.origin = ORIGIN;
  headers.referer = `${ORIGIN}/`;
  headers['sec-fetch-site'] = 'same-origin';
  headers['sec-fetch-mode'] = 'cors';
  headers['sec-fetch-dest'] = 'empty';
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

function sessionData(session) {
  return { cookies: structuredClone(session.cookies), tokens: structuredClone(session.tokens ?? {}),
    device: structuredClone(session.device ?? {}), expiresAt: session.expiresAt ?? null };
}

function vmDescriptor(value) {
  if (!value || typeof value !== 'object' || typeof value.endpoint_url !== 'string') throw new MuseTransportError('invalid_vm_descriptor');
  let url;
  try { url = new URL(value.endpoint_url); } catch { throw new MuseTransportError('invalid_vm_descriptor'); }
  if (!['https:', 'wss:'].includes(url.protocol) || !url.hostname.endsWith('.metaaivm.com') ||
    (url.port && url.port !== '443') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new MuseTransportError('invalid_vm_descriptor');
  }
  if (typeof value.vm_id !== 'string' || value.vm_id.length === 0 || value.vm_id.length > 255 ||
    (value.vm_name != null && (typeof value.vm_name !== 'string' || value.vm_name.length > 255))) {
    throw new MuseTransportError('invalid_vm_descriptor');
  }
  return { gatewayUrl: url.href, vmId: value.vm_id, ...(value.vm_name ? { vmName: value.vm_name } : {}) };
}

function classifyStatus(status) {
  if ([401, 419].includes(status)) return { code: 'authentication_expired', scope: 'account', recoverable: true, status };
  if (status === 429) return { code: 'upstream_rate_limited', scope: 'account', status };
  if (status === 403) return { code: 'upstream_forbidden', scope: 'account', status };
  return { code: 'upstream_unavailable', scope: status >= 500 ? 'service' : 'account', status };
}

/** Direct HTTPS session operations and official Noise/WebSocket generation. */
export function createMuseProtocol({
  store,
  vendorManifest,
  timeoutMs = 240000,
  networkFactory = createNetworkRuntime,
  vendorFactory = createNoiseRuntime,
  channelFactory = options => new MuseNoiseChannel(options),
  rpcFactory = options => new MuseRpcClient(options),
  failureFactory = meta => new MuseTransportError(meta?.code, meta),
} = {}) {
  if ((!vendorManifest || !['object', 'function'].includes(typeof vendorManifest))
    || typeof networkFactory !== 'function' || typeof vendorFactory !== 'function' || typeof failureFactory !== 'function') {
    throw new TypeError('A prepared vendor manifest and transport factories are required.');
  }

  let manifestPromise = null;
  async function resolveVendorManifest() {
    if (typeof vendorManifest !== 'function') return vendorManifest;
    manifestPromise ??= Promise.resolve().then(() => vendorManifest()).then(manifest => {
      if (!manifest || typeof manifest !== 'object' || typeof manifest.assetsDirValidated !== 'string') {
        throw new Error('manifest_unavailable');
      }
      return manifest;
    }).catch(() => {
      manifestPromise = null;
      throw transportFailure(failureFactory, 'needs_vendor_assets', { delivery: 'not_sent', scope: 'service' });
    });
    return manifestPromise;
  }

  function makeClient(session, network, onCookies, requestTimeoutMs = timeoutMs) {
    return createSessionHttpClient({ allowedOrigins: [ORIGIN], session, fetchImpl: network.fetchImpl,
      onSessionCookies: jar => onCookies?.(jar.cookies), timeoutMs: Math.min(120000, requestTimeoutMs) });
  }

  async function readUsage(account, session, { signal } = {}) {
    if (!account || typeof account.id !== 'string' || !session || !Array.isArray(session.cookies) || session.cookies.length === 0) {
      throw new MuseUsageError('usage_auth_required');
    }
    if (signal?.aborted) throw new MuseUsageError('usage_cancelled');

    const expectedRevision = Number.isSafeInteger(session.sessionRevision) && session.sessionRevision >= 0
      ? session.sessionRevision : 0;
    const next = sessionData(session);
    let network;
    let cookiesChanged = false;
    let persistedRevision = expectedRevision;
    let primaryError = null;
    let parsed;
    try {
      network = networkFactory();
      const client = makeClient(next, network, cookies => {
        if (!isDeepStrictEqual(next.cookies, cookies)) {
          next.cookies = structuredClone(cookies);
          cookiesChanged = true;
        }
      }, Math.min(20_000, timeoutMs));
      const headers = fingerprintHeaders(next);
      headers.accept = 'text/x-component';
      headers['content-type'] = 'text/plain;charset=UTF-8';
      headers['next-action'] = '4029ac5c4bd03136487d91ebde5de39c64b35229b4';
      headers['sec-fetch-site'] ??= 'same-origin';
      headers['sec-fetch-mode'] ??= 'cors';
      headers['sec-fetch-dest'] ??= 'empty';
      const response = await client.request(`${ORIGIN}/`, {
        method: 'POST', headers, body: JSON.stringify([{ includeAgreement: false }]), signal,
      });
      if ([401, 419].includes(response.status)) throw new MuseUsageError('usage_auth_required');
      if (response.status === 403) throw new MuseUsageError('usage_forbidden');
      if (response.status !== 200) throw new MuseUsageError('usage_unavailable');
      parsed = parseMuseSubscriptionFlight(response.bodyText, { observedAt: Date.now() });
    } catch (error) {
      if (error instanceof MuseUsageError) primaryError = error;
      else if (signal?.aborted || error?.code === 'aborted') primaryError = new MuseUsageError('usage_cancelled');
      else primaryError = new MuseUsageError('usage_unavailable');
    } finally {
      if (cookiesChanged) {
        try {
          if (typeof store?.replaceSession !== 'function') throw new Error('session_store_unavailable');
          const saved = await store.replaceSession(account.id, expectedRevision, next);
          persistedRevision = Number.isSafeInteger(saved?.sessionRevision) && saved.sessionRevision >= 0
            ? saved.sessionRevision : expectedRevision + 1;
        } catch (error) {
          if (!primaryError) primaryError = new MuseUsageError(error?.code === 'session_conflict'
            ? 'usage_session_changed' : 'usage_unavailable');
        }
      }
      try { await network?.close?.(); }
      catch { if (!primaryError) primaryError = new MuseUsageError('usage_unavailable'); }
    }
    if (primaryError) throw primaryError;
    return { ...parsed, sessionRevision: persistedRevision };
  }

  async function checkSession(account, session, { signal, refresh = false } = {}) {
    if (!session || !Array.isArray(session.cookies) || !session.cookies.length) return refresh ? { ok: false, reason: 'needs_relogin' } : { valid: false };
    const network = networkFactory();
    const next = sessionData(session);
    let probeCookiesChanged = false;
    const client = makeClient(next, network, cookies => {
      if (!isDeepStrictEqual(next.cookies, cookies)) {
        next.cookies = structuredClone(cookies);
        probeCookiesChanged = true;
      }
    }, refresh ? Math.min(15_000, timeoutMs) : timeoutMs);
    try {
      if (refresh) {
        const authCheckHeaders = fingerprintHeaders(next);
        delete authCheckHeaders['content-type'];
        authCheckHeaders['cache-control'] = 'no-store';
        const checked = await client.request(`${ORIGIN}/api/auth/check`, { method: 'POST', headers: authCheckHeaders, signal });
        const invalidation = checked.json && typeof checked.json === 'object' && !Array.isArray(checked.json) &&
          Object.keys(checked.json).length === 3 && Object.hasOwn(checked.json, 'type') &&
          Object.hasOwn(checked.json, 'reason') && Object.hasOwn(checked.json, 'status') &&
          checked.json.type === 'hatchAdmissionInvalidated' && checked.json.reason === 'session' &&
          checked.json.status === 401 && checked.status === 401;
        if (invalidation) return { ok: false, reason: 'needs_relogin' };
        const authCheckValidated = checked.status === 200 && checked.json?.outcome === 'validated';
        if (!authCheckValidated) {
          throw transportFailure(failureFactory, 'session_refresh_unavailable', { delivery: 'not_sent', scope: 'service', status: checked.status });
        }
      }
      const found = await client.request(`${ORIGIN}/api/session`, { headers: fingerprintHeaders(next), signal });
      if ([401, 419].includes(found.status)) return refresh ? { ok: false, reason: 'expired' } : { valid: false };
      if (found.status !== 200) {
        const failure = classifyStatus(found.status);
        throw transportFailure(failureFactory, failure.code, { ...failure, delivery: 'not_sent' });
      }
      const vm = vmDescriptor(found.json);
      if (!refresh) {
        if (probeCookiesChanged && typeof store?.replaceSession === 'function') {
          try {
            await store.replaceSession(account.id, session.sessionRevision, next);
          } catch (error) {
            if (error?.code !== 'session_conflict') {
              throw transportFailure(failureFactory, 'probe_cookie_persistence_failed', { delivery: 'not_sent', scope: 'service' });
            }
          }
        }
        return { valid: true, expiresAt: null };
      }
      const token = await client.request(`${ORIGIN}/api/hatch/token`, { method: 'POST', headers: fingerprintHeaders(next, { json: true }),
        body: JSON.stringify({ vmAddress: vm.gatewayUrl, ...(vm.vmName ? { vmName: vm.vmName } : {}) }), signal });
      if ([401, 419].includes(token.status)) return { ok: false, reason: 'needs_relogin' };
      if (token.status !== 200 || typeof token.json?.token !== 'string') throw transportFailure(failureFactory, 'session_refresh_unavailable', { delivery: 'not_sent', scope: 'service', status: token.status });
      next.tokens.gateway = { token: token.json.token, notaryToken: token.json.notary_token ?? null };
      next.device.upstream = vm;
      next.expiresAt = null;
      return { ok: true, session: next };
    } finally { await network.close(); }
  }

  return {
    readUsage,
    probe: (account, session, options) => checkSession(account, session, options),
    refresh: (account, session, options) => checkSession(account, session, { ...options, refresh: true }),
    transportFactory(account, session) {
      return new MuseHttpTransport({ account, session, store, vendorManifest, timeoutMs, networkFactory, vendorFactory,
        channelFactory, rpcFactory, failureFactory, makeClient, resolveVendorManifest });
    },
  };
}

class MuseHttpTransport {
  constructor(options) {
    Object.assign(this, options);
    if (!options.session || !Array.isArray(options.session.cookies)) throw new TypeError('A stored account session is required.');
    this.bundle = sessionData(options.session);
    this.expectedRevision = options.session.sessionRevision ?? 0;
    this.network = null;
    this.runtime = null;
    this.channel = null;
    this.active = false;
    this.used = false;
    this.dirty = false;
    this.closePromise = null;
    this.lastHttpFailure = null;
    this.cleanupPromise = null;
  }

  async generate(prompt, { signal, nonce } = {}) {
    if (this.used || this.closePromise) throw transportFailure(this.failureFactory, 'transport_already_used', { delivery: 'not_sent', scope: 'account' });
    this.used = true;
    this.active = true;
    let generationInvoked = false;
    let result;
    let failure;
    let primaryFailure = null;
    try {
      if (signal?.aborted) throw transportFailure(this.failureFactory, 'request_cancelled', { delivery: 'not_sent', scope: 'request' });
      this.network = this.networkFactory();
      const client = this.makeClient(this.bundle, this.network, cookies => { this.bundle.cookies = cookies; this.dirty = true; });
      const request = async (url, init = {}) => {
        const headers = new Headers(fingerprintHeaders(this.bundle, { json: init.method === 'POST' }));
        for (const [key, value] of new Headers(init.headers ?? {})) headers.set(key, value);
        this.lastHttpFailure = null;
        const response = await client.request(url, { ...init, headers });
        if (response.status !== 200) this.lastHttpFailure = classifyStatus(response.status);
        return response;
      };
      const discovered = await request(`${ORIGIN}/api/session`, { signal });
      if (discovered.status !== 200) {
        const detail = this.lastHttpFailure ?? classifyStatus(discovered.status);
        throw transportFailure(this.failureFactory, detail.code, { ...detail, delivery: 'not_sent' });
      }
      const vm = vmDescriptor(discovered.json);
      this.bundle.device.upstream = vm;
      this.bundle.device.id ??= randomUUID();
      this.dirty = true;
      const awake = await request(`${ORIGIN}/api/hatch/vm/wake`, { method: 'POST', signal,
        body: JSON.stringify({ vm_id: vm.vmId, retry_count: 0, connect_attempt_id: randomUUID() }) });
      if (awake.status !== 200) {
        const detail = this.lastHttpFailure ?? classifyStatus(awake.status);
        throw transportFailure(this.failureFactory, detail.code, { ...detail, delivery: 'not_sent' });
      }
      const assetsDirValidatedManifest = await this.resolveVendorManifest();
      this.runtime = await this.vendorFactory({
        assetsDirValidatedManifest,
        WebSocketImpl: this.network.WebSocketImpl,
        fetchImpl: async (url, init) => {
          const response = await request(url, init);
          if (new URL(url).pathname === '/api/hatch/token' && response.status === 200 && typeof response.json?.token === 'string') {
            this.bundle.tokens.gateway = { token: response.json.token, notaryToken: response.json.notary_token ?? null };
            this.dirty = true;
          }
          const body = [204, 205, 304].includes(response.status) ? null : response.bodyText;
          return new Response(body, { status: response.status, headers: response.headers });
        },
      });
      const connection = await this.runtime.open(vm.gatewayUrl, { ...(vm.vmName ? { vmName: vm.vmName } : {}), signal });
      this.channel = this.channelFactory({ runtime: this.runtime, connection, nodeId: this.bundle.device.id });
      const rpc = this.rpcFactory({ channel: this.channel, timeoutMs: this.timeoutMs });
      generationInvoked = true;
      result = await rpc.generate(prompt, { signal, nonce });
    } catch (error) {
      if (error instanceof MuseRpcError) {
        primaryFailure = {
          code: SAFE_CODE.test(error.code) ? error.code : 'muse_rpc_failed',
          delivery: error.delivery, scope: 'account', quarantine: error.safe?.quarantine === true,
        };
        failure = transportFailure(this.failureFactory, primaryFailure.code, primaryFailure);
      } else {
        const owned = error && ((typeof error === 'object' && error !== null) || typeof error === 'function')
          ? ownedFailures.get(error) : undefined;
        if (owned) {
          primaryFailure = { ...owned };
        } else if (error instanceof NoiseRuntimeError && !generationInvoked &&
          (error.code === 'runtime_aborted' || signal?.aborted)) {
          primaryFailure = { code: 'request_cancelled', delivery: 'not_sent', scope: 'request', recoverable: false, quarantine: false };
        } else if (error instanceof NoiseRuntimeError && !generationInvoked && error.code === 'needs_vendor_assets') {
          primaryFailure = { code: 'needs_vendor_assets', delivery: 'not_sent', scope: 'service', recoverable: false, quarantine: false };
        } else if (error instanceof NoiseRuntimeError && !generationInvoked && error.code === 'noise_runtime_failed') {
          primaryFailure = { code: 'gateway_connect_failed', delivery: 'not_sent', scope: 'account', recoverable: true, quarantine: false };
        } else {
          const detail = !generationInvoked && this.lastHttpFailure ? this.lastHttpFailure : {};
          const cancelled = signal?.aborted === true;
          primaryFailure = {
            code: detail.code ?? (cancelled ? 'request_cancelled' : 'muse_transport_failed'),
            ...detail, delivery: generationInvoked ? 'unknown' : 'not_sent', scope: detail.scope ?? (cancelled ? 'request' : 'account'),
            quarantine: generationInvoked,
          };
        }
        failure = transportFailure(this.failureFactory, primaryFailure.code, primaryFailure);
      }
    } finally {
      try { await this.cleanup(); }
      catch (cleanupError) {
        // Cleanup uncertainty makes the account ineligible, but it must not hide
        // whether the primary operation was accepted or what safe RPC failure occurred.
        failure = primaryFailure
          ? transportFailure(this.failureFactory, primaryFailure.code, {
            delivery: primaryFailure.delivery, scope: 'account', quarantine: true, recoverable: false,
            ...(primaryFailure.accountStatus ? { accountStatus: primaryFailure.accountStatus } : {}),
          })
          : cleanupError;
      }
      this.active = false;
    }
    if (failure) throw failure;
    return { text: result.text, delivery: 'accepted' };
  }

  async cleanup() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      let failed = false;
      // The channel owns the socket. Let it settle before the vendor runtime closes its socket set.
      try { await this.channel?.close({ quarantine: true }); } catch { failed = true; }
      try { await this.runtime?.close(); } catch { failed = true; }
      try { await this.network?.close(); } catch { failed = true; }
      if (failed) throw transportFailure(this.failureFactory, 'transport_cleanup_unconfirmed', {
        quarantine: true, delivery: 'unknown', scope: 'account',
      });
    })();
    return this.cleanupPromise;
  }

  /** Pool releases the lease only after this completes. Persist after failure handling. */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.active) throw transportFailure(this.failureFactory, 'transport_still_active', { quarantine: true, delivery: 'unknown', scope: 'account' });
      await this.cleanup();
      if (!this.store || !this.dirty) return;
      try { await this.store.replaceSession(this.account.id, this.expectedRevision, this.bundle); }
      catch (error) {
        if (error?.code !== 'session_conflict') throw transportFailure(this.failureFactory, 'session_persistence_failed', { delivery: 'unknown', quarantine: true, scope: 'account' });
      }
    })();
    return this.closePromise;
  }
}
