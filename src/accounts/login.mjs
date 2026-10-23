import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { MAIL_HOSTS, MailClient, normalizeEmail, parseImportLine, validateMailUrl } from '../mail/index.mjs';
import chromiumNetErrors from './chromium-net-errors.json' with { type: 'json' };
import { waitForVerification } from '../mail/verification.mjs';
import { resolveBrowserExecutable } from '../platform.mjs';
import { resolveMuseSessionVm } from '../muse/vm.mjs';

const MUSE_ORIGIN = 'https://muse.ai';
const LOGIN_DIRECTORY = 'login-browser';
const MAX_CAPTURED_HEADERS = 8192;
const MAX_OTP_RESPONSE_BYTES = 1_048_576;
const MAX_SESSION_RESPONSE_BYTES = 1_048_576;
const SAFE_MESSAGES = Object.freeze({
  invalid_account: 'Account details are invalid.',
  unsafe_workspace: 'The dedicated login workspace is unsafe.',
  login_workspace_exists: 'A previous login workspace must be removed before retrying.',
  browser_unavailable: 'Could not open the dedicated Muse login window.',
  browser_launch_failed: 'Could not start the dedicated Muse login browser.',
  browser_launch_timeout: 'Starting the dedicated Muse login browser timed out.',
  browser_permission_denied: 'The system denied permission to start the dedicated Muse login browser.',
  muse_navigation_failed: 'Could not open the Muse sign-in page.',
  muse_navigation_timeout: 'Opening the Muse sign-in page timed out.',
  muse_dns_error: 'The Muse sign-in page could not be found through DNS.',
  muse_proxy_error: 'The Muse sign-in page could not be reached through the configured proxy.',
  muse_tls_error: 'A secure connection to the Muse sign-in page could not be established.',
  login_timeout: 'Muse sign-in did not finish before the login deadline.',
  needs_user_interaction: 'Finish the visible Muse sign-in step and retry login.',
  needs_mail_auth: 'The mail provider needs its own authorization; finish verification in the visible Muse window.',
  account_mismatch: 'Muse sign-in was requested for a different email address.',
  aborted: 'Muse sign-in was cancelled.',
  muse_session_unavailable: 'Muse did not provide a valid authenticated session.',
  muse_vm_unavailable: 'Muse has not made a VM available for this account yet.',
  token_exchange_failed: 'Muse did not accept the session token request.',
  invalid_token_response: 'Muse returned an invalid session token response.',
  browser_cleanup_failed: 'The dedicated Muse login window could not be closed safely.',
});
const SAFE_PHASES = new Set(['opening_browser', 'requesting_code', 'reading_mail', 'waiting_for_user', 'saving_session']);

export class BrowserSessionError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(SAFE_MESSAGES, code) ? code : 'browser_unavailable';
    super(SAFE_MESSAGES[safeCode]);
    this.name = 'BrowserSessionError';
    this.code = safeCode;
  }
}

function fail(code) { throw new BrowserSessionError(code); }

function abortIfNeeded(signal) {
  if (signal?.aborted) fail('aborted');
}

function safeProgress(setProgress, value) {
  if (typeof setProgress !== 'function') return;
  try { setProgress(value); } catch { /* Progress observers do not control login. */ }
}

function safePhase(setPhase, value) {
  if (!SAFE_PHASES.has(value) || typeof setPhase !== 'function') return;
  try { setPhase(value); } catch { /* Phase observers do not control login. */ }
}

function validLabel(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
}

function isPermissionDenied(error) {
  if (error?.code === 'EPERM' || error?.code === 'EACCES') return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return /\b(?:operation not permitted|permission denied)\b/i.test(message) ||
    (/\bsandbox\b/i.test(message) && /\b(?:fail(?:ed|ure)?|error|denied|not permitted)\b/i.test(message));
}

function museNavigationFailureCode(error) {
  if (isTimeoutError(error)) return 'muse_navigation_timeout';
  const message = typeof error?.message === 'string' ? error.message : '';
  const exactNetErrors = [
    ['muse_dns_error', ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_DNS_TIMED_OUT', 'net::ERR_DNS_SERVER_FAILED']],
    ['muse_proxy_error', ['net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_NO_SUPPORTED_PROXIES']],
    ['muse_tls_error', ['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_CERT_INVALID', 'net::ERR_CERT_REVOKED', 'net::ERR_SSL_PROTOCOL_ERROR', 'net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH']],
  ];
  for (const [code, markers] of exactNetErrors) {
    if (markers.some(marker => message.includes(marker))) return code;
  }
  return 'muse_navigation_failed';
}

const SAFE_DIAGNOSTIC_REASONS = new Set([
  ...chromiumNetErrors,
  'timeout', 'permission_denied', 'context_closed', 'interrupted_navigation', 'unknown',
]);
const SAFE_NAV_PAGE_STATES = new Set(['muse', 'muse_auth', 'provider_auth', 'browser_error', 'blank', 'other', 'closed', 'invalid']);
const SAFE_NAV_ERROR_TYPES = new Set(['Error', 'TypeError', 'ReferenceError', 'TimeoutError', 'TargetClosedError', 'other']);
const SAFE_NAV_ERROR_WORDS = Object.freeze([
  'invalid', 'argument', 'not', 'function', 'undefined', 'properties', 'protocol', 'crash',
  'download', 'navigation', 'interrupted', 'policy', 'permission', 'denied', 'blocked',
  'restricted', 'unsupported', 'api', 'playwright', 'proxy', 'certificate', 'net', 'error',
  'closed', 'timeout',
]);
const SAFE_OTP_BODY_KINDS = new Set(['object', 'array', 'other', 'unavailable']);
const SAFE_OTP_STATUS_FLAGS = new Set(['ok', 'success', 'error', 'failed', 'other', 'absent']);
const SAFE_EMAIL_OUTCOMES = new Set([
  'submitted', 'button_missing', 'button_ambiguous', 'button_hidden', 'button_disabled',
  'fill_failed', 'email_not_retained', 'click_failed', 'cancelled', 'page_changed', 'input_not_ready',
]);
const SAFE_EMAIL_BUTTON_COUNTS = new Set(['none', 'one', 'many']);
const SAFE_VERIFICATION_OUTCOMES = new Set([
  'ready', 'verification_timeout', 'needs_mail_auth', 'mail_timeout', 'mail_unavailable',
  'mail_auth_failed', 'mail_response_invalid', 'mail_rate_limited', 'aborted', 'unknown',
]);
const SAFE_VERIFICATION_FAILURES = new Set([...SAFE_VERIFICATION_OUTCOMES].filter(outcome => outcome !== 'ready'));
const SAFE_OTP_SUBMIT_OUTCOMES = new Set([
  'submitted', 'submitted_enter', 'input_missing', 'input_ambiguous', 'input_hidden', 'input_disabled',
  'input_value_changed', 'button_unavailable', 'interaction_required', 'auto_verifying', 'failed', 'cancelled',
]);

function diagnosticReason(error, deadlineExpired = false) {
  if (deadlineExpired || isTimeoutError(error)) return 'timeout';
  if (isPermissionDenied(error)) return 'permission_denied';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/Target page, context or browser has been closed/i.test(message)) return 'context_closed';
  if (/\bnavigation\b.{0,256}\binterrupted by another navigation\b/i.test(message)) return 'interrupted_navigation';
  const netError = message.match(/\bnet::(ERR_[A-Z0-9_]+)\b/);
  if (netError && chromiumNetErrors.includes(netError[1])) return netError[1];
  return 'unknown';
}

function pageIsClosed(page, error) {
  if (diagnosticReason(error) === 'context_closed') return true;
  try { return typeof page?.isClosed === 'function' && page.isClosed(); }
  catch { return true; }
}

