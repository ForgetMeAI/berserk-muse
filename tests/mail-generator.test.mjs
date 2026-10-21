import test from 'node:test';
import assert from 'node:assert/strict';
import { MailError } from '../src/mail/index.mjs';
import { fetchLatest } from '../src/mail/generator.mjs';

const mailbox = 'qa-user@example.test';
const mailboxUrl = `https://generator.email/${encodeURIComponent(mailbox)}`;
const messageLink = 'https://generator.email/example.test/qa-user/message-42';
const notification = {
  link: '/example.test/qa-user/message-42',
  from: 'verify@example.org',
  subject: 'Synthetic verification',
  date: '2026-10-20T10:20:30.000Z',
};
const html = '<main><header id="mail-summary-head"><div>To: qa-user@example.test</div><div>From: verify@example.org</div></header><div id="mail-summary-body"><p>Code is only synthetic.</p><a href="https://example.org/help">Help</a></div></main>';
const noRecipientHtml = '<main><header id="mail-summary-head"><div>notification@email.meta.com</div><div>to</div><div>Mail delivered</div></header><div id="mail-summary-body"><p>Synthetic code: 123456</p></div><footer>qa-user@example.test</footer></main>';
const mailboxContextCookie = 'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure';
const emptyInbox = '<main><div class="list-group-item active">From Subject Time (UTC)</div><div id="email-table"></div></main>';
const listedInbox = `<main><div class="list-group-item active">From Subject Time (UTC)</div><div id="email-table"><div class="g8r list-group-item list-group-item-success" onclick="loadInboxClientSide('${notification.link}')"><div class="g8r from_div_45g45gg">verify@example.org</div><div class="g8r subj_div_45g45gg">Synthetic verification</div><div class="g8r time_div_45g45gg">2026-10-20 10:20:30</div></div></div></main>`;
const configuredInbox = `<script>window.SITE_DATA={url_inbox:"",url_language:"",cookie_names:[]};</script>${emptyInbox}`;

class FakeWebSocket extends EventTarget {
  static payload = notification;
  static payloads = null;
  static lastUrl = null;

  constructor(url) {
    super();
    FakeWebSocket.lastUrl = url;
    queueMicrotask(() => {
      for (const payload of FakeWebSocket.payloads || [FakeWebSocket.payload]) {
        const event = new Event('message');
        Object.defineProperty(event, 'data', { value: JSON.stringify(payload) });
        this.dispatchEvent(event);
      }
    });
  }

  close() {}
}

function response(body = html, { status = 200, contentType = 'text/html; charset=utf-8', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': contentType, ...headers } });
}

function responseWithSetCookies(body, cookies, options = {}) {
  const headers = new Headers({ 'content-type': options.contentType || 'text/html; charset=utf-8' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(body, { status: options.status || 200, headers });
}

function fetchStub(...results) {
  const pending = results.length ? [...results] : [response(emptyInbox), response(html)];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return pending.shift() || response(html);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function expectMailError(promise, code) {
  await assert.rejects(promise, error => error instanceof MailError && error.code === code);
}

test('reads one same-mailbox notification and parses documented message slots as data', async () => {
  FakeWebSocket.payload = notification;
  FakeWebSocket.payloads = null;
  const fetchImpl = fetchStub();
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox,
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
  });

  assert.equal(FakeWebSocket.lastUrl, `wss://generator.email/notificon/ws?email=${encodeURIComponent(mailbox)}`);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url, mailboxUrl);
  assert.equal(fetchImpl.calls[1].url, messageLink);
  assert.deepEqual(messages, [{
    id: '/example.test/qa-user/message-42',
    provider: 'generator',
    from: 'verify@example.org',
    to: mailbox,
    receivedAt: notification.date,
    subject: 'Synthetic verification',
    text: 'Code is only synthetic.\nHelp',
    html: '<p>Code is only synthetic.</p><a href="https://example.org/help">Help</a>',
    links: ['https://example.org/help'],
  }]);
});

test('rejects mailbox mismatch before opening a socket', async () => {
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: 'different@example.test', fetchImpl: fetchStub(), WebSocketImpl: FakeWebSocket,
  }), 'invalid_input');
  assert.equal(FakeWebSocket.lastUrl.includes(encodeURIComponent('different@example.test')), false);
});

