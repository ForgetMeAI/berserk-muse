import { CookieJar } from 'tough-cookie';

export const DeliveryState = Object.freeze({
  NOT_SENT: 'not_sent',
  REJECTED_BEFORE_ACCEPTANCE: 'rejected_before_acceptance',
  ACCEPTED: 'accepted',
  UNKNOWN: 'unknown',
});

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const FORBIDDEN_REQUEST_HEADERS = new Set(['cookie', 'host', 'proxy-authorization', 'set-cookie']);
const SENSITIVE_REDIRECT_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'origin', 'referer']);

/** Error whose properties contain only safe transport metadata. */
export class SafeTransportError extends Error {
  /** @param {string} code @param {{status?:number, delivery?:string}} [metadata] */
  constructor(code, { status, delivery = DeliveryState.NOT_SENT } = {}) {
    super(code);
    this.name = 'SafeTransportError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
    this.delivery = delivery;
  }
}

/**
 * Classify an HTTP response without treating authentication failures as proof
 * that the server did not accept an operation.
 * @param {number} status
 * @param {unknown} [_body]
 * @returns {'not_sent'|'rejected_before_acceptance'|'accepted'|'unknown'}
 */
export function classifyHTTPResponse(status, _body) {
  if (status >= 200 && status < 300) return DeliveryState.ACCEPTED;
  return DeliveryState.UNKNOWN;
}

/**
 * Create an isolated fetch client with an isolated tough-cookie jar.
 * `onSessionCookies` receives only the serialized jar after cookie updates and
 * is awaited in order, so callers can persist each snapshot atomically.
 * @param {{allowedOrigins:string[], session?:object|Array<object>, fetchImpl?:Function, maxBytes?:number, timeoutMs?:number, onSessionCookies?:(jar:object)=>Promise<void>|void}} options
 */
