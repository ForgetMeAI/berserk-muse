import test from 'node:test';
import assert from 'node:assert/strict';
import { mailboxFromUrl, parseImport, detect } from '../src/mail/index.mjs';

test('path and query Luuvan mailbox links bind the same normalized recipient', () => {
  for (const link of [
    'https://luuvan.site/demo%2Btag%40example.test',
    'https://luuvan.site/demo+tag@example.test/',
    'https://luuvan.site/?inbox=demo%2Btag%40example.test',
    'https://luuvan.site/inbox?email=demo%2Btag%40example.test',
    'https://luuvan.site/demo%2Btag%40example.test?address=demo%2Btag%40example.test',
  ]) {
    const [entry] = parseImport(`143 | Demo+tag@Example.test | ${link}`);
    assert.equal(entry.provider, 'luuvan');
    assert.equal(mailboxFromUrl(entry.provider, entry.url), 'demo+tag@example.test');
    assert.equal(detect(entry.email, entry.url), 'luuvan');
  }
});

test('shared mailbox resolution rejects path, query, and explicit recipient conflicts', () => {
  for (const link of [
    'https://luuvan.site/other@example.test',
    'https://luuvan.site/demo@example.test?inbox=other@example.test',
    'https://luuvan.site/?inbox=demo@example.test&inbox=other@example.test',
    'https://generator.email/other@example.test',
    'https://generator.email/demo@example.test?email=other@example.test',
  ]) {
    const provider = link.includes('generator.email') ? 'generator' : 'luuvan';
    assert.throws(() => mailboxFromUrl(provider, link, { expectedEmail: 'demo@example.test' }), { code: 'invalid_input' });
  }
  assert.throws(() => mailboxFromUrl('generator', 'https://luuvan.site/demo@example.test'), { code: 'unsupported_provider' });
  assert.throws(() => mailboxFromUrl('luuvan', 'https://luuvan.site/invalid/path?inbox=demo@example.test'), { code: 'invalid_input' });
});

test('a root-only Luuvan link requires an explicit per-call recipient and generator always requires its mailbox path', () => {
  assert.equal(mailboxFromUrl('luuvan', 'https://luuvan.site/', { expectedEmail: 'demo@example.test' }), 'demo@example.test');
  assert.throws(() => mailboxFromUrl('luuvan', 'https://luuvan.site/'), { code: 'invalid_input' });
  assert.throws(() => mailboxFromUrl('generator', 'https://generator.email/', { expectedEmail: 'demo@example.test' }), { code: 'invalid_input' });
});