test('rejects notification links on other origins and links bound to another mailbox', async () => {
  FakeWebSocket.payload = { ...notification, link: 'https://attacker.example/example.test/qa-user/message-42' };
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
  FakeWebSocket.payload = { ...notification, link: '/example.test/other-user/message-42' };
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
});

test('unknown message layout or missing actual recipient metadata fails closed', async () => {
  FakeWebSocket.payload = notification;
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response('<main><p>unknown layout</p></main>')), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
  const missingRecipient = html.replace('To: qa-user@example.test', 'Mailbox: qa-user@example.test');
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox), response(missingRecipient)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
  const ambiguousRecipient = html.replace('To: qa-user@example.test', 'To: qa-user@example.test, other@example.test');
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox), response(ambiguousRecipient)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
});

test('does not accept Reply-To as To, while accepting an explicit To alongside Reply-To', async () => {
  FakeWebSocket.payload = notification;
  const replyToOnly = html.replace('To: qa-user@example.test', 'Reply-To: qa-user@example.test');
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox), response(replyToOnly)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');

  const explicitTo = html.replace(
    '<div>To: qa-user@example.test</div>',
    '<div>Reply-To: other@example.org</div><div>To: qa-user@example.test</div>',
  );
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox), response(explicitTo)), WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, mailbox);
});

test('uses only the final server-issued mailbox context when the header omits a recipient', async () => {
  FakeWebSocket.payload = { ...notification, from: 'notification@email.meta.com' };
  const fetchImpl = fetchStub(response(emptyInbox), responseWithSetCookies(noRecipientHtml, [mailboxContextCookie]));
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl, WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, 'notification@email.meta.com');
  assert.equal(messages[0].to, mailbox);
  assert.equal(messages[0].recipientSource, 'mailbox_context');

  const validOptionalFlags = 'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; HttpOnly; SameSite=None';
  const optionalFlagsMessage = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox,
    fetchImpl: fetchStub(response(emptyInbox), responseWithSetCookies(noRecipientHtml, [validOptionalFlags])),
    WebSocketImpl: FakeWebSocket,
  });
  assert.equal(optionalFlagsMessage[0].recipientSource, 'mailbox_context');

  const normalizedDomainCookie = 'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=.generator.email; Path=/; Secure; SameSite=Lax; Max-Age=3600; Expires=Wed, 31 Dec 2099 23:59:59 GMT';
  const normalizedDomainMessage = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox,
    fetchImpl: fetchStub(response(emptyInbox), responseWithSetCookies(noRecipientHtml, [normalizedDomainCookie])),
    WebSocketImpl: FakeWebSocket,
  });
  assert.equal(normalizedDomainMessage[0].recipientSource, 'mailbox_context');

  // Context cookies set on a redirect, then merely replayed by the request
  // CookieJar, do not count as evidence from the final successful response.
  const redirectOnlyContext = fetchStub(
    response(emptyInbox),
    response('', { status: 302, headers: { location: '/inbox1/', 'set-cookie': mailboxContextCookie } }),
    response(noRecipientHtml),
  );
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: redirectOnlyContext, WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
  assert.match(redirectOnlyContext.calls[2].options.headers.cookie, /inbox_ctx=/);
});

test('parses a recipient address only from the direct div following the standalone to label', async () => {
  FakeWebSocket.payload = { ...notification, from: 'notification@email.meta.com' };
  const plainRecipient = noRecipientHtml.replace('<div>to</div><div>Mail delivered</div>', '<div>to</div><div>qa-user@example.test</div><div>Mail delivered</div>');
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox), response(plainRecipient)), WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages[0].to, mailbox);
  assert.equal(messages[0].recipientSource, undefined);

  const nestedValue = noRecipientHtml.replace(
    '<div>to</div><div>Mail delivered</div>',
    '<div>to</div><section><div>other@example.test</div></section><div>Mail delivered</div>',
  );
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox,
    fetchImpl: fetchStub(response(emptyInbox), responseWithSetCookies(nestedValue, [mailboxContextCookie])),
    WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
});