function navigationPageState(page, error) {
  if (diagnosticReason(error) === 'context_closed') return 'closed';
  try {
    if (typeof page?.isClosed === 'function' && page.isClosed()) return 'closed';
  } catch { return 'closed'; }
  let rawUrl;
  try { rawUrl = page?.url?.(); }
  catch { return 'invalid'; }
  if (typeof rawUrl !== 'string' || !rawUrl) return 'invalid';
  if (rawUrl === 'about:blank') return 'blank';
  let url;
  try { url = new URL(rawUrl); }
  catch { return 'invalid'; }
  if (url.protocol === 'chrome-error:' || url.hostname === 'chromewebdata') return 'browser_error';
  if (url.origin === MUSE_ORIGIN) return 'muse';
  if (url.protocol === 'https:' && url.hostname === 'auth.muse.ai') return 'muse_auth';
  if (url.protocol === 'https:' && ['www.facebook.com', 'm.facebook.com'].includes(url.hostname)) return 'provider_auth';
  if (url.protocol === 'about:' && url.pathname === 'blank') return 'blank';
  return 'other';
}

function diagnosticErrorType(error) {
  let rawName;
  try { rawName = error?.name; } catch { return 'other'; }
  return SAFE_NAV_ERROR_TYPES.has(rawName) ? rawName : 'other';
}

function diagnosticSignals(error) {
  let message = '';
  try { message = typeof error?.message === 'string' ? error.message : ''; } catch { return Object.freeze([]); }
  const found = SAFE_NAV_ERROR_WORDS.filter(word => new RegExp(`\\b${word}\\b`, 'i').test(message));
  return Object.freeze(found);
}

function safeDiagnostic(onDiagnostic, stage, reason, navigation = null) {
  if (typeof onDiagnostic !== 'function') return;
  if (stage === 'otp_response') {
    const { httpStatus, bodyKind, successFlag, statusFlag, hasError } = navigation || {};
    if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599 || !SAFE_OTP_BODY_KINDS.has(bodyKind) ||
        !(successFlag === true || successFlag === false || successFlag === null) || !SAFE_OTP_STATUS_FLAGS.has(statusFlag) ||
        typeof hasError !== 'boolean') return;
    try { onDiagnostic(Object.freeze({ stage, httpStatus, bodyKind, successFlag, statusFlag, hasError })); }
    catch { /* Diagnostics do not control login. */ }
    return;
  }
  if (stage === 'session_response') {
    const { httpStatus, bodyParsed, endpointPresent, vmIdPresent, vmNamePresent, accepted, vmUnavailable } = navigation || {};
    if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599 ||
        ![bodyParsed, endpointPresent, vmIdPresent, vmNamePresent, accepted, vmUnavailable].every(value => typeof value === 'boolean')) return;
    try { onDiagnostic(Object.freeze({ stage, httpStatus, bodyParsed, endpointPresent, vmIdPresent, vmNamePresent, accepted, vmUnavailable })); }
    catch { /* Diagnostics do not control login. */ }
    return;
  }
  if (stage === 'email_submit') {
    const { outcome, buttonCount, buttonVisible, buttonEnabled, emailMatches } = navigation || {};
    if (!SAFE_EMAIL_OUTCOMES.has(outcome) || !SAFE_EMAIL_BUTTON_COUNTS.has(buttonCount) ||
        !(buttonVisible === true || buttonVisible === false || buttonVisible === null) ||
        !(buttonEnabled === true || buttonEnabled === false || buttonEnabled === null) ||
        !(emailMatches === true || emailMatches === false || emailMatches === null)) return;
    try { onDiagnostic(Object.freeze({ stage, outcome, buttonCount, buttonVisible, buttonEnabled, emailMatches })); }
    catch { /* Diagnostics do not control login. */ }
    return;
  }
  if (stage === 'verification' || stage === 'otp_submit') {
    const { outcome } = navigation || {};
    const allowed = stage === 'verification' ? SAFE_VERIFICATION_OUTCOMES : SAFE_OTP_SUBMIT_OUTCOMES;
    if (!allowed.has(outcome)) return;
    try { onDiagnostic(Object.freeze({ stage, outcome })); }
    catch { /* Diagnostics do not control login. */ }
    return;
  }
  if (!['launch', 'navigation'].includes(stage) || !SAFE_DIAGNOSTIC_REASONS.has(reason)) return;
  if (stage === 'navigation' && navigation) {
    const { pageState, errorType, signals } = navigation;
    if (!SAFE_NAV_PAGE_STATES.has(pageState) || !SAFE_NAV_ERROR_TYPES.has(errorType) ||
        !Array.isArray(signals) || signals.some(word => !SAFE_NAV_ERROR_WORDS.includes(word))) return;
    try { onDiagnostic(Object.freeze({ stage, reason, pageState, errorType, signals })); }
    catch { /* Diagnostics do not control login. */ }
    return;
  }
  try { onDiagnostic(Object.freeze({ stage, reason })); } catch { /* Diagnostics do not control login. */ }
}

function nonemptyErrorValue(value) {
  if (value === null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

async function otpResponseDiagnostic(response, { timeoutMs = 5_000, signal } = {}) {
  let httpStatus;
  try { httpStatus = response.status(); } catch { return null; }
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) return null;
  let body = null;
  let bodyKind = 'unavailable';
  const startedAt = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
  const readBounded = operation => boundedOperation(operation, Math.min(5_000, remaining()), signal);
  try {
    const headersResult = typeof response.headers === 'function'
      ? await readBounded(() => response.headers()) : { kind: 'value', value: {} };
    if (headersResult.kind === 'aborted') return null;
    const headers = headersResult.kind === 'value' ? headersResult.value : null;
    const hasContentLength = headers && Object.hasOwn(headers, 'content-length');
    const rawContentLength = hasContentLength ? headers['content-length'] : undefined;
    const contentLength = typeof rawContentLength === 'string' && /^\d{1,10}$/.test(rawContentLength)
      ? Number(rawContentLength) : Number.NaN;
    if (hasContentLength && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_OTP_RESPONSE_BYTES)) {
      // An invalid or oversized declared length is not safe to read.
    } else if (hasContentLength && typeof response.json === 'function') {
      const jsonResult = await readBounded(() => response.json());
      if (jsonResult.kind === 'aborted') return null;
      if (jsonResult.kind === 'value') {
        body = jsonResult.value;
        bodyKind = Array.isArray(body) ? 'array' : body && typeof body === 'object' ? 'object' : 'other';
      }
    } else if (headersResult.kind === 'value' && !hasContentLength && typeof response.body === 'function') {
      const bodyResult = await readBounded(() => response.body());
      if (bodyResult.kind === 'aborted') return null;
      if (bodyResult.kind === 'value') {
        const bytes = bodyResult.value;
        if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
          if (bytes.byteLength <= MAX_OTP_RESPONSE_BYTES) {
            try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); }
            catch { bodyKind = 'other'; }
            if (bodyKind !== 'other') {
              bodyKind = Array.isArray(body) ? 'array' : body && typeof body === 'object' ? 'object' : 'other';
            }
          }
        }
      }
    }
  } catch { body = null; bodyKind = 'unavailable'; }
  if (signal?.aborted) return null;
  const objectBody = body && typeof body === 'object' ? body : null;
  let successFlag = null;
  if (objectBody && Object.hasOwn(objectBody, 'success') && typeof objectBody.success === 'boolean') {
    successFlag = objectBody.success;
  }
  let statusFlag = 'absent';
  if (objectBody && Object.hasOwn(objectBody, 'status') && typeof objectBody.status === 'string') {
    const status = objectBody.status.trim().toLowerCase();
    statusFlag = ['ok', 'success', 'error', 'failed'].includes(status) ? status : 'other';
  }
  const hasError = Boolean(objectBody && ['error', 'errors'].some(key =>
    Object.hasOwn(objectBody, key) && nonemptyErrorValue(objectBody[key]),
  ));
  return { httpStatus, bodyKind, successFlag, statusFlag, hasError };
}

