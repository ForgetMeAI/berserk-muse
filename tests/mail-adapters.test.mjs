import test from 'node:test';
import assert from 'node:assert/strict';
import { MailError, MailClient, requestJson } from '../src/mail/index.mjs';

const response = (value, status = 200, headers = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

test('missing provider auth returns a typed error without calling fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('unexpected'); };
  for (const [provider, url] of [
    ['gmail', 'https://mail.google.com/'],
    ['outlook', 'https://outlook.live.com/'],
  ]) {
    await assert.rejects(MailClient.fetchLatest(provider, url, { fetchImpl }), error => error.code === 'needs_mail_auth');
  }
  assert.equal(calls, 0);
});

test('generator dispatch preserves cancellation and rejects a mismatched provider before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('unexpected'); };
  const WebSocketImpl = class { constructor() { calls += 1; throw new Error('unexpected'); } };
  await assert.rejects(MailClient.fetchLatest('generator', 'https://generator.email/demo.inbox@sample.test', {
    fetchImpl, WebSocketImpl, signal: AbortSignal.abort(),
  }), error => error instanceof MailError && error.code === 'aborted');
  await assert.rejects(MailClient.fetchLatest('generator', 'https://mail.google.com/demo.inbox@sample.test', { fetchImpl }),
    error => error instanceof MailError && error.code === 'unsupported_provider');
  assert.equal(calls, 0);
});

test('Gmail fetch uses bounded Inbox list and detail calls and normalizes plain text', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), options });
    if (String(url).endsWith('/messages?labelIds=INBOX&maxResults=2')) return response({ messages: [{ id: 'id-1' }] });
    return response({ id: 'id-1', internalDate: '1792320000000', payload: { headers: [
      { name: 'From', value: 'Sender <Sender@Example.com>' }, { name: 'To', value: 'User+tag@gmail.com' }, { name: 'Subject', value: 'Confirm' },
    ], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Your code is 765432').toString('base64url') } }] } });
  };
  const messages = await MailClient.fetchLatest('gmail', 'https://mail.google.com/mail/u/0/', { limit: 2, auth: { accessToken: 'SENTINEL-SECRET' }, fetchImpl });
  assert.equal(messages[0].from, 'sender@example.com');
  assert.equal(messages[0].to, 'user+tag@gmail.com');
  assert.match(messages[0].text, /765432/);
  assert.equal(seen.every(item => item.options.redirect === 'manual'), true);
  assert.equal(seen.every(item => item.options.headers.authorization === 'Bearer SENTINEL-SECRET'), true);
});

test('Outlook uses the fixed Graph endpoint and returns normalized message fields', async () => {
  const seen = [];
  const messages = await MailClient.fetchLatest('outlook', 'https://outlook.live.com/mail/0/inbox', {
    auth: { accessToken: 'token' }, fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return response({ value: [{ id: 'o-1', subject: 'Hello', receivedDateTime: '2026-10-18T10:00:00Z',
        from: { emailAddress: { address: 'sender@example.com' } }, toRecipients: [{ emailAddress: { address: 'reader@example.com' } }],
        body: { contentType: 'text', content: 'Message body' } }] });
    },
  });
  assert.match(seen[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\?/);
  assert.equal(messages[0].text, 'Message body');
  assert.equal(messages[0].to, 'reader@example.com');
});

test('Luuvan public quick inbox uses the verified landing API routes', async () => {
  const seen = [];
  const messages = await MailClient.fetchLatest('luuvan', 'https://luuvan.site/?address=box%40example.com', {
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return new URL(url).pathname === '/api/public/inbox'
        ? response({ mailbox: { address: 'box@example.com', label: 'box', expiresAt: '2026-10-19T12:00:00Z' }, messages: [
          { id: 'public-id', mailboxAddress: 'box@example.com', messageId: 'provider-id', from: 'robot@example.com', to: 'box@example.com', subject: 'Welcome', receivedAt: '2026-10-18T12:00:00Z' },
        ] })
        : response({ message: { id: 'public-id', mailboxAddress: 'box@example.com', messageId: 'provider-id', from: 'robot@example.com', to: 'box@example.com', subject: 'Welcome', receivedAt: '2026-10-18T12:00:00Z', text: 'Hello', html: '<p>Hello</p>', headers: {} } });
    },
  });
  assert.deepEqual(seen.map(item => new URL(item.url).pathname), ['/api/public/inbox', '/api/public/messages/public-id']);
  assert.ok(seen.every(item => new URL(item.url).origin === 'https://luuvan.site'));
  assert.ok(seen.every(item => new URL(item.url).searchParams.get('address') === 'box@example.com'));
  assert.equal(messages[0].to, 'box@example.com');
  assert.equal(messages[0].text, 'Hello');
});

