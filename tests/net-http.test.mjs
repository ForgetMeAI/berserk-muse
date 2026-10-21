import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionHttpClient, SafeTransportError, DeliveryState, classifyHTTPResponse } from '../src/net/http.mjs';

const ok = (text = 'ok', headers = {}) => new Response(text, { status: 200, headers });

test('cookie jars are isolated per client and apply browser-cookie domain, path, and expiry rules', async () => {
  const seenA = [];
  const seenB = [];
  const clientA = createSessionHttpClient({
    allowedOrigins: ['https://example.test', 'https://sub.example.test'],
    session: { cookies: [
      { name: 'domain', value: 'yes', domain: '.example.test', path: '/api', secure: true, expires: Date.now() / 1000 + 3600 },
      { name: 'host', value: 'only', domain: 'example.test', path: '/', secure: true },
      { name: 'expired', value: 'no', domain: '.example.test', path: '/', secure: true, expires: Date.now() / 1000 - 60 },
    ] },
    fetchImpl: async (url, init) => { seenA.push({ url, cookie: init.headers.get('cookie') }); return ok(); },
  });
  const clientB = createSessionHttpClient({
    allowedOrigins: ['https://sub.example.test'],
    fetchImpl: async (url, init) => { seenB.push({ url, cookie: init.headers.get('cookie') }); return ok(); },
  });

  await clientA.request('https://sub.example.test/api/read');
  await clientA.request('https://sub.example.test/elsewhere');
  await clientB.request('https://sub.example.test/api/read');
  assert.equal(seenA[0].cookie, 'domain=yes');
  assert.equal(seenA[1].cookie, null);
  assert.equal(seenB[0].cookie, null);
});

test('Set-Cookie values persist in the cookie jar, including Expires commas and path scope', async () => {
  let persisted;
  let calls = 0;
  const client = createSessionHttpClient({
    allowedOrigins: ['https://example.test'],
    onSessionCookies: async cookieJar => { persisted = cookieJar; },
    fetchImpl: async (url, init) => {
      calls += 1;
      if (calls === 1) {
        const headers = new Headers();
        headers.append('set-cookie', 'sid=abc; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/api; HttpOnly; Secure');
        return ok('login', headers);
      }
      return new Response(JSON.stringify({ cookie: init.headers.get('cookie') }), { headers: { 'content-type': 'application/json' } });
    },
  });
  await client.request('https://example.test/login');
  assert.equal(Array.isArray(persisted.cookies), true);
  const scoped = await client.request('https://example.test/api/check');
  const unscoped = await client.request('https://example.test/private');
  assert.equal(scoped.json.cookie, 'sid=abc');
  assert.equal(unscoped.json.cookie, null);

  const restored = createSessionHttpClient({
    allowedOrigins: ['https://example.test'], session: { cookieJar: persisted },
    fetchImpl: async (_url, init) => ok(init.headers.get('cookie') || ''),
  });
  assert.equal((await restored.request('https://example.test/api/check')).bodyText, 'sid=abc');
});

test('redirects are manual, bounded to allowlisted origins, and drop credentials across origins', async () => {
  const seen = [];
  const client = createSessionHttpClient({
    allowedOrigins: ['https://a.test', 'https://b.test'],
    session: { cookies: [{ name: 'a-cookie', value: 'secret', domain: 'a.test', path: '/', secure: true }] },
    fetchImpl: async (url, init) => {
      seen.push({ url, authorization: init.headers.get('authorization'), cookie: init.headers.get('cookie'), redirect: init.redirect });
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://b.test/next' } })
        : ok('done');
    },
  });
  const result = await client.request('https://a.test/start', { headers: { authorization: 'Bearer SENTINEL-SECRET' } });
  assert.equal(result.bodyText, 'done');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].authorization, 'Bearer SENTINEL-SECRET');
  assert.equal(seen[0].cookie, 'a-cookie=secret');
  assert.equal(seen[1].authorization, null);
  assert.equal(seen[1].cookie, null);
  assert.ok(seen.every(item => item.redirect === 'manual'));

  let calls = 0;
  const blocked = createSessionHttpClient({
    allowedOrigins: ['https://a.test'],
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: 'https://evil.test/leak' } }); },
  });
  await assert.rejects(blocked.request('https://a.test/start'), error => error.code === 'redirect_origin_not_allowed');
  assert.equal(calls, 1);
});

test('redirects with userinfo or fragments are rejected and redirect count is capped', async () => {
  for (const location of ['https://user:pass@a.test/path', '/path#fragment']) {
    const client = createSessionHttpClient({
      allowedOrigins: ['https://a.test'],
      fetchImpl: async () => new Response(null, { status: 302, headers: { location } }),
    });
    await assert.rejects(client.request('https://a.test/start'), error => error.code === 'redirect_origin_not_allowed');
  }
  let calls = 0;
  const looping = createSessionHttpClient({
    allowedOrigins: ['https://a.test'],
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: '/again' } }); },
  });
  await assert.rejects(looping.request('https://a.test/start'), error => error.code === 'too_many_redirects');
  assert.equal(calls, 4);
});