test('does not treat an outgoing inbox_ctx cookie or an address elsewhere in the document as recipient proof', async () => {
  FakeWebSocket.payload = { ...notification, from: 'notification@email.meta.com' };
  const fetchImpl = fetchStub(response(configuredInbox), response(noRecipientHtml));
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl, WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
  assert.match(fetchImpl.calls[1].options.headers.cookie, /inbox_ctx=example\.test%2Fqa-user%2Fmessage-42/);
});

test('rejects invalid, foreign, duplicated, or unsafe final mailbox-context cookies', async () => {
  FakeWebSocket.payload = { ...notification, from: 'notification@email.meta.com' };
  const invalidCookies = [
    'inbox_ctx=example.test%2Fother-user%2Fmessage-42; Domain=generator.email; Path=/; Secure',
    'inbox_ctx=example.test%2Fqa-user%2Fother-message; Domain=generator.email; Path=/; Secure',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=evil.example; Path=/; Secure',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=..generator.email; Path=/; Secure',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure=false',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/foo; Secure',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; Path=/',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; SameSite=invalid',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; SameSite=',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; Max-Age=0',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; Max-Age=-1',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; Max-Age=not-a-number',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; Expires=Wed, 31 Dec 2000 23:59:59 GMT',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure; Expires=not-a-date',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage-42; Domain=generator.email; Path=/; Secure, inbox_ctx=example.test%2Fqa-user%2Fmessage-42',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage%252F42; Domain=generator.email; Path=/; Secure',
    'inbox_ctx=example.test%2Fqa-user%2Fmessage%5C42; Domain=generator.email; Path=/; Secure',
    'inbox_ctx; Domain=generator.email; Path=/; Secure',
  ];
  for (const cookie of invalidCookies) {
    await expectMailError(fetchLatest('generator', mailboxUrl, {
      expectedEmail: mailbox,
      fetchImpl: fetchStub(response(emptyInbox), responseWithSetCookies(noRecipientHtml, [cookie])),
      WebSocketImpl: FakeWebSocket,
    }), 'mail_response_invalid');
  }

  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox,
    fetchImpl: fetchStub(response(emptyInbox), responseWithSetCookies(noRecipientHtml, [mailboxContextCookie, mailboxContextCookie])),
    WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
});

test('rejects placeholder values in the observed standalone recipient slot', async () => {
  FakeWebSocket.payload = { ...notification, from: 'notification@email.meta.com' };
  for (const placeholder of ['', 'self', 'none', '...', '…']) {
    const page = noRecipientHtml.replace('<div>Mail delivered</div>', `<div>${placeholder}</div>`);
    await expectMailError(fetchLatest('generator', mailboxUrl, {
      expectedEmail: mailbox,
      fetchImpl: fetchStub(response(emptyInbox), responseWithSetCookies(page, [mailboxContextCookie])),
      WebSocketImpl: FakeWebSocket,
    }), 'mail_response_invalid');
  }
});

test('explicit foreign or multiple recipients cannot be overridden by mailbox context', async () => {
  FakeWebSocket.payload = { ...notification, from: 'notification@email.meta.com' };
  const cases = [
    html.replace('To: qa-user@example.test', 'To: other@example.test'),
    html.replace('To: qa-user@example.test', 'To: qa-user@example.test, other@example.test'),
    '<main><header id="mail-summary-head"><div>Meta</div><div>to</div><div>other@example.test</div></header><div id="mail-summary-body"><p>Synthetic</p></div></main>',
    '<main><header id="mail-summary-head"><div>Meta</div><div>to</div><div>qa-user@example.test, other@example.test</div></header><div id="mail-summary-body"><p>Synthetic</p></div></main>',
    '<main><header id="mail-summary-head"><div>Meta</div><div>to</div><div>qa-user@</div></header><div id="mail-summary-body"><p>Synthetic</p></div></main>',
  ];
  for (const page of cases) {
    await expectMailError(fetchLatest('generator', mailboxUrl, {
      expectedEmail: mailbox,
      fetchImpl: fetchStub(response(emptyInbox), responseWithSetCookies(page, [mailboxContextCookie])),
      WebSocketImpl: FakeWebSocket,
    }), 'mail_response_invalid');
  }
});

