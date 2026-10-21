import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile, stat, link, symlink, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Telemetry, TelemetryError } from '../src/telemetry.mjs';

const TMP = join(dirname(dirname(fileURLToPath(import.meta.url))), '.test-tmp');
const ACCOUNT = '123e4567-e89b-42d3-a456-426614174000';
const FILE = 'telemetry.jsonl';

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: ms => { now += ms; } };
}

async function telemetry(t, options = {}) {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, 'telemetry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rootDir = join(dir, 'telemetry');
  const clock = options.clock ?? makeClock();
  const tel = new Telemetry({ rootDir, ...options, clock });
  t.after(() => tel.close());
  return { tel, rootDir, clock };
}

const SECRETS = ['SECRET_PROMPT', 'SECRET_BODY', 'SECRET_AUTH', 'SECRET_ERROR', 'SECRET_MAIL', 'SECRET_TOOL', 'SECRET_MSG'];
const poisoned = extra => ({
  prompt: 'SECRET_PROMPT', responseBody: 'SECRET_BODY', headers: { authorization: 'SECRET_AUTH' },
  error: 'SECRET_ERROR at line 9', mailAccessUrl: 'https://mail/SECRET_MAIL', toolArgs: { q: 'SECRET_TOOL' },
  message: 'SECRET_MSG', ...extra,
});

test('records whitelisted attempt/result fields and aggregates them in a snapshot', async t => {
  const { tel } = await telemetry(t);
  await tel.recordAttempt({ requestId: 'req-1', accountId: ACCOUNT, sessionRevision: 2, modelAlias: 'muse-web', attempt: 1, queuedMs: 12, estimatedInputTokens: 100 });
  await tel.recordResult({ requestId: 'req-1', accountId: ACCOUNT, sessionRevision: 2, modelAlias: 'muse-web', durationMs: 900, delivery: 'accepted', status: 'ok', estimatedInputTokens: 100, estimatedOutputTokens: 40 });
  await tel.recordResult({ requestId: 'req-2', status: 'error', delivery: 'not_sent', errorCode: 'transport_failed' });

  const snapshot = tel.snapshot();
  assert.equal(snapshot.totals.attempts, 1);
  assert.equal(snapshot.totals.results, 2);
  assert.equal(snapshot.requests, 2);
  assert.equal(snapshot.byStatus.ok, 1);
  assert.equal(snapshot.byStatus.error, 1);
  assert.equal(snapshot.byDelivery.accepted, 1);
  assert.equal(snapshot.byErrorCode.transport_failed, 1);
  assert.equal(snapshot.estimatedOutputTokens.sum, 40);
});

test('discards every non-whitelisted field so secrets never reach disk or snapshots', async t => {
  const { tel, rootDir } = await telemetry(t);
  const event = await tel.recordResult(poisoned({ requestId: 'req-x', accountId: ACCOUNT, status: 'ok', delivery: 'accepted', errorCode: 'bad_code', estimatedOutputTokens: 5 }));
  for (const forbidden of ['prompt', 'responseBody', 'headers', 'error', 'mailAccessUrl', 'toolArgs', 'message']) {
    assert.equal(Object.hasOwn(event, forbidden), false, `event retained forbidden key ${forbidden}`);
  }
  assert.equal(event.errorCode, 'bad_code');
  assert.equal(event.status, 'ok');

  const serialized = JSON.stringify([tel.snapshot(), tel.listRequests({})]);
  const onDisk = await readFile(join(rootDir, FILE), 'utf8');
  for (const secret of SECRETS) {
    assert.equal(serialized.includes(secret), false, `snapshot/list leaked ${secret}`);
    assert.equal(onDisk.includes(secret), false, `disk log leaked ${secret}`);
  }
});

test('unknown token counts are tracked separately and never summed as zero', async t => {
  const { tel } = await telemetry(t);
  await tel.recordResult({ requestId: 'a', status: 'ok', delivery: 'accepted', estimatedOutputTokens: null });
  await tel.recordResult({ requestId: 'b', status: 'ok', delivery: 'accepted', estimatedOutputTokens: 7 });
  const out = tel.snapshot().estimatedOutputTokens;
  assert.equal(out.sum, 7);
  assert.equal(out.knownCount, 1);
  assert.equal(out.unknownCount, 1);
});

