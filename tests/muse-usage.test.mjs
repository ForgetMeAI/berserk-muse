import test from 'node:test';
import assert from 'node:assert/strict';
import { MuseUsageError, parseMuseSubscriptionFlight } from '../src/muse/usage.mjs';

function flight(subscription = {}) {
  return [
    `0:${JSON.stringify({ a: '$@1', b: '$undefined' })}`,
    `1:${JSON.stringify({ success: true, subscription: {
      tier: { tierCode: 'power', name: 'Power', isPaid: true, rank: 2 },
      usage: { state: 'active', percentUsed: 4, resetsAt: 1_800_000_000, quotaStatus: 'available' },
      topupBalance: 40_000_000, topupTotal: 50_000_000,
      topupRowValueLabel: '20% used (40M tokens left)',
      ...subscription,
    } })}`,
  ].join('\n');
}

test('projects subscription Flight data into a fixed weekly and additional-usage schema', () => {
  assert.deepEqual(parseMuseSubscriptionFlight(flight(), { observedAt: 1234 }), {
    source: 'muse_subscription', observedAt: 1234,
    tier: { code: 'power', name: 'Power', isPaid: true },
    weekly: { state: 'active', percentUsed: 4, resetsAt: 1_800_000_000, quotaStatus: 'available' },
    additional: {
      remaining: 40_000_000, limit: null, used: null, percentUsed: 20,
      approximate: true, displayLabel: '20% used (40M tokens left)',
      raw: { remaining: 40_000_000, limit: 50_000_000, unit: 'muse_quota_units' },
    },
  });
});

test('zero top-up total preserves the provider-reported zero and does not invent a percentage', () => {
  const value = parseMuseSubscriptionFlight(flight({ topupBalance: 0, topupTotal: 0, topupRowValueLabel: '0% used (0 tokens left)' }));
  assert.deepEqual(value.additional, {
    remaining: 0, limit: null, used: null, percentUsed: null, approximate: false,
    displayLabel: '0% used (0 tokens left)',
    raw: { remaining: 0, limit: 0, unit: 'muse_quota_units' },
  });
});

test('uses the provider display label for actual token balance, never raw Muse quota units', () => {
  const billion = parseMuseSubscriptionFlight(flight({
    topupBalance: 40_000_000, topupTotal: 40_000_000,
    topupRowValueLabel: '0% used (1B tokens left)',
  }));
  assert.equal(billion.additional.remaining, 1_000_000_000);
  assert.equal(billion.additional.approximate, true);
  assert.equal(billion.additional.percentUsed, 0);
  assert.equal(billion.additional.limit, null);
  assert.equal(billion.additional.used, null);
  assert.deepEqual(billion.additional.raw, { remaining: 40_000_000, limit: 40_000_000, unit: 'muse_quota_units' });

  const millions = parseMuseSubscriptionFlight(flight({ topupBalance: 38_000_000, topupRowValueLabel: '24% used (760M tokens left)' }));
  assert.equal(millions.additional.remaining, 760_000_000);
  assert.equal(millions.additional.approximate, true);
  assert.equal(millions.additional.percentUsed, 24);
});

test('parses comma-grouped exact integer counts and bounds the token label grammar', () => {
  const exact = parseMuseSubscriptionFlight(flight({ topupRowValueLabel: '0% used (1,234,567 tokens left)' }));
  assert.equal(exact.additional.remaining, 1_234_567);
  assert.equal(exact.additional.approximate, false);
  for (const label of [
    'Tokens left: 1234567', '0% used (1,23M tokens left)', '101% used (2M tokens left)',
    '0% used (9000000000B tokens left)', '0% used (1.25M tokens left)', '0% used (https://example.test tokens left)',
  ]) {
    const parsed = parseMuseSubscriptionFlight(flight({ topupRowValueLabel: label }));
    assert.equal(parsed.additional.remaining, null, label);
    assert.equal(parsed.additional.displayLabel, null, label);
    assert.equal(parsed.weekly.percentUsed, 4, label);
    assert.equal(parsed.additional.percentUsed, 20, label);
  }
});

test('rejects invalid or contradictory source numbers without coercion', () => {
  const invalid = [
    { topupBalance: '40000000' },
    { topupBalance: -1 },
    { topupBalance: 51, topupTotal: 50 },
    { topupBalance: 1, topupTotal: 0 },
    { usage: { state: 'active', percentUsed: 101, resetsAt: 1, quotaStatus: 'available' } },
    { usage: { state: 'active', percentUsed: -0.01, resetsAt: 1, quotaStatus: 'available' } },
    { usage: { state: 'active', percentUsed: '4', resetsAt: 1, quotaStatus: 'available' } },
    { usage: { state: 'active', percentUsed: 4, resetsAt: '2030-01-01T00:00:00Z', quotaStatus: 'available' } },
    { topupBalance: 1, topupTotal: undefined },
  ];
  for (const subscription of invalid) {
    assert.throws(() => parseMuseSubscriptionFlight(flight(subscription)), error => error.code === 'usage_response_invalid');
  }
});

test('rejects malformed, missing, error, oversized, and over-row-limit Flight bodies safely', () => {
  const invalid = [
    '',
    '0:{not-json}\n1:{}',
    `0:${JSON.stringify({ a: '$@2' })}\n1:${JSON.stringify({ success: true, subscription: {} })}`,
    `0:${JSON.stringify({ a: '$@1' })}\n1:${JSON.stringify({ success: false, subscription: {} })}`,
    `0:${JSON.stringify({ a: '$@1' })}\n1:${JSON.stringify({ success: true })}`,
    `0:${JSON.stringify({ a: '$@1' })}\n1:${JSON.stringify({ success: true, subscription: {} })}\n1:{}`,
    `0:${JSON.stringify({ a: '$@1' })}\n1:${JSON.stringify({ success: true, subscription: {} })}\n${Array.from({ length: 255 }, (_, i) => `${(i + 2).toString(16)}:{}`).join('\n')}`,
    'x'.repeat(1_048_577),
  ];
  for (const body of invalid) {
    assert.throws(() => parseMuseSubscriptionFlight(body), error => error instanceof MuseUsageError && error.code === 'usage_response_invalid');
  }
});

test('usage errors expose fixed safe messages only', () => {
  const error = new MuseUsageError('usage_forbidden');
  assert.equal(error.code, 'usage_forbidden');
  assert.equal(error.message, 'Muse denied access to usage information.');
  assert.equal(new MuseUsageError('secret upstream text').code, 'usage_unavailable');
});
