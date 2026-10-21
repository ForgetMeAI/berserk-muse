import { EventEmitter } from 'node:events';
import * as nodeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { BridgeError } from '../errors.mjs';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants;
export const ACCOUNT_STATUSES = Object.freeze(['active', 'expired', 'needs_relogin', 'banned']);
export const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^[a-z0-9_]{1,64}$/;
const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const UNSAFE_TEXT = /[\u0000- \u007f]/;
const TEMP_FILE = /^\.(?:index|account|mail|session)\.json\.[0-9a-f-]{36}\.tmp$/;
const LIMITS = { index: 1 << 22, account: 1 << 16, mail: 1 << 16, session: 1 << 19, lock: 1 << 12 };
const MAX_BATCH = 1000;
const LOCK_FILE = 'writer.lock';
const ENTRY_KEYS = ['email', 'emailNormalized', 'provider', 'mailAccessUrl'];
const PATCH_KEYS = ['enabled', 'status', 'reasonCode', 'cooldownUntil', 'quarantinedAt'];
const SESSION_INPUT_KEYS = ['cookies', 'tokens', 'device', 'expiresAt'];
const ACCOUNT_KEYS = ['schemaVersion', 'id', 'email', 'emailNormalized', 'provider', 'enabled', 'status', 'reasonCode',
  'revision', 'createdAt', 'updatedAt', 'cooldownUntil', 'quarantinedAt'];
const SESSION_KEYS = ['schemaVersion', 'sessionRevision', 'cookies', 'tokens', 'device', 'expiresAt', 'updatedAt'];
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const heldLocks = new Set();

const MESSAGES = {
  account_not_found: 'Account was not found.',
  invalid_account_id: 'Account ID is invalid.',
  invalid_account_input: 'Account input is invalid.',
  invalid_session_input: 'Session data is invalid.',
  revision_conflict: 'Account changed concurrently. Reload it and retry.',
  session_conflict: 'Session changed concurrently. The older session was not saved.',
  import_conflict: 'Import conflicts with an existing or repeated account. Nothing was imported.',
  unsafe_state: 'Account storage contains an unsafe file or directory. It was not changed.',
  corrupt_state: 'Account storage is unreadable. It was not changed.',
  store_io_error: 'Account storage could not be written. No partial change is visible.',
  store_not_initialized: 'Account storage is not initialized.',
  store_locked: 'Account storage is in use by another process.',
  store_closed: 'Account storage is closed.',
};
const STATUS = { account_not_found: 404, invalid_account_id: 400, invalid_account_input: 400, invalid_session_input: 400,
  revision_conflict: 409, session_conflict: 409, import_conflict: 409, store_not_initialized: 503, store_locked: 503, store_closed: 503 };

// Messages are fixed text. Only validated IDs, entry indexes and errno names are attached.
export class AccountStoreError extends BridgeError {
  constructor(code, details = {}) {
    const known = Object.hasOwn(MESSAGES, code) ? code : 'store_io_error';
    super(MESSAGES[known], STATUS[known] ?? 500, known);
    this.name = 'AccountStoreError';
    if (typeof details.accountId === 'string' && ACCOUNT_ID.test(details.accountId)) this.accountId = details.accountId;
    if (Number.isSafeInteger(details.entryIndex)) this.entryIndex = details.entryIndex;
    if (typeof details.ioCode === 'string' && /^E[A-Z0-9]{1,15}$/.test(details.ioCode)) this.ioCode = details.ioCode;
  }
}

function fail(code, details) { throw new AccountStoreError(code, details); }
const ioError = error => error instanceof AccountStoreError ? error : new AccountStoreError('store_io_error', { ioCode: error?.code });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isNullableTime = value => value === null || isTime(value);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

export function assertAccountId(id) {
  if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) fail('invalid_account_id');
  return id;
}

function isEmail(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 320 && !UNSAFE_TEXT.test(value)
    && value.indexOf('@') > 0 && value.lastIndexOf('@') < value.length - 1;
}

function isAccessUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || UNSAFE_TEXT.test(value)) return false;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}

function isPlainJson(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 10000) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 16384;
  if (depth >= 8) return false;
  if (Array.isArray(value)) return value.length <= 512 && Array.from(value).every(item => isPlainJson(item, depth + 1, budget));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => key.length <= 256 && key !== '__proto__' && isPlainJson(item, depth + 1, budget));
}

