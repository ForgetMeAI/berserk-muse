import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { mkdir, mkdtemp, rm, symlink, link, writeFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AccountStore, AccountStoreError, ACCOUNT_ID, ACCOUNT_STATUSES,
  assertAccountId, maskEmail, validateSessionInput,
} from '../src/accounts/store.mjs';

const TMP = join(dirname(dirname(fileURLToPath(import.meta.url))), '.test-tmp');

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, set: value => { now = value; }, advance: ms => { now += ms; } };
}

async function tmpRoot(t) {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, 'store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function freshStore(t, { fs = nodeFs, clock = makeClock(), rootDir } = {}) {
  const root = rootDir ?? join(await tmpRoot(t), 'accounts');
  const store = new AccountStore({ rootDir: root, clock, fs });
  t.after(() => store.close());
  await store.init();
  return { store, rootDir: root, clock };
}

function entry(i, over = {}) {
  return {
    email: `User${i}@Mail.test`, emailNormalized: `user${i}@mail.test`,
    provider: 'mailprov', mailAccessUrl: `https://mail.test/inbox/${i}?token=URLSECRET${i}`, ...over,
  };
}

function session(over = {}) {
  return {
    cookies: [{ name: 'sid', value: 'COOKIE_CANARY' }],
    tokens: { access: 'TOKEN_CANARY', refresh: 'REFRESH_CANARY' },
    device: { id: 'DEVICE_CANARY' }, expiresAt: null, ...over,
  };
}

const accountDirs = async rootDir => (await readdir(rootDir)).filter(name => ACCOUNT_ID.test(name));

function renameFailingFs(shouldFail) {
  return { ...nodeFs, rename: async (from, to) => {
    if (shouldFail(to)) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    return nodeFs.rename(from, to);
  } };
}

test('initializes an empty store and reloads imported accounts after reopen', async t => {
  const rootDir = join(await tmpRoot(t), 'accounts');
  const { store } = await freshStore(t, { rootDir });
  assert.deepEqual(store.listPublic(), []);
  const { imported } = await store.importBatch([entry(0)]);
  assert.equal(imported.length, 1);
  const id = imported[0].id;
  await store.close();

  const reopened = new AccountStore({ rootDir, clock: makeClock() });
  t.after(() => reopened.close());
  await reopened.init();
  const list = reopened.listPublic();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].revision, 1);
  assert.equal(list[0].hasSession, false);
});

test('public views never serialize raw email, mail URL, or session secrets', async t => {
  const { store } = await freshStore(t);
  const { imported } = await store.importBatch([entry(0)]);
  const id = imported[0].id;
  await store.replaceSession(id, 0, session({ expiresAt: 1_700_000_900_000 }));

  const blob = JSON.stringify([store.listPublic(), store.getPublic(id)]);
  for (const secret of ['URLSECRET0', 'TOKEN_CANARY', 'REFRESH_CANARY', 'COOKIE_CANARY', 'DEVICE_CANARY', 'user0@mail.test', 'User0@Mail.test']) {
    assert.equal(blob.includes(secret), false, `public view leaked ${secret}`);
  }
  const pub = store.getPublic(id);
  assert.equal(pub.maskedEmail, 'u***@m***.test');
  assert.equal(pub.hasSession, true);
  assert.equal(pub.sessionRevision, 1);
  assert.equal(pub.sessionExpiresAt, 1_700_000_900_000);
  assert.equal(pub.provider, 'mailprov');

  // The private view is the trusted path and intentionally carries the real values.
  const priv = store.getPrivate(id);
  assert.equal(priv.email, 'User0@Mail.test');
  assert.equal(priv.mail.mailAccessUrl, 'https://mail.test/inbox/0?token=URLSECRET0');
  assert.equal(priv.session.tokens.access, 'TOKEN_CANARY');
});