function validateAccount(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) fail('invalid_account');
  const id = account.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    fail('invalid_account');
  }
  let email;
  let mailUrl;
  try {
    email = normalizeEmail(account.email);
    mailUrl = validateMailUrl(account.mailAccessUrl);
  } catch { fail('invalid_account'); }
  const providerAllowed = ['luuvan', 'gmail', 'outlook', 'generator'].includes(account.provider);
  if (!providerAllowed || MAIL_HOSTS[mailUrl.hostname] !== account.provider) {
    fail('invalid_account');
  }
  if (account.provider === 'generator' || account.provider === 'luuvan') {
    try {
      const parsed = parseImportLine(`${email}|${mailUrl.href}`);
      if (parsed.provider !== account.provider || parsed.email !== email) fail('invalid_account');
    } catch { fail('invalid_account'); }
  }
  const deviceId = account.deviceId === undefined ? randomUUID() : account.deviceId;
  if (!validLabel(deviceId)) fail('invalid_account');
  return { id, email, provider: account.provider, mailAccessUrl: mailUrl.href, deviceId };
}

async function ensurePrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  if (absolute === path.parse(absolute).root) fail('unsafe_workspace');
  const segments = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error?.code !== 'ENOENT') fail('unsafe_workspace');
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') fail('unsafe_workspace'); }
      try { stat = await lstat(current); } catch { fail('unsafe_workspace'); }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_workspace');
  }
  try { await chmod(absolute, 0o700); }
  catch { fail('unsafe_workspace'); }
  return absolute;
}

async function createLoginDirectory(accountDir) {
  const profileDir = path.join(accountDir, LOGIN_DIRECTORY);
  let created = false;
  try {
    await mkdir(profileDir, { mode: 0o700 });
    created = true;
    const stat = await lstat(profileDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_workspace');
    await chmod(profileDir, 0o700);
    const actual = await realpath(profileDir);
    if (actual !== profileDir) fail('unsafe_workspace');
  } catch (error) {
    if (created) {
      try {
        const stat = await lstat(profileDir);
        if (!stat.isSymbolicLink() && stat.isDirectory() && await realpath(profileDir) === profileDir) {
          await rm(profileDir, { recursive: true, force: false });
        }
      } catch { /* Do not remove a path that cannot be proven to be ours. */ }
    }
    if (error?.code === 'EEXIST') fail('login_workspace_exists');
    if (error instanceof BrowserSessionError) throw error;
    fail('unsafe_workspace');
  }
  return profileDir;
}

async function removeLoginDirectory(profileDir) {
  if (!profileDir) return;
  try {
    const stat = await lstat(profileDir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(profileDir) !== profileDir) {
      fail('unsafe_workspace');
    }
    await rm(profileDir, { recursive: true, force: false });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof BrowserSessionError) throw error;
    fail('unsafe_workspace');
  }
}

async function loadChromium(chromium) {
  if (chromium) return chromium.chromium || chromium.default?.chromium || chromium.default || chromium;
  const module = await import('playwright-core');
  return module.chromium || module.default?.chromium || module.default;
}

function pickHeaders(headers) {
  const selected = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = rawName.toLowerCase();
    if (name === 'cookie' || name === 'set-cookie' || /(?:authorization|token|secret|password)/i.test(name)) continue;
    if (!/^(?:user-agent|sec-fetch-[a-z0-9-]+|sec-ch-[a-z0-9-]+|origin|referer|accept|content-type|x-hatch-[a-z0-9-]+)$/.test(name)) continue;
    if (typeof rawValue !== 'string' || rawValue.length > MAX_CAPTURED_HEADERS || /[\r\n\u0000]/.test(rawValue)) continue;
    if (name === 'referer') {
      try {
        const referer = new URL(rawValue);
        if (referer.origin !== MUSE_ORIGIN) continue;
        selected[name] = `${referer.origin}${referer.pathname}`;
      } catch { continue; }
    } else {
      selected[name] = rawValue;
    }
  }
  return selected;
}

function sessionFields(body, resolution = resolveMuseSessionVm(body, { allowLegacyDirect: true })) {
  return resolution.kind === 'vm' ? resolution.descriptor : null;
}

function containsOfficialToken(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return ['token', 'accessToken', 'access_token', 'gateway_token'].some(key =>
    typeof data[key] === 'string' && data[key].trim().length > 0 && data[key].length <= 262_144,
  );
}

function isMuseSessionResponse(response) {
  try {
    const url = new URL(response.url());
    return url.origin === MUSE_ORIGIN && url.pathname === '/api/session' && response.request().method() === 'GET';
  } catch { return false; }
}

async function boundedOperation(operation, timeoutMs, signal) {
  if (signal?.aborted) return { kind: 'aborted' };
  let timer;
  let abortHandler;
  const operationPromise = Promise.resolve().then(operation).then(
    value => ({ kind: 'value', value }),
    () => ({ kind: 'error' }),
  );
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(1, timeoutMs));
  });
  const abortPromise = new Promise(resolve => {
    abortHandler = () => resolve({ kind: 'aborted' });
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
  try { return await Promise.race([operationPromise, timeoutPromise, abortPromise]); }
  finally {
    clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  }
}

function capturedSessionPayload(httpStatus, body, bodyParsed, headers = {}) {
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) return null;
  if (httpStatus !== 200) return {
    upstream: null, headers,
    vmUnavailable: false,
    diagnostic: { httpStatus, bodyParsed: false, endpointPresent: false, vmIdPresent: false, vmNamePresent: false, accepted: false, vmUnavailable: false },
  };
  const objectBody = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const records = Array.isArray(objectBody?.vms) ? objectBody.vms.filter(item => item && typeof item === 'object') : [];
  const resolution = bodyParsed ? resolveMuseSessionVm(body, { allowLegacyDirect: true }) : { kind: 'unknown' };
  const upstream = bodyParsed ? sessionFields(body, resolution) : null;
  return {
    upstream,
    headers,
    vmUnavailable: resolution.kind === 'unavailable',
    diagnostic: {
      httpStatus, bodyParsed,
      endpointPresent: Boolean(objectBody && (Object.hasOwn(objectBody, 'endpoint_url') || records.some(item => Object.hasOwn(item, 'endpoint_url')))),
      vmIdPresent: Boolean(objectBody && (Object.hasOwn(objectBody, 'vm_id') || records.some(item => Object.hasOwn(item, 'vm_id')))),
      vmNamePresent: Boolean(objectBody && (Object.hasOwn(objectBody, 'vm_name') || records.some(item =>
        ['vm_name', 'name', 'vmName'].some(key => Object.hasOwn(item, key))))),
      accepted: Boolean(upstream),
      vmUnavailable: resolution.kind === 'unavailable',
    },
  };
}

async function captureSession(response, { timeoutMs, signal } = {}) {
  let httpStatus;
  try { httpStatus = response.status(); } catch { return null; }
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) return null;
  let headers = {};
  if (httpStatus === 200) {
    const headerResult = await boundedOperation(
      () => response.request().allHeaders(), Math.min(1_000, Math.max(1, timeoutMs)), signal,
    );
    if (headerResult.kind === 'aborted') return null;
    if (headerResult.kind === 'value') headers = pickHeaders(headerResult.value);
  }
  if (httpStatus !== 200) return capturedSessionPayload(httpStatus, null, false, headers);
  const jsonResult = await boundedOperation(() => response.json(), timeoutMs, signal);
  if (jsonResult.kind === 'aborted') return null;
  return capturedSessionPayload(httpStatus, jsonResult.value, jsonResult.kind === 'value', headers);
}

function sendOtpRequest(request) {
  try {
    const url = new URL(request.url());
    return url.origin === MUSE_ORIGIN && url.pathname === '/api/auth/native/send-otp' && request.method() === 'POST';
  } catch { return false; }
}

function requestContactPoint(request) {
  try {
    let body;
    try { body = request.postDataJSON(); } catch {
      const raw = request.postData();
      if (typeof raw === 'string') {
        try { body = JSON.parse(raw); }
        catch { body = Object.fromEntries(new URLSearchParams(raw)); }
      }
    }
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'contact_point')) return { present: false, value: null };
    return { present: true, value: body.contact_point };
  } catch { return { present: false, value: null }; }
}

