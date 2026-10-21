const nonnegativeFinite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function validObservedAt(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function observedAtTime(value) {
  return typeof value === 'number' ? value : Date.parse(value);
}

/** Normalize one provider quota without inventing measurements. */
export function quotaView(quota) {
  const empty = {
    known: false,
    remaining: null,
    used: null,
    limit: null,
    percent: null,
    unit: null,
    observedAt: null,
  };
  if (!quota || typeof quota !== 'object') return empty;

  const observedAt = validObservedAt(quota.observedAt);
  const unit = typeof quota.unit === 'string' && /^[a-zA-Z0-9_.-]{1,32}$/.test(quota.unit) ? quota.unit : null;
  if (observedAt === null || unit === null) return empty;

  const rawRemaining = nonnegativeFinite(quota.remaining) ? quota.remaining : null;
  const rawUsed = nonnegativeFinite(quota.used) ? quota.used : null;
  const rawLimit = nonnegativeFinite(quota.limit) && quota.limit > 0 ? quota.limit : null;
  let remaining = rawRemaining;
  let used = rawUsed;
  let limit = rawLimit;

  // A valid limit allows the missing side of the measurement to be derived.
  if (limit !== null) {
    if (remaining === null && used !== null && used <= limit) remaining = limit - used;
    if (used === null && remaining !== null && remaining <= limit) used = limit - remaining;
  }

  const known = remaining !== null || (used !== null && limit !== null);
  if (!known) return { ...empty, unit, observedAt };

  let percent = null;
  const contradictory = (rawRemaining !== null && rawLimit !== null && rawRemaining > rawLimit)
    || (rawUsed !== null && rawLimit !== null && rawUsed > rawLimit)
    || (rawRemaining !== null && rawUsed !== null && rawLimit !== null
      && Math.abs(rawRemaining + rawUsed - rawLimit) > Math.max(1e-9, rawLimit * 1e-9));
  if (!contradictory && limit !== null) {
    const percentUsed = used !== null ? used / limit : null;
    const percentRemaining = remaining !== null ? (limit - remaining) / limit : null;
    const fraction = percentUsed ?? percentRemaining;
    if (fraction !== null && Number.isFinite(fraction)) {
      percent = Math.min(100, Math.max(0, fraction * 100));
    }
  }

  return {
    known,
    remaining,
    used,
    limit,
    percent,
    unit,
    observedAt,
  };
}

const countKnown = (accounts, getter) => accounts.reduce((count, account) => (
  count + (nonnegativeFinite(getter(account)) ? 1 : 0)
), 0);

const sumKnown = (accounts, getter) => {
  let sum = 0;
  let count = 0;
  for (const account of accounts) {
    const value = getter(account);
    if (!nonnegativeFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count ? sum : null;
};

/** Aggregate account state for the panel while keeping partial data explicit. */
export function aggregateAccounts(input) {
  const accounts = Array.isArray(input) ? input : [];
  const normalizedStatus = account => typeof account?.status === 'string' ? account.status.toLowerCase() : '';
  const usageOf = account => account?.estimatedUsage;
  const usageMetric = (account, field) => {
    const usage = usageOf(account);
    if (nonnegativeFinite(usage)) return field === 'totalTokens' ? usage : null;
    return usage && typeof usage === 'object' ? usage[field] : null;
  };
  const disabledAccounts = accounts.filter(account => account?.enabled === false || normalizedStatus(account) === 'disabled');
  const activeAccounts = accounts.filter(account => normalizedStatus(account) === 'active'
    && account?.enabled !== false && account?.quarantined !== true);
  const attentionStatuses = new Set(['expired', 'banned', 'needs_relogin', 'error', 'failed']);
  const knownEstimates = countKnown(accounts, account => usageMetric(account, 'totalTokens'));
  const quotas = accounts.map(account => quotaView(account?.upstreamQuota));
  const knownRemaining = quotas.filter(quota => quota.remaining !== null);
  const knownRemainingUnits = new Set(knownRemaining.map(quota => quota.unit));
  const sameRemainingUnit = knownRemaining.length > 0 && knownRemainingUnits.size === 1;
  const remainingCoverage = knownRemaining.length;
  const limitContributors = quotas.filter(quota => quota.percent !== null && quota.used !== null && quota.limit !== null);
  const limitUnits = new Set(limitContributors.map(quota => quota.unit));
  const sameLimitUnit = limitContributors.length > 0 && limitUnits.size === 1;
  const limitCoverage = limitContributors.length;
  const quotaComplete = accounts.length > 0 && remainingCoverage === accounts.length && sameRemainingUnit;
  const quotaLimitComplete = accounts.length > 0 && limitCoverage === accounts.length && sameLimitUnit;
  const observed = quotas.filter(quota => quota.observedAt !== null)
    .sort((a, b) => observedAtTime(b.observedAt) - observedAtTime(a.observedAt));
  const quotaUnit = sameRemainingUnit ? knownRemaining[0].unit : null;

  let quotaUsed = null;
  let quotaLimit = null;
  let quotaPercent = null;
  if (quotaLimitComplete) {
    quotaUsed = limitContributors.reduce((sum, quota) => sum + quota.used, 0);
    quotaLimit = limitContributors.reduce((sum, quota) => sum + quota.limit, 0);
    quotaPercent = quotaLimit > 0 ? Math.min(100, Math.max(0, quotaUsed / quotaLimit * 100)) : null;
  }

  return {
    total: accounts.length,
    active: activeAccounts.length,
    disabled: disabledAccounts.length,
    needsAttention: accounts.filter(account => account?.quarantined === true || attentionStatuses.has(normalizedStatus(account))).length,
    busy: activeAccounts.filter(account => account?.busy === true).length,
    estimatedTokens: sumKnown(accounts, account => usageMetric(account, 'totalTokens')),
    inputTokens: sumKnown(accounts, account => usageMetric(account, 'inputTokens')),
    outputTokens: sumKnown(accounts, account => usageMetric(account, 'outputTokens')),
    estimateCoverage: knownEstimates,
    unknownRequests: sumKnown(accounts, account => usageMetric(account, 'unknownRequests')) ?? 0,
    quota: {
      remaining: sameRemainingUnit
        ? knownRemaining.reduce((sum, quota) => sum + quota.remaining, 0)
        : null,
      unit: sameRemainingUnit ? quotaUnit : null,
      coverage: remainingCoverage,
      total: accounts.length,
      complete: quotaComplete,
      percent: quotaPercent,
      used: quotaUsed,
      limit: quotaLimit,
      limitCoverage,
      observedAt: observed[0]?.observedAt ?? null,
    },
  };
}

/** Token labels and opaque quota counters have different units in Muse. */
export function aggregateMuseBalances(input) {
  const accounts = Array.isArray(input) ? input : [];
  const samples = accounts.map(account => account?.museUsage?.sample);
  const additional = samples.map(sample => sample?.source === 'muse_subscription' ? sample.additional : null);
  const known = additional.filter(value => nonnegativeFinite(value?.remaining));
  const counters = additional.map(value => value?.raw).filter(raw => raw?.unit === 'muse_quota_units'
    && nonnegativeFinite(raw.remaining) && nonnegativeFinite(raw.limit) && raw.remaining <= raw.limit);
  const rawLimit = counters.reduce((sum, raw) => sum + raw.limit, 0);
  const rawRemaining = counters.reduce((sum, raw) => sum + raw.remaining, 0);
  return {
    remaining: known.length ? known.reduce((sum, value) => sum + value.remaining, 0) : null,
    unit: 'tokens', coverage: known.length, total: accounts.length,
    complete: accounts.length > 0 && known.length === accounts.length,
    approximate: known.some(value => value.approximate === true),
    percent: accounts.length > 0 && counters.length === accounts.length && rawLimit > 0
      ? Math.min(100, Math.max(0, (rawLimit - rawRemaining) / rawLimit * 100)) : null,
  };
}
