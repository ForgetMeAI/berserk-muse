import * as nodeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { BridgeError } from './errors.mjs';
import { ACCOUNT_ID } from './accounts/store.mjs';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_APPEND } = constants;
const DAY_MS = 24 * 60 * 60_000;
const FILE = 'telemetry.jsonl';
const MAX_LINE_CHARS = 2048;
const KINDS = new Set(['attempt', 'result']);
const DELIVERY = new Set(['not_sent', 'rejected_before_acceptance', 'accepted', 'unknown']);
const STATUS = new Set(['ok', 'error', 'cancelled', 'timeout', 'rejected']);
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const SAFE_ALIAS = /^[A-Za-z0-9_.-]{1,64}$/;
const uid = typeof process.getuid === 'function' ? process.getuid() : null;

const nonNegInt = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const nonNegNum = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const safe = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : null;
const privateStat = stat => stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && (uid === null || stat.uid === uid);

const MESSAGES = {
  telemetry_unsafe_state: 'Telemetry storage contains an unsafe file. Recording is disabled until it is repaired.',
  telemetry_corrupt_state: 'Telemetry storage is unreadable. Recording is disabled until it is repaired.',
  telemetry_io_error: 'Telemetry could not be persisted.',
  telemetry_closed: 'Telemetry is closed.',
};
const FATAL = new Set(['telemetry_unsafe_state', 'telemetry_corrupt_state']);

// Fixed, safe persistence errors; raw filesystem errors are never surfaced.
export class TelemetryError extends BridgeError {
  constructor(code) {
    const known = Object.hasOwn(MESSAGES, code) ? code : 'telemetry_io_error';
    super(MESSAGES[known], 500, known);
    this.name = 'TelemetryError';
  }
}

const openError = error => new TelemetryError(error?.code === 'ELOOP' || error?.code === 'EMLINK' ? 'telemetry_unsafe_state' : 'telemetry_io_error');

// Whitelisted projection. Every field is validated to a safe type/shape; anything not listed
// (prompts, responses, tool args, mail, bodies, URLs, headers, raw error text) is discarded here,
// so untrusted input — including a tampered journal line — can never add fields.
function project(kind, record, at, seq) {
  const input = record && typeof record === 'object' ? record : {};
  const event = {
    seq, kind, at,
    requestId: safe(input.requestId, SAFE_ID),
    accountId: safe(input.accountId, ACCOUNT_ID),
    sessionRevision: nonNegInt(input.sessionRevision),
    modelAlias: safe(input.modelAlias, SAFE_ALIAS),
    attempt: nonNegInt(input.attempt),
    queuedMs: nonNegNum(input.queuedMs),
    durationMs: nonNegNum(input.durationMs),
    delivery: DELIVERY.has(input.delivery) ? input.delivery : null,
    status: STATUS.has(input.status) ? input.status : null,
    errorCode: safe(input.errorCode, SAFE_CODE),
    // null means "unknown" and is counted separately; it is never coerced to zero.
    estimatedInputTokens: nonNegInt(input.estimatedInputTokens),
    estimatedOutputTokens: nonNegInt(input.estimatedOutputTokens),
    // Upstream quota remaining stays null unless the upstream actually reported a number.
    upstreamRemaining: nonNegNum(input.upstreamRemaining),
  };
  return event;
}

function restoreEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!KINDS.has(raw.kind) || !Number.isSafeInteger(raw.seq) || raw.seq < 1 || !Number.isSafeInteger(raw.at) || raw.at < 0) return null;
  return project(raw.kind, raw, raw.at, raw.seq);
}

// Telemetry({ rootDir, clock, maxRecords = 5000, retentionMs = 7 days, fs? })
//   init() / ready()     -> restore the bounded, re-validated journal and the next sequence (idempotent)
//   recordAttempt(record) / recordResult(record) -> stored event once persisted; rejects with TelemetryError otherwise
//   snapshot()           -> aggregate counts + persistence { state, errorCode, droppedLines }, never secrets
//   listRequests({ limit <= 100, cursor }) -> { records, nextCursor } newest-first, paginated
//   persistence          -> { state: 'uninitialized'|'ok'|'degraded'|'failed', errorCode, droppedLines }
//   close()              -> flush pending appends
// The journal is append-only (O_NOFOLLOW, fstat-checked regular/nlink 1/owner/0600 on every open) and is
// compacted atomically once it holds 2 x maxRecords lines. An unsafe or unreadable journal fails closed.
export class Telemetry {
  #root;
  #fs;
  #clock;
  #maxRecords;
  #retentionMs;
  #ring = [];
  #seq = 0;
  #lines = 0;
  #chain = Promise.resolve();
  #initPromise = null;
  #state = 'uninitialized';
  #errorCode = null;
  #droppedLines = 0;
  #closed = false;