test('upstream remaining stays null until actually reported and is kept apart from estimates', async t => {
  const { tel } = await telemetry(t);
  await tel.recordResult({ requestId: 'a', status: 'ok', delivery: 'accepted', estimatedOutputTokens: 10 });
  assert.equal(tel.snapshot().upstream.remaining, null);
  await tel.recordResult({ requestId: 'b', status: 'ok', delivery: 'accepted', estimatedOutputTokens: 10, upstreamRemaining: 42 });
  const snapshot = tel.snapshot();
  assert.equal(snapshot.upstream.remaining, 42);
  assert.equal(snapshot.estimatedOutputTokens.sum, 20, 'quota is never merged into the token estimate');
});

test('listRequests returns newest-first pages, clamps the limit, and walks a cursor', async t => {
  const { tel } = await telemetry(t);
  for (let i = 0; i < 5; i += 1) await tel.recordAttempt({ requestId: `r${i}` });
  const first = tel.listRequests({ limit: 2 });
  assert.deepEqual(first.records.map(r => r.requestId), ['r4', 'r3']);
  const second = tel.listRequests({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.records.map(r => r.requestId), ['r2', 'r1']);
  assert.ok(tel.listRequests({ limit: 1000 }).records.length <= 100);
});

test('the in-memory ring stays at maxRecords and the journal is compacted at 2 x maxRecords', async t => {
  const { tel, rootDir } = await telemetry(t, { maxRecords: 3 });
  for (let i = 0; i < 7; i += 1) await tel.recordAttempt({ requestId: `r${i}`, estimatedInputTokens: i });
  assert.deepEqual(tel.listRequests({ limit: 100 }).records.map(r => r.requestId), ['r6', 'r5', 'r4']);
  await tel.close();
  const lines = (await readFile(join(rootDir, FILE), 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'the 7th append compacted the journal down to the retained ring');
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
});

test('init restores bounded whitelisted records and continues the sequence after restart', async t => {
  const { tel, rootDir, clock } = await telemetry(t);
  await tel.init();
  for (let i = 0; i < 3; i += 1) await tel.recordAttempt({ requestId: `r${i}`, estimatedInputTokens: i });
  await tel.recordResult({ requestId: 'r2', status: 'ok', delivery: 'accepted', estimatedOutputTokens: null });
  await tel.close();

  const reopened = new Telemetry({ rootDir, clock });
  t.after(() => reopened.close());
  await reopened.ready();
  assert.deepEqual(reopened.listRequests({}).records.map(r => r.requestId), ['r2', 'r2', 'r1', 'r0']);
  const next = await reopened.recordAttempt({ requestId: 'r3' });
  assert.equal(next.seq, 5, 'the sequence continues after the restored journal');
  const snapshot = reopened.snapshot();
  assert.equal(snapshot.totals.attempts, 4);
  assert.equal(snapshot.estimatedOutputTokens.unknownCount, 1, 'restored unknown usage stays unknown');
  assert.equal(snapshot.upstream.remaining, null);
  assert.deepEqual(snapshot.persistence, { state: 'ok', errorCode: null, droppedLines: 0 });
});

test('restored journal lines are re-whitelisted and malformed lines are dropped', async t => {
  const { tel, rootDir, clock } = await telemetry(t);
  await tel.init();
  await tel.close();
  const now = clock.now();
  await writeFile(join(rootDir, FILE), [
    JSON.stringify({ seq: 1, kind: 'attempt', at: now, requestId: 'kept-1', prompt: 'SECRET_PROMPT', evil: { headers: 'SECRET_AUTH' } }),
    'not json at all',
    JSON.stringify({ seq: 2, kind: 'other', at: now, requestId: 'bad-kind' }),
    JSON.stringify({ seq: 1, kind: 'attempt', at: now, requestId: 'duplicate-seq' }),
    '',
  ].join('\n'), { mode: 0o600 });

  const reopened = new Telemetry({ rootDir, clock });
  t.after(() => reopened.close());
  await reopened.init();
  const { records } = reopened.listRequests({});
  assert.deepEqual(records.map(r => r.requestId), ['kept-1']);
  assert.equal(Object.hasOwn(records[0], 'prompt'), false);
  assert.equal(Object.hasOwn(records[0], 'evil'), false);
  assert.equal(JSON.stringify([records, reopened.snapshot()]).includes('SECRET'), false);
  assert.equal(reopened.persistence.droppedLines, 3);
});

test('a hardlinked journal fails closed at init with a fixed persistence error', async t => {
  const { tel, rootDir } = await telemetry(t);
  await tel.recordAttempt({ requestId: 'r0' });
  await tel.close();
  await link(join(rootDir, FILE), join(rootDir, 'copied.jsonl'));

  const reopened = new Telemetry({ rootDir, clock: makeClock() });
  t.after(() => reopened.close());
  await assert.rejects(reopened.init(), e => e instanceof TelemetryError && e.code === 'telemetry_unsafe_state');
  await assert.rejects(reopened.recordAttempt({ requestId: 'r1' }), e => e.code === 'telemetry_unsafe_state');
  assert.equal(reopened.persistence.state, 'failed');
  assert.equal(reopened.snapshot().persistence.errorCode, 'telemetry_unsafe_state');
  assert.deepEqual(reopened.listRequests({}).records, [], 'nothing is restored from an unsafe journal');
});

test('an append refuses a journal that became hardlinked, symlinked, or group-readable', async t => {
  const hardlinked = await telemetry(t);
  await hardlinked.tel.recordAttempt({ requestId: 'r0' });
  await link(join(hardlinked.rootDir, FILE), join(hardlinked.rootDir, 'copied.jsonl'));
  await assert.rejects(hardlinked.tel.recordAttempt({ requestId: 'r1' }), e => e.code === 'telemetry_unsafe_state');
  await assert.rejects(hardlinked.tel.recordAttempt({ requestId: 'r2' }), e => e.code === 'telemetry_unsafe_state', 'stays failed');
  assert.deepEqual(hardlinked.tel.listRequests({}).records.map(r => r.requestId), ['r0'], 'refused events are not kept');

  const symlinked = await telemetry(t);
  await symlinked.tel.init();
  await symlink(join(symlinked.rootDir, 'elsewhere.jsonl'), join(symlinked.rootDir, FILE));
  await assert.rejects(symlinked.tel.recordAttempt({ requestId: 'r0' }), e => e.code === 'telemetry_unsafe_state');

  const loose = await telemetry(t);
  await loose.tel.recordAttempt({ requestId: 'r0' });
  await chmod(join(loose.rootDir, FILE), 0o644);
  await assert.rejects(loose.tel.recordAttempt({ requestId: 'r1' }), e => e.code === 'telemetry_unsafe_state');
});

test('retention drops events older than the window', async t => {
  const { tel, clock } = await telemetry(t, { retentionMs: 1000 });
  await tel.recordAttempt({ requestId: 'stale' });
  clock.advance(2000);
  await tel.recordAttempt({ requestId: 'fresh' });
  const list = tel.listRequests({});
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].requestId, 'fresh');
});

test('appends are immutable and never touch neighbouring files', async t => {
  const { tel, rootDir } = await telemetry(t);
  await tel.recordAttempt({ requestId: 'r0' });
  await writeFile(join(rootDir, 'neighbour.txt'), 'UNRELATED', 'utf8');
  await tel.recordAttempt({ requestId: 'r1' });
  await tel.close();
  assert.equal(await readFile(join(rootDir, 'neighbour.txt'), 'utf8'), 'UNRELATED');
  assert.equal((await stat(join(rootDir, FILE))).mode & 0o777, 0o600);
});

test('rejects an unsafe rootDir and invalid bounds', async t => {
  assert.throws(() => new Telemetry({ rootDir: 'relative' }), TypeError);
  assert.throws(() => new Telemetry({ rootDir: '/', maxRecords: 1 }), TypeError);
  const { rootDir } = await telemetry(t);
  assert.throws(() => new Telemetry({ rootDir, maxRecords: 0 }), TypeError);
  assert.throws(() => new Telemetry({ rootDir, retentionMs: 0 }), TypeError);
});
