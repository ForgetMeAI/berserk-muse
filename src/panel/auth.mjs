import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const KEY_BYTES = 32;
const TICKET_MS = 60_000;
const SESSION_MS = 8 * 60 * 60_000;
const cookieName = 'muse_panel';

function randomToken(bytes = 32) { return randomBytes(bytes).toString('base64url'); }

async function ensurePrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  const parent = await realpath(path.dirname(absolute));
  const canonical = path.join(parent, path.basename(absolute));
  try { await mkdir(canonical, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Panel state directory must be a real directory.');
  await chmod(canonical, 0o700);
  if (await realpath(canonical) !== canonical) throw new Error('Panel state directory resolved through a symlink.');
  return canonical;
}

async function readPrivateKey(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size !== KEY_BYTES) {
    throw new Error('Panel admin key is not a private 32-byte regular file.');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.size !== KEY_BYTES) throw new Error('Panel admin key changed during read.');
    const key = await handle.readFile();
    if (key.length !== KEY_BYTES) throw new Error('Panel admin key is invalid.');
    return key;
  } finally { await handle.close(); }
}

async function createPrivateKey(file) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.panel-key-${process.pid}-${randomToken(12)}.tmp`);
  const key = randomBytes(KEY_BYTES);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(key);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, file);
    await unlink(temporary);
    return await readPrivateKey(file);
  } catch (error) {
    if (error?.code === 'EEXIST') return await readPrivateKey(file);
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function parseCookies(header = '') {
  const values = new Map();
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index > 0) values.set(item.slice(0, index).trim(), item.slice(index + 1).trim());
  }
  return values;
}

export function panelSessionCookie(sessionId, maxAge = SESSION_MS / 1000) {
  return `${cookieName}=${sessionId}; Path=/panel; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

export function createPanelAuth({ stateDir, now = Date.now } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required');
  let keyPath;
  const tickets = new Map();
  const sessions = new Map();
  let adminKey;

  async function ready() {
    if (adminKey) return;
    keyPath = path.join(await ensurePrivateDirectory(stateDir), 'panel.key');
    try { adminKey = await readPrivateKey(keyPath); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      adminKey = await createPrivateKey(keyPath);
    }
  }

  function adminAuthorized(request) {
    if (!adminKey) return false;
    const header = request.headers.authorization || '';
    const supplied = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header)?.[1];
    if (!supplied) return false;
    const candidate = Buffer.from(supplied, 'base64url');
    return candidate.length === adminKey.length && timingSafeEqual(candidate, adminKey);
  }

  function makeTicket(request) {
    if (!adminAuthorized(request)) return null;
    const timestamp = now();
    for (const [digest, expiresAt] of tickets) if (expiresAt <= timestamp) tickets.delete(digest);
    while (tickets.size >= 4096) tickets.delete(tickets.keys().next().value);
    const ticket = randomToken();
    tickets.set(createHash('sha256').update(ticket).digest('hex'), timestamp + TICKET_MS);
    return ticket;
  }

  function exchangeTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length < 32 || ticket.length > 128) return null;
    const digest = createHash('sha256').update(ticket).digest('hex');
    const expires = tickets.get(digest);
    tickets.delete(digest);
    if (!expires || expires <= now()) return null;
    const sessionId = randomToken();
    const csrf = randomToken(24);
    for (const [id, record] of sessions) if (record.expiresAt <= now()) sessions.delete(id);
    while (sessions.size >= 4096) sessions.delete(sessions.keys().next().value);
    sessions.set(createHash('sha256').update(sessionId).digest('hex'), { expiresAt: now() + SESSION_MS, csrf });
    return { sessionId, csrf };
  }

  function session(request) {
    const id = parseCookies(request.headers.cookie).get(cookieName);
    if (!id || id.length > 128) return null;
    const digest = createHash('sha256').update(id).digest('hex');
    const record = sessions.get(digest);
    if (!record) return null;
    if (record.expiresAt <= now()) { sessions.delete(digest); return null; }
    return { id, csrf: record.csrf, expiresAt: record.expiresAt };
  }

  function revoke(request) {
    const current = session(request);
    if (current) sessions.delete(createHash('sha256').update(current.id).digest('hex'));
  }

  function csrfValid(request, current = session(request)) {
    const supplied = request.headers['x-panel-csrf'];
    if (!current || typeof supplied !== 'string') return false;
    const left = Buffer.from(supplied);
    const right = Buffer.from(current.csrf);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  return { ready, adminAuthorized, makeTicket, exchangeTicket, session, revoke, csrfValid,
    async adminBearer() { await ready(); return adminKey.toString('base64url'); },
    sessionCookie: panelSessionCookie, clearCookie: () => panelSessionCookie('', 0) };
}