function accountMismatchRequest(request, expectedEmail) {
  if (!sendOtpRequest(request)) return false;
  const contact = requestContactPoint(request);
  if (!contact.present || typeof contact.value !== 'string') return true;
  return contact.value !== expectedEmail;
}

function sendOtpResponse(response, expectedEmail) {
  try {
    const status = response.status();
    if (!Number.isInteger(status) || status < 100 || status > 599) return null;
    const request = response.request();
    const url = new URL(response.url());
    if (url.origin !== MUSE_ORIGIN || url.pathname !== '/api/auth/native/send-otp' || request.method() !== 'POST') return null;
    const contact = requestContactPoint(request);
    return {
      matched: contact.present && typeof contact.value === 'string' && contact.value === expectedEmail,
      accepted: status >= 200 && status < 300,
    };
  } catch { return null; }
}

async function inspectManualStep(page) {
  try {
    return await page.evaluate(() => {
      const visible = element => Boolean(element && (element.getClientRects().length || element.offsetWidth || element.offsetHeight));
      const captcha = [...document.querySelectorAll('iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [data-sitekey]')].some(visible);
      const terms = [...document.querySelectorAll('input[type="checkbox"]')].some(input => {
        if (!visible(input)) return false;
        const text = `${input.getAttribute('aria-label') || ''} ${input.labels ? [...input.labels].map(label => label.textContent || '').join(' ') : ''}`;
        return /terms|agree|условия|соглас/i.test(text);
      });
      const otp = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[role="textbox"], input')].some(input => {
        if (!visible(input)) return false;
        if ((input.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') return true;
        const label = `${input.getAttribute('aria-label') || ''} ${input.getAttribute('placeholder') || ''} ${input.labels ? [...input.labels].map(item => item.textContent || '').join(' ') : ''}`;
        return /(?:code|код)/i.test(label) && (input.getAttribute('role') === 'textbox' || input.tagName === 'INPUT');
      });
      const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
      const accept = [...document.querySelectorAll('button, a, [role="button"]')].some(element =>
        visible(element) && /^(accept|agree|i agree|принимаю|согласен|согласна)$/i.test((element.innerText || element.textContent || '').trim()),
      );
      const signIn = [...document.querySelectorAll('button, a, [role="button"]')].some(element =>
        visible(element) && /^(sign in|log in|войти|авторизация)$/i.test((element.innerText || element.textContent || '').trim()),
      );
      return { captcha, terms, otp, password, accept, signIn };
    });
  } catch { return { captcha: false, terms: false, otp: false, password: false, accept: false, signIn: false }; }
}

const EMAIL_LABEL = /(?:e-?mail|электрон|почт)/i;
const OTP_LABEL = /(?:code|код)/i;
const CONTINUE_LABEL = /^(?:continue|next|продолжить|далее)$/i;

async function discoverEmailInput(page) {
  const candidates = [
    page.getByRole('textbox', { name: EMAIL_LABEL }),
    page.locator('input[type="email"]:visible'),
    page.locator('input[autocomplete="username"]:visible'),
  ];
  for (const candidate of candidates) {
    try {
      const count = await candidate.count();
      if (count > 0) return { locator: candidate, count };
    } catch { /* Try the next narrow email-specific locator. */ }
  }
  return { locator: null, count: 0 };
}

async function discoverOtpInput(page) {
  const candidates = [
    page.locator('input[autocomplete="one-time-code"]:visible'),
    page.getByRole('textbox', { name: OTP_LABEL }),
  ];
  for (const candidate of candidates) {
    try {
      const count = await candidate.count();
      if (count > 0) return { locator: candidate, count };
    } catch { /* Try the accessible security-code name fallback. */ }
  }
  return { locator: null, count: 0 };
}

async function waitForEmailInputReady(input, { deadline, clock, sleep, signal, canAutoFill }) {
  const readinessDeadline = Math.min(deadline, clock() + 3_000);
  while (clock() < readinessDeadline) {
    if (signal?.aborted || !canAutoFill()) return false;
    try {
      if (!input || await input.count() !== 1) return false;
      if (typeof input.isVisible === 'function' && !await input.isVisible()) {
        await sleep(Math.min(50, readinessDeadline - clock()), signal);
        continue;
      }
      if (typeof input.isEditable === 'function' && !await input.isEditable()) {
        await sleep(Math.min(50, readinessDeadline - clock()), signal);
        continue;
      }
      // React exposes its installed input handlers on the DOM node after hydration.
      // Inspect only their presence; never read the element value or handler data here.
      if (typeof input.evaluate === 'function') {
        const result = await boundedOperation(() => input.evaluate(element => {
          for (let node = element, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
            for (const key of Object.keys(node)) {
              if (!/^__react(?:Props|EventHandlers)\$/.test(key)) continue;
              const props = node[key];
              if (props && typeof props === 'object' &&
                  ['onChange', 'onInput'].some(name => typeof props[name] === 'function')) return true;
            }
          }
          return false;
        }), Math.min(250, readinessDeadline - clock()), signal);
        if (result.kind === 'aborted') return false;
        if (result.kind !== 'value' || result.value !== true) {
          await sleep(Math.min(50, readinessDeadline - clock()), signal);
          continue;
        }
      }
      return true;
    } catch {
      if (signal?.aborted || !canAutoFill()) return false;
      await sleep(Math.min(50, readinessDeadline - clock()), signal).catch(() => {});
    }
  }
  return false;
}

async function tryFillEmail(page, email, input, canAutoFill, { deadline, clock, sleep, signal }) {
  let current = { outcome: 'fill_failed', buttonCount: 'none', buttonVisible: null, buttonEnabled: null };
  let fillAttempted = false;
  const setOutcome = (name, buttonCount = 'none', buttonVisible = null, buttonEnabled = null) => {
    current = { outcome: name, buttonCount, buttonVisible, buttonEnabled };
  };
  const onMuse = () => {
    try { return new URL(page.url()).origin === MUSE_ORIGIN; }
    catch { return false; }
  };
  try {
    if (!onMuse()) setOutcome('page_changed');
    else if (!canAutoFill()) setOutcome('cancelled');
    else if (!await waitForEmailInputReady(input, { deadline, clock, sleep, signal, canAutoFill })) {
      setOutcome(signal?.aborted || !canAutoFill() ? 'cancelled' : 'input_not_ready');
    }
    else {
      fillAttempted = true;
      let fillSucceeded = false;
      try {
        if (typeof input.pressSequentially === 'function') {
          await input.fill('');
          if (canAutoFill() && onMuse()) {
            await input.pressSequentially(email, { delay: 20, timeout: 10_000 });
            fillSucceeded = true;
          } else setOutcome(canAutoFill() ? 'page_changed' : 'cancelled');
        } else {
          await input.fill(email);
          fillSucceeded = true;
        }
      }
      catch { setOutcome(canAutoFill() ? 'fill_failed' : 'cancelled'); }
      if (fillSucceeded) {
        try {
          if (!canAutoFill()) setOutcome('cancelled');
          else if (!onMuse()) setOutcome('page_changed');
          else {
            const buttons = page.getByRole('button', { name: CONTINUE_LABEL });
            let buttonCount;
            try { buttonCount = await buttons.count(); }
            catch { buttonCount = 0; setOutcome('button_missing'); }
            if (current.outcome === 'fill_failed') {
              if (buttonCount === 0) setOutcome('button_missing');
              else if (buttonCount !== 1) setOutcome('button_ambiguous', 'many');
              else {
                let visible;
                try { visible = typeof buttons.isVisible === 'function' ? await buttons.isVisible() : false; }
                catch { visible = false; }
                if (!visible) setOutcome('button_hidden', 'one', false);
                else {
                  let enabled = null;
                  try {
                    if (typeof buttons.isEnabled === 'function') {
                      const enabledDeadline = Math.min(deadline, clock() + 1_500);
                      do {
                        const value = await buttons.isEnabled();
                        enabled = typeof value === 'boolean' ? value : null;
                        if (enabled !== false || !canAutoFill() || !onMuse()) break;
                        await sleep(Math.min(50, enabledDeadline - clock()), signal);
                      } while (clock() < enabledDeadline);
                    }
                  } catch { enabled = null; }
                  if (!canAutoFill()) setOutcome('cancelled', 'one', true, enabled);
                  else if (!onMuse()) setOutcome('page_changed', 'one', true, enabled);
                  else {
                    try {
                      let emailRetained = true;
                      if (typeof input.inputValue === 'function') {
                        try { emailRetained = (await input.inputValue({ timeout: 1_000 })) === email; }
                        catch { emailRetained = false; }
                      }
                      if (!canAutoFill()) setOutcome('cancelled', 'one', true, enabled);
                      else if (!onMuse()) setOutcome('page_changed', 'one', true, enabled);
                      else if (!emailRetained) setOutcome('email_not_retained', 'one', true, enabled);
                      else if (enabled === false) setOutcome('button_disabled', 'one', true, false);
                      else {
                        await buttons.click({ timeout: 5_000 });
                        setOutcome('submitted', 'one', true, true);
                      }
                    } catch {
                      if (!canAutoFill()) setOutcome('cancelled', 'one', true, enabled);
                      else {
                        let finalEnabled = null;
                        try {
                          if (typeof buttons.isEnabled === 'function') {
                            const value = await buttons.isEnabled();
                            finalEnabled = typeof value === 'boolean' ? value : null;
                          }
                        } catch { /* Keep the safe unknown state. */ }
                        setOutcome(finalEnabled === false ? 'button_disabled' : 'click_failed', 'one', true, finalEnabled);
                      }
                    }
                  }
                }
              }
            }
          }
        } catch { setOutcome(canAutoFill() ? 'click_failed' : 'cancelled'); }
      }
    }
  } catch { setOutcome(canAutoFill() ? 'fill_failed' : 'cancelled'); }
  let emailMatches = null;
  if (fillAttempted && typeof input?.inputValue === 'function') {
    try { emailMatches = (await input.inputValue({ timeout: 1_000 })) === email; }
    catch { emailMatches = null; }
  }
  return { ...current, emailMatches };
}

