import { MailError, isoDate, normalizeEmail, requestJson, sinceIso, validateMailUrl } from './index.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Fetch Gmail Inbox messages through the user's per-call OAuth token. */
export async function fetchLatest(provider, url, { signal, since, limit = 20, auth, fetchImpl, excludeIds = [] } = {}) {
  if (provider !== 'gmail') throw new MailError('unsupported_provider');
  const parsed = validateMailUrl(url);
  if (!['mail.google.com', 'gmail.com'].includes(parsed.hostname)) throw new MailError('unsupported_provider');
  const count = checkedLimit(limit);
  const sinceDate = sinceIso(since);
  const excluded = excludedIdSet(excludeIds);
  if (!auth?.accessToken) throw new MailError('needs_mail_auth', 'Gmail OAuth authorization is required.');
  const headers = { authorization: `Bearer ${auth.accessToken}`, accept: 'application/json' };
  const listUrl = new URL(`${API}/messages`);
  listUrl.searchParams.set('labelIds', 'INBOX');
  listUrl.searchParams.set('maxResults', String(count));
  if (sinceDate) listUrl.searchParams.set('q', `after:${Math.floor(Date.parse(sinceDate) / 1000)}`);
  const listing = await requestJson(listUrl.href, { headers, signal, fetchImpl });
  if (!Array.isArray(listing.messages)) {
    if (listing.resultSizeEstimate === 0 || listing.messages === undefined) return [];
    throw new MailError('mail_response_invalid', 'Gmail returned an invalid message list.');
  }
  const candidates = listing.messages.filter(item => {
    if (!item || typeof item.id !== 'string' || excluded.has(item.id)) return false;
    if (!sinceDate) return true;
    const metadataDate = Date.parse(item.receivedAt || item.internalDate || '');
    return !Number.isFinite(metadataDate) || metadataDate > Date.parse(sinceDate);
  }).slice(0, count);
  const result = await Promise.all(candidates.map(async item => {
    if (!item || typeof item.id !== 'string') return null;
    const detail = await requestJson(`${API}/messages/${encodeURIComponent(item.id)}?format=full`, { headers, signal, fetchImpl });
    return normalizeGmail(detail);
  }));
  return result.filter(message => message && (!sinceDate || !message.receivedAt || Date.parse(message.receivedAt) > Date.parse(sinceDate)))
    .sort((a, b) => (Date.parse(b.receivedAt || 0) || 0) - (Date.parse(a.receivedAt || 0) || 0)).slice(0, count);
}

function excludedIdSet(value) {
  if (!Array.isArray(value) || value.length > 1_000) throw new MailError('invalid_input', 'Mail excluded message IDs are invalid.');
  return new Set(value.filter(id => typeof id === 'string' || typeof id === 'number').map(String));
}

function normalizeGmail(message) {
  const headers = Object.fromEntries((message.payload?.headers || []).map(header => [String(header.name).toLowerCase(), header.value]));
  const bodies = { text: '', html: '' };
  collectBodies(message.payload, bodies);
  const to = getAddress(headers.to);
  return {
    id: String(message.id), provider: 'gmail', from: getAddress(headers.from), to,
    subject: safeString(headers.subject), receivedAt: isoDate(Number(message.internalDate) || headers.date),
    text: bodies.text.slice(0, 200_000), html: bodies.html.slice(0, 200_000), links: [],
  };
}

function collectBodies(part, bodies) {
  if (!part) return;
  if (Array.isArray(part.parts)) for (const child of part.parts) collectBodies(child, bodies);
  const type = String(part.mimeType || '').toLowerCase();
  const data = part.body?.data;
  if (!data || !['text/plain', 'text/html'].includes(type)) return;
  let decoded;
  try { decoded = Buffer.from(data.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'); }
  catch { return; }
  if (type === 'text/plain' && !bodies.text) bodies.text = decoded;
  if (type === 'text/html' && !bodies.html) bodies.html = decoded;
}

function getAddress(value) {
  if (typeof value !== 'string') return null;
  const found = value.match(/<?([^<>\s,]+@[^<>\s,]+)>?/);
  if (!found) return null;
  try { return normalizeEmail(found[1]); } catch { return null; }
}

function safeString(value) { return typeof value === 'string' ? value.slice(0, 10_000) : ''; }
function checkedLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new MailError('invalid_input', 'Mail limit must be between 1 and 100.');
  return value;
}
