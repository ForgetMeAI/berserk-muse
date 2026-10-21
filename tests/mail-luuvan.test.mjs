import test from 'node:test';
import assert from 'node:assert/strict';
import { MailClient, MailError } from '../src/mail/index.mjs';

const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('Luuvan resolves path, legacy query, and bare links with an expected email', async () => {
  const cases = [
    ['https://luuvan.site/box%2Btag%40example.com', undefined],
    ['https://luuvan.site/inbox?email=box%2Btag%40example.com', undefined],
    ['https://luuvan.site/?inbox=box%2Btag%40example.com', undefined],
    ['https://luuvan.site/', 'BOX+TAG@example.com'],
  ];
  for (const [url, expectedEmail] of cases) {
    const seen = [];
    const messages = await MailClient.fetchLatest('luuvan', url, {
      ...(expectedEmail ? { expectedEmail } : {}),
      fetchImpl: async requestUrl => {
        seen.push(new URL(requestUrl));
        return seen.length === 1 ? response({ messages: [] }) : response({});
      },
    });
    assert.deepEqual(messages, []);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].origin, 'https://luuvan.site');
    assert.equal(seen[0].pathname, '/api/public/inbox');
    assert.equal(seen[0].searchParams.get('address'), 'box+tag@example.com');
  }
});

test('Luuvan honors the public response schema and does not invent sender, recipient, or time', async () => {
  const messages = await MailClient.fetchLatest('luuvan', 'https://luuvan.site/?address=box%40example.com', {
    fetchImpl: async requestUrl => new URL(requestUrl).pathname === '/api/public/inbox'
      ? response({ messages: [{ id: 'msg-1', subject: 'Welcome', receivedAt: '2026-10-20T09:00:00Z' }] })
      : response({ message: { id: 'msg-1', subject: 'Welcome', text: 'Hello' } }),
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, null);
  assert.equal(messages[0].to, null);
  assert.equal(messages[0].receivedAt, '2026-10-20T09:00:00.000Z');
  assert.equal(messages[0].text, 'Hello');
});

test('Luuvan accepts a server-declared mailbox binding and rejects a mismatched recipient', async () => {
  let messages = await MailClient.fetchLatest('luuvan', 'https://luuvan.site/?inbox=box%40example.com', {
    fetchImpl: async requestUrl => new URL(requestUrl).pathname === '/api/public/inbox'
      ? response({ mailbox: { address: 'box@example.com' }, messages: [{ id: 'bound-1', receivedAt: '2026-10-20T09:00:00Z' }] })
      : response({ message: { id: 'bound-1', from: 'notice@example.net', subject: 'Hi', text: 'Hello' } }),
  });
  assert.equal(messages[0].to, 'box@example.com');

  messages = await MailClient.fetchLatest('luuvan', 'https://luuvan.site/?inbox=box%40example.com', {
    fetchImpl: async requestUrl => new URL(requestUrl).pathname === '/api/public/inbox'
      ? response({ messages: [{ id: 'wrong-1', receivedAt: '2026-10-20T09:00:00Z' }] })
      : response({ message: { id: 'wrong-1', to: 'other@example.com', text: 'Hello' } }),
  });
  assert.deepEqual(messages, []);
});

test('Luuvan never replaces an invalid or ambiguous explicit recipient with mailbox binding', async () => {
  for (const [id, to] of [
    ['malformed', 'not an email address'],
    ['ambiguous', 'Other <other@example.com>, Box <box@example.com>'],
  ]) {
    const messages = await MailClient.fetchLatest('luuvan', 'https://luuvan.site/?inbox=box%40example.com', {
      fetchImpl: async requestUrl => new URL(requestUrl).pathname === '/api/public/inbox'
        ? response({ mailbox: { address: 'box@example.com' }, messages: [{ id, receivedAt: '2026-10-20T09:00:00Z' }] })
        : response({ message: { id, to, from: 'notice@example.net', subject: 'Code', text: 'Code: 123456' } }),
    });
    assert.deepEqual(messages, []);
  }
});

test('Luuvan filters excluded and stale summaries before fetching details and applies limit', async () => {
  const details = [];
  const messages = await MailClient.fetchLatest('luuvan', 'https://luuvan.site/?address=box%40example.com', {
    since: '2026-10-20T09:00:00Z', excludeIds: ['seen'], limit: 1,
    fetchImpl: async requestUrl => {
      const url = new URL(requestUrl);
      if (url.pathname === '/api/public/inbox') return response({ messages: [
        { id: 'stale', receivedAt: '2026-10-20T08:59:59Z' },
        { id: 'seen', receivedAt: '2026-10-20T09:02:00Z' },
        { id: 'newer', receivedAt: '2026-10-20T09:03:00Z' },
        { id: 'newest', receivedAt: '2026-10-20T09:04:00Z' },
      ] });
      details.push(url.pathname.split('/').at(-1));
      return response({ message: { id: url.pathname.split('/').at(-1), to: 'box@example.com', receivedAt: '2026-10-20T09:04:00Z', text: 'new' } });
    },
  });
  assert.deepEqual(details, ['newest']);
  assert.deepEqual(messages.map(message => message.id), ['newest']);
});

test('Luuvan rejects conflicting mailbox identities before making a request', async () => {
  let calls = 0;
  for (const [url, expectedEmail] of [
    ['https://luuvan.site/?inbox=a%40example.com&address=b%40example.com'],
    ['https://luuvan.site/a%40example.com?address=b%40example.com'],
    ['https://luuvan.site/a%40example.com', 'other@example.com'],
    ['https://luuvan.site/'],
  ]) {
    await assert.rejects(MailClient.fetchLatest('luuvan', url, {
      ...(expectedEmail ? { expectedEmail } : {}),
      fetchImpl: async () => { calls += 1; return response({ messages: [] }); },
    }), error => error instanceof MailError && error.code === 'invalid_input');
  }
  assert.equal(calls, 0);
});
