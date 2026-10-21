# Core account/session/queue/telemetry contracts

Backend modules for multi-account Muse routing. Node >= 22, ESM, builtin-only (these modules add no
dependencies). Every dependency is constructor-injected; every clock is `{ now(): epoch_ms }`
(default `Date.now`). All thrown errors are `BridgeError` subclasses with fixed messages — no
tokens, cookies, URLs, emails, paths or upstream text.

Shared vocabulary:
- **delivery** — `not_sent` | `rejected_before_acceptance` | `accepted` | `unknown`. Only the first two
  are ever retryable (anything accepted/unknown risks a duplicate generation), whatever the status code.
- **account status** — `active` | `expired` | `needs_relogin` | `banned`.
- **quarantine** — independent persisted `quarantinedAt`; cleared only by an explicit verified action.

Wiring: `AccountStore → SessionManager → AccountPool → AccountQueue`; `Telemetry` standalone.
Shutdown order: `queue.close()` → abort active request signals → `pool.close()` →
`sessionManager.close()` → `store.close()` → `telemetry.close()`.

## `src/accounts/store.mjs` — AccountStore (single-writer persistence)

`new AccountStore({ rootDir, clock?, fs? })` — absolute normalized `rootDir` (runtime `.state/accounts`);
`fs` injectable for fault tests. `EventEmitter`: `change` → `{ type, accountIds }` (IDs only).

- `init()` — idempotent; dir 0700, per-root `writer.lock` (live second process → `store_locked`; dead PID
  reclaimed), validates `index.json` and every account. Missing index beside account dirs → `corrupt_state`.
- `listPublic()` / `getPublic(id)` — masked public views. `getPrivate(id)` — full record, trusted callers only.
- `importBatch(entries)` → `{ imported, skipped, indexRevision }`; entry `{ email, emailNormalized, provider,
  mailAccessUrl }`. Identical email+URL skipped; any conflict rejects the whole batch; accounts become
  visible only when the index is committed after every account file.
- `updateAccount(id, expectedRevision, patch, { expectedSessionRevision }?)` — CAS on `revision`; the
  optional `expectedSessionRevision` is checked under the same per-account lock (`session_conflict`), so a
  verdict about an old session can never change a newer one. Patch keys: `enabled`, `status`,
  `reasonCode`, `cooldownUntil`, `quarantinedAt`.
- `replaceSession(id, expectedSessionRevision, session)` → `{ accountId, sessionRevision, expiresAt,
  updatedAt }`; CAS (0 = none yet). One atomic bundle.

Files 0600 / dirs 0700; O_EXCL temp → fsync → rename; symlinks, hardlinks, path escapes and
group/other-readable files → `unsafe_state`. `PublicView = { id, maskedEmail, provider, enabled, status,
reasonCode, quarantined, quarantinedAt, cooldownUntil, hasSession, sessionRevision, sessionExpiresAt,
revision, createdAt, updatedAt }`. Also exports `ACCOUNT_STATUSES`, `ACCOUNT_ID`, `assertAccountId`,
`validateSessionInput`, `maskEmail`, `AccountStoreError`.

## `src/muse/session.mjs` — SessionManager

`new SessionManager({ store, protocol, clock? })`; `store` needs `getPrivate/getPublic/replaceSession/updateAccount`.
Injected `protocol`:
- `probe(privateAccount, session, { signal })` → `{ valid: boolean, expiresAt?: number|null }`.
- `refresh(privateAccount, session, { signal })` → `{ ok: true, session }` | `{ ok: false, reason: 'needs_relogin'|'expired' }`.
  `signal` here is internal to the shared flight and aborts only on `close()`.

Descriptor: `{ accountId, sessionRevision, expiresAt, refreshed, validatedAt }`.
- `ensureValid(accountId, { signal })` — banned/needs_relogin short-circuit; status `expired` or expiry
  within 60 s refreshes without probing; otherwise probes (a malformed probe is `probe_failed`).
- `refresh(accountId, { signal })` — single-flight per account. A caller's abort rejects only that caller.
  **Only** an explicit `{ ok:false, reason }` marks `needs_relogin`/`expired`. Throws, timeouts, unknown
  reasons and malformed results are `refresh_failed` with state untouched. Status marking and reactivation
  are conditional on the session revision they were decided against. A lost CAS surfaces `session_conflict`.