async function sleepDefault(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new BrowserSessionError('aborted'));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new BrowserSessionError('aborted')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function evaluateWithTimeout(page, callback, args, timeoutMs, signal) {
  let timer;
  let abortHandler;
  if (signal?.aborted) throw new BrowserSessionError('aborted');
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BrowserSessionError('token_exchange_failed')), timeoutMs);
        abortHandler = () => reject(new BrowserSessionError('aborted'));
        signal?.addEventListener('abort', abortHandler, { once: true });
      }),
      Promise.resolve().then(() => page.evaluate(callback, args)),
    ]);
  } finally {
    clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  }
}

function validatedCookies(cookies) {
  if (!Array.isArray(cookies)) fail('muse_session_unavailable');
  return cookies.map(cookie => {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
        typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') fail('muse_session_unavailable');
    return {
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: Number.isFinite(cookie.expires) ? cookie.expires : -1,
      httpOnly: cookie.httpOnly === true, secure: cookie.secure === true,
      sameSite: ['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? cookie.sameSite : 'Lax',
    };
  });
}

export class BrowserSessionBootstrapper {
  constructor({ chromium = null, browserExecutable = resolveBrowserExecutable(), mailClient = MailClient, rootDir, timeoutMs = 180_000, manualTimeoutMs = 600_000, pollMs = 1_000, onDiagnostic = null,
    clock = Date.now, sleep = sleepDefault, allowedSenders = ['notification@email.meta.com'] } = {}) {
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir) || typeof clock !== 'function' || typeof sleep !== 'function' ||
        !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000 ||
        !Number.isFinite(manualTimeoutMs) || manualTimeoutMs < 1 || manualTimeoutMs > 600_000 ||
        !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 30_000 ||
        !mailClient || typeof mailClient.fetchLatest !== 'function' || !Array.isArray(allowedSenders) || allowedSenders.length > 20) {
      throw new TypeError('Invalid browser session bootstrapper configuration.');
    }
    let normalizedSenders;
    try { normalizedSenders = [...new Set(allowedSenders.map(normalizeEmail))]; }
    catch { throw new TypeError('Invalid browser session bootstrapper configuration.'); }
    this.chromium = chromium;
    this.browserExecutable = browserExecutable;
    this.mailClient = mailClient;
    this.allowedSenders = Object.freeze(normalizedSenders);
    this.rootDir = path.resolve(rootDir);
    this.timeoutMs = timeoutMs;
    this.manualTimeoutMs = manualTimeoutMs;
    this.pollMs = pollMs;
    this.clock = clock;
    this.sleep = sleep;
    this.onDiagnostic = onDiagnostic;
  }

  async login(account, { signal, setProgress, setPhase } = {}) {
    const validated = validateAccount(account);
    if (typeof this.mailClient.detect === 'function') {
      try { if (this.mailClient.detect(validated.email, validated.mailAccessUrl) !== validated.provider) fail('invalid_account'); }
      catch (error) { if (error instanceof BrowserSessionError) throw error; fail('invalid_account'); }
    }
    abortIfNeeded(signal);
    const autoDeadline = this.clock() + this.timeoutMs;
    let deadline = autoDeadline;
    const rootDir = await ensurePrivateDirectory(this.rootDir);
    const accountDir = await ensurePrivateDirectory(path.join(rootDir, validated.id));
    const profileDir = await createLoginDirectory(accountDir);
    const verificationController = new AbortController();
    const relayVerificationAbort = () => verificationController.abort();
    signal?.addEventListener('abort', relayVerificationAbort, { once: true });
    let context = null;
    let page = null;
    let result = null;
    let failure = null;
    let navigationFailureCode = null;
    let routeHandler = null;
    let responseHandler = null;
    let abortHandler = null;
    let contextClosePromise = null;
    let otpWaitStarted = false;
    let otpSentAt = null;
    let verificationState = 'idle';
    let verificationIssue = null;
    let verificationCode = '';
    let otpSubmitted = false;
    let otpFilled = false;
    let lastSessionProbeAt = null;
    const captureTasks = [];
    let capturedSession = null;
    let capturedSessionHeaders = {};
    let vmUnavailableObserved = false;
    let accountMismatch = false;
    let manualMode = false;
    let manualActivated = false;
    let mailTabOpened = false;
    let contextFinalized = false;
    const otpDiagnosticResponses = new WeakSet();
    const sessionDiagnosticShapes = new Set();
    let sessionFailureDiagnosticCount = 0;
    let vmUnavailableDiagnosticReported = false;
    let verificationDiagnosticReported = false;
    const otpSubmitDiagnosticOutcomes = new Set();

    const reportVerificationOutcome = outcome => {
      if (verificationDiagnosticReported || contextFinalized || signal?.aborted) return;
      verificationDiagnosticReported = true;
      safeDiagnostic(this.onDiagnostic, 'verification', null, { outcome });
    };
    const reportOtpSubmitOutcome = outcome => {
      if (contextFinalized || signal?.aborted || otpSubmitDiagnosticOutcomes.has(outcome)) return;
      otpSubmitDiagnosticOutcomes.add(outcome);
      safeDiagnostic(this.onDiagnostic, 'otp_submit', null, { outcome });
    };

    const reportOtpResponse = response => {
      if (!response || (typeof response !== 'object' && typeof response !== 'function') || otpDiagnosticResponses.has(response)) return;
      otpDiagnosticResponses.add(response);
      const diagnosticTimeoutMs = Math.min(5_000, Math.max(1, deadline - this.clock()));
      void otpResponseDiagnostic(response, { timeoutMs: diagnosticTimeoutMs, signal }).then(metadata => {
        if (!metadata || contextFinalized || signal?.aborted) return;
        try { if (typeof page?.isClosed === 'function' && page.isClosed()) return; }
        catch { return; }
        safeDiagnostic(this.onDiagnostic, 'otp_response', null, metadata);
      }).catch(() => {});
    };

    const reportSessionResponse = metadata => {
      if (!metadata || contextFinalized || signal?.aborted) return;
      const shape = JSON.stringify(metadata);
      if (sessionDiagnosticShapes.has(shape) || sessionDiagnosticShapes.size >= 3) return;
      const reportUnavailableOnce = metadata.vmUnavailable && !vmUnavailableDiagnosticReported;
      if (!metadata.accepted && sessionFailureDiagnosticCount >= 2 && !reportUnavailableOnce) return;
      sessionDiagnosticShapes.add(shape);
      if (!metadata.accepted) sessionFailureDiagnosticCount++;
      if (reportUnavailableOnce) vmUnavailableDiagnosticReported = true;
      safeDiagnostic(this.onDiagnostic, 'session_response', null, metadata);
    };

    const enterManualMode = async () => {
      if (!manualActivated) {
        manualActivated = true;
        manualMode = true;
        verificationCode = '';
        verificationState = 'manual';
        deadline = this.clock() + this.manualTimeoutMs;
        verificationController.abort();
      }
      safePhase(setPhase, 'waiting_for_user');
      if (!mailTabOpened && context) {
        mailTabOpened = true;
        try {
          const mailPage = await context.newPage();
          if (mailPage && typeof mailPage.goto === 'function') {
            await mailPage.goto(validated.mailAccessUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          }
        } catch { /* Mail navigation is optional; the Muse window remains usable. */ }
        try { await page?.bringToFront?.(); } catch { /* Keep the primary Muse page in front when possible. */ }
      }
    };

    const startOtpWait = sentAt => {
      otpSentAt = sentAt;
      verificationState = 'waiting';
      safePhase(setPhase, 'reading_mail');
      const startDate = new Date(sentAt);
      const sinceDate = new Date(Math.max(0, sentAt - 1));
      const sourceMailClient = this.mailClient;
      const boundedMailClient = {
        async fetchLatest(provider, url, options = {}) {
          const messages = await sourceMailClient.fetchLatest(provider, url, {
            ...options, signal: verificationController.signal, since: sinceDate.toISOString(), expectedEmail: validated.email,
          });
          if (!Array.isArray(messages)) return [];
          return messages.filter(message => {
            const receivedAt = Date.parse(message?.receivedAt || '');
            return Number.isFinite(receivedAt) && receivedAt >= sentAt && message?.to === validated.email;
          });
        },
      };
      const mailClient = boundedMailClient;
      const polling = waitForVerification({
        email: validated.email, recipient: validated.email, provider: validated.provider,
        url: validated.mailAccessUrl, startedAt: startDate,
        allowedSenders: this.allowedSenders, otpPattern: /\b([0-9]{6})\b/,
      }, { signal: verificationController.signal, mailClient, clock: this.clock, sleep: this.sleep });
      return polling.then(result => {
        if (contextFinalized || signal?.aborted || manualMode || verificationController.signal.aborted) return;
        if (result?.kind === 'otp' && /^\d{6}$/.test(result.code || '')) {
          verificationCode = result.code;
          verificationState = 'ready';
          reportVerificationOutcome('ready');
        } else {
          verificationCode = '';
          verificationState = 'manual';
          reportVerificationOutcome('unknown');
        }
      }).catch(error => {
        if (contextFinalized || signal?.aborted || manualMode || verificationController.signal.aborted) return;
        if (error?.code === 'needs_mail_auth') verificationIssue = 'needs_mail_auth';
        verificationCode = '';
        verificationState = 'manual';
        reportVerificationOutcome(SAFE_VERIFICATION_FAILURES.has(error?.code) ? error.code : 'unknown');
      });
    };

    try {
      abortIfNeeded(signal);
      const chromium = await loadChromium(this.chromium);
      if (!chromium || typeof chromium.launchPersistentContext !== 'function') fail('browser_unavailable');
      safePhase(setPhase, 'opening_browser');
      const remainingBeforeLaunch = deadline - this.clock();
      if (remainingBeforeLaunch <= 0) fail('login_timeout');
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          ...(this.browserExecutable ? { executablePath: this.browserExecutable } : { channel: 'chrome' }),
          headless: false, chromiumSandbox: true,
          viewport: { width: 1200, height: 850 }, acceptDownloads: false,
          timeout: Math.min(30_000, remainingBeforeLaunch),
        });
      } catch (error) {
        if (signal?.aborted) fail('aborted');
        safeDiagnostic(this.onDiagnostic, 'launch', diagnosticReason(error, this.clock() >= deadline));
        if (isPermissionDenied(error)) fail('browser_permission_denied');
        if (isTimeoutError(error) || this.clock() >= deadline) fail('browser_launch_timeout');
        fail('browser_launch_failed');
      }
      const closeContext = () => {
        if (!context) return Promise.resolve();
        if (!contextClosePromise) contextClosePromise = Promise.resolve().then(() => context.close());
        return contextClosePromise;
      };
      abortHandler = () => { void closeContext().catch(() => {}); };
      signal?.addEventListener('abort', abortHandler, { once: true });
      abortIfNeeded(signal);
      page = context.pages()[0] || await context.newPage();
      if (!page || typeof page.on !== 'function' || typeof page.goto !== 'function') fail('browser_unavailable');
      page.setDefaultTimeout?.(10_000);

      responseHandler = response => {
        if (contextFinalized || signal?.aborted) return;
        const otpResponse = sendOtpResponse(response, validated.email);
        if (otpResponse && !otpResponse.matched) accountMismatch = true;
        if (otpResponse?.matched) reportOtpResponse(response);
        if (otpResponse?.matched && otpResponse.accepted && !otpWaitStarted && !manualMode) {
          otpWaitStarted = true;
          const sentAt = this.clock();
          if (Number.isFinite(sentAt) && Number.isFinite(new Date(sentAt).getTime())) {
            void startOtpWait(sentAt);
          } else {
            verificationState = 'manual';
            reportVerificationOutcome('unknown');
          }
        }
        if (!isMuseSessionResponse(response)) return;
        const captureTimeoutMs = Math.min(10_000, Math.max(1, deadline - this.clock()));
        const task = captureSession(response, { timeoutMs: captureTimeoutMs, signal }).then(value => {
          if (!value || contextFinalized || signal?.aborted) return;
          reportSessionResponse(value.diagnostic);
          if (value.diagnostic.httpStatus === 200) capturedSessionHeaders = value.headers;
          if (value.vmUnavailable) vmUnavailableObserved = true;
          if (value.upstream) capturedSession = { upstream: value.upstream, headers: value.headers };
        })
          .catch(() => {});
        captureTasks.push(task);
      };
      page.on('response', responseHandler);

      routeHandler = async route => {
        if (accountMismatchRequest(route.request(), validated.email)) {
          accountMismatch = true;
          try { await route.abort('blockedbyclient'); } catch { /* Browser may close concurrently. */ }
          return;
        }
        try { await route.continue(); } catch { /* Browser may close concurrently. */ }
      };
      await page.route(`${MUSE_ORIGIN}/**`, routeHandler);

      safeProgress(setProgress, 5);
      const remainingBeforeNavigation = deadline - this.clock();
      if (remainingBeforeNavigation <= 0) fail('login_timeout');
      try { await page.goto(MUSE_ORIGIN, { waitUntil: 'domcontentloaded', timeout: Math.min(45_000, remainingBeforeNavigation) }); }
      catch (error) {
        if (signal?.aborted) fail('aborted');
        safeDiagnostic(this.onDiagnostic, 'navigation', diagnosticReason(error, this.clock() >= deadline), {
          pageState: navigationPageState(page, error), errorType: diagnosticErrorType(error), signals: diagnosticSignals(error),
        });
        navigationFailureCode = isTimeoutError(error) || this.clock() >= deadline
          ? 'muse_navigation_timeout' : museNavigationFailureCode(error);
        if (!page || !context || pageIsClosed(page, error)) fail(navigationFailureCode);
        await enterManualMode();
      }
      await page.bringToFront?.();
      safeProgress(setProgress, 15);
      if (manualMode) await enterManualMode();

      let emailAttempted = false;
      let interactionRequired = false;
      while (this.clock() < deadline || (!manualMode && this.clock() >= autoDeadline)) {
        if (!manualMode && this.clock() >= autoDeadline) {
          if (vmUnavailableObserved) {
            let manualStepRequiresUser = false;
            if (page && !contextFinalized) {
              const manual = await inspectManualStep(page);
              manualStepRequiresUser = manual.captcha || manual.terms || manual.accept || manual.password;
            }
            if (!manualStepRequiresUser) fail('muse_vm_unavailable');
          }
          await enterManualMode();
        }
        abortIfNeeded(signal);
        if (accountMismatch) fail('account_mismatch');
        if (captureTasks.length) {
          await Promise.allSettled(captureTasks.splice(0));
          abortIfNeeded(signal);
        }
        if (capturedSession) {
          safePhase(setPhase, 'saving_session');
          safeProgress(setProgress, 65);
          if (new URL(page.url()).origin !== MUSE_ORIGIN) fail('muse_session_unavailable');
          let exchange;
          const exchangeTimeoutMs = Math.min(30_000, Math.max(1, deadline - this.clock()));
          try {
            exchange = await evaluateWithTimeout(page, async ({ endpointUrl, vmName, timeoutMs }) => {
              const body = { vmAddress: endpointUrl, ...(vmName ? { vmName } : {}) };
              const signal = AbortSignal.timeout(timeoutMs);
              const response = await fetch('/api/hatch/token', {
                method: 'POST', credentials: 'include',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal,
              });
              const text = await response.text();
              if (text.length > 1_048_576) return { status: response.status, oversized: true };
              let data = null;
              try { data = JSON.parse(text); } catch { /* Returned as invalid data below. */ }
              return { status: response.status, data };
            }, {
              endpointUrl: capturedSession.upstream.gatewayUrl,
              ...(capturedSession.upstream.vmName ? { vmName: capturedSession.upstream.vmName } : {}),
              timeoutMs: exchangeTimeoutMs,
            }, exchangeTimeoutMs, signal);
          } catch {
            if (signal?.aborted) fail('aborted');
            fail('token_exchange_failed');
          }
          if (!exchange || exchange.status !== 200) fail('token_exchange_failed');
          if (exchange.oversized || !containsOfficialToken(exchange.data)) fail('invalid_token_response');

          let cookies;
          try { cookies = validatedCookies(await context.cookies(MUSE_ORIGIN)); }
          catch (error) { if (error instanceof BrowserSessionError) throw error; fail('muse_session_unavailable'); }
          result = {
            schemaVersion: 1,
            cookies,
            tokens: exchange.data,
            device: { id: validated.deviceId, headers: capturedSession.headers },
            upstream: {
              gatewayUrl: capturedSession.upstream.gatewayUrl,
              ...(capturedSession.upstream.vmName ? { vmName: capturedSession.upstream.vmName } : {}),
              vmId: capturedSession.upstream.vmId,
            },
            expiresAt: null,
          };
          safeProgress(setProgress, 95);
          break;
        }

        if ((otpFilled || manualMode) && !signal?.aborted && page && !contextFinalized) {
          let onMuseOrigin = false;
          try { onMuseOrigin = new URL(page.url()).origin === MUSE_ORIGIN; } catch { /* Skip probe for invalid page URLs. */ }
          const probeAt = this.clock();
          if (onMuseOrigin && probeAt < deadline &&
              (lastSessionProbeAt === null || probeAt - lastSessionProbeAt >= 10_000)) {
            lastSessionProbeAt = probeAt;
            const probeTimeoutMs = Math.min(10_000, Math.max(1, deadline - probeAt));
            let probeResult = null;
            try {
              probeResult = await evaluateWithTimeout(page, async ({ timeoutMs, maxResponseBytes }) => {
                const probeSignal = AbortSignal.timeout(timeoutMs);
                const response = await fetch('/api/session', {
                  method: 'GET', credentials: 'include', headers: { accept: 'application/json' }, signal: probeSignal,
                  redirect: 'error',
                });
                const responseUrl = response.url;
                if (responseUrl !== 'https://muse.ai/api/session') {
                  return { status: response.status, responseUrl, bodyParsed: false };
                }
                if (response.status !== 200) return { status: response.status, responseUrl, bodyParsed: false };
                const reader = response.body?.getReader();
                if (!reader) return { status: response.status, responseUrl, bodyParsed: false };
                const chunks = [];
                let totalBytes = 0;
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    totalBytes += value.byteLength;
                    if (totalBytes > maxResponseBytes) {
                      await reader.cancel();
                      return { status: response.status, responseUrl, bodyParsed: false, oversized: true };
                    }
                    chunks.push(value);
                  }
                  const bytes = new Uint8Array(totalBytes);
                  let offset = 0;
                  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                  try {
                    return { status: response.status, responseUrl, bodyParsed: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
                  } catch {
                    return { status: response.status, responseUrl, bodyParsed: false };
                  }
                } catch {
                  try { await reader.cancel(); } catch { /* The page request may already be aborted. */ }
                  return { status: response.status, responseUrl, bodyParsed: false };
                }
              }, { timeoutMs: probeTimeoutMs, maxResponseBytes: MAX_SESSION_RESPONSE_BYTES, probeSession: true }, probeTimeoutMs, signal);
            } catch {
              abortIfNeeded(signal);
              // A failed or unauthorized discovery probe leaves the existing sign-in flow alone.
            }
            abortIfNeeded(signal);
            if (captureTasks.length) await Promise.allSettled(captureTasks.splice(0));
            abortIfNeeded(signal);
            if (probeResult?.status === 200 && probeResult.responseUrl === `${MUSE_ORIGIN}/api/session` &&
                probeResult.bodyParsed === true && !probeResult.oversized && !capturedSession) {
              const value = capturedSessionPayload(200, probeResult.body, true, capturedSessionHeaders);
              if (value) {
                reportSessionResponse(value.diagnostic);
                if (value.vmUnavailable) vmUnavailableObserved = true;
                if (value.upstream) capturedSession = { upstream: value.upstream, headers: value.headers };
              }
            }
            if (capturedSession) continue;
          }
        }

        if (new URL(page.url()).origin === MUSE_ORIGIN) {
          const manual = await inspectManualStep(page);
          if (manual.captcha || manual.terms || manual.accept || manual.password || manual.signIn ||
              (manual.otp && !otpSubmitted)) interactionRequired = true;
          if (manual.captcha || manual.terms || manual.accept || manual.password) {
            if (verificationState === 'ready' && !otpSubmitted) reportOtpSubmitOutcome('interaction_required');
            await enterManualMode();
          }
          const emailInput = await discoverEmailInput(page);
          if (manual.signIn && emailInput.count === 0 && !manual.otp) {
            const otpInput = await discoverOtpInput(page);
            if (otpInput.count === 0) await enterManualMode();
          }
          if (!emailAttempted && !manualMode && !verificationController.signal.aborted && !signal?.aborted && !manual.captcha && !manual.terms) {
            try {
              const emailCount = emailInput.count;
              if (emailCount > 1) {
                interactionRequired = true;
                await enterManualMode();
              }
              else if (emailCount === 1) {
                safePhase(setPhase, 'requesting_code');
                emailAttempted = true;
                const attempt = await tryFillEmail(page, validated.email, emailInput.locator,
                  () => !manualMode && !verificationController.signal.aborted && !signal?.aborted,
                  { deadline, clock: this.clock, sleep: this.sleep, signal });
                if (!signal?.aborted && !contextFinalized) safeDiagnostic(this.onDiagnostic, 'email_submit', null, attempt);
                if (attempt.outcome === 'submitted') {
                  interactionRequired = true;
                } else if (attempt.outcome !== 'cancelled' || !signal?.aborted) {
                  interactionRequired = true;
                  await enterManualMode();
                }
              }
            } catch { /* Keep waiting for the user-visible flow. */ }
          }
          if (verificationState === 'ready' && !otpSubmitted && !manualMode && !verificationController.signal.aborted && !signal?.aborted) {
            if (manual.captcha || manual.terms || manual.accept) {
              verificationCode = '';
              verificationState = 'manual';
              reportOtpSubmitOutcome('interaction_required');
            } else {
              try {
                const otpInput = await discoverOtpInput(page);
                const otpInputs = otpInput.locator;
                const count = otpInput.count;
                if (count === 0) {
                  reportOtpSubmitOutcome('input_missing');
                } else if (count > 1) {
                  verificationCode = '';
                  verificationState = 'manual';
                  interactionRequired = true;
                  reportOtpSubmitOutcome('input_ambiguous');
                } else {
                  const code = verificationCode;
                  if (manualMode || verificationController.signal.aborted || signal?.aborted) {
                    verificationCode = '';
                    verificationState = 'manual';
                    reportOtpSubmitOutcome('cancelled');
                  } else if (typeof otpInputs.isVisible !== 'function' || !await otpInputs.isVisible()) {
                    verificationCode = '';
                    verificationState = 'manual';
                    interactionRequired = true;
                    reportOtpSubmitOutcome('input_hidden');
                  } else if (typeof otpInputs.isEnabled !== 'function' || !await otpInputs.isEnabled()) {
                    verificationCode = '';
                    verificationState = 'manual';
                    interactionRequired = true;
                    reportOtpSubmitOutcome('input_disabled');
                  } else {
                    verificationCode = '';
                    if (typeof otpInputs.pressSequentially === 'function') {
                      await otpInputs.fill('');
                      if (manualMode || verificationController.signal.aborted || signal?.aborted) {
                        verificationState = 'manual';
                        reportOtpSubmitOutcome('cancelled');
                      } else {
                        await otpInputs.pressSequentially(code, { delay: 20, timeout: 5_000 });
                        otpFilled = true;
                      }
                    } else {
                      await otpInputs.fill(code);
                      otpFilled = true;
                    }
                    if (verificationState !== 'manual' &&
                        (manualMode || verificationController.signal.aborted || signal?.aborted)) {
                      try { await otpInputs.fill(''); } catch { /* Remove only our in-flight automatic value when possible. */ }
                      verificationState = 'manual';
                      reportOtpSubmitOutcome('cancelled');
                    } else if (verificationState !== 'manual') {
                      const currentCount = await otpInputs.count();
                      let autoVerificationPending = currentCount === 0;
                      if (currentCount === 1) {
                        try {
                          autoVerificationPending = typeof otpInputs.isEnabled !== 'function' ||
                            !await otpInputs.isEnabled();
                        } catch { autoVerificationPending = true; }
                      }
                      if (autoVerificationPending && !manualMode && !verificationController.signal.aborted && !signal?.aborted) {
                        // Muse may submit the code as soon as its controlled field accepts it.
                        // The successful fill is the single submission; wait for session proof,
                        // never press Enter or click a second control in this state.
                        otpSubmitted = true;
                        reportOtpSubmitOutcome('auto_verifying');
                      } else {
                        const continueButtons = page.getByRole('button', { name: CONTINUE_LABEL });
                        const buttonCount = await continueButtons.count();
                        const buttonVisible = buttonCount === 1 && await continueButtons.isVisible();
                        if (buttonVisible && !manualMode && !verificationController.signal.aborted && !signal?.aborted) {
                          await continueButtons.click();
                          otpSubmitted = true;
                          reportOtpSubmitOutcome('submitted');
                        } else if (!manualMode && !verificationController.signal.aborted && !signal?.aborted &&
                            typeof otpInputs.press === 'function') {
                          const currentCount = await otpInputs.count();
                          let guardOutcome = null;
                          let inputEnabled = false;
                          if (currentCount === 0) guardOutcome = 'input_missing';
                          else if (currentCount > 1) guardOutcome = 'input_ambiguous';
                          else if (typeof otpInputs.isVisible !== 'function' || !await otpInputs.isVisible()) guardOutcome = 'input_hidden';
                          else if (typeof otpInputs.isEnabled !== 'function') guardOutcome = 'input_disabled';
                          else if (!await otpInputs.isEnabled()) guardOutcome = 'input_disabled';
                          else {
                            inputEnabled = true;
                            if (typeof otpInputs.inputValue === 'function') {
                              try {
                                if (await otpInputs.inputValue({ timeout: 1_000 }) !== code) guardOutcome = 'input_value_changed';
                              } catch { guardOutcome = 'input_value_changed'; }
                            }
                          }
                          let onMuse = false;
                          try { onMuse = new URL(page.url()).origin === MUSE_ORIGIN; } catch { /* Form changed. */ }
                          if (!onMuse && !guardOutcome) guardOutcome = 'failed';
                          if (inputEnabled && !guardOutcome && onMuse && !manualMode &&
                              !verificationController.signal.aborted && !signal?.aborted) {
                            await otpInputs.press('Enter', { timeout: 5_000 });
                            otpSubmitted = true;
                            reportOtpSubmitOutcome('submitted_enter');
                          } else {
                            interactionRequired = true;
                            verificationState = 'manual';
                            reportOtpSubmitOutcome(signal?.aborted || verificationController.signal.aborted || manualMode
                              ? 'cancelled' : (guardOutcome ?? 'button_unavailable'));
                          }
                        } else {
                          interactionRequired = true;
                          verificationState = 'manual';
                          reportOtpSubmitOutcome('button_unavailable');
                        }
                      }
                    }
                  }
                }
              } catch {
                verificationCode = '';
                verificationState = 'manual';
                interactionRequired = true;
                reportOtpSubmitOutcome(signal?.aborted ? 'cancelled' : 'failed');
              }
            }
          }
          if (otpWaitStarted && verificationState === 'waiting') safePhase(setPhase, 'reading_mail');
          if (verificationState === 'manual' && !manualMode) await enterManualMode();
          if (interactionRequired) safeProgress(setProgress, 25);
        } else {
          interactionRequired = true;
          safeProgress(setProgress, 25);
        }
        await this.sleep(Math.min(this.pollMs, Math.max(1, deadline - this.clock())), signal);
      }
      if (!result && navigationFailureCode) fail(navigationFailureCode);
      if (!result && vmUnavailableObserved && this.clock() >= deadline) fail('muse_vm_unavailable');
      if (!result && this.clock() >= deadline) fail('needs_user_interaction');
      if (!result) fail(verificationIssue || (interactionRequired ? 'needs_user_interaction' : 'login_timeout'));
      safeProgress(setProgress, 100);
    } catch (error) {
      failure = error instanceof BrowserSessionError ? error : new BrowserSessionError('browser_unavailable');
    } finally {
      contextFinalized = true;
      if (page && responseHandler) {
        try { page.off?.('response', responseHandler); } catch { /* Best effort listener cleanup. */ }
      }
      if (page && routeHandler) {
        try { await page.unroute?.(`${MUSE_ORIGIN}/**`, routeHandler); } catch { /* Context close remains the owner cleanup. */ }
      }
      verificationCode = '';
      verificationController.abort();
      signal?.removeEventListener('abort', relayVerificationAbort);
      signal?.removeEventListener('abort', abortHandler);
      if (context) {
        try {
          if (!contextClosePromise) contextClosePromise = Promise.resolve().then(() => context.close());
          await contextClosePromise;
        }
        catch { if (!failure) failure = new BrowserSessionError('browser_cleanup_failed'); }
      }
      try { await removeLoginDirectory(profileDir); }
      catch { if (!failure) failure = new BrowserSessionError('unsafe_workspace'); }
    }

    if (failure) throw failure;
    return result;
  }
}
