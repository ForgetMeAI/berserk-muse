const DELIVERY = new Set(['not_sent', 'rejected_before_acceptance', 'accepted', 'unknown']);
const STATUS = new Set(['ok', 'error', 'cancelled', 'timeout', 'rejected']);
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;

const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeTime = value => Number.isFinite(value) && value >= 0 ? value : null;

function cursorValue(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  if (typeof cursor !== 'string' || !/^\d{1,15}$/.test(cursor)) throw new TypeError('cursor must be a decimal sequence string');
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('cursor must be a safe positive sequence');
  return value;
}

function requestGroup() {
  return { first: null, latestSeq: -1, latestAttempt: null, latestResult: null };
}

function chooseEvent(current, event) {
  return !current || event.seq > current.seq ? event : current;
}

function asRequest(requestId, group, isActive) {
  const start = group.first;
  const attempt = group.latestAttempt;
  const result = group.latestResult;
  let status = 'unknown';
  if (result) status = STATUS.has(result.status) ? result.status === 'ok' ? 'completed' : result.status : 'unknown';
  else {
    try { if (isActive(requestId) === true) status = 'running'; } catch { /* Activity hints are non-authoritative. */ }
  }
  const accountId = result?.accountId ?? attempt?.accountId;
  const delivery = result?.delivery ?? attempt?.delivery;
  const errorCode = result?.errorCode ?? attempt?.errorCode;
  return {
    requestId,
    startedAt: safeTime(start?.at),
    finishedAt: result ? safeTime(result.at) : null,
    status,
    accountId: typeof accountId === 'string' && ACCOUNT_ID.test(accountId) ? accountId : null,
    delivery: DELIVERY.has(delivery) ? delivery : null,
    errorCode: typeof errorCode === 'string' && ERROR_CODE.test(errorCode) ? errorCode : null,
    estimatedInputTokens: safeCount(attempt?.estimatedInputTokens),
    estimatedOutputTokens: safeCount(result?.estimatedOutputTokens),
    _latestSeq: group.latestSeq,
  };
}

/**
 * Project bounded telemetry events into one secret-free row per logical request.
 * `telemetry.listRequests` is called newest-first in pages of at most 100, for at most 100 pages.
 */
export function createRequestView({ telemetry, isActive = () => false } = {}) {
  if (typeof telemetry?.listRequests !== 'function') throw new TypeError('telemetry.listRequests is required');
  if (typeof isActive !== 'function') throw new TypeError('isActive must be a function');

  return Object.freeze({
    async list({ limit = 50, cursor = null } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) throw new TypeError('limit must be an integer from 1 to 100');
      const beforeSeq = cursorValue(cursor);
      const groups = new Map();
      let scanCursor = null;

      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const page = await telemetry.listRequests({ limit: PAGE_SIZE, cursor: scanCursor });
        if (!page || !Array.isArray(page.records) || page.records.length > PAGE_SIZE) throw new TypeError('telemetry returned an invalid page');
        for (const event of page.records) {
          if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
              typeof event.requestId !== 'string' || !REQUEST_ID.test(event.requestId) || !['attempt', 'result'].includes(event.kind)) continue;
          let group = groups.get(event.requestId);
          if (!group) { group = requestGroup(); groups.set(event.requestId, group); }
          if (event.seq > group.latestSeq) group.latestSeq = event.seq;
          if (!group.first || event.seq < group.first.seq) group.first = event;
          if (event.kind === 'attempt') group.latestAttempt = chooseEvent(group.latestAttempt, event);
          else group.latestResult = chooseEvent(group.latestResult, event);
        }
        const next = page.nextCursor;
        if (next === null || next === undefined) break;
        const nextValue = typeof next === 'string' && /^\d{1,15}$/.test(next) ? Number(next) : next;
        if (!Number.isSafeInteger(nextValue) || nextValue < 1 || (scanCursor !== null && nextValue >= scanCursor)) break;
        scanCursor = nextValue;
      }

      const ordered = [...groups.entries()]
        .filter(([, group]) => beforeSeq === null || group.latestSeq < beforeSeq)
        .sort((left, right) => right[1].latestSeq - left[1].latestSeq || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
      const selected = ordered.slice(0, limit + 1);
      const hasMore = selected.length > limit;
      const rows = selected.slice(0, limit).map(([id, group]) => asRequest(id, group, isActive));
      const nextCursor = hasMore && rows.length ? String(rows.at(-1)._latestSeq) : null;
      return {
        data: rows.map(({ _latestSeq, ...row }) => row),
        nextCursor,
      };
    },
  });
}
