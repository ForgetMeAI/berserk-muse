/** Mail adapter boundary. All credentials are supplied per call, never stored here. */
import { fetchLatest as fetchLuuvan } from './luuvan.mjs';
import { fetchLatest as fetchGenerator } from './generator.mjs';
import { fetchLatest as fetchGmail } from './gmail.mjs';
import { fetchLatest as fetchOutlook } from './outlook.mjs';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_LINES = 100;
const API_ORIGINS = new Set(['https://luuvan.site', 'https://gmail.googleapis.com', 'https://graph.microsoft.com']);

/** Exact HTTPS host registry for import links. API hosts are separately fixed below. */
export const MAIL_HOSTS = Object.freeze({
  'luuvan.site': 'luuvan',
  'generator.email': 'generator',
  'www.generator.email': 'generator',
  'mail.google.com': 'gmail',
  'gmail.com': 'gmail',
  'outlook.live.com': 'outlook',
  'outlook.office.com': 'outlook',
  'outlook.com': 'outlook',
});

export class MailError extends Error {
  /** @param {string} code @param {string} [message] @param {{retryAfterMs?:number}} [options] */
  constructor(code, message = code, { retryAfterMs } = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = retryAfterMs;
  }
}

/** Parse one `email|https://mail-link` or `number|email|https://mail-link` row. */
export function parseImportLine(line, physicalLine = 1) {
  if (typeof line !== 'string') throw new MailError('invalid_input', `Invalid import line ${physicalLine}.`);
  const bits = line.split('|');
  let emailPart;
  let urlPart;
  if (bits.length === 2) [emailPart, urlPart] = bits;
  else if (bits.length === 3 && /^\s*\d+\s*$/.test(bits[0])) [, emailPart, urlPart] = bits;
  else throw new MailError('invalid_input', `Invalid import line ${physicalLine}.`);

  const email = normalizeEmail(emailPart);
  const url = validateMailUrl(urlPart.trim());
  const provider = MAIL_HOSTS[url.hostname];
  if (!provider) throw new MailError('unsupported_provider', `Unsupported mail URL on line ${physicalLine}.`);
  if (provider === 'luuvan' || provider === 'generator') mailboxFromUrl(provider, url, { expectedEmail: email });
  return Object.freeze({ email, emailNormalized: email, provider, mailAccessUrl: url.href, url: url.href });
}

/** Return the normalized address from a structurally valid row, for safe preview masking. */
export function extractImportEmail(line) {
  if (typeof line !== 'string') return null;
  const bits = line.split('|');
  let candidate;
  if (bits.length === 2) [candidate] = bits;
  else if (bits.length === 3 && /^\s*\d+\s*$/.test(bits[0])) [, candidate] = bits;
  else return null;
  try { return normalizeEmail(candidate); } catch { return null; }
}

/** Parse a complete newline-separated batch; blank lines are ignored. */
export function parseImport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
    throw new MailError('invalid_input', 'Import must be text no larger than 1 MiB.');
  }
  const lines = text.split(/\r?\n/).map((line, index) => ({ line, physicalLine: index + 1 })).filter(row => row.line.trim());
  if (!lines.length || lines.length > MAX_IMPORT_LINES) throw new MailError('invalid_input', 'Import must contain 1 to 100 non-empty lines.');
  return lines.map(({ line, physicalLine }) => parseImportLine(line, physicalLine));
}

/** Resolve a public mailbox link and reject conflicting address bindings. */
export function mailboxFromUrl(provider, value, { expectedEmail } = {}) {
  const url = validateMailUrl(value instanceof URL ? value.href : value);
  if (!['luuvan', 'generator'].includes(provider) || MAIL_HOSTS[url.hostname] !== provider) throw new MailError('unsupported_provider');
  const expected = expectedEmail === undefined || expectedEmail === null ? null : normalizeEmail(expectedEmail);
  const candidates = [];
  for (const key of ['email', 'inbox', 'address']) {
    for (const address of url.searchParams.getAll(key)) candidates.push(normalizeEmail(address));
  }
  const segment = url.pathname.match(/^\/([^/]+)\/?$/)?.[1];
  let decoded = '';
  try { decoded = segment ? decodeURIComponent(segment) : ''; }
  catch { throw new MailError('invalid_input', 'Mailbox URL is invalid.'); }
  if (provider === 'generator' || decoded.includes('@')) {
    if (!segment || /[\\/]/.test(decoded)) throw new MailError('invalid_input', 'Mailbox URL is invalid.');
    candidates.push(normalizeEmail(decoded));
  } else if (url.pathname !== '/' && !(segment && candidates.length)) {
    throw new MailError('invalid_input', 'Mailbox URL is invalid.');
  }
  const mailbox = expected || candidates[0];
  if (!mailbox || candidates.some(address => address !== mailbox)) throw new MailError('invalid_input', 'Mailbox URL does not match its address.');
  return mailbox;
}