test('importBatch commits all entries or none when a conflict is present', async t => {
  const { store } = await freshStore(t);
  await store.importBatch([entry(0), entry(1)]);
  assert.equal(store.listPublic().length, 2);

  // entry(2) is new, but the second element reuses entry(0)'s email with a different URL.
  await assert.rejects(
    store.importBatch([entry(2), entry(0, { mailAccessUrl: 'https://mail.test/other' })]),
    e => e instanceof AccountStoreError && e.code === 'import_conflict' && e.status === 409);
  assert.equal(store.listPublic().length, 2, 'no entry from the rejected batch is visible');

  // A conflict between two members of the same batch also rejects the whole batch.
  await assert.rejects(
    store.importBatch([entry(3), entry(3, { mailAccessUrl: 'https://mail.test/dup' })]),
    e => e.code === 'import_conflict');
  assert.equal(store.listPublic().length, 2);
});

test('importBatch skips exact duplicates and rejects ambiguous email/URL pairings', async t => {
  const { store } = await freshStore(t);
  await store.importBatch([entry(0)]);
  const result = await store.importBatch([entry(0), entry(4)]);
  assert.equal(result.skipped, 1);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].maskedEmail, maskEmail('user4@mail.test'));
  assert.equal(store.listPublic().length, 2);

  await assert.rejects(store.importBatch([entry(0, { mailAccessUrl: 'https://mail.test/moved' })]), e => e.code === 'import_conflict');
  await assert.rejects(store.importBatch([entry(5, { mailAccessUrl: 'https://mail.test/inbox/0?token=URLSECRET0' })]), e => e.code === 'import_conflict');
});

test('updateAccount enforces revision CAS and validates the patch', async t => {
  const clock = makeClock();
  const { store } = await freshStore(t, { clock });
  const { imported } = await store.importBatch([entry(0)]);
  const id = imported[0].id;

  clock.advance(1000);
  const updated = await store.updateAccount(id, 1, { status: 'banned', reasonCode: 'manual_ban', enabled: false });
  assert.equal(updated.revision, 2);
  assert.equal(updated.status, 'banned');
  assert.equal(updated.enabled, false);
  assert.equal(updated.updatedAt, clock.now());

  await assert.rejects(store.updateAccount(id, 1, { status: 'active' }), e => e.code === 'revision_conflict' && e.status === 409);
  await assert.rejects(store.updateAccount(id, 2, { status: 'nonsense' }), e => e.code === 'invalid_account_input');
  await assert.rejects(store.updateAccount(id, 2, { unknown: true }), e => e.code === 'invalid_account_input');

  const quarantined = await store.updateAccount(id, 2, { quarantinedAt: clock.now() });
  assert.equal(quarantined.quarantined, true);
  assert.equal(quarantined.quarantinedAt, clock.now());
  await assert.rejects(store.updateAccount('not-a-uuid', 1, { status: 'active' }), e => e.code === 'invalid_account_id');
});

test('replaceSession enforces session CAS so a stale refresh cannot overwrite a fresh one', async t => {
  const { store } = await freshStore(t);
  const { imported } = await store.importBatch([entry(0)]);
  const id = imported[0].id;

  const first = await store.replaceSession(id, 0, session());
  assert.equal(first.sessionRevision, 1);

  // An older refresh still expecting revision 0 must fail CAS and not clobber the newer session.
  await assert.rejects(store.replaceSession(id, 0, session({ tokens: { access: 'STALE' } })), e => e.code === 'session_conflict' && e.status === 409);
  assert.equal(store.getPrivate(id).session.tokens.access, 'TOKEN_CANARY');

  const second = await store.replaceSession(id, 1, session({ tokens: { access: 'FRESH' }, expiresAt: 1_700_111_111_111 }));
  assert.equal(second.sessionRevision, 2);
  assert.equal(second.expiresAt, 1_700_111_111_111);
  assert.equal(store.getPublic(id).sessionRevision, 2);
});