- `drain(accountId?)` — resolves when the in-flight refresh(es) settle; never rejects.
- `close()` — rejects new work (`shutting_down`), aborts in-flight protocol refreshes, awaits them; nothing
  is persisted from an aborted flight.

Token/JWT claims are never trusted; unknown expiry stays `null`. `SessionError` codes: `needs_relogin |
expired | account_banned | session_unavailable | refresh_failed | probe_failed | shutting_down`
(non-enumerable `cause`).

## `src/accounts/pool.mjs` — AccountPool

`new AccountPool({ store, transportFactory, clock?, sessionManager?, accountCooldownMs=30000,
serviceCooldownMs=15000, transientCooldownMs=5000 })`. `transportFactory(privateAccount, session)` →
transport with optional `close()` (or `release()`); it must settle (bound it inside the transport).

**One gate per account**, owned by exactly one of: an acquisition, a lease (including its `recover` and
release cleanup), or an exclusive job. New leases require a free gate **and** no queued exclusive job;
an exclusive job starts only after the current owner fully settles.

- `acquire({ requestId, excludeIds?, signal?, estimatedInputTokens=0 })` → `Lease | null`. Eligible =
  enabled + `active` + session + not quarantined + off cooldown + free gate + not excluded + no service
  block. Order: rolling 5-min estimated input tokens → `lastAssignedAt` → `id` (routing only, never quota).
  With a `sessionManager`, runs `ensureValid` under the gate; a failure drains any joined refresh, and a
  still-usable account gets an explicit bounded in-memory cooldown (`transientCooldownMs`) plus a signal,
  so waiters wake on a timer. Never returns a lease after abort or `close()`.
- `Lease = { id, accountId, sessionRevision, transport }` (frozen).
- `release(lease, outcome?)` → `true` once, `false` afterwards; concurrent calls share one in-flight
  release. The gate stays owned until the transport close **and** persistence finish. A rejected close
  persists quarantine `cleanup_unconfirmed` (held in memory if that write also fails). `outcome.cooldownMs`
  optionally cools the account.
- `noteFailure(lease, failure, { allowRefresh=true })` → `{ retryable, retrySameAccount, retryOtherAccount,
  scope, delivery }`. Non-branded errors → neutral. Explicit `quarantine` persists regardless of delivery;
  explicit `accountStatus` persists only while the lease's `sessionRevision` is current. `service` scope →
  service-wide block. `account` scope: `recoverable` + retryable delivery + `allowRefresh` + session manager
  + no terminal effect → `retrySameAccount`; otherwise (no explicit effect) a cooldown and
  `retryOtherAccount` when retryable. Generic 403 never bans.
- `recover(lease, { signal })` → new `Lease` on the **same** account, under the caller's own gate (no
  deadlock with queued exclusive work): confirm the old transport closed (failure → quarantine,
  `cleanup_unconfirmed`) → refresh (on abort, drain the flight first) → new transport. On failure the
  original lease stays with the caller to release.
- `runExclusive(accountId, fn, { signal })` → `fn(signal)` with the gate held (relogin/health/operator
  jobs). `refreshAccount(accountId, { signal })` = exclusive `sessionManager.refresh` (drained on failure).
- `waitForAvailability(signal?, { excludeIds?, sinceVersion? })` — resolves at once if `sinceVersion` is
  stale or something is eligible; otherwise on the next release/store change/cooldown expiry; rejects on abort.
- `availability({ excludeIds? })` → `{ usable, eligible, serviceBlocked, version }`; `version` getter.
- `accountState(accountId)` → `{ busy }` (safe for the panel). `status()` → account-neutral
  `{ ready, state, mode:'http', model:'Muse app selection', counts }`.
- `quarantine(accountId, reasonCode?)`; `clearQuarantine(accountId, { verified: true, signal? })` (runs under the gate).
- `close()` — waits for in-flight acquisitions/recoveries/exclusive jobs/releases, then retires
  still-held leases (awaiting their transport close; failures quarantine). Later `release` is a no-op.