/** Normalize only casing and surrounding whitespace; preserve dots and plus-tags. */
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new MailError('invalid_input', 'Email address is invalid.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@|]+@[^\s@|.]+(?:\.[^\s@|.]+)+$/.test(email)) {
    throw new MailError('invalid_input', 'Email address is invalid.');
  }
  return email;
}

/** Reject non-HTTPS, credentials, ports, IP literals, fragments and unknown hosts. */
export function validateMailUrl(value) {
  if (typeof value !== 'string') throw new MailError('invalid_input', 'Mail URL is invalid.');
  const authority = value.trim().match(/^https:\/\/([^/?#]+)/i)?.[1] || '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (/:[0-9]+$/.test(hostPort)) throw new MailError('unsupported_provider', 'Mail URL ports are not supported.');
  let url;
  try { url = new URL(value); } catch { throw new MailError('invalid_input', 'Mail URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !MAIL_HOSTS[url.hostname]) {
    throw new MailError('unsupported_provider', 'Mail URL must use a supported HTTPS host.');
  }
  if (isIpAddress(url.hostname)) throw new MailError('unsupported_provider', 'IP-address mail URLs are not supported.');
  return url;
}

/** Select an adapter using the normalized email and trusted input URL. */
export function detect(email, url) {
  const expectedEmail = normalizeEmail(email);
  const parsed = validateMailUrl(url);
  const provider = MAIL_HOSTS[parsed.hostname];
  if (!provider) throw new MailError('unsupported_provider');
  if (provider === 'luuvan' || provider === 'generator') mailboxFromUrl(provider, parsed, { expectedEmail });
  return provider;
}

/** Dispatch a single fetch to its provider adapter; auth is scoped to this call. */
export async function fetchLatest(provider, url, options = {}) {
  if (provider === 'generator') return fetchGenerator(provider, url, options);
  if (provider === 'luuvan') return fetchLuuvan(provider, url, options);
  if (provider === 'gmail') return fetchGmail(provider, url, options);
  if (provider === 'outlook') return fetchOutlook(provider, url, options);
  throw new MailError('unsupported_provider', 'Mail provider is not supported.');
}

export const MailClient = Object.freeze({ detect, fetchLatest });

/** Make an abortable request to a fixed API origin and cap the response at 1 MiB. */
export async function requestJson(url, { headers = {}, signal, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  let target;
  try { target = new URL(url); }
  catch { throw new MailError('invalid_input', 'Mail API URL is invalid.'); }
  if (!API_ORIGINS.has(target.origin) || target.protocol !== 'https:' || target.username || target.password || target.port || target.hash) {
    throw new MailError('unsupported_provider', 'Mail API origin is not supported.');
  }
  const requestTimeout = Number.isFinite(timeoutMs) ? Math.min(30_000, Math.max(100, timeoutMs)) : 15_000;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), requestTimeout);
  try {
    if (signal?.aborted) throw new MailError('aborted', 'Mail request was cancelled.');
    let response = await fetchImpl(target.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      let next;
      try { next = new URL(location, target); } catch { throw new MailError('mail_response_invalid', 'Mail service returned an unsafe redirect.'); }
      if (next.origin !== target.origin || next.protocol !== 'https:' || next.username || next.password || next.port || next.hash) {
        throw new MailError('mail_response_invalid', 'Mail service returned an unsafe redirect.');
      }
      response = await fetchImpl(next.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new MailError('mail_response_invalid', 'Mail service returned too many redirects.');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new MailError('mail_auth_failed', 'Mail authentication failed.');
      if (response.status === 429) throw new MailError('mail_rate_limited', 'Mail service asked us to retry later.', { retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) });
      throw new MailError('mail_unavailable', 'Mail service request failed.');
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new MailError('mail_response_invalid', 'Mail response exceeds the size limit.');
    const raw = await readBody(response);
    try { return JSON.parse(raw); } catch { throw new MailError('mail_response_invalid', 'Mail service returned invalid JSON.'); }
  } catch (error) {
    if (error instanceof MailError) throw error;
    if (signal?.aborted) throw new MailError('aborted', 'Mail request was cancelled.');
    if (controller.signal.aborted) throw new MailError('mail_timeout', 'Mail request timed out.');
    throw new MailError('mail_unavailable', 'Mail service is unavailable.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || !value.trim()) return 3_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(180_000, seconds * 1_000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.min(180_000, Math.max(0, dateMs - Date.now())) : 3_000;
}

async function readBody(response) {
  if (!response.body?.getReader) {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw new MailError('mail_response_invalid', 'Mail response exceeds the size limit.');
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MailError('mail_response_invalid', 'Mail response exceeds the size limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** Convert a provider date value to ISO, returning null when it is invalid. */
export function isoDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Validate a caller-provided date and return its ISO representation. */
export function sinceIso(value) {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new MailError('invalid_input', 'Mail since date is invalid.');
  return date.toISOString();
}

/** Accept a provider message-list response and return its message rows. */
export function asMessages(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.messages)) return value.messages;
  if (Array.isArray(value?.value)) return value.value;
  throw new MailError('mail_response_invalid', 'Mail service returned an invalid message list.');
}

function isIpAddress(host) {
  return host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}