test('does not invent sender or timestamp when notification metadata is absent', async () => {
  FakeWebSocket.payload = { ...notification, from: '', date: '' };
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
});

test('rejects ambiguous senders in both notifications and initial inbox rows', async () => {
  FakeWebSocket.payloads = null;
  FakeWebSocket.payload = { ...notification, from: 'verify@example.org, attacker@example.org' };
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
  const ambiguousInbox = listedInbox.replace('verify@example.org', 'verify@example.org; attacker@example.org');
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(ambiguousInbox)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
  FakeWebSocket.payload = notification;
});

test('rejects minute-only timestamps instead of inventing seconds', async () => {
  FakeWebSocket.payload = { ...notification, date: '2026-10-20T10:20Z' };
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox)), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
});

test('applies since and excluded-id filters using notification data', async () => {
  FakeWebSocket.payload = notification;
  FakeWebSocket.payloads = null;
  const staleFetch = fetchStub();
  const stale = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, since: '2026-10-20T10:20:30.000Z', fetchImpl: staleFetch, WebSocketImpl: FakeWebSocket, webSocketTimeoutMs: 1,
  });
  assert.deepEqual(stale, []);
  assert.equal(staleFetch.calls.length, 1);

  const excludedFetch = fetchStub();
  const excluded = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, excludeIds: ['/example.test/qa-user/message-42'], fetchImpl: excludedFetch, WebSocketImpl: FakeWebSocket, webSocketTimeoutMs: 1,
  });
  assert.deepEqual(excluded, []);
  assert.equal(excludedFetch.calls.length, 1);
});

test('rejects redirects outside the fixed origin and caps message HTML to 1 MiB', async () => {
  FakeWebSocket.payload = notification;
  const redirect = response('', { status: 302, headers: { location: 'https://attacker.example/steal' } });
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox), redirect), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');

  const oversized = response('x'.repeat(1024 * 1024 + 1));
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox), oversized), WebSocketImpl: FakeWebSocket,
  }), 'mail_response_invalid');
});

test('follows at most one same-origin message-page redirect without adding browser state', async () => {
  FakeWebSocket.payload = notification;
  const fetchImpl = fetchStub(
    response(emptyInbox),
    response('', { status: 302, headers: { location: '/inbox1/' } }),
    response(html),
  );
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl, WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(fetchImpl.calls.map(call => call.url), [mailboxUrl, messageLink, 'https://generator.email/inbox1/']);
  assert.equal(fetchImpl.calls[2].options.headers.cookie, undefined);
});

test('accepts only an expected-mailbox tab_ctx redirect fragment and strips it before GET', async () => {
  FakeWebSocket.payload = notification;
  const redirect = response('', {
    status: 302,
    headers: { location: '/inbox1/#tab_ctx=example.test/qa-user/message-42' },
  });
  const fetchImpl = fetchStub(redirect, response(emptyInbox), response(html));
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl, WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages.length, 1);
  assert.equal(fetchImpl.calls[1].url, 'https://generator.email/inbox1/');

  for (const fragment of ['#tab_ctx=example.test/other-user', '#unrecognized=example.test/qa-user']) {
    const wrongContextFetch = fetchStub(
      response('', { status: 302, headers: { location: `/inbox1/${fragment}` } }),
    );
    await expectMailError(fetchLatest('generator', mailboxUrl, {
      expectedEmail: mailbox, fetchImpl: wrongContextFetch, WebSocketImpl: FakeWebSocket,
    }), 'mail_response_invalid');
    assert.equal(wrongContextFetch.calls.length, 1);
  }
});

test('uses the public static SITE_DATA inbox route and an in-memory mailbox context cookie', async () => {
  FakeWebSocket.payload = notification;
  const fetchImpl = fetchStub(response(configuredInbox, { headers: { 'set-cookie': 'site_pref=synthetic; Path=/; Domain=.generator.email; Secure' } }), response(html));
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl, WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages.length, 1);
  assert.equal(fetchImpl.calls[1].url, 'https://generator.email/inbox1/');
  assert.match(fetchImpl.calls[1].options.headers.cookie, /site_pref=synthetic/);
  assert.match(fetchImpl.calls[1].options.headers.cookie, /inbox_ctx=example\.test%2Fqa-user%2Fmessage-42/);
});