export function createSessionHttpClient({
  allowedOrigins, session, fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS, onSessionCookies,
} = {}) {
  const origins = normalizeOrigins(allowedOrigins);
  if (typeof fetchImpl !== 'function') throw new SafeTransportError('invalid_fetch');
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * DEFAULT_MAX_BYTES) throw new SafeTransportError('invalid_body_limit');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new SafeTransportError('invalid_timeout');
  if (onSessionCookies !== undefined && typeof onSessionCookies !== 'function') throw new SafeTransportError('invalid_cookie_callback');
  const jar = restoreJar(session, origins);
  let persistenceTail = Promise.resolve();

  async function persistCookies() {
    if (!onSessionCookies) return;
    const snapshot = jar.serializeSync();
    const persist = persistenceTail.then(() => onSessionCookies(snapshot));
    persistenceTail = persist.catch(() => {});
    try { await persist; }
    catch { throw new SafeTransportError('cookie_persistence_failed', { delivery: DeliveryState.UNKNOWN }); }
  }

  async function applyResponseCookies(response, responseUrl) {
    const setCookies = getSetCookieValues(response.headers);
    if (!setCookies.length) return;
    try {
      for (const cookie of setCookies) await jar.setCookie(cookie, responseUrl, { ignoreError: false });
    } catch {
      throw new SafeTransportError('invalid_response_cookie', { status: response.status, delivery: classifyHTTPResponse(response.status) });
    }
    await persistCookies();
  }

  /** Send one request. No automatic retries are performed. */
  async function request(inputUrl, { method = 'GET', headers = {}, body, signal } = {}) {
    let url;
    try { url = new URL(inputUrl); }
    catch { throw new SafeTransportError('invalid_url'); }
    if (!isSafeUrl(url) || !origins.has(url.origin)) throw new SafeTransportError('origin_not_allowed');
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/.test(method)) throw new SafeTransportError('invalid_method');
    if ((method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD') && body !== undefined) throw new SafeTransportError('body_not_allowed');
    const outgoing = normalizeHeaders(headers);
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (signal?.aborted) throw new SafeTransportError('aborted', { delivery: DeliveryState.NOT_SENT });
    signal?.addEventListener('abort', relayAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let currentMethod = method.toUpperCase();
    let currentBody = body;
    let networkInvoked = false;
    let lastStatus;
    try {
      for (let redirects = 0; ; redirects += 1) {
        if (signal?.aborted) throw new SafeTransportError('aborted', { status: lastStatus, delivery: networkInvoked ? deliveryForStatus(lastStatus) : DeliveryState.NOT_SENT });
        const requestHeaders = new Headers(outgoing);
        const cookie = jar.getCookieStringSync(url.href);
        if (cookie) requestHeaders.set('cookie', cookie);
        else requestHeaders.delete('cookie');
        networkInvoked = true;
        let response;
        try {
          response = await fetchImpl(url.href, {
            method: currentMethod, headers: requestHeaders, body: currentBody, signal: controller.signal, redirect: 'manual',
          });
        } catch {
          throw new SafeTransportError(signal?.aborted ? 'aborted' : timedOut ? 'timeout' : 'network_failed', {
            status: lastStatus, delivery: DeliveryState.UNKNOWN,
          });
        }
        lastStatus = response.status;
        if (isRedirect(response.status)) {
          await applyResponseCookies(response, url.href);
          if (redirects >= MAX_REDIRECTS) {
            await cancelBody(response);
            throw new SafeTransportError('too_many_redirects', { status: response.status, delivery: classifyHTTPResponse(response.status) });
          }
          const location = response.headers.get('location');
          let next;
          try { next = new URL(location, url); }
          catch { await cancelBody(response); throw new SafeTransportError('invalid_redirect', { status: response.status, delivery: classifyHTTPResponse(response.status) }); }
          if (!isSafeUrl(next) || !origins.has(next.origin)) {
            await cancelBody(response);
            throw new SafeTransportError('redirect_origin_not_allowed', { status: response.status, delivery: classifyHTTPResponse(response.status) });
          }
          const crossOrigin = next.origin !== url.origin;
          const oldMethod = currentMethod;
          if (crossOrigin) {
            if (![301, 302, 303].includes(response.status) && currentBody !== undefined) {
              await cancelBody(response);
              throw new SafeTransportError('cross_origin_body_redirect', { status: response.status, delivery: DeliveryState.UNKNOWN });
            }
            for (const name of SENSITIVE_REDIRECT_HEADERS) outgoing.delete(name);
          }
          if (response.status === 303 || ([301, 302].includes(response.status) && oldMethod === 'POST')) {
            currentMethod = oldMethod === 'HEAD' ? 'HEAD' : 'GET';
            currentBody = undefined;
            outgoing.delete('content-length');
            outgoing.delete('content-type');
          }
          await cancelBody(response);
          url = next;
          continue;
        }
        await applyResponseCookies(response, url.href);
        const bodyText = await readBoundedText(response, maxBytes, signal, controller.signal, lastStatus, () => timedOut);
        const responseHeaders = filteredResponseHeaders(response.headers);
        const result = { status: response.status, headers: responseHeaders, bodyText, delivery: classifyHTTPResponse(response.status) };
        try { result.json = JSON.parse(bodyText); } catch { /* A non-JSON response has no json property. */ }
        return result;
      }
    } catch (error) {
      if (error instanceof SafeTransportError) {
        if (networkInvoked && error.delivery === DeliveryState.NOT_SENT) {
          throw new SafeTransportError(error.code, { status: error.status, delivery: DeliveryState.UNKNOWN });
        }
        throw error;
      }
      throw new SafeTransportError('transport_failed', { status: lastStatus, delivery: networkInvoked ? deliveryForStatus(lastStatus) : DeliveryState.NOT_SENT });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
    }
  }

  return Object.freeze({ request });
}

function normalizeOrigins(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) throw new SafeTransportError('invalid_allowed_origins');
  const origins = new Set();
  for (const value of values) {
    let url;
    try { url = new URL(value); } catch { throw new SafeTransportError('invalid_allowed_origins'); }
    if (!isSafeUrl(url) || url.pathname !== '/' || url.search || url.hash || url.href !== `${url.origin}/`) {
      throw new SafeTransportError('invalid_allowed_origins');
    }
    origins.add(url.origin);
  }
  return origins;
}

function isSafeUrl(url) {
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || isLoopback(url.hostname));
}

function isLoopback(host) { return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'; }

function normalizeHeaders(input) {
  let entries;
  try { entries = input instanceof Headers ? [...input.entries()] : Object.entries(input || {}); }
  catch { throw new SafeTransportError('invalid_headers'); }
  const headers = new Headers();
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n\0]/.test(value) || FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw new SafeTransportError('invalid_headers');
    }
    try { headers.set(name, value); } catch { throw new SafeTransportError('invalid_headers'); }
  }
  return headers;
}