// Session input: { cookies: object[], tokens: object, device: object, expiresAt?: epoch ms | null }.
// A missing expiresAt stays null (unknown); nothing is derived from token contents.
export function validateSessionInput(session) {
  if (!isRecord(session) || Object.keys(session).some(key => !SESSION_INPUT_KEYS.includes(key))
    || !Array.isArray(session.cookies) || !isRecord(session.tokens) || !isRecord(session.device)
    || !isNullableTime(session.expiresAt ?? null)
    || !isPlainJson({ cookies: session.cookies, tokens: session.tokens, device: session.device })
    || !Array.from(session.cookies).every(isRecord)) fail('invalid_session_input');
  const text = JSON.stringify({ cookies: session.cookies, tokens: session.tokens, device: session.device });
  if (text.length > 262144) fail('invalid_session_input');
  return { ...JSON.parse(text), expiresAt: session.expiresAt ?? null };
}

function validateEntry(entry, entryIndex) {
  if (!hasExactKeys(entry, ENTRY_KEYS) || !isEmail(entry.email) || !isEmail(entry.emailNormalized)
    || entry.emailNormalized !== entry.emailNormalized.toLowerCase() || typeof entry.provider !== 'string'
    || !PROVIDER.test(entry.provider) || !isAccessUrl(entry.mailAccessUrl)) fail('invalid_account_input', { entryIndex });
  return { email: entry.email, emailNormalized: entry.emailNormalized, provider: entry.provider, mailAccessUrl: entry.mailAccessUrl };
}

function validatePatch(patch) {
  if (!isRecord(patch) || Object.keys(patch).length === 0 || Object.keys(patch).some(key => !PATCH_KEYS.includes(key))) fail('invalid_account_input');
  if (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') fail('invalid_account_input');
  if (Object.hasOwn(patch, 'status') && !ACCOUNT_STATUSES.includes(patch.status)) fail('invalid_account_input');
  if (Object.hasOwn(patch, 'reasonCode') && patch.reasonCode !== null
    && !(typeof patch.reasonCode === 'string' && CODE.test(patch.reasonCode))) fail('invalid_account_input');
  for (const key of ['cooldownUntil', 'quarantinedAt']) {
    if (Object.hasOwn(patch, key) && !isNullableTime(patch[key])) fail('invalid_account_input');
  }
  return Object.fromEntries(PATCH_KEYS.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
}

function parseIndex(raw) {
  if (!hasExactKeys(raw, ['schemaVersion', 'revision', 'ids']) || raw.schemaVersion !== 1 || !isTime(raw.revision)
    || !Array.isArray(raw.ids) || !raw.ids.every(id => typeof id === 'string' && ACCOUNT_ID.test(id))
    || new Set(raw.ids).size !== raw.ids.length) fail('corrupt_state');
  return { schemaVersion: 1, revision: raw.revision, ids: [...raw.ids] };
}

function parseAccount(raw, id) {
  if (!hasExactKeys(raw, ACCOUNT_KEYS) || raw.schemaVersion !== 1 || raw.id !== id || !isEmail(raw.email)
    || !isEmail(raw.emailNormalized) || typeof raw.provider !== 'string' || !PROVIDER.test(raw.provider)
    || typeof raw.enabled !== 'boolean' || !ACCOUNT_STATUSES.includes(raw.status)
    || !(raw.reasonCode === null || (typeof raw.reasonCode === 'string' && CODE.test(raw.reasonCode)))
    || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !isTime(raw.createdAt) || !isTime(raw.updatedAt)
    || !isNullableTime(raw.cooldownUntil) || !isNullableTime(raw.quarantinedAt)) fail('corrupt_state', { accountId: id });
  return raw;
}

function parseMail(raw, id) {
  if (!hasExactKeys(raw, ['schemaVersion', 'mailAccessUrl']) || raw.schemaVersion !== 1 || !isAccessUrl(raw.mailAccessUrl)) {
    fail('corrupt_state', { accountId: id });
  }
  return raw;
}

function parseSession(raw, id) {
  if (!hasExactKeys(raw, SESSION_KEYS) || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.sessionRevision)
    || raw.sessionRevision < 1 || !isTime(raw.updatedAt)) fail('corrupt_state', { accountId: id });
  try { validateSessionInput({ cookies: raw.cookies, tokens: raw.tokens, device: raw.device, expiresAt: raw.expiresAt }); }
  catch { fail('corrupt_state', { accountId: id }); }
  return raw;
}

export function maskEmail(address) {
  const at = address.lastIndexOf('@');
  const first = text => Array.from(text)[0] ?? '';
  const labels = address.slice(at + 1).split('.');
  return `${first(address.slice(0, at))}***@${first(labels[0])}***${labels.length > 1 ? `.${labels.at(-1)}` : ''}`;
}

function publicView({ account, session }) {
  return {
    id: account.id, maskedEmail: maskEmail(account.emailNormalized), provider: account.provider,
    enabled: account.enabled, status: account.status, reasonCode: account.reasonCode,
    quarantined: account.quarantinedAt !== null, quarantinedAt: account.quarantinedAt, cooldownUntil: account.cooldownUntil,
    hasSession: session !== null, sessionRevision: session?.sessionRevision ?? 0, sessionExpiresAt: session?.expiresAt ?? null,
    revision: account.revision, createdAt: account.createdAt, updatedAt: account.updatedAt,
  };
}

function privateView({ account, mail, session }) {
  const { schemaVersion: _version, ...identity } = account;
  return structuredClone({ ...identity, mail: { mailAccessUrl: mail.mailAccessUrl }, session });
}

const privateStat = stat => stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && (uid === null || stat.uid === uid);

async function readPrivateJson(fs, path, maxBytes) {
  let handle;
  try { handle = await fs.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') fail('unsafe_state');
    throw ioError(error);
  }
  try {
    const stat = await handle.stat();
    if (!privateStat(stat)) fail('unsafe_state');
    if (stat.size > maxBytes) fail('corrupt_state');
    const text = await handle.readFile({ encoding: 'utf8' });
    try { return JSON.parse(text); } catch { fail('corrupt_state'); }
  } catch (error) { throw ioError(error); }
  finally { await handle.close().catch(() => {}); }
}

async function assertPrivateDir(fs, dir) {
  let stat;
  try { stat = await fs.lstat(dir); }
  catch (error) { throw error?.code === 'ENOENT' ? new AccountStoreError('corrupt_state') : ioError(error); }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) fail('unsafe_state');
}