test('uses the configured inbox cookie name without executing SITE_DATA JavaScript', async () => {
  FakeWebSocket.payload = notification;
  const mappedConfig = configuredInbox.replace('cookie_names:[]', 'cookie_names:{inbox_ctx:"site_inbox"}');
  const fetchImpl = fetchStub(response(mappedConfig), response(html));
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl, WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages.length, 1);
  assert.match(fetchImpl.calls[1].options.headers.cookie, /site_inbox=example\.test%2Fqa-user%2Fmessage-42/);
  assert.doesNotMatch(fetchImpl.calls[1].options.headers.cookie, /inbox_ctx=/);
});

test('normalizes a root url_language to the canonical inbox path', async () => {
  FakeWebSocket.payload = notification;
  const rootLanguageConfig = configuredInbox.replace('url_language:""', 'url_language:"/"');
  const fetchImpl = fetchStub(response(rootLanguageConfig), response(html));
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl, WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages.length, 1);
  assert.equal(fetchImpl.calls[1].url, 'https://generator.email/inbox1/');
});

test('loads messages already present in the initial inbox page without waiting for WSS', async () => {
  const fetchImpl = fetchStub(response(listedInbox), response(html));
  const neverSocket = class extends EventTarget { constructor() { super(); } close() {} };
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl, WebSocketImpl: neverSocket,
  });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url, mailboxUrl);
  assert.equal(fetchImpl.calls[1].url, messageLink);
  assert.equal(messages[0].receivedAt, notification.date);
  assert.equal(messages[0].id, '/example.test/qa-user/message-42');
});

test('skips stale WSS notifications and keeps waiting for a fresh one', async () => {
  FakeWebSocket.payloads = [
    { ...notification, date: '2026-10-20T10:19:00.000Z' },
    notification,
  ];
  const fetchImpl = fetchStub();
  const messages = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, since: '2026-10-20T10:20:00.000Z', fetchImpl, WebSocketImpl: FakeWebSocket,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, '/example.test/qa-user/message-42');
  assert.equal(fetchImpl.calls.length, 2);
  FakeWebSocket.payloads = null;
});

test('internal WSS idle timeout returns an empty snapshot; caller abort remains aborted', async () => {
  const SilentWebSocket = class extends EventTarget { constructor() { super(); } close() {} };
  const idle = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox)),
    WebSocketImpl: SilentWebSocket, webSocketTimeoutMs: 2,
  });
  assert.deepEqual(idle, []);

  const controller = new AbortController();
  controller.abort();
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, signal: controller.signal, fetchImpl: fetchStub(), WebSocketImpl: SilentWebSocket,
  }), 'aborted');

  const activeController = new AbortController();
  class AbortOnConnectSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => activeController.abort()); }
    close() {}
  }
  await expectMailError(fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, signal: activeController.signal, fetchImpl: fetchStub(response(emptyInbox)),
    WebSocketImpl: AbortOnConnectSocket,
  }), 'aborted');

  class NormalCloseSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        const event = new Event('close');
        Object.defineProperty(event, 'code', { value: 1000 });
        this.dispatchEvent(event);
      });
    }
    close() {}
  }
  const start = Date.now();
  const closed = await fetchLatest('generator', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(response(emptyInbox)),
    WebSocketImpl: NormalCloseSocket, webSocketTimeoutMs: 5_000,
  });
  assert.deepEqual(closed, []);
  assert.ok(Date.now() - start < 1_000);
});

test('rejects unsupported URLs and mismatched provider names', async () => {
  await expectMailError(fetchLatest('generator', 'https://example.org/qa-user@example.test', {
    expectedEmail: mailbox, fetchImpl: fetchStub(), WebSocketImpl: FakeWebSocket,
  }), 'unsupported_provider');
  await expectMailError(fetchLatest('gmail', mailboxUrl, {
    expectedEmail: mailbox, fetchImpl: fetchStub(), WebSocketImpl: FakeWebSocket,
  }), 'unsupported_provider');
});