test('Luuvan recovery key uses documented list and detail API routes on the verified host', async () => {
  const seen = [];
  const messages = await MailClient.fetchLatest('luuvan', 'https://luuvan.site/inbox?email=box@example.com', {
    auth: { recoveryKey: 'secret-key' }, fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return String(url).endsWith('/api/inbox')
        ? response({ messages: [{ id: 'l-1' }] })
        : response({ id: 'l-1', from: 'robot@example.com', to: 'box@example.com', subject: 'Sign-in code', text: 'code: 987654', receivedAt: '2026-10-18T12:00:00Z' });
    },
  });
  assert.deepEqual(seen.map(item => new URL(item.url).pathname), ['/api/inbox', '/api/inbox/messages/l-1']);
  assert.equal(seen[0].options.headers['x-recovery-key'], 'secret-key');
  assert.equal(messages[0].provider, 'luuvan');
});

test('Luuvan filters old and excluded message metadata before fetching details', async () => {
  const detailIds = [];
  const messages = await MailClient.fetchLatest('luuvan', 'https://luuvan.site/?address=box%40example.com', {
    since: '2026-10-18T12:00:00Z', excludeIds: ['seen-id'], auth: {},
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      if (path === '/api/public/inbox') return response({ messages: [
        { id: 'old-id', receivedAt: '2026-10-18T11:59:00Z' },
        { id: 'seen-id', receivedAt: '2026-10-18T12:01:00Z' },
        { id: 'new-id', receivedAt: '2026-10-18T12:02:00Z', mailboxAddress: 'box@example.com' },
      ] });
      detailIds.push(path.split('/').at(-1));
      return response({ message: { id: 'new-id', from: 'robot@example.com', to: 'box@example.com', receivedAt: '2026-10-18T12:02:00Z', text: 'new' } });
    },
  });
  assert.deepEqual(detailIds, ['new-id']);
  assert.deepEqual(messages.map(message => message.id), ['new-id']);
});

test('cross-origin redirects are rejected and secret response text is not exposed', async () => {
  let calls = 0;
  await assert.rejects(requestJson('https://luuvan.site/api/inbox', {
    headers: { authorization: 'Bearer SENTINEL-SECRET' },
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/steal' } }); },
  }), error => {
    assert.equal(error.code, 'mail_response_invalid');
    assert.equal(error.message.includes('SENTINEL-SECRET'), false);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(requestJson('https://luuvan.site/api/inbox', {
    headers: { authorization: 'Bearer SENTINEL-SECRET' },
    fetchImpl: async () => response('SENTINEL-SECRET upstream error', 401),
  }), error => {
    assert.equal(error.code, 'mail_auth_failed');
    assert.equal(error.message.includes('SENTINEL-SECRET'), false);
    return true;
  });
});

test('same-origin redirects with URL credentials or fragments are rejected', async () => {
  for (const location of ['https://user:secret@luuvan.site/private', '/private#fragment']) {
    let calls = 0;
    await assert.rejects(requestJson('https://luuvan.site/api/inbox', {
      fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location } }); },
    }), error => error.code === 'mail_response_invalid');
    assert.equal(calls, 1);
  }
});

test('429 errors expose only a parsed retry delay', async () => {
  await assert.rejects(requestJson('https://luuvan.site/api/inbox', {
    headers: { authorization: 'Bearer SENTINEL-SECRET' },
    fetchImpl: async () => response('private upstream body SENTINEL-SECRET', 429, { 'retry-after': '7' }),
  }), error => {
    assert.equal(error.code, 'mail_rate_limited');
    assert.equal(error.retryAfterMs, 7000);
    assert.equal(error.message.includes('SENTINEL-SECRET'), false);
    return true;
  });
});

test('aborted mail request is typed and does not expose credentials', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestJson('https://luuvan.site/api/inbox', {
    signal: controller.signal, headers: { authorization: 'Bearer SENTINEL-SECRET' }, fetchImpl: async () => response({}),
  }), error => error.code === 'aborted' && !error.message.includes('SENTINEL-SECRET'));
});

test('unverified Luuvan hostname is blocked before any request', async () => {
  let calls = 0;
  await assert.rejects(MailClient.fetchLatest('luuvan', 'https://api.luuvan.com/inbox', {
    auth: { accessToken: 'SENTINEL-SECRET', email: 'box@example.com' },
    fetchImpl: async () => { calls += 1; return response({}); },
  }), error => error instanceof MailError && error.code === 'unsupported_provider');
  await assert.rejects(requestJson('https://api.luuvan.com/api/inbox', { fetchImpl: async () => { calls += 1; return response({}); } }),
    error => error instanceof MailError && error.code === 'unsupported_provider');
  assert.equal(calls, 0);
});

