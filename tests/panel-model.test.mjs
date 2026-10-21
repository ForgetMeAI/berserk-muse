import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAccounts, quotaView, aggregateMuseBalances } from '../public/panel/model.js';

const at = '2026-10-18T12:00:00Z';

test('quotaView derives the missing side and clamps percentage to the valid range', () => {
  assert.deepEqual(quotaView({ remaining: 25, limit: 100, unit: 'tokens', observedAt: at }), {
    known: true,
    remaining: 25,
    used: 75,
    limit: 100,
    percent: 75,
    unit: 'tokens',
    observedAt: at,
  });
  assert.equal(quotaView({ used: 0, limit: 10, unit: 'requests', observedAt: at }).remaining, 10);
});

test('quotaView rejects invalid measurements and hides stale or unobserved values', () => {
  assert.equal(quotaView({ remaining: -1, limit: 10, unit: 'tokens', observedAt: at }).known, false);
  assert.deepEqual(quotaView({ remaining: 2, limit: 10, unit: 'tokens' }), {
    known: false, remaining: null, used: null, limit: null, percent: null, unit: null, observedAt: null,
  });
  assert.equal(quotaView({ remaining: 2, limit: 10, unit: 'tokens', observedAt: 'not-a-date' }).known, false);
  assert.equal(quotaView({ remaining: 2, limit: 0, unit: 'tokens', observedAt: at }).percent, null);
  assert.equal(quotaView({ remaining: 2, limit: 10, unit: 'tokens per hour', observedAt: at }).known, false);
});

test('quotaView preserves a reported remaining value but suppresses contradictory percentages', () => {
  const tooMuchRemaining = quotaView({ remaining: 12, limit: 10, unit: 'tokens', observedAt: at });
  assert.equal(tooMuchRemaining.known, true);
  assert.equal(tooMuchRemaining.remaining, 12);
  assert.equal(tooMuchRemaining.percent, null);

  const tooMuchUsed = quotaView({ used: 11, limit: 10, unit: 'tokens', observedAt: at });
  assert.equal(tooMuchUsed.known, true);
  assert.equal(tooMuchUsed.percent, null);

  const inconsistent = quotaView({ remaining: 2, used: 3, limit: 10, unit: 'tokens', observedAt: at });
  assert.equal(inconsistent.known, true);
  assert.equal(inconsistent.percent, null);
});

test('aggregateAccounts counts eligible activity and sums only valid token estimates', () => {
  const result = aggregateAccounts([
    { status: 'active', busy: true, estimatedUsage: { inputTokens: 60, outputTokens: 20, totalTokens: 80, requests: 2, unknownRequests: 2, estimated: true } },
    { status: 'active', enabled: false, busy: true, estimatedUsage: { inputTokens: 7, outputTokens: 0, totalTokens: 7, requests: 1, unknownRequests: 1, estimated: true } },
    { status: 'error', quarantined: true, estimatedUsage: { inputTokens: 0, outputTokens: 12, totalTokens: 12, requests: 1, unknownRequests: 0, estimated: true } },
    { status: 'expired', estimatedUsage: 0 },
  ]);
  assert.deepEqual({
    total: result.total,
    active: result.active,
    disabled: result.disabled,
    needsAttention: result.needsAttention,
    busy: result.busy,
    estimatedTokens: result.estimatedTokens,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimateCoverage: result.estimateCoverage,
    unknownRequests: result.unknownRequests,
  }, {
    total: 4,
    active: 1,
    disabled: 1,
    needsAttention: 2,
    busy: 1,
    estimatedTokens: 99,
    inputTokens: 67,
    outputTokens: 32,
    estimateCoverage: 4,
    unknownRequests: 3,
  });
});

