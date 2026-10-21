import { MailError, asMessages, isoDate, mailboxFromUrl, normalizeEmail, requestJson, sinceIso, validateMailUrl } from './index.mjs';

const API = 'https://luuvan.site';

/** Fetch newest messages for a Luuvan mailbox. `auth` is supplied for this call only. */
export async function fetchLatest(provider, url, { signal, since, limit = 20, auth, expectedEmail, fetchImpl, excludeIds = [] } = {}) {
  if (provider !== 'luuvan') throw new MailError('unsupported_provider');
  const parsed = validateMailUrl(url);
  if (parsed.hostname !== 'luuvan.site') throw new MailError('unsupported_provider');
  const count = checkedLimit(limit);
  const sinceDate = sinceIso(since);
  const excluded = excludedIdSet(excludeIds);
  const mailbox = mailboxFromUrl('luuvan', parsed, { expectedEmail: auth?.email || expectedEmail });
  const quick = !auth || !(auth.recoveryKey || auth.accessToken);
  const headers = auth?.recoveryKey
    ? { 'x-recovery-key': auth.recoveryKey, accept: 'application/json' }
    : auth?.accessToken ? { authorization: `Bearer ${auth.accessToken}`, accept: 'application/json' } : { accept: 'application/json' };
  const listingUrl = quick
    ? withAddress(`${API}/api/public/inbox`, mailbox)
    : new URL(auth.recoveryKey ? '/api/inbox' : `/mailboxes/${encodeURIComponent(mailbox)}/messages`, API).href;
  const listing = await requestJson(listingUrl, { headers, signal, fetchImpl });
  const declaredListingMailbox = declaredMailbox(listing);
  if (declaredListingMailbox && declaredListingMailbox !== mailbox) {
    throw new MailError('mail_response_invalid', 'Luuvan returned a mailbox that does not match the requested address.');
  }
  const items = asMessages(listing).filter(item => {
    if (!item || typeof item !== 'object') return false;
    const id = String(item.id ?? item.messageId ?? '');
    if (!id || excluded.has(id)) return false;
    if (!sinceDate) return true;
    const metadataDate = messageTimestamp(item);
    return Number.isFinite(metadataDate) && metadataDate > Date.parse(sinceDate);
  }).sort((a, b) => timestampForSort(b) - timestampForSort(a)).slice(0, count);

  const rows = await Promise.all(items.map(async item => {
    const id = item?.id ?? item?.messageId;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    const itemBinding = declaredMailbox(item) || declaredListingMailbox;
    if (itemBinding && itemBinding !== mailbox) return null;
    const detailPath = quick
      ? `/api/public/messages/${encodeURIComponent(String(id))}`
      : auth.recoveryKey
      ? `/api/inbox/messages/${encodeURIComponent(String(id))}`
      : `/messages/${encodeURIComponent(String(id))}`;
    const detailUrl = quick ? withAddress(`${API}${detailPath}`, mailbox) : new URL(detailPath, API).href;
    const detailResponse = await requestJson(detailUrl, { headers, signal, fetchImpl });
    const detailMessage = detailResponse?.message && typeof detailResponse.message === 'object'
      ? detailResponse.message
      : detailResponse;
    const detailBinding = declaredMailbox(detailMessage) || declaredMailbox(detailResponse) || itemBinding;
    if (detailBinding && detailBinding !== mailbox) return null;
    return normalizeLuuvan({ ...item, ...detailMessage, id: String(id) }, mailbox, detailBinding);
  }));
  return rows.filter(message => message && (!sinceDate || (message.receivedAt && Date.parse(message.receivedAt) > Date.parse(sinceDate))))
    .sort((a, b) => (Date.parse(b.receivedAt || 0) || 0) - (Date.parse(a.receivedAt || 0) || 0)).slice(0, count);
}

function excludedIdSet(value) {
  if (!Array.isArray(value) || value.length > 1_000) throw new MailError('invalid_input', 'Mail excluded message IDs are invalid.');
  return new Set(value.filter(id => typeof id === 'string' || typeof id === 'number').map(String));
}

function withAddress(value, address) {
  const url = new URL(value);
  url.searchParams.set('address', address);
  return url.href;
}

function normalizeLuuvan(message, expectedEmail, mailboxBinding) {
  const recipient = explicitRecipient(message);
  if (recipient.present && !recipient.address) return null;
  const to = recipient.present ? recipient.address : mailboxBinding || null;
  if (to && to !== expectedEmail) return null;
  return {
    id: String(message.id), provider: 'luuvan',
    from: normalizeEmailAddress(message.from ?? message.sender), to,
    subject: safeString(message.subject), receivedAt: isoDate(message.receivedAt ?? message.received_at ?? message.date ?? message.created_at),
    text: safeString(message.text ?? message.textBody ?? message.bodyText ?? message.body),
    html: safeString(message.html ?? message.htmlBody ?? message.bodyHtml),
    links: Array.isArray(message.links) ? message.links.filter(link => typeof link === 'string').slice(0, 50) : [],
  };
}

function explicitRecipient(message) {
  const values = ['to', 'recipient', 'email']
    .filter(key => message[key] !== null && message[key] !== undefined)
    .map(key => message[key]);
  if (!values.length) return { present: false, address: null };
  const addresses = values.map(normalizeEmailAddress);
  if (addresses.some(address => !address) || new Set(addresses).size !== 1) {
    return { present: true, address: null };
  }
  return { present: true, address: addresses[0] };
}

function declaredMailbox(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = value.mailboxAddress ?? value.mailbox_address ?? value.mailbox?.address;
  if (typeof candidate !== 'string') return null;
  try { return normalizeEmail(candidate); } catch { return null; }
}

function normalizeEmailAddress(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const candidates = trimmed.match(/[^\s<>@,;]+@[^\s<>@,;]+/g) || [];
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  const bracketed = trimmed.match(/^.*<\s*([^<>]+)\s*>$/);
  if (trimmed !== candidate && bracketed?.[1].trim() !== candidate) return null;
  try { return normalizeEmail(candidate); } catch { return null; }
}

function safeString(value) { return typeof value === 'string' ? value.slice(0, 200_000) : ''; }
function messageTimestamp(message) { return Date.parse(message.receivedAt ?? message.received_at ?? message.date ?? message.created_at ?? ''); }
function timestampForSort(message) { const value = messageTimestamp(message); return Number.isFinite(value) ? value : 0; }
function checkedLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new MailError('invalid_input', 'Mail limit must be between 1 and 100.');
  return value;
}