async function syncDir(fs, dir) {
  let handle;
  try { handle = await fs.open(dir, O_RDONLY | O_DIRECTORY); await handle.sync(); }
  catch { /* Directory fsync is best effort after a completed rename. */ }
  finally { await handle?.close().catch(() => {}); }
}

async function writeNewPrivateFile(fs, path, text) {
  const handle = await fs.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}

// Exclusive temp file, fsync, refuse unsafe targets, rename. Throws only if the target was not replaced.
async function writePrivateJsonAtomic(fs, dir, name, value) {
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeNewPrivateFile(fs, temp, `${JSON.stringify(value)}\n`);
    let stat = null;
    try { stat = await fs.lstat(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (stat && !privateStat(stat)) fail('unsafe_state');
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw ioError(error);
  }
  await syncDir(fs, dir);
}

async function removeTempFiles(fs, dir) {
  for (const name of await fs.readdir(dir)) {
    if (!TEMP_FILE.test(name)) continue;
    const stat = await fs.lstat(join(dir, name)).catch(() => null);
    if (stat?.isFile()) await fs.unlink(join(dir, name)).catch(() => {});
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

// Single-writer store for one server process. Emits 'change' with { type, accountIds } only.
export class AccountStore extends EventEmitter {
  #root;
  #fs;
  #clock;
  #state = null;
  #initPromise = null;
  #locks = new Map();
  #lockHeld = false;
  #closed = false;

  constructor({ rootDir, clock = { now: () => Date.now() }, fs = nodeFs } = {}) {
    super();
    const root = typeof rootDir === 'string' && isAbsolute(rootDir) ? resolve(rootDir) : null;
    if (!root || root === '/' || (rootDir !== root && rootDir !== `${root}/`)) throw new TypeError('rootDir must be an absolute normalized directory');
    if (typeof clock?.now !== 'function') throw new TypeError('clock.now must be a function');
    this.#root = root;
    this.#clock = clock;
    this.#fs = fs;
  }

  init() {
    if (this.#closed) return Promise.reject(new AccountStoreError('store_closed'));
    this.#initPromise ??= this.#initialize().catch(error => { this.#initPromise = null; throw error; });
    return this.#initPromise;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#initPromise?.catch(() => {});
    await Promise.all([...this.#locks.values()]);
    await this.#unlock();
  }

  listPublic() {
    const state = this.#ready();
    return state.index.ids.map(id => publicView(state.accounts.get(id)));
  }

  getPublic(id) {
    return publicView(this.#entry(id));
  }

  // Full private record including mail access and the session bundle; never expose it outside trusted code.
  getPrivate(id) {
    return privateView(this.#entry(id));
  }

  async importBatch(entries) {
    this.#ready();
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_BATCH) fail('invalid_account_input');
    const normalized = Array.from(entries, (entry, entryIndex) => validateEntry(entry, entryIndex));
    return this.#exclusive('index', async () => {
      const state = this.#ready();
      const urlByEmail = new Map();
      const emailByUrl = new Map();
      for (const { account, mail } of state.accounts.values()) {
        urlByEmail.set(account.emailNormalized, mail.mailAccessUrl);
        emailByUrl.set(mail.mailAccessUrl, account.emailNormalized);
      }
      const fresh = [];
      let skipped = 0;
      normalized.forEach((entry, entryIndex) => {
        const knownUrl = urlByEmail.get(entry.emailNormalized);
        const knownEmail = emailByUrl.get(entry.mailAccessUrl);
        if (knownUrl === undefined && knownEmail === undefined) {
          urlByEmail.set(entry.emailNormalized, entry.mailAccessUrl);
          emailByUrl.set(entry.mailAccessUrl, entry.emailNormalized);
          fresh.push(entry);
        } else if (knownUrl === entry.mailAccessUrl && knownEmail === entry.emailNormalized) skipped += 1;
        else fail('import_conflict', { entryIndex });
      });
      if (!fresh.length) return { imported: [], skipped, indexRevision: state.index.revision };
      const fs = this.#fs;
      const now = this.#clock.now();
      const created = [];
      const records = [];
      try {
        for (const entry of fresh) {
          const id = randomUUID();
          const dir = join(this.#root, id);
          await fs.mkdir(dir, { mode: 0o700 });
          created.push(dir);
          const account = { schemaVersion: 1, id, email: entry.email, emailNormalized: entry.emailNormalized,
            provider: entry.provider, enabled: true, status: 'active', reasonCode: null, revision: 1,
            createdAt: now, updatedAt: now, cooldownUntil: null, quarantinedAt: null };
          const mail = { schemaVersion: 1, mailAccessUrl: entry.mailAccessUrl };
          await writePrivateJsonAtomic(fs, dir, 'mail.json', mail);
          await writePrivateJsonAtomic(fs, dir, 'account.json', account);
          records.push({ account, mail, session: null });
        }
        const index = { schemaVersion: 1, revision: state.index.revision + 1,
          ids: [...state.index.ids, ...records.map(record => record.account.id)] };
        // Commit point: accounts become visible only through the index, written after every account file.
        await writePrivateJsonAtomic(fs, this.#root, 'index.json', index);
        state.index = index;
        for (const record of records) state.accounts.set(record.account.id, record);
      } catch (error) {
        for (const dir of created) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw ioError(error);
      }
      this.#emit('import', records.map(record => record.account.id));
      return { imported: records.map(publicView), skipped, indexRevision: state.index.revision };
    });
  }

  // Optional expectedSessionRevision makes the write conditional on the session it was decided against,
  // checked under the same per-account lock (so an old session's verdict can never touch a newer session).
  async updateAccount(id, expectedRevision, patch, { expectedSessionRevision } = {}) {
    this.#entry(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('invalid_account_input');
    if (expectedSessionRevision !== undefined && (!Number.isSafeInteger(expectedSessionRevision) || expectedSessionRevision < 0)) {
      fail('invalid_account_input');
    }
    const changes = validatePatch(patch);
    return this.#exclusive(`account:${id}`, async () => {
      const entry = this.#entry(id);
      if (entry.account.revision !== expectedRevision) fail('revision_conflict', { accountId: id });
      if (expectedSessionRevision !== undefined && (entry.session?.sessionRevision ?? 0) !== expectedSessionRevision) {
        fail('session_conflict', { accountId: id });
      }
      const account = { ...entry.account, ...changes, revision: entry.account.revision + 1, updatedAt: this.#clock.now() };
      const dir = join(this.#root, id);
      await assertPrivateDir(this.#fs, dir);
      await writePrivateJsonAtomic(this.#fs, dir, 'account.json', account);
      entry.account = account;
      this.#emit('account', [id]);
      return publicView(entry);
    });
  }

  // CAS on sessionRevision (0 = no session yet). The whole bundle is replaced atomically.
  async replaceSession(id, expectedSessionRevision, session) {
    this.#entry(id);
    if (!Number.isSafeInteger(expectedSessionRevision) || expectedSessionRevision < 0) fail('invalid_session_input');
    const data = validateSessionInput(session);
    return this.#exclusive(`account:${id}`, async () => {
      const entry = this.#entry(id);
      const current = entry.session?.sessionRevision ?? 0;
      if (current !== expectedSessionRevision) fail('session_conflict', { accountId: id });
      const bundle = { schemaVersion: 1, sessionRevision: current + 1, cookies: data.cookies, tokens: data.tokens,
        device: data.device, expiresAt: data.expiresAt, updatedAt: this.#clock.now() };
      const dir = join(this.#root, id);
      await assertPrivateDir(this.#fs, dir);
      await writePrivateJsonAtomic(this.#fs, dir, 'session.json', bundle);
      entry.session = bundle;
      this.#emit('session', [id]);
      return { accountId: id, sessionRevision: bundle.sessionRevision, expiresAt: bundle.expiresAt, updatedAt: bundle.updatedAt };
    });
  }

  #ready() {
    if (this.#closed) fail('store_closed');
    if (!this.#state) fail('store_not_initialized');
    return this.#state;
  }

  #entry(id) {
    assertAccountId(id);
    return this.#ready().accounts.get(id) ?? fail('account_not_found', { accountId: id });
  }

  #emit(type, accountIds) {
    try { this.emit('change', { type, accountIds: [...accountIds] }); } catch { /* Listener failures never undo a commit. */ }
  }

  async #exclusive(key, fn) {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.#locks.set(key, tail);
    await previous;
    try { return await fn(); }
    catch (error) { throw ioError(error); }
    finally {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  async #initialize() {
    const fs = this.#fs;
    try {
      await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.#root);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid)) fail('unsafe_state');
      if ((stat.mode & 0o077) !== 0) await fs.chmod(this.#root, 0o700);
    } catch (error) { throw ioError(error); }
    await this.#lock();
    try {
      const raw = await readPrivateJson(fs, join(this.#root, 'index.json'), LIMITS.index);
      let index;
      if (raw === null) {
        // A missing index next to account directories is damage, not an empty store.
        if ((await fs.readdir(this.#root)).some(name => ACCOUNT_ID.test(name))) fail('corrupt_state');
        index = { schemaVersion: 1, revision: 0, ids: [] };
        await writePrivateJsonAtomic(fs, this.#root, 'index.json', index);
      } else index = parseIndex(raw);
      const accounts = new Map();
      const emails = new Set();
      const urls = new Set();
      for (const id of index.ids) {
        const entry = await this.#load(id);
        if (emails.has(entry.account.emailNormalized) || urls.has(entry.mail.mailAccessUrl)) fail('corrupt_state', { accountId: id });
        emails.add(entry.account.emailNormalized);
        urls.add(entry.mail.mailAccessUrl);
        accounts.set(id, entry);
      }
      await removeTempFiles(fs, this.#root);
      for (const id of index.ids) await removeTempFiles(fs, join(this.#root, id));
      this.#state = { index, accounts };
    } catch (error) {
      await this.#unlock();
      throw ioError(error);
    }
  }

  async #load(id) {
    const fs = this.#fs;
    const dir = join(this.#root, id);
    await assertPrivateDir(fs, dir);
    const account = parseAccount(await readPrivateJson(fs, join(dir, 'account.json'), LIMITS.account) ?? fail('corrupt_state', { accountId: id }), id);
    const mail = parseMail(await readPrivateJson(fs, join(dir, 'mail.json'), LIMITS.mail) ?? fail('corrupt_state', { accountId: id }), id);
    const rawSession = await readPrivateJson(fs, join(dir, 'session.json'), LIMITS.session);
    return { account, mail, session: rawSession === null ? null : parseSession(rawSession, id) };
  }

  async #lock() {
    const path = join(this.#root, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeNewPrivateFile(this.#fs, path, JSON.stringify({ pid: process.pid, startedAt: this.#clock.now() }));
        heldLocks.add(this.#root);
        this.#lockHeld = true;
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw ioError(error);
      }
      const owner = await readPrivateJson(this.#fs, path, LIMITS.lock).catch(() => null);
      const pid = owner?.pid;
      const stale = Number.isSafeInteger(pid) && pid > 0 && !heldLocks.has(this.#root) && (pid === process.pid || !processAlive(pid));
      if (!stale || attempt) break;
      await this.#fs.unlink(path).catch(() => {});
    }
    fail('store_locked');
  }

  async #unlock() {
    if (!this.#lockHeld) return;
    this.#lockHeld = false;
    heldLocks.delete(this.#root);
    await this.#fs.unlink(join(this.#root, LOCK_FILE)).catch(() => {});
  }
}
