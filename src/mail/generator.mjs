import { CookieJar } from 'tough-cookie';
import { MailError, mailboxFromUrl, normalizeEmail, sinceIso, validateMailUrl } from './index.mjs';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 15_000;
const ALLOWED_HOSTS = new Set(['generator.email', 'www.generator.email']);

/**
 * Read the initial inbox snapshot, then wait on one bounded notification stream
 * for its first fresh, non-excluded message (or an idle/normal-close result).
 * Message pages are loaded only from mailbox-bound links discovered by the site.
 */
export async function fetchLatest(provider, url, {
  signal, since, limit = 20, fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket, excludeIds = [], expectedEmail,
  webSocketTimeoutMs = 10_000,
} = {}) {
  if (provider !== 'generator') throw new MailError('unsupported_provider');
  const parsed = validateMailUrl(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new MailError('unsupported_provider');
  const mailbox = mailboxFromUrl('generator', parsed, { expectedEmail });
  const count = checkedLimit(limit);
  const sinceDate = sinceIso(since);
  const excluded = checkedExcludedIds(excludeIds);
  if (typeof fetchImpl !== 'function' || typeof WebSocketImpl !== 'function') {
    throw new MailError('mail_unavailable', 'Generator email transport is unavailable.');
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const cookieJar = new CookieJar();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), MAX_TIMEOUT_MS);
  try {
    if (signal?.aborted) throw new MailError('aborted', 'Mail request was cancelled.');
    const { html: inboxHtml } = await fetchMessagePage(parsed, { fetchImpl, signal: controller.signal, cookieJar, expectedEmail: mailbox });
    const config = readSiteConfig(inboxHtml);
    const initialRows = extractInboxRows(inboxHtml, parsed, mailbox)
      .filter(row => !excluded.has(row.id) && (!sinceDate || Date.parse(row.receivedAt) > Date.parse(sinceDate)))
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
      .slice(0, count);
    if (initialRows.length) {
      const messages = [];
      for (const row of initialRows) {
        messages.push(await loadMessage(row, mailbox, { fetchImpl, signal: controller.signal, cookieJar, config, sourceUrl: parsed }));
      }
      return messages.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, count);
    }

    const remainingMs = MAX_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 25) return [];
    if (controller.signal.aborted) throw new MailError('aborted', 'Mail request was cancelled.');
    const wsWaitMs = Math.min(Number.isFinite(webSocketTimeoutMs) ? webSocketTimeoutMs : 10_000, remainingMs - 25);
    const notification = await nextNotification(parsed, mailbox, WebSocketImpl, controller.signal, signal, {
      sinceDate, excluded, timeoutMs: wsWaitMs,
    });
    if (!notification) return [];
    return [await loadMessage(notification, mailbox, { fetchImpl, signal: controller.signal, cookieJar, config, sourceUrl: parsed })].slice(0, count);
  } catch (error) {
    if (error instanceof MailError) throw error;
    if (signal?.aborted) throw new MailError('aborted', 'Mail request was cancelled.');
    if (controller.signal.aborted) throw new MailError('mail_timeout', 'Generator email request timed out.');
    throw new MailError('mail_unavailable', 'Generator email is unavailable.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

async function loadMessage(summary, mailbox, { fetchImpl, signal, cookieJar, config, sourceUrl }) {
  const navigation = config ? inboxNavigation(summary, mailbox, sourceUrl, config) : null;
  const target = navigation?.target || summary.url;
  const page = await fetchMessagePage(target, {
    fetchImpl, signal, cookieJar, extraCookie: navigation?.cookie,
    expectedEmail: mailbox, expectedMessageUrl: summary.url,
  });
  const head = extractElement(page.html, 'mail-summary-head');
  const body = extractElement(page.html, 'mail-summary-body');
  if (!head || !body) throw responseInvalid('Generator message page has an unknown layout.');
  const recipient = parseRecipient(head, mailbox);
  if (recipient.kind === 'invalid') throw responseInvalid('Generator message page has an invalid recipient field.');
  let to = recipient.address;
  let recipientSource;
  if (recipient.kind === 'absent') {
    if (!page.serverMailboxContext) throw responseInvalid('Generator message page does not confirm its mailbox recipient.');
    to = mailbox;
    recipientSource = 'mailbox_context';
  }
  const html = body.html.slice(0, 200_000);
  const text = htmlToText(body.html).slice(0, 200_000);
  if (!text.trim()) throw responseInvalid('Generator message page has an empty body.');
  return {
    id: summary.id, provider: 'generator', from: summary.from, to,
    receivedAt: summary.receivedAt, subject: summary.subject, text, html,
    links: extractLinks(body.html, summary.url),
    // `to` is the resolved delivery destination, matching the normalized
    // message contract used by the other adapters. This provenance marks the
    // case where Generator omitted a To field and server context proved it.
    ...(recipientSource ? { recipientSource } : {}),
  };
}

function checkedLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new MailError('invalid_input', 'Mail limit must be between 1 and 100.');
  return value;
}

function checkedExcludedIds(value) {
  if (!Array.isArray(value) || value.length > 1_000) throw new MailError('invalid_input', 'Mail excluded message IDs are invalid.');
  return new Set(value.filter(id => typeof id === 'string' || typeof id === 'number').map(String));
}

function nextNotification(parsed, mailbox, WebSocketImpl, signal, externalSignal, { sinceDate, excluded, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const idleTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(MAX_TIMEOUT_MS, timeoutMs)) : 10_000;
    const idleTimer = setTimeout(() => finish(null, null), idleTimeout);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      signal.removeEventListener('abort', onAbort);
      try { socket?.close(1000, 'snapshot complete'); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(externalSignal?.aborted
      ? new MailError('aborted', 'Mail request was cancelled.')
      : new MailError('mail_timeout', 'Generator notification wait timed out.'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const wsUrl = new URL('/notificon/ws', `https://${parsed.host}`);
      wsUrl.protocol = 'wss:';
      wsUrl.searchParams.set('email', mailbox);
      socket = new WebSocketImpl(wsUrl.href);
      socket.addEventListener('message', event => {
        if (Buffer.byteLength(String(event.data), 'utf8') > MAX_RESPONSE_BYTES) {
          finish(responseInvalid('Generator notification exceeds the size limit.')); return;
        }
        let value;
        try { value = JSON.parse(String(event.data)); }
        catch { finish(responseInvalid('Generator returned an invalid notification.')); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          finish(responseInvalid('Generator returned an invalid notification.')); return;
        }
        let summary;
        try { summary = notificationSummary(value, parsed, mailbox); }
        catch (error) {
          finish(error instanceof MailError ? error : responseInvalid('Generator notification is invalid.'));
          return;
        }
        if (!summary) { finish(responseInvalid('Generator notification is missing required message metadata.')); return; }
        if (excluded.has(summary.id) || (sinceDate && Date.parse(summary.receivedAt) <= Date.parse(sinceDate))) return;
        finish(null, summary);
      });
      socket.addEventListener('error', () => finish(new MailError('mail_unavailable', 'Generator notification channel failed.')), { once: true });
      socket.addEventListener('close', event => {
        if (!settled && event.code === 1000) finish(null, null);
        else if (!settled) finish(new MailError('mail_unavailable', 'Generator notification channel closed.'));
      }, { once: true });
    } catch {
      finish(new MailError('mail_unavailable', 'Generator notification channel is unavailable.'));
    }
  });
}

function notificationSummary(value, sourceUrl, mailbox) {
  const url = validateNotificationLink(value.link, sourceUrl, mailbox);
  const receivedAt = validTimestamp(value.date);
  const from = parseAddress(value.from);
  const subject = safeString(value.subject, 10_000);
  if (!receivedAt || !from || !subject) return null;
  return { id: url.pathname + url.search, url, from, subject, receivedAt };
}

function validateNotificationLink(value, sourceUrl, mailbox) {
  if (typeof value !== 'string' || !value || value.length > 2_048) throw responseInvalid('Generator notification has no message link.');
  let target;
  try { target = new URL(value, sourceUrl.origin); }
  catch { throw responseInvalid('Generator notification has an invalid message link.'); }
  if (target.origin !== sourceUrl.origin || !['https://generator.email', 'https://www.generator.email'].includes(target.origin)
      || target.protocol !== 'https:' || target.username || target.password || target.port || target.hash) {
    throw responseInvalid('Generator notification returned an unsafe message link.');
  }
  const parts = target.pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment).toLowerCase(); }
    catch { return ''; }
  });
  const [user, domain] = mailbox.split('@');
  if (parts[0] === 'en') parts.shift();
  if (parts.length < 3 || parts[0] !== domain || parts[1] !== user || !parts[2] || /^page_is_\d+$/.test(parts[2])) {
    throw responseInvalid('Generator message link does not match the requested mailbox.');
  }
  return target;
}