test('updateAccount can also require the session revision it was decided against', async t => {
  const { store } = await freshStore(t);
  const { imported } = await store.importBatch([entry(0)]);
  const id = imported[0].id;
  await store.replaceSession(id, 0, session());

  await assert.rejects(store.updateAccount(id, 1, { status: 'needs_relogin' }, { expectedSessionRevision: 0 }),
    e => e.code === 'session_conflict');
  assert.equal(store.getPublic(id).status, 'active', 'an outdated verdict changes nothing');
  assert.equal(store.getPublic(id).revision, 1);
  await assert.rejects(store.updateAccount(id, 1, { status: 'expired' }, { expectedSessionRevision: -1 }), e => e.code === 'invalid_account_input');

  const updated = await store.updateAccount(id, 1, { status: 'needs_relogin' }, { expectedSessionRevision: 1 });
  assert.equal(updated.status, 'needs_relogin');
});

test('private files are 0600 and the account directory is 0700', async t => {
  const { store, rootDir } = await freshStore(t);
  const { imported } = await store.importBatch([entry(0)]);
  const id = imported[0].id;
  await store.replaceSession(id, 0, session());
  assert.equal((await stat(join(rootDir, id))).mode & 0o777, 0o700);
  for (const file of ['account.json', 'mail.json', 'session.json']) {
    assert.equal((await stat(join(rootDir, id, file))).mode & 0o777, 0o600);
  }
});

test('refuses symlinked files, symlinked directories, and hardlinked account files', async t => {
  async function tamperedReopen(mutate) {
    const rootDir = join(await tmpRoot(t), 'accounts');
    const store = new AccountStore({ rootDir, clock: makeClock() });
    await store.init();
    const { imported } = await store.importBatch([entry(0)]);
    await store.close();
    await mutate(rootDir, imported[0].id);
    const reopened = new AccountStore({ rootDir, clock: makeClock() });
    t.after(() => reopened.close());
    await assert.rejects(reopened.init(), e => e instanceof AccountStoreError && e.code === 'unsafe_state');
  }

  await tamperedReopen(async (rootDir, id) => {
    await rm(join(rootDir, id, 'account.json'));
    await symlink('decoy-target', join(rootDir, id, 'account.json'));
  });
  await tamperedReopen(async (rootDir, id) => {
    await rm(join(rootDir, id), { recursive: true });
    await symlink(join(rootDir, 'decoy-dir'), join(rootDir, id));
  });
  await tamperedReopen(async (rootDir, id) => {
    await link(join(rootDir, id, 'account.json'), join(rootDir, `${id}.hardlink`));
  });
  await tamperedReopen(async rootDir => {
    await rm(join(rootDir, 'index.json'));
    await symlink('decoy-index', join(rootDir, 'index.json'));
  });
});

test('a failed index commit leaves no partially visible accounts', async t => {
  let armed = false;
  const fs = renameFailingFs(to => armed && to.endsWith(`${'/'}index.json`));
  const { store, rootDir } = await freshStore(t, { fs });
  await store.importBatch([entry(0)]);

  armed = true;
  await assert.rejects(store.importBatch([entry(1)]), e => e instanceof AccountStoreError && e.code === 'store_io_error');
  assert.equal(store.listPublic().length, 1, 'the uncommitted account is not visible');
  assert.equal((await accountDirs(rootDir)).length, 1, 'the orphaned account directory was cleaned up');
});

test('a failed account write preserves the previous committed revision on disk', async t => {
  let armed = false;
  const fs = renameFailingFs(to => armed && to.endsWith(`${'/'}account.json`));
  const rootDir = join(await tmpRoot(t), 'accounts');
  const store = new AccountStore({ rootDir, clock: makeClock(), fs });
  await store.init();
  const { imported } = await store.importBatch([entry(0)]);
  const id = imported[0].id;

  armed = true;
  await assert.rejects(store.updateAccount(id, 1, { status: 'banned' }), e => e.code === 'store_io_error');
  assert.equal(store.getPublic(id).revision, 1);
  await store.close();

  const reopened = new AccountStore({ rootDir, clock: makeClock() });
  t.after(() => reopened.close());
  await reopened.init();
  assert.equal(reopened.getPublic(id).status, 'active');
  assert.equal(reopened.getPublic(id).revision, 1);
});