test('aggregateAccounts marks partial same-unit quota coverage and computes weighted percent only when complete', () => {
  const partial = aggregateAccounts([
    { upstreamQuota: { remaining: 5, limit: 10, unit: 'tokens', observedAt: at } },
    {},
  ]).quota;
  assert.deepEqual(partial, {
    remaining: 5, unit: 'tokens', coverage: 1, total: 2, complete: false,
    percent: null, used: null, limit: null, limitCoverage: 1, observedAt: at,
  });

  const full = aggregateAccounts([
    { upstreamQuota: { used: 5, limit: 10, unit: 'tokens', observedAt: at } },
    { upstreamQuota: { remaining: 5, limit: 20, unit: 'tokens', observedAt: 1_792_334_400_000 } },
  ]).quota;
  assert.equal(full.remaining, 10);
  assert.equal(full.complete, true);
  assert.equal(full.percent, 20 / 30 * 100);
  assert.equal(full.used, 20);
  assert.equal(full.limit, 30);
  assert.equal(full.limitCoverage, 2);
});

test('aggregateAccounts refuses to combine mixed quota units and exposes coverage', () => {
  const quota = aggregateAccounts([
    { upstreamQuota: { remaining: 5, limit: 10, unit: 'tokens', observedAt: at } },
    { upstreamQuota: { remaining: 2, limit: 8, unit: 'requests', observedAt: at } },
  ]).quota;
  assert.equal(quota.coverage, 2);
  assert.equal(quota.total, 2);
  assert.equal(quota.complete, false);
  assert.equal(quota.unit, null);
  assert.equal(quota.remaining, null);
  assert.equal(quota.percent, null);
  assert.equal(quota.limitCoverage, 2);
});

test('aggregateAccounts preserves zero usage, supports scalar legacy totals, and tolerates non-arrays', () => {
  const empty = aggregateAccounts([{}]);
  assert.equal(empty.estimatedTokens, null);
  assert.equal(empty.inputTokens, null);
  assert.equal(empty.outputTokens, null);
  assert.equal(empty.unknownRequests, 0);
  assert.equal(empty.quota.observedAt, null);
  assert.equal(aggregateAccounts(null).total, 0);

  const zeroAndLegacy = aggregateAccounts([
    { estimatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownRequests: 0 } },
    { estimatedUsage: 14 },
    null,
  ]);
  assert.equal(zeroAndLegacy.estimatedTokens, 14);
  assert.equal(zeroAndLegacy.estimateCoverage, 2);
  assert.equal(zeroAndLegacy.inputTokens, 0);
  assert.equal(zeroAndLegacy.outputTokens, 0);
});

test('Muse totals sum provider-labelled tokens and weight opaque counters only for progress', () => {
  const account = (remaining, rawRemaining, weekly) => ({ museUsage: { sample: {
    source: 'muse_subscription', weekly: { percentUsed: weekly },
    additional: { remaining, approximate: true, raw: { remaining: rawRemaining, limit: 40_000_000, unit: 'muse_quota_units' } },
  } } });
  const values = [account(1_000_000_000, 40_000_000, 4), account(500_000_000, 20_000_000, 80)];
  assert.deepEqual(aggregateMuseBalances(values), { remaining: 1_500_000_000, unit: 'tokens', coverage: 2, total: 2, complete: true, approximate: true, percent: 25 });
  assert.deepEqual(aggregateMuseBalances([...values, { museUsage: { sample: null } }]), {
    remaining: 1_500_000_000, unit: 'tokens', coverage: 2, total: 3, complete: false, approximate: true, percent: null,
  });
});

test('Muse total never relabels a raw quota counter as tokens when formatted balance is unavailable', () => {
  const result = aggregateMuseBalances([{ upstreamQuota: { remaining: 40_000_000, unit: 'tokens', observedAt: at }, museUsage: {
    sample: { source: 'muse_subscription', additional: { remaining: null, approximate: false, raw: { remaining: 40_000_000, limit: 40_000_000, unit: 'muse_quota_units' } } },
  } }]);
  assert.equal(result.remaining, null); assert.equal(result.coverage, 0); assert.equal(result.percent, 0);
});
