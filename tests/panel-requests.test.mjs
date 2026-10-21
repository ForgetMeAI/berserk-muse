import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestView } from '../src/panel/requests.mjs';

const ACCOUNT_A = '123e4567-e89b-42d3-a456-426614174000';
const ACCOUNT_B = '123e4567-e89b-42d3-a456-426614174001';

function fakeTelemetry(records) {
  return {
    async listRequests({ limit = 100, cursor = null } = {}) {
      const eligible = records.filter(event => cursor === null || event.seq < cursor).sort((a, b) => b.seq - a.seq);
      const page = eligible.slice(0, limit);
      return { records: page, nextCursor: page.length < eligible.length ? page.at(-1).seq : null };
    },
  };
}

const attempt = (seq, requestId, at, fields = {}) => ({ seq, kind: 'attempt', requestId, at, ...fields });
const result = (seq, requestId, at, fields = {}) => ({ seq, kind: 'result', requestId, at, ...fields });

test('groups retry attempts with one final result and uses earliest/latest times', async () => {
  const view = createRequestView({ telemetry: fakeTelemetry([
    attempt(1, 'req-a', 100, { accountId: ACCOUNT_A, estimatedInputTokens: 11, delivery: 'not_sent' }),
    attempt(2, 'req-a', 200, { accountId: ACCOUNT_B, estimatedInputTokens: 17, delivery: 'accepted' }),
    result(3, 'req-a', 350, { accountId: ACCOUNT_A, status: 'error', errorCode: 'transient_error', delivery: 'unknown' }),
    result(4, 'req-a', 400, { accountId: ACCOUNT_B, status: 'ok', delivery: 'accepted', estimatedOutputTokens: 23 }),
  ]) });
  const page = await view.list();
  assert.equal(page.data.length, 1);
  assert.deepEqual(page.data[0], {
    requestId: 'req-a', startedAt: 100, finishedAt: 400, status: 'completed', accountId: ACCOUNT_B,
    delivery: 'accepted', errorCode: null, estimatedInputTokens: 17, estimatedOutputTokens: 23,
  });
  assert.equal(page.nextCursor, null);
});

test('restored orphan attempts are unknown unless active in memory', async () => {
  const telemetry = fakeTelemetry([attempt(1, 'orphan', 100, { accountId: ACCOUNT_A })]);
  const inactive = await createRequestView({ telemetry }).list();
  assert.equal(inactive.data[0].status, 'unknown');
  const active = await createRequestView({ telemetry, isActive: id => id === 'orphan' }).list();
  assert.equal(active.data[0].status, 'running');
  assert.equal(active.data[0].finishedAt, null);
});

test('cursor paginates grouped requests stably across newly appended rows', async () => {
  const records = [
    attempt(1, 'old-a', 10), result(2, 'old-a', 20, { status: 'ok' }),
    attempt(3, 'mid-b', 30), result(4, 'mid-b', 40, { status: 'error', errorCode: 'upstream_error' }),
    attempt(5, 'new-c', 50), result(6, 'new-c', 60, { status: 'ok' }),
  ];
  const telemetry = fakeTelemetry(records);
  const view = createRequestView({ telemetry });
  const first = await view.list({ limit: 1 });
  assert.equal(first.data[0].requestId, 'new-c');
  assert.equal(first.nextCursor, '6');

  records.push(attempt(7, 'later-d', 70), result(8, 'later-d', 80, { status: 'ok' }));
  const second = await view.list({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.data[0].requestId, 'mid-b');
  assert.equal(second.nextCursor, '4');
  const third = await view.list({ limit: 1, cursor: second.nextCursor });
  assert.equal(third.data[0].requestId, 'old-a');
  assert.equal(third.nextCursor, null);
});

test('returns only whitelisted fields and omits raw-data canaries', async () => {
  const view = createRequestView({ telemetry: fakeTelemetry([
    attempt(1, 'safe-id', 100, { accountId: ACCOUNT_A, estimatedInputTokens: 3, prompt: 'PROMPT_CANARY', mailAccessUrl: 'URL_CANARY' }),
    result(2, 'safe-id', 200, { status: 'error', errorCode: 'safe_error', estimatedOutputTokens: 4,
      rawError: 'ERROR_CANARY', response: 'RESPONSE_CANARY', accessToken: 'TOKEN_CANARY' }),
  ]) });
  const serialized = JSON.stringify(await view.list());
  for (const canary of ['PROMPT_CANARY', 'URL_CANARY', 'ERROR_CANARY', 'RESPONSE_CANARY', 'TOKEN_CANARY']) assert.equal(serialized.includes(canary), false);
  assert.equal(serialized.includes('estimatedInputTokens'), true);
  assert.equal(serialized.includes('estimatedOutputTokens'), true);
  assert.equal(serialized.includes('rawError'), false);
});

test('rejects malformed limits and cursors instead of broadening the read', async () => {
  const view = createRequestView({ telemetry: fakeTelemetry([]) });
  await assert.rejects(view.list({ limit: 101 }), TypeError);
  await assert.rejects(view.list({ cursor: '1e3' }), TypeError);
});