function restoreJar(session, origins) {
  let jar = new CookieJar();
  try {
    const stored = session?.cookieJar;
    if (stored) {
      let decoded = stored;
      if (typeof stored === 'string') decoded = JSON.parse(stored);
      if (Array.isArray(decoded)) importBrowserCookies(jar, decoded, origins);
      else if (decoded && typeof decoded === 'object' && Array.isArray(decoded.cookies)) jar = CookieJar.deserializeSync(decoded);
    }
    if (Array.isArray(session)) importBrowserCookies(jar, session, origins);
    else if (Array.isArray(session?.cookies)) importBrowserCookies(jar, session.cookies, origins);
  } catch {
    throw new SafeTransportError('invalid_session_cookies');
  }
  return jar;
}

function importBrowserCookies(jar, cookies, origins) {
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.value !== 'string') continue;
    // Playwright uses `name`; tough-cookie's persisted JSON uses `key`.
    const cookieName = typeof cookie.name === 'string' ? cookie.name : cookie.key;
    if (typeof cookieName !== 'string') continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName) || /[;\r\n\0]/.test(cookie.value)) throw new Error('invalid cookie');
    const rawDomain = typeof cookie.domain === 'string' ? cookie.domain : '';
    const domain = rawDomain.replace(/^\./, '');
    const hostOnly = typeof cookie.hostOnly === 'boolean' ? cookie.hostOnly : !rawDomain.startsWith('.');
    let source;
    try { source = cookie.url ? new URL(cookie.url) : new URL(`https://${domain || [...origins][0].replace(/^https?:\/\//, '')}/`); }
    catch { continue; }
    if (!domain && !origins.has(source.origin)) continue;
    const parts = [`${cookieName}=${cookie.value}`];
    if (domain && !hostOnly) parts.push(`Domain=${cookie.domain}`);
    if (typeof cookie.path === 'string' && cookie.path.startsWith('/')) parts.push(`Path=${cookie.path}`);
    const expiry = cookie.expires instanceof Date ? cookie.expires : typeof cookie.expires === 'string' && Number.isFinite(Date.parse(cookie.expires)) ? new Date(cookie.expires) :
      Number.isFinite(cookie.expires) && cookie.expires > 0 ? new Date(cookie.expires * 1000) :
      Number.isFinite(cookie.expirationDate) && cookie.expirationDate > 0 ? new Date(cookie.expirationDate * 1000) : null;
    if (expiry) parts.push(`Expires=${expiry.toUTCString()}`);
    if (cookie.secure) parts.push('Secure');
    if (cookie.httpOnly) parts.push('HttpOnly');
    if (typeof cookie.sameSite === 'string') {
      const sameSiteValue = cookie.sameSite.toLowerCase() === 'no_restriction' ? 'none' : cookie.sameSite.toLowerCase();
      if (['strict', 'lax', 'none'].includes(sameSiteValue)) parts.push(`SameSite=${sameSiteValue[0].toUpperCase()}${sameSiteValue.slice(1)}`);
    }
    jar.setCookieSync(parts.join('; '), source.href, { ignoreError: false });
  }
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  throw new SafeTransportError('unsupported_cookie_headers', { delivery: DeliveryState.UNKNOWN });
}

async function readBoundedText(response, maxBytes, externalSignal, internalSignal, status, isTimedOut) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    let text;
    try { text = await response.text(); } catch { throw new SafeTransportError(externalSignal?.aborted ? 'aborted' : isTimedOut() ? 'timeout' : internalSignal.aborted ? 'aborted' : 'response_read_failed', { status, delivery: classifyHTTPResponse(status) }); }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new SafeTransportError('response_too_large', { status, delivery: classifyHTTPResponse(status) });
    return text;
  }
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      if (externalSignal?.aborted) throw new SafeTransportError('aborted', { status, delivery: classifyHTTPResponse(status) });
      if (isTimedOut()) throw new SafeTransportError('timeout', { status, delivery: classifyHTTPResponse(status) });
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new SafeTransportError('response_too_large', { status, delivery: classifyHTTPResponse(status) });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SafeTransportError) throw error;
    throw new SafeTransportError(externalSignal?.aborted ? 'aborted' : isTimedOut() ? 'timeout' : internalSignal.aborted ? 'aborted' : 'response_read_failed', { status, delivery: classifyHTTPResponse(status) });
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function filteredResponseHeaders(headers) {
  const output = {};
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === 'set-cookie') continue;
    output[name.toLowerCase()] = value;
  }
  return output;
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* Ignore cancellation errors; no response body is returned. */ }
}

function isRedirect(status) { return [301, 302, 303, 307, 308].includes(status); }
function deliveryForStatus(status) { return Number.isInteger(status) ? classifyHTTPResponse(status) : DeliveryState.UNKNOWN; }