test('corrupt or missing state surfaces an error instead of silently resetting', async t => {
  async function corrupt(mutate) {
    const rootDir = join(await tmpRoot(t), 'accounts');
    const store = new AccountStore({ rootDir, clock: makeClock() });
    await store.init();
    const { imported } = await store.importBatch([entry(0)]);
    await store.close();
    await mutate(rootDir, imported[0].id);
    const reopened = new AccountStore({ rootDir, clock: makeClock() });
    t.after(() => reopened.close());
    await assert.rejects(reopened.init(), e => e instanceof AccountStoreError && e.code === 'corrupt_state');
    assert.equal((await accountDirs(rootDir)).length, 1, 'account data is preserved, not wiped');
  }

  await corrupt(rootDir => writeFile(join(rootDir, 'index.json'), 'not json{', 'utf8'));
  await corrupt(rootDir => writeFile(join(rootDir, 'index.json'), JSON.stringify({ schemaVersion: 2, revision: 0, ids: [] }), 'utf8'));
  await corrupt(rootDir => rm(join(rootDir, 'index.json')));
  await corrupt((rootDir, id) => writeFile(join(rootDir, id, 'account.json'), '{"schemaVersion":1}', 'utf8'));
});

test('a second store on the same root is refused while the first holds the writer lock', async t => {
  const rootDir = join(await tmpRoot(t), 'accounts');
  const first = new AccountStore({ rootDir, clock: makeClock() });
  t.after(() => first.close());
  await first.init();

  const second = new AccountStore({ rootDir, clock: makeClock() });
  await assert.rejects(second.init(), e => e instanceof AccountStoreError && e.code === 'store_locked' && e.status === 503);

  await first.close();
  const third = new AccountStore({ rootDir, clock: makeClock() });
  t.after(() => third.close());
  await third.init();
  assert.deepEqual(third.listPublic(), []);
});

test('validates constructor input, account ids, sessions, and exposes helpers', async t => {
  assert.throws(() => new AccountStore({ rootDir: 'relative/path' }), TypeError);
  assert.throws(() => new AccountStore({ rootDir: '/' }), TypeError);

  assert.equal(assertAccountId('123e4567-e89b-42d3-a456-426614174000'), '123e4567-e89b-42d3-a456-426614174000');
  assert.throws(() => assertAccountId('nope'), e => e.code === 'invalid_account_id');
  assert.ok(Object.isFrozen(ACCOUNT_STATUSES));
  assert.equal(maskEmail('a@b.co').includes('a@b'), false);

  assert.equal(validateSessionInput(session()).expiresAt, null);
  assert.equal(validateSessionInput(session({ expiresAt: 123 })).expiresAt, 123);
  assert.throws(() => validateSessionInput({ cookies: 'nope', tokens: {}, device: {} }), e => e.code === 'invalid_session_input');
  assert.throws(() => validateSessionInput({ cookies: [], tokens: {}, device: {}, expiresAt: -1 }), e => e.code === 'invalid_session_input');

  const { store } = await freshStore(t);
  await assert.rejects(store.importBatch([]), e => e.code === 'invalid_account_input');
  await assert.rejects(store.importBatch('nope'), e => e.code === 'invalid_account_input');
  await assert.rejects(store.importBatch([entry(0, { emailNormalized: 'User0@Mail.test' })]), e => e.code === 'invalid_account_input');
  await assert.rejects(store.importBatch([entry(0, { mailAccessUrl: 'ftp://bad' })]), e => e.code === 'invalid_account_input');
  assert.throws(() => store.getPrivate('123e4567-e89b-42d3-a456-426614174000'), e => e.code === 'account_not_found');
  assert.throws(() => store.getPublic('123e4567-e89b-42d3-a456-426614174000'), e => e.code === 'account_not_found');
});