`new TransportFailure({ code, scope, delivery, recoverable? | refreshable?, quarantine?=false,
accountStatus?=null, upstreamStatus?=null })` — validated (`accountStatus` ∈ `needs_relogin|expired|banned`
requires `account` scope; `service` scope cannot quarantine), frozen, brand-checked via
`TransportFailure.is()`. `upstreamStatus` is informational and never drives retry. Also exported:
`transportFailure()`, `DELIVERY`, `FAILURE_SCOPE`, `FAILURE_ACCOUNT_STATUS`, `isRetryableDelivery`.

## `src/queue.mjs` — AccountQueue (SerialQueue byte-for-byte unchanged)

`new AccountQueue({ pool, limit=4, maxActive=1, maxAttempts=3 (1..3), clock? })`.

- `run(fn, signal, { requestId, estimatedInputTokens=0 })` → `fn(signal, lease)`. One global permit per
  logical request for its whole life; `maxActive` concurrent logical requests; `limit` FIFO **waiting**
  requests (overflow → 429 `queue_full`). The pool never touches the permit.
- Every exit path releases the held lease exactly once and awaits its cleanup before acquiring another
  account or returning the permit; a recovery failure (including abort) releases the original lease.
- Retry only from the pool's branded decision; ≤ `maxAttempts` callback invocations in total; at most
  **one** session refresh per logical request (a refreshed same-account retry counts as an attempt).
  An aborted signal always wins over a retryable failure.
- Waits use the pool `version` captured before `acquire`, so a release in between is never missed.
- No usable account → 503 `no_ready_account`; abort → 499 `request_cancelled`; `close()` rejects waiters
  with 503 `shutting_down` while active requests finish. `status` → `{ active, activeCount, waiting, capacity }`.

## `src/telemetry.mjs` — Telemetry

`new Telemetry({ rootDir, clock?, maxRecords=5000, retentionMs=7d, fs? })`.

- `init()` / `ready()` (idempotent; also run lazily by `record*`) — restores the journal: only
  re-whitelisted, validated, deduplicated events within retention/`maxRecords`, and the next sequence.
  Malformed lines are dropped (`persistence.droppedLines`) and can never add fields.
- Every journal open is `O_NOFOLLOW` + fstat: regular file, `nlink === 1`, owned by us, no group/other
  bits. Unsafe or oversized → **fail closed**: `init()`/`record*` reject with `TelemetryError`
  (`telemetry_unsafe_state` / `telemetry_corrupt_state`), state `failed`, nothing restored.
- `recordAttempt(record)` / `recordResult(record)` → the stored event once it is on disk; otherwise rejects
  with `TelemetryError` (`telemetry_io_error` → state `degraded`; `telemetry_closed` after `close()`). The
  in-memory ring mirrors persisted events only. Whitelist: `requestId, accountId, sessionRevision,
  modelAlias, attempt, queuedMs, durationMs, delivery, status (ok|error|cancelled|timeout|rejected),
  errorCode, estimatedInputTokens, estimatedOutputTokens, upstreamRemaining`; `seq`/`kind`/`at` are assigned.
- `snapshot()` → counts only; estimates as `{ sum, knownCount, unknownCount }` (unknown never summed as
  zero), `upstream.remaining` null unless reported, plus `persistence { state, errorCode, droppedLines }`.
- `listRequests({ limit<=100, cursor })` → `{ records, nextCursor }` newest-first. `persistence` getter.
- Journal `telemetry.jsonl` is append-only and atomically compacted once it holds 2 × `maxRecords` lines.

## Integration notes / remaining constraints

- New persisted `account.json` field `quarantinedAt`. Explicit failure quarantine is applied
  even if the lease's session revision moved on (it is fail-safe and needs a verified clear); explicit
  **status** changes are revision-guarded.
- `expired` accounts are not acquirable, so they are not auto-refreshed by `acquire`; schedule
  `pool.refreshAccount(id)` (exclusive) from the panel/health job to revive them.
- Relogin/health/operator jobs must go through `pool.runExclusive` / `pool.refreshAccount` (not direct store
  or session-manager calls) to be excluded from generation.
- A transport `close()` or protocol call that never settles keeps its account gated (by design); bound
  them inside the transport/protocol implementations.
- Server integration maps `model → modelAlias` and `completed → ok` for telemetry and must handle
  `record*` rejections (fail-closed journal).
