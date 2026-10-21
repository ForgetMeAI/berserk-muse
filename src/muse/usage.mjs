const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_ROWS = 256;
const ERROR_MESSAGES = Object.freeze({
  usage_auth_required: 'Muse authentication is required to read usage.',
  usage_forbidden: 'Muse denied access to usage information.',
  usage_unavailable: 'Muse usage information is temporarily unavailable.',
  usage_response_invalid: 'Muse returned an invalid usage response.',
  usage_session_changed: 'The Muse session changed while usage was being read.',
  usage_cancelled: 'The Muse usage request was cancelled.',
});

export class MuseUsageError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'usage_unavailable';
    super(ERROR_MESSAGES[safeCode]);
    this.name = 'MuseUsageError';
    this.code = safeCode;
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeString(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
}

function safeOptionalText(value, max = 128) {
  return value === null || (typeof value === 'string' && value.length <= max && !/[\r\n\0]/.test(value));
}

export function parseTokenBalanceLabel(value) {
  if (typeof value !== 'string' || value.length > 160 || !/^[\x20-\x7e]+$/.test(value)) return null;
  const match = /^(0|[1-9][0-9]{0,2})% used \(((?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+))([KMB])? tokens left\)$/i.exec(value);
  if (!match || Number(match[1]) > 100) return null;
  const countText = match[2];
  const count = Number(countText.replaceAll(',', ''));
  const suffix = match[3]?.toUpperCase();
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
  const remaining = count * multiplier;
  if (!Number.isSafeInteger(remaining)) return null;
  return { remaining, approximate: suffix !== undefined, displayLabel: value };
}

function parseFlightRows(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new MuseUsageError('usage_response_invalid');
  }
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_ROWS) throw new MuseUsageError('usage_response_invalid');
  const rows = new Map();
  for (const line of lines) {
    const match = /^(0|[1-9a-f][0-9a-f]*):(.*)$/i.exec(line);
    if (!match || rows.has(match[1])) throw new MuseUsageError('usage_response_invalid');
    let value;
    try { value = JSON.parse(match[2]); }
    catch { throw new MuseUsageError('usage_response_invalid'); }
    // React Flight error records start with an error discriminator rather than JSON.
    if (match[2].startsWith('E')) throw new MuseUsageError('usage_response_invalid');
    rows.set(match[1], value);
  }
  return rows;
}

/** Parse the documented Muse subscription Server Action Flight response. */
export function parseMuseSubscriptionFlight(text, { observedAt = Date.now() } = {}) {
  const rows = parseFlightRows(text);
  const root = rows.get('0');
  if (!record(root) || root.a !== '$@1') throw new MuseUsageError('usage_response_invalid');
  const action = rows.get('1');
  if (!record(action) || action.success !== true || !record(action.subscription)) {
    throw new MuseUsageError('usage_response_invalid');
  }
  const subscription = action.subscription;
  const tier = subscription.tier;
  const usage = subscription.usage;
  const rawRemaining = subscription.topupBalance;
  const rawLimit = subscription.topupTotal;
  if (!record(tier) || !safeString(tier.tierCode, 64) || !safeString(tier.name) || typeof tier.isPaid !== 'boolean'
    || !record(usage) || !nonnegative(usage.percentUsed) || usage.percentUsed > 100
    || !safeOptionalText(usage.state) || !safeOptionalText(usage.quotaStatus)
    || !(usage.resetsAt === null || nonnegative(usage.resetsAt))
    || !nonnegative(rawRemaining) || !nonnegative(rawLimit) || rawRemaining > rawLimit
    || (rawLimit === 0 && rawRemaining !== 0)) {
    throw new MuseUsageError('usage_response_invalid');
  }
  const parsedBalance = parseTokenBalanceLabel(subscription.topupRowValueLabel);

  const validObservedAt = nonnegative(observedAt) ? observedAt : Date.now();
  return {
    source: 'muse_subscription',
    observedAt: validObservedAt,
    tier: { code: tier.tierCode, name: tier.name, isPaid: tier.isPaid },
    weekly: {
      state: safeOptionalText(usage.state) ? usage.state : null,
      percentUsed: usage.percentUsed,
      resetsAt: usage.resetsAt ?? null,
      quotaStatus: safeOptionalText(usage.quotaStatus) ? usage.quotaStatus : null,
    },
    additional: {
      remaining: parsedBalance?.remaining ?? null,
      limit: null,
      used: null,
      percentUsed: rawLimit > 0 ? ((rawLimit - rawRemaining) / rawLimit) * 100 : null,
      approximate: parsedBalance?.approximate ?? false,
      displayLabel: parsedBalance?.displayLabel ?? null,
      raw: { remaining: rawRemaining, limit: rawLimit, unit: 'muse_quota_units' },
    },
  };
}