function extractInboxRows(html, sourceUrl, mailbox) {
  if (!/\bTime\s*\(UTC\)/i.test(htmlToText(html))) throw responseInvalid('Generator inbox does not confirm the timestamp timezone.');
  const table = extractElement(html, 'email-table');
  if (!table) throw responseInvalid('Generator inbox page has an unknown layout.');
  const rows = extractDivs(table.html).filter(element => {
    const classes = String(element.attributes.class || '').split(/\s+/);
    return classes.includes('list-group-item') && /loadInboxClientSide\s*\(/.test(element.attributes.onclick || '');
  });
  const result = [];
  for (const row of rows) {
    const call = String(row.attributes.onclick).match(/loadInboxClientSide\s*\(\s*(['"])(.*?)\1\s*\)/);
    if (!call) throw responseInvalid('Generator inbox row has an unknown message link.');
    const url = validateNotificationLink(call[2], sourceUrl, mailbox);
    const from = elementTextByClass(row.html, 'from_div_45g45gg');
    const subject = elementTextByClass(row.html, 'subj_div_45g45gg');
    const dateText = elementTextByClass(row.html, 'time_div_45g45gg');
    const receivedAt = validTimestamp(dateText);
    if (!from || !subject || !receivedAt) throw responseInvalid('Generator inbox row is missing message metadata.');
    const normalizedFrom = parseAddress(from);
    if (!normalizedFrom) throw responseInvalid('Generator inbox row has an invalid sender.');
    result.push({ id: url.pathname + url.search, url, from: normalizedFrom, subject, receivedAt });
  }
  return result;
}

function extractDivs(html) {
  const result = [];
  const stack = [];
  const token = /<!--[\s\S]*?-->|<\/?div\b[^>]*>/ig;
  let match;
  while ((match = token.exec(html))) {
    const raw = match[0];
    if (raw.startsWith('<!--')) continue;
    if (/^<\//.test(raw)) {
      const open = stack.pop();
      if (!open) continue;
      result.push({ attributes: open.attributes, html: html.slice(open.innerStart, match.index) });
      continue;
    }
    const attributes = parseAttributes(raw);
    if (!/\/\s*>$/.test(raw)) stack.push({ attributes, innerStart: token.lastIndex });
  }
  return result;
}

function parseAttributes(tag) {
  const attributes = {};
  const source = tag.replace(/^<\/?[\w:-]+\b/, '').replace(/>$/, '');
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[3]);
  }
  return attributes;
}

function elementTextByClass(html, className) {
  const matches = extractDivs(html).filter(element => String(element.attributes.class || '').split(/\s+/).includes(className));
  if (matches.length !== 1) return '';
  return htmlToText(matches[0].html);
}

function extractDirectChildren(html) {
  const result = [];
  const stack = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const token = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)\b[^>]*>/ig;
  let match;
  while ((match = token.exec(html))) {
    const raw = match[0];
    if (raw.startsWith('<!--')) continue;
    const closing = /^<\//.test(raw);
    const tagName = match[1].toLowerCase();
    if (closing) {
      let opened = stack.pop();
      while (opened && opened.tagName !== tagName) opened = stack.pop();
      if (opened?.direct) result.push({
        tagName: opened.tagName, attributes: opened.attributes,
        html: html.slice(opened.innerStart, match.index), start: opened.start, end: token.lastIndex,
      });
      continue;
    }
    if (voidTags.has(tagName) || /\/\s*>$/.test(raw)) continue;
    stack.push({ tagName, attributes: parseAttributes(raw), innerStart: token.lastIndex, start: match.index, direct: stack.length === 0 });
  }
  return result;
}

function readSiteConfig(html) {
  const siteData = html.match(/window\.SITE_DATA\s*=\s*\{([\s\S]*?)\}\s*;/)?.[1];
  if (!siteData) return null;
  const readString = key => {
    const found = siteData.match(new RegExp(`(?:^|,)\\s*${key}\\s*:\\s*(["'])(.*?)\\1`));
    return found ? found[2] : null;
  };
  const cookieNamesRaw = siteData.match(/(?:^|,)\s*cookie_names\s*:\s*(\{[^{}]*\}|\[\s*\])/s)?.[1];
  if (cookieNamesRaw === undefined) return null;
  const cookieNames = {};
  if (cookieNamesRaw.startsWith('{')) {
    const remainder = cookieNamesRaw.replace(/^\{/, '').replace(/\}$/, '').replace(/\s+/g, '');
    const pairPattern = /(?:^|,)(["']?)[\w-]+\1:(['"])[^'"]*\2/g;
    let consumed = '';
    for (const pair of remainder.matchAll(pairPattern)) consumed += pair[0];
    if (remainder && consumed.replaceAll(',', '') !== remainder.replaceAll(',', '')) return null;
    for (const pair of remainder.matchAll(/(?:^|,)["']?([\w-]+)["']?:\s*(["'])(.*?)\2/g)) cookieNames[pair[1]] = pair[3];
  }
  const urlInbox = readString('url_inbox');
  const urlLanguage = readString('url_language');
  if (urlInbox === null || urlLanguage === null) return null;
  const cookieName = cookieNames.inbox_ctx || 'inbox_ctx';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName)) return null;
  return { urlInbox, urlLanguage, inboxCookieName: cookieName };
}

