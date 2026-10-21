import { MailError, normalizeEmail } from './index.mjs';

const MAX_WAIT_MS = 180_000;
const MAX_POLLS = 20;

/**
 * Poll a mail adapter for a message created after an authentication attempt.
 * Mail content is treated only as data: this function extracts an OTP or a
 * constrained HTTPS link and never interprets or executes message instructions.
 * @param {{email:string, url:string, provider:string, auth?:object, startedAt?:string|number|Date, recipient?:string, allowedSenders?:string[], allowedOrigins?:string[], otpPattern?:RegExp, challenge?:string}} authAttempt
 * @param {{signal?:AbortSignal, mailClient:{fetchLatest:Function}, clock?:()=>number, sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>}} options
 * @returns {Promise<{kind:'otp',code:string,message:object}|{kind:'magic_link',url:string,message:object}>}
 */
export async function waitForVerification(authAttempt, { signal, mailClient, clock = Date.now, sleep = defaultSleep } = {}) {
  if (!authAttempt || typeof authAttempt !== 'object' || !mailClient || typeof mailClient.fetchLatest !== 'function') {
    throw new MailError('invalid_input', 'Verification attempt and mail client are required.');
  }
  const recipient = normalizeEmail(authAttempt.recipient || authAttempt.email);
  const startedAt = new Date(authAttempt.startedAt ?? clock());
  if (!Number.isFinite(startedAt.getTime())) throw new MailError('invalid_input', 'Verification start time is invalid.');
  const senders = new Set((authAttempt.allowedSenders || []).map(normalizeEmail));
  const origins = new Set((authAttempt.allowedOrigins || []).map(validateOrigin));
  const otpPattern = validateOtpPattern(authAttempt.otpPattern || /(?:verification|security|one[ -]?time|login|sign[ -]?in|confirmation)?\s*(?:code|otp)\s*(?:is|:|：)?\s*([0-9]{4,8})/i);
  const startedMs = startedAt.getTime();
  const deadline = clock() + MAX_WAIT_MS;
  let delayMs = 3_000;
  let polls = 0;
  const seenIds = new Set();
  while (clock() < deadline && polls < MAX_POLLS) {
    if (signal?.aborted) throw new MailError('aborted', 'Verification wait was cancelled.');
    polls += 1;
    let messages;
    try {
      messages = await mailClient.fetchLatest(authAttempt.provider, authAttempt.url, {
        signal, since: startedAt.toISOString(), limit: 20, auth: authAttempt.auth, excludeIds: [...seenIds],
      });
    } catch (error) {
      if (!(error instanceof MailError) || error.code !== 'mail_rate_limited') throw error;
      const remaining = deadline - clock();
      if (remaining <= 0 || polls >= MAX_POLLS) break;
      const retryMs = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : delayMs;
      await sleep(Math.min(retryMs, remaining), signal);
      delayMs = Math.min(15_000, Math.max(delayMs + 2_000, retryMs));
      continue;
    }
    for (const message of [...messages].sort((a, b) => dateMs(b.receivedAt) - dateMs(a.receivedAt))) {
      if (message?.id !== undefined && message?.id !== null) seenIds.add(String(message.id));
      if (!eligible(message, recipient, senders, startedMs)) continue;
      const text = `${message.subject || ''}\n${message.text || ''}`;
      const match = otpPattern.exec(text);
      if (match) return { kind: 'otp', code: match[1] || match[0], message };
      for (const candidate of extractLinks(message)) {
        const safeUrl = allowedMagicLink(candidate, origins, authAttempt.challenge);
        if (safeUrl) return { kind: 'magic_link', url: safeUrl, message };
      }
    }
    const remaining = deadline - clock();
    if (remaining <= 0 || polls >= MAX_POLLS) break;
    await sleep(Math.min(delayMs, remaining), signal);
    delayMs = Math.min(15_000, delayMs + 2_000);
  }
  throw new MailError('verification_timeout', 'No matching verification message arrived before the timeout.');
}

function eligible(message, recipient, senders, startedMs) {
  if (!message || typeof message !== 'object' || !message.receivedAt || dateMs(message.receivedAt) < startedMs) return false;
  if (!message.to || normalizeMaybe(message.to) !== recipient) return false;
  if (!message.from || !senders.has(normalizeMaybe(message.from))) return false;
  return true;
}

function extractLinks(message) {
  const found = new Set();
  for (const value of [message.text, message.html, ...(Array.isArray(message.links) ? message.links : [])]) {
    if (typeof value !== 'string') continue;
    const pattern = /https?:\/\/[^\s"'<>]+/gi;
    for (const match of value.matchAll(pattern)) found.add(match[0].replace(/[).,;!?]+$/, ''));
  }
  return [...found].slice(0, 100);
}

function allowedMagicLink(value, origins, challenge) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !origins.has(url.origin)) return null;
  if (challenge) {
    const present = [...url.searchParams.values()].some(item => item === challenge) || decodeURIComponentSafe(url.pathname).includes(challenge);
    if (!present) return null;
  }
  return url.href;
}

function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new MailError('invalid_input', 'Magic-link origin is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || isIp(url.hostname)) {
    throw new MailError('invalid_input', 'Magic-link origin must be an exact HTTPS origin.');
  }
  return url.origin;
}

function validateOtpPattern(value) {
  if (!(value instanceof RegExp) || value.global || value.sticky) throw new MailError('invalid_input', 'OTP pattern must be a non-global regular expression.');
  return value;
}

function dateMs(value) { const n = new Date(value).getTime(); return Number.isFinite(n) ? n : -Infinity; }
function normalizeMaybe(value) { try { return normalizeEmail(value); } catch { return ''; } }
function decodeURIComponentSafe(value) { try { return decodeURIComponent(value); } catch { return value; } }
function isIp(host) { return host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':'); }

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MailError('aborted', 'Verification wait was cancelled.'));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new MailError('aborted', 'Verification wait was cancelled.')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