  constructor({ rootDir, clock = { now: () => Date.now() }, maxRecords = 5000, retentionMs = 7 * DAY_MS, fs = nodeFs } = {}) {
    const root = typeof rootDir === 'string' && isAbsolute(rootDir) ? resolve(rootDir) : null;
    if (!root || root === '/' || (rootDir !== root && rootDir !== `${root}/`)) throw new TypeError('rootDir must be an absolute normalized directory');
    if (typeof clock?.now !== 'function') throw new TypeError('clock.now must be a function');
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new TypeError('retentionMs must be a positive integer');
    this.#root = root;
    this.#fs = fs;
    this.#clock = clock;
    this.#maxRecords = maxRecords;
    this.#retentionMs = retentionMs;
  }

  init() {
    this.#initPromise ??= this.#initialize();
    return this.#initPromise;
  }

  ready() { return this.init(); }

  get persistence() {
    return { state: this.#state, errorCode: this.#errorCode, droppedLines: this.#droppedLines };
  }

  recordAttempt(record) { return this.#record('attempt', record); }

  recordResult(record) { return this.#record('result', record); }

  snapshot() {
    this.#ring = this.#pruned(this.#ring);
    const totals = { attempts: 0, results: 0 };
    const byStatus = {};
    const byDelivery = {};
    const byErrorCode = {};
    const estimatedInputTokens = { sum: 0, knownCount: 0, unknownCount: 0 };
    const estimatedOutputTokens = { sum: 0, knownCount: 0, unknownCount: 0 };
    const requests = new Set();
    let upstreamRemaining = null;
    let upstreamReportedAt = null;
    const tally = (bucket, key) => { if (key !== null) bucket[key] = (bucket[key] ?? 0) + 1; };
    const measure = (bucket, value) => {
      if (value === null) bucket.unknownCount += 1;
      else { bucket.sum += value; bucket.knownCount += 1; }
    };
    for (const event of this.#ring) {
      if (event.requestId !== null) requests.add(event.requestId);
      if (event.kind === 'attempt') { totals.attempts += 1; measure(estimatedInputTokens, event.estimatedInputTokens); continue; }
      totals.results += 1;
      tally(byStatus, event.status);
      tally(byDelivery, event.delivery);
      tally(byErrorCode, event.errorCode);
      measure(estimatedOutputTokens, event.estimatedOutputTokens);
      if (event.upstreamRemaining !== null) { upstreamRemaining = event.upstreamRemaining; upstreamReportedAt = event.at; }
    }
    return {
      generatedAt: this.#clock.now(), windowMs: this.#retentionMs,
      totals, requests: requests.size, byStatus, byDelivery, byErrorCode,
      estimatedInputTokens, estimatedOutputTokens,
      upstream: { remaining: upstreamRemaining, reportedAt: upstreamReportedAt },
      persistence: this.persistence,
    };
  }

  listRequests({ limit = 50, cursor = null } = {}) {
    this.#ring = this.#pruned(this.#ring);
    const capped = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50;
    const upper = Number.isSafeInteger(cursor) ? cursor : Infinity;
    const eligible = this.#ring.filter(event => event.seq < upper);
    const page = eligible.slice(-capped);
    const records = page.slice().reverse().map(event => ({ ...event }));
    const nextCursor = eligible.length > page.length && page.length > 0 ? page[0].seq : null;
    return { records, nextCursor };
  }

  async close() {
    this.#closed = true;
    await this.#initPromise?.catch(() => {});
    await this.#chain;
  }

  async #record(kind, record) {
    await this.init();
    if (this.#closed) throw new TelemetryError('telemetry_closed');
    if (this.#state === 'failed') throw new TelemetryError(this.#errorCode);
    const event = project(kind, record, this.#clock.now(), this.#seq += 1);
    const persisted = this.#chain.then(() => this.#append(event));
    this.#chain = persisted.then(() => undefined, () => undefined);
    await persisted;
    return { ...event };
  }

  // The in-memory ring only ever mirrors events that reached disk.
  async #append(event) {
    if (this.#state === 'failed') throw new TelemetryError(this.#errorCode);
    try {
      if (this.#lines >= this.#maxRecords * 2) {
        const retained = this.#pruned([...this.#ring, event]);
        await this.#rewrite(retained);
        this.#ring = retained;
        this.#lines = retained.length;
      } else {
        await this.#appendLine(`${JSON.stringify(event)}\n`);
        this.#lines += 1;
        this.#ring = this.#pruned([...this.#ring, event]);
      }
    } catch (error) {
      const failure = error instanceof TelemetryError ? error : new TelemetryError('telemetry_io_error');
      this.#state = FATAL.has(failure.code) ? 'failed' : 'degraded';
      this.#errorCode = failure.code;
      throw failure;
    }
    if (this.#state === 'degraded') {
      this.#state = 'ok';
      this.#errorCode = null;
    }
  }

  #pruned(events) {
    const cutoff = this.#clock.now() - this.#retentionMs;
    const live = events.filter(event => event.at >= cutoff);
    return live.length > this.#maxRecords ? live.slice(-this.#maxRecords) : live;
  }

  async #initialize() {
    try {
      await this.#fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
      const stat = await this.#fs.lstat(this.#root);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid)) throw new TelemetryError('telemetry_unsafe_state');
      if ((stat.mode & 0o077) !== 0) await this.#fs.chmod(this.#root, 0o700);
      await this.#restore();
      this.#state = 'ok';
      this.#errorCode = null;
    } catch (error) {
      const failure = error instanceof TelemetryError ? error : new TelemetryError('telemetry_io_error');
      this.#state = 'failed';
      this.#errorCode = failure.code;
      throw failure;
    }
  }

  async #restore() {
    let handle;
    try { handle = await this.#fs.open(join(this.#root, FILE), O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw openError(error);
    }
    let text;
    try {
      const stat = await handle.stat();
      if (!privateStat(stat)) throw new TelemetryError('telemetry_unsafe_state');
      if (stat.size > (this.#maxRecords * 2 + 16) * MAX_LINE_CHARS * 4) throw new TelemetryError('telemetry_corrupt_state');
      text = await handle.readFile({ encoding: 'utf8' });
    } catch (error) {
      throw error instanceof TelemetryError ? error : new TelemetryError('telemetry_io_error');
    } finally { await handle.close().catch(() => {}); }
    const bySeq = new Map();
    let lines = 0;
    let maxSeq = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      lines += 1;
      let event = null;
      if (line.length <= MAX_LINE_CHARS) {
        try { event = restoreEvent(JSON.parse(line)); } catch { event = null; }
      }
      if (!event || bySeq.has(event.seq)) {
        this.#droppedLines += 1;
        continue;
      }
      bySeq.set(event.seq, event);
      maxSeq = Math.max(maxSeq, event.seq);
    }
    this.#seq = maxSeq;
    this.#lines = lines;
    this.#ring = this.#pruned([...bySeq.values()].sort((a, b) => a.seq - b.seq));
  }

  async #appendLine(line) {
    let handle;
    try { handle = await this.#fs.open(join(this.#root, FILE), O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK, 0o600); }
    catch (error) { throw openError(error); }
    try {
      if (!privateStat(await handle.stat())) throw new TelemetryError('telemetry_unsafe_state');
      await handle.writeFile(line, 'utf8');
    } catch (error) {
      throw error instanceof TelemetryError ? error : new TelemetryError('telemetry_io_error');
    } finally { await handle.close().catch(() => {}); }
  }

  // Atomic compaction of our own journal: exclusive temp file, fsync, refuse an unsafe target, rename.
  async #rewrite(events) {
    const target = join(this.#root, FILE);
    const temp = join(this.#root, `.${FILE}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await this.#fs.open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      await handle.writeFile(events.map(event => `${JSON.stringify(event)}\n`).join(''), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      let stat = null;
      try { stat = await this.#fs.lstat(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (stat && !privateStat(stat)) throw new TelemetryError('telemetry_unsafe_state');
      await this.#fs.rename(temp, target);
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.#fs.unlink(temp).catch(() => {});
      throw error instanceof TelemetryError ? error : new TelemetryError('telemetry_io_error');
    }
  }
}