function inboxNavigation(summary, mailbox, sourceUrl, config) {
  let inboxPath = config.urlInbox || '/inbox1/';
  let language = config.urlLanguage || '';
  if (inboxPath.startsWith('//') || !inboxPath.startsWith('/') || /[?#\\]/.test(inboxPath) || /(?:^|\/)\.\.(?:\/|$)/.test(inboxPath)) return null;
  if (language && language !== '/' && !/^\/?en\/?$/.test(language)) return null;
  if (language === '/') language = '';
  language = language.replace(/^\/?/, '/').replace(/\/$/, '');
  const canonicalPath = `${language}${inboxPath}`;
  let target;
  try { target = new URL(canonicalPath, sourceUrl.origin); } catch { return null; }
  if (target.origin !== sourceUrl.origin || target.pathname !== canonicalPath) return null;
  const rawParts = summary.url.pathname.split('/').filter(Boolean);
  const first = decodePathSegment(rawParts[0]);
  if (first === 'en') rawParts.shift();
  if (rawParts.length < 3) return null;
  const [user, domain] = mailbox.split('@');
  if (decodePathSegment(rawParts[0]) !== domain || decodePathSegment(rawParts[1]) !== user) return null;
  const routeValue = `${rawParts[0]}/${rawParts[1]}/${rawParts[2]}`;
  return {
    target,
    cookie: `${config.inboxCookieName}=${encodeURIComponent(routeValue)}; Domain=.generator.email; Path=/; SameSite=None; Secure`,
  };
}

function decodePathSegment(value) {
  try { return decodeURIComponent(value).toLowerCase(); } catch { return ''; }
}

async function requestOptions(target, signal, cookieJar, extraCookie) {
  const headers = { accept: 'text/html' };
  if (extraCookie) {
    try { await cookieJar.setCookie(extraCookie, target.href, { ignoreError: false }); }
    catch { throw responseInvalid('Generator mailbox context could not be prepared.'); }
  }
  const cookie = await cookieJar.getCookieString(target.href);
  if (cookie) headers.cookie = cookie;
  return { method: 'GET', redirect: 'manual', signal, headers };
}

async function absorbSetCookies(headers, target, cookieJar) {
  let lines = [];
  if (typeof headers.getSetCookie === 'function') lines = headers.getSetCookie();
  else {
    const one = headers.get('set-cookie');
    if (one) lines = [one];
  }
  for (const line of lines) {
    try { await cookieJar.setCookie(line, target.href, { ignoreError: false }); }
    catch { /* Invalid response cookies are ignored; no cookie rules are bypassed. */ }
  }
}

async function fetchMessagePage(target, { fetchImpl, signal, cookieJar = [], extraCookie = '', expectedEmail, expectedMessageUrl }) {
  let finalTarget = target;
  let response;
  try {
    response = await fetchImpl(target.href, await requestOptions(target, signal, cookieJar, extraCookie));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new MailError('mail_unavailable', 'Generator message page could not be loaded.');
  }
  await absorbSetCookies(response.headers, target, cookieJar);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    let next;
    try { next = new URL(location, target); } catch { throw responseInvalid('Generator returned an invalid redirect.'); }
    if (next.origin !== target.origin || next.protocol !== 'https:' || next.username || next.password || next.port
        || (next.hash && !isMailboxTabContext(next.hash, expectedEmail))) {
      throw responseInvalid('Generator returned an unsafe redirect.');
    }
    // Fragments are browser-only state. Validate the observed tab_ctx binding,
    // then strip it before making the redirected HTTP request.
    next.hash = '';
    finalTarget = next;
    try {
      response = await fetchImpl(next.href, await requestOptions(next, signal, cookieJar, extraCookie));
    } catch (error) {
      if (signal.aborted) throw error;
      throw new MailError('mail_unavailable', 'Generator message page could not be loaded.');
    }
    await absorbSetCookies(response.headers, next, cookieJar);
    if (response.status >= 300 && response.status < 400) throw responseInvalid('Generator returned too many redirects.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new MailError('mail_auth_failed', 'Generator mailbox could not be opened.');
    throw new MailError('mail_unavailable', 'Generator message page request failed.');
  }
  if (response.headers.get('x-ab-interstitial')) throw responseInvalid('Generator requested an anti-bot interstitial.');
  const contentType = response.headers.get('content-type') || '';
  if (!/^text\/html\b/i.test(contentType)) throw responseInvalid('Generator returned an unexpected message format.');
  const raw = await readBounded(response);
  const serverMailboxContext = expectedMessageUrl
    ? parseFinalMailboxContext(response.headers, finalTarget, expectedEmail, expectedMessageUrl)
    : false;
  return { html: raw, serverMailboxContext };
}

function parseFinalMailboxContext(headers, responseUrl, expectedEmail, expectedMessageUrl) {
  if (!expectedEmail || !expectedMessageUrl || !ALLOWED_HOSTS.has(responseUrl.hostname) || responseUrl.protocol !== 'https:') {
    throw responseInvalid('Generator mailbox context cannot be bound to this message.');
  }
  const lines = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  const candidates = [];
  for (const line of lines) {
    const first = String(line).split(';', 1)[0];
    const equals = first.indexOf('=');
    const name = (equals < 0 ? first : first.slice(0, equals)).trim();
    if (name.toLowerCase() === 'inbox_ctx') {
      candidates.push({ line: String(line), name, value: equals < 0 ? '' : first.slice(equals + 1).trim() });
    }
  }
  if (!candidates.length) return false;
  if (candidates.length !== 1) throw responseInvalid('Generator returned ambiguous mailbox context cookies.');
  const candidate = candidates[0];
  if (candidate.name !== 'inbox_ctx' || !candidate.value || candidate.value.startsWith('"') || candidate.value.includes('=')) {
    throw responseInvalid('Generator returned a malformed mailbox context cookie.');
  }
  if (/,[ \t]*inbox_ctx\s*=/i.test(candidate.line)) throw responseInvalid('Generator returned combined mailbox context cookies.');

  const attributes = new Map();
  for (const attribute of candidate.line.split(';').slice(1)) {
    const item = attribute.trim();
    if (!item) continue;
    const separator = item.indexOf('=');
    const key = (separator < 0 ? item : item.slice(0, separator)).trim().toLowerCase();
    const value = separator < 0 ? '' : item.slice(separator + 1).trim();
    if (attributes.has(key)) throw responseInvalid('Generator returned duplicated mailbox context attributes.');
    attributes.set(key, value);
  }
  const cookieDomain = attributes.get('domain')?.toLowerCase();
  const sameSite = attributes.get('samesite')?.toLowerCase();
  const maxAge = attributes.get('max-age');
  const expires = attributes.get('expires');
  const maxAgeNumber = maxAge === undefined ? null : Number(maxAge);
  const expiresTime = expires === undefined ? null : Date.parse(expires);
  if ((cookieDomain !== 'generator.email' && cookieDomain !== '.generator.email')
      || attributes.get('path') !== '/'
      || !attributes.has('secure')
      || attributes.get('secure') !== ''
      || (attributes.has('samesite') && !['lax', 'strict', 'none'].includes(sameSite))
      || (maxAge !== undefined && (!/^-?\d+$/.test(maxAge) || !Number.isFinite(maxAgeNumber) || !Number.isInteger(maxAgeNumber) || maxAgeNumber <= 0))
      || (expires !== undefined && (!Number.isFinite(expiresTime) || expiresTime <= Date.now()))) {
    throw responseInvalid('Generator mailbox context cookie has unsafe attributes.');
  }

  const cookieParts = decodeMailboxContext(candidate.value);
  const linkedParts = messageRouteParts(expectedMessageUrl);
  if (!cookieParts || !linkedParts) throw responseInvalid('Generator mailbox context is malformed.');
  const [user, domain] = expectedEmail.split('@');
  if (cookieParts[0].toLowerCase() !== domain
      || cookieParts[1].toLowerCase() !== user
      || cookieParts[0].toLowerCase() !== linkedParts[0].toLowerCase()
      || cookieParts[1].toLowerCase() !== linkedParts[1].toLowerCase()
      || cookieParts[2] !== linkedParts[2]) {
    throw responseInvalid('Generator mailbox context conflicts with the expected mailbox or message.');
  }
  return true;
}

function decodeMailboxContext(value) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (decoded.includes('\\')) return null;
  const parts = decoded.split('/');
  if (parts.length !== 3 || parts.some(part => !part || part === '.' || part === '..' || /%[0-9a-f]{2}/i.test(part))) return null;
  return parts;
}

function messageRouteParts(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!ALLOWED_HOSTS.has(url.hostname) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() === 'en') parts.shift();
  if (parts.length !== 3) return null;
  let decoded;
  try { decoded = parts.map(part => decodeURIComponent(part)); } catch { return null; }
  if (decoded.some(part => !part || part.includes('/') || part.includes('\\') || /%[0-9a-f]{2}/i.test(part))) return null;
  return decoded;
}

