import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, lstat, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPanelAuth } from '../src/panel/auth.mjs';

test('admin key is private and panel tickets are one-use with expiring sessions', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'panel-auth-'));
  const stateDir = path.join(base, '.state');
  let now = 10_000;
  try {
    const auth = createPanelAuth({ stateDir, now: () => now });
    const bearer = await auth.adminBearer();
    assert.equal(Buffer.from(bearer, 'base64url').length, 32);
    const stat = await lstat(path.join(stateDir, 'panel.key'));
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
    assert.equal((await readFile(path.join(stateDir, 'panel.key'))).length, 32);

    const request = { headers: { authorization: `Bearer ${bearer}` } };
    const ticket = auth.makeTicket(request);
    assert.equal(typeof ticket, 'string');
    assert.equal(auth.exchangeTicket(ticket).csrf.length > 20, true);
    assert.equal(auth.exchangeTicket(ticket), null, 'ticket cannot be reused');

    const expired = auth.makeTicket(request);
    now += 60_001;
    assert.equal(auth.exchangeTicket(expired), null, 'expired ticket cannot be exchanged');

    const invalid = createPanelAuth({ stateDir: path.join(base, 'other') });
    await invalid.ready();
    assert.equal(invalid.adminAuthorized(request), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('state directory symlinks are refused', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'panel-auth-link-'));
  const target = path.join(base, 'target');
  const linkPath = path.join(base, 'linked');
  const { mkdir, symlink } = await import('node:fs/promises');
  try {
    await mkdir(target);
    await symlink(target, linkPath);
    await assert.rejects(createPanelAuth({ stateDir: linkPath }).ready(), /real directory/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