test('network exceptions expose no raw message, URL, body, or cause and report unknown delivery', async () => {
  const sentinel = 'SENTINEL-SECRET https://example.test/path?token=value body=private';
  const client = createSessionHttpClient({
    allowedOrigins: ['https://example.test'],
    fetchImpl: async () => { throw new Error(sentinel); },
  });
  for (const options of [{ method: 'GET' }, { method: 'POST', body: sentinel }]) {
    await assert.rejects(client.request('https://example.test/request', options), error => {
      assert.ok(error instanceof SafeTransportError);
      assert.equal(error.code, 'network_failed');
      assert.equal(error.delivery, DeliveryState.UNKNOWN);
      assert.equal(error.message.includes('SENTINEL-SECRET'), false);
      assert.equal(error.message.includes('example.test'), false);
      assert.equal('cause' in error, false);
      return true;
    });
  }
});

test('caller cannot spoof cookies or inject CRLF headers', async () => {
  let calls = 0;
  const client = createSessionHttpClient({ allowedOrigins: ['https://example.test'], fetchImpl: async () => { calls += 1; return ok(); } });
  await assert.rejects(client.request('https://example.test/', { headers: { Cookie: 'evil=1' } }), error => error.delivery === DeliveryState.NOT_SENT);
  await assert.rejects(client.request('https://example.test/', { headers: { 'x-test': 'safe\r\nAuthorization: stolen' } }), error => error.delivery === DeliveryState.NOT_SENT);
  assert.equal(calls, 0);
});

test('response bodies are streamed within the byte limit and parse JSON when valid', async () => {
  const client = createSessionHttpClient({
    allowedOrigins: ['https://example.test'], maxBytes: 5,
    fetchImpl: async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(client.request('https://example.test/large'), error => error.code === 'response_too_large' && error.status === 200);

  const small = createSessionHttpClient({
    allowedOrigins: ['https://example.test'], maxBytes: 50,
    fetchImpl: async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
  });
  assert.deepEqual((await small.request('https://example.test/small')).json, { ok: true });
});

test('abort before fetch is not_sent; abort after fetch invocation is unknown', async () => {
  const already = new AbortController();
  already.abort();
  let calls = 0;
  const client = createSessionHttpClient({
    allowedOrigins: ['https://example.test'],
    fetchImpl: async (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('raw abort detail')), { once: true }));
    },
  });
  await assert.rejects(client.request('https://example.test/', { signal: already.signal }), error => error.code === 'aborted' && error.delivery === DeliveryState.NOT_SENT);
  const active = new AbortController();
  const pending = client.request('https://example.test/', { signal: active.signal });
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
  active.abort();
  await assert.rejects(pending, error => error.code === 'aborted' && error.delivery === DeliveryState.UNKNOWN);
});

test('request timeout reports unknown delivery once fetch has started', async () => {
  const client = createSessionHttpClient({
    allowedOrigins: ['https://example.test'], timeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('timeout details')), { once: true });
    }),
  });
  await assert.rejects(client.request('https://example.test/slow'), error => error.code === 'timeout' && error.delivery === DeliveryState.UNKNOWN && !error.message.includes('details'));
});

test('HTTP delivery classification never treats 401 or 419 as proof of rejection', () => {
  assert.equal(classifyHTTPResponse(200), DeliveryState.ACCEPTED);
  for (const status of [400, 401, 405, 413, 415, 419, 422, 500]) assert.equal(classifyHTTPResponse(status), DeliveryState.UNKNOWN);
  assert.equal(classifyHTTPResponse(401, { error: 'invalid auth' }), DeliveryState.UNKNOWN);
  assert.equal(classifyHTTPResponse(419, { error: 'session expired' }), DeliveryState.UNKNOWN);
});



test('restores persisted tough-cookie snapshots after a JSON/session restart', async () => {
  let persisted;
  const first = createSessionHttpClient({ allowedOrigins: ['https://muse.ai'],
    session: { cookies: [{ name: 'sid', value: 'INITIAL_CANARY', domain: 'muse.ai', path: '/', secure: true }] },
    onSessionCookies: snapshot => { persisted = JSON.parse(JSON.stringify(snapshot)); },
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'set-cookie': 'sid=ROTATED_CANARY; Path=/; Secure; HttpOnly; SameSite=Lax' } }),
  });
  await first.request('https://muse.ai/api/session');
  assert.equal(persisted.cookies[0].key, 'sid');
  let outgoing;
  const restarted = createSessionHttpClient({ allowedOrigins: ['https://muse.ai'], session: { cookies: persisted.cookies },
    fetchImpl: async (_url, init) => { outgoing = new Headers(init.headers).get('cookie'); return new Response('{}'); },
  });
  await restarted.request('https://muse.ai/api/session');
  assert.equal(outgoing, 'sid=ROTATED_CANARY');
});