function isMailboxTabContext(hash, expectedEmail) {
  if (typeof expectedEmail !== 'string' || !hash.startsWith('#tab_ctx=')) return false;
  let context;
  try { context = decodeURIComponent(hash.slice('#tab_ctx='.length)); }
  catch { return false; }
  const parts = context.split('/');
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !part || part === '.' || part === '..')) return false;
  const [user, domain] = expectedEmail.split('@');
  if (parts[0].toLowerCase() !== domain || parts[1].toLowerCase() !== user) return false;
  if (parts.length === 3 && /^page_is_\d+$/i.test(parts[2])) return false;
  return true;
}

async function readBounded(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw responseInvalid('Generator response exceeds the size limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw responseInvalid('Generator response exceeds the size limit.');
    return text;
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
        try { await reader.cancel(); } catch {}
        throw responseInvalid('Generator response exceeds the size limit.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// Extract one documented message-page slot as data. No HTML is executed or loaded into a DOM.
function extractElement(html, wantedId) {
  let found = null;
  let scanFrom = 0;
  const openPattern = new RegExp(`<([a-z][\\w:-]*)\\b(?=[^>]*\\bid\\s*=\\s*(["'])${wantedId}\\2)[^>]*>`, 'ig');
  const opening = openPattern.exec(html);
  if (!opening) return null;
  const tagName = opening[1].toLowerCase();
  const contentStart = openPattern.lastIndex;
  const token = /<!--[^]*?-->|<\/?[a-z][^>]*>/ig;
  token.lastIndex = contentStart;
  let depth = 1;
  while (true) {
    const match = token.exec(html);
    if (!match) return null;
    const raw = match[0];
    if (raw.startsWith('<!--')) continue;
    const parsedTag = raw.match(/^<(\/)?([a-z][\w:-]*)\b/i);
    if (!parsedTag || parsedTag[2].toLowerCase() !== tagName) continue;
    if (parsedTag[1]) depth--;
    else if (!/\/\s*>$/.test(raw) && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tagName)) depth++;
    if (depth === 0) {
      found = { html: html.slice(contentStart, match.index) };
      break;
    }
  }
  if (!found) return null;
  // Duplicate slots are ambiguous, so reject rather than silently choosing one.
  scanFrom = openPattern.lastIndex;
  openPattern.lastIndex = scanFrom;
  if (openPattern.test(html)) return null;
  found.text = htmlToText(found.html);
  return found;
}

function parseRecipient(headerValue, expectedEmail) {
  const header = typeof headerValue === 'string' ? { html: '', text: headerValue } : headerValue;
  const raw = String(header?.text || '').replace(/\r/g, '').trim();
  // Avoid mistaking the suffix of Reply-To: (or X-To:) for a To: field.
  const explicitLabels = [...raw.matchAll(/(?<![\w-])(?:to|recipient)\s*:\s*/ig)];
  const sourceHtml = String(header?.html || '');
  const directChildren = extractDirectChildren(sourceHtml);
  const plainLabels = directChildren.flatMap((child, index) => child.tagName === 'div' && /^(?:to|recipient)$/i.test(htmlToText(child.html).trim()) ? [index] : []);
  if (explicitLabels.length + plainLabels.length > 1) return { kind: 'invalid' };
  if (explicitLabels.length === 1) {
    const text = raw.replace(/\s+/g, ' ');
    // Match against the normalized form so offsets remain valid after whitespace folding.
    const normalizedLabel = [...text.matchAll(/(?<![\w-])(?:to|recipient)\s*:\s*/ig)];
    const start = normalizedLabel[0].index + normalizedLabel[0][0].length;
    const nextHeader = text.slice(start).search(/\b(?:from|subject|date|sent|cc|bcc)\s*:/i);
    const value = nextHeader < 0 ? text.slice(start) : text.slice(start, start + nextHeader);
    return recipientFromValue(value, expectedEmail);
  }
  if (plainLabels.length === 1) {
    // The observed layout can render a standalone "to" label without a colon.
    // Its value is only the next direct sibling div inside the header.
    const labelDiv = directChildren[plainLabels[0]];
    const valueDiv = directChildren[plainLabels[0] + 1];
    if (!valueDiv) return { kind: 'absent' };
    const gap = sourceHtml.slice(labelDiv.end, valueDiv.start).replace(/<!--[\s\S]*?-->/g, '').trim();
    if (gap || valueDiv.tagName !== 'div') return { kind: 'invalid' };
    const displayedRecipient = htmlToText(valueDiv.html).trim();
    const normalizedDisplay = displayedRecipient.toLowerCase();
    if (!displayedRecipient || ['self', 'none', '...', '…'].includes(normalizedDisplay)) return { kind: 'invalid' };
    // Generator may show a non-address display name. The final server cookie proves delivery
    // to this mailbox; a display name cannot be independently matched to an RFC email address.
    return recipientFromValue(displayedRecipient, expectedEmail, { absentWhenNoAddress: true });
  }
  return { kind: 'absent' };
}

function recipientFromValue(value, expectedEmail, { absentWhenNoAddress = false } = {}) {
  const source = String(value);
  const addresses = source.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/ig) || [];
  const atCount = (source.match(/@/g) || []).length;
  if (!addresses.length && absentWhenNoAddress && atCount === 0) return { kind: 'absent' };
  if (addresses.length !== 1 || atCount !== 1) return { kind: 'invalid' };
  const recipient = parseAddress(addresses[0]);
  return recipient === expectedEmail ? { kind: 'match', address: recipient } : { kind: 'invalid' };
}

function extractLinks(html, base) {
  const result = [];
  const visibleMarkup = html.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/ig, ' ');
  for (const match of visibleMarkup.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/ig)) {
    if (result.length >= 50) break;
    const raw = decodeEntities(match[2]).trim();
    try {
      const link = new URL(raw, base);
      if (['https:', 'http:'].includes(link.protocol) && !link.username && !link.password) result.push(link.href);
    } catch {}
  }
  return [...new Set(result)];
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/ig, ' ')
    .replace(/<\s*br\b[^>]*>/ig, '\n')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6])\s*>/ig, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function decodeEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const name = entity.toLowerCase();
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    if (name === 'nbsp') return ' ';
    const numeric = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : ' ';
  });
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let timestamp = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC))$/i.test(timestamp)) {
    // The public inbox labels this column Time (UTC); accept only an explicit
    // unambiguous ISO-like date/time and apply that documented timezone.
    const bare = timestamp.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?$/);
    if (!bare || !validDatePart(bare[1])) return null;
    const hour = Number(bare[2]);
    const minute = Number(bare[3]);
    const second = Number(bare[4]);
    if (hour > 23 || minute > 59 || second > 59) return null;
    timestamp = `${bare[1]}T${bare[2]}:${bare[3]}:${bare[4]}${bare[5] || ''}Z`;
  }
  if (!/\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2}|\s+(?:GMT|UTC))$/i.test(timestamp)) return null;
  const datePrefix = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePrefix && !validDatePart(datePrefix[1])) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function validDatePart(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

function parseAddress(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const addresses = trimmed.match(/[^\s<>@,;]+@[^\s<>@,;]+/g) || [];
  if (addresses.length !== 1) return null;
  const address = addresses[0];
  const bracketed = trimmed.match(/^.*<\s*([^<>]+)\s*>$/);
  if (trimmed !== address && bracketed?.[1].trim() !== address) return null;
  try { return normalizeEmail(address); } catch { return null; }
}

function safeString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function responseInvalid(message) { return new MailError('mail_response_invalid', message); }
