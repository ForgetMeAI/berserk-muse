import { MailError, isoDate, normalizeEmail, requestJson, sinceIso, validateMailUrl } from './index.mjs';

const API = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages';

/** Fetch Outlook Inbox messages through a per-call Microsoft Graph Mail.Read token. */
export async function fetchLatest(provider, url, { signal, since, limit = 20, auth, fetchImpl, excludeIds = [] } = {}) {
  if (provider !== 'outlook') throw new MailError('unsupported_provider');
  const parsed = validateMailUrl(url);
  if (!['outlook.live.com', 'outlook.office.com', 'outlook.com'].includes(parsed.hostname)) throw new MailError('unsupported_provider');
  const count = checkedLimit(limit);
  const sinceDate = sinceIso(since);
  const excluded = excludedIdSet(excludeIds);
  if (!auth?.accessToken) throw new MailError('needs_mail_auth', 'Outlook OAuth authorization is required.');
  const endpoint = new URL(API);
  endpoint.searchParams.set('$top', String(count));
  endpoint.searchParams.set('$orderby', 'receivedDateTime desc');
  endpoint.searchParams.set('$select', 'id,from,toRecipients,subject,receivedDateTime,body,bodyPreview');
  if (sinceDate) endpoint.searchParams.set('$filter', `receivedDateTime ge ${sinceDate}`);
  const response = await requestJson(endpoint.href, {
    headers: { authorization: `Bearer ${auth.accessToken}`, accept: 'application/json' }, signal, fetchImpl,
  });
  if (!Array.isArray(response.value)) throw new MailError('mail_response_invalid', 'Outlook returned an invalid message list.');
  return response.value.filter(item => {
    if (!item || typeof item.id !== 'string' || excluded.has(item.id)) return false;
    if (!sinceDate) return true;
    const metadataDate = Date.parse(item.receivedDateTime || '');
    return Number.isFinite(metadataDate) && metadataDate > Date.parse(sinceDate);
  }).slice(0, count).map(normalizeOutlook).filter(Boolean)
    .sort((a, b) => (Date.parse(b.receivedAt || 0) || 0) - (Date.parse(a.receivedAt || 0) || 0)).slice(0, count);
}

function excludedIdSet(value) {
  if (!Array.isArray(value) || value.length > 1_000) throw new MailError('invalid_input', 'Mail excluded message IDs are invalid.');
  return new Set(value.filter(id => typeof id === 'string' || typeof id === 'number').map(String));
}

function normalizeOutlook(message) {
  if (typeof message?.id !== 'string') return null;
  const bodyType = String(message.body?.contentType || '').toLowerCase();
  const body = safeString(message.body?.content || message.bodyPreview);
  const recipients = Array.isArray(message.toRecipients) ? message.toRecipients.map(item => parseAddress(item?.emailAddress?.address)).filter(Boolean) : [];
  return {
    id: message.id, provider: 'outlook', from: parseAddress(message.from?.emailAddress?.address),
    to: recipients[0] || null, subject: safeString(message.subject), receivedAt: isoDate(message.receivedDateTime),
    text: bodyType === 'text' ? body : '', html: bodyType === 'html' ? body : '', links: [],
  };
}

function parseAddress(value) {
  if (typeof value !== 'string') return null;
  try { return normalizeEmail(value); } catch { return null; }
}
function safeString(value) { return typeof value === 'string' ? value.slice(0, 200_000) : ''; }
function checkedLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new MailError('invalid_input', 'Mail limit must be between 1 and 100.');
  return value;
}
