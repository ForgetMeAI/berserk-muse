import test from 'node:test';
import assert from 'node:assert/strict';
import { createMuseProtocol, MuseTransportError } from '../src/muse/http.mjs';
import { MuseRpcError } from '../src/muse/rpc.mjs';
import { NoiseRuntimeError } from '../src/muse/vendor-runtime.mjs';
import { AccountPool, TransportFailure } from '../src/accounts/pool.mjs';
import { AccountQueue } from '../src/queue.mjs';

const VM = Object.freeze({ endpoint_url: 'https://gateway.metaaivm.com/', vm_id: 'vm-1', vm_name: 'test-vm' });

function makeResponse(status, value, headers = {}) {
  const body = value === undefined || [204, 205, 304].includes(status) ? null : JSON.stringify(value);
  return new Response(body, { status, headers });
}

function sessionFor(cookie, revision = 4) {
  return {
    sessionRevision: revision,
    cookies: [{ name: 'muse_session', value: cookie, domain: 'muse.ai', path: '/', secure: true, httpOnly: true }],
    tokens: { accessToken: `token-${cookie}` },
    device: { id: `device-${cookie}`, headers: { 'user-agent': 'Fake Browser', cookie: 'must-not-be-forwarded' } },
    expiresAt: null,
  };
}

function setup({ responses = {}, rpcGenerate = async () => ({ text: 'safe answer' }),
  beforeChannel, onRuntimeOpen, onChannelClose, onRuntimeClose, onNetworkClose, storeReplace = async () => ({ sessionRevision: 5 }),
  vendorManifest = { assetsDirValidated: '/fake/validated/manifest' }, onVendorFactory, vendorFactory, timeoutMs = 1_000,
  failureFactory = meta => new MuseTransportError(meta.code, meta),
} = {}) {
  const calls = [];
  const networks = [];
  const runtimes = [];
  const channels = [];
  const store = { replacements: [], async replaceSession(id, revision, bundle) {
    this.replacements.push({ id, revision, bundle: structuredClone(bundle) });
    return storeReplace(id, revision, bundle);
  } };
  const protocol = createMuseProtocol({
    store,
    vendorManifest,
    timeoutMs,
    failureFactory,
    networkFactory() {
      const network = {
        async fetchImpl(input, init = {}) {
          const url = new URL(input);
          const headers = new Headers(init.headers || {});
          calls.push({ method: init.method || 'GET', path: url.pathname, cookie: headers.get('cookie'), body: init.body,
            headers, url });
          const value = responses[url.pathname] ? await responses[url.pathname]({ init, headers, calls }) : null;
          return value instanceof Response ? value : value || makeResponse(200, url.pathname === '/api/session' ? VM : url.pathname === '/api/hatch/token' ? { token: 'gateway-token', notary_token: 'notary' } : { ok: true });
        },
        WebSocketImpl: class FakeSocket {},
        async close() { onNetworkClose?.(network); },
      };
      networks.push(network);
      return network;
    },
    vendorFactory: vendorFactory ?? (async options => {
      await onVendorFactory?.(options);
      const runtime = {
        options,
        async open(url, openOptions = {}) {
          await onRuntimeOpen?.(runtime, url, openOptions);
          return { fakeConnection: true };
        },
        async close() { onRuntimeClose?.(runtime); },
      };
      runtimes.push(runtime);
      return runtime;
    }),
    channelFactory: options => {
      const channel = { options, async close(closeOptions) { await onChannelClose?.(channel, closeOptions); } };
      channels.push(channel);
      return channel;
    },
    rpcFactory: options => ({ async generate(prompt, context) {
      await beforeChannel?.({ prompt, context, options });
      return rpcGenerate(prompt, context, options);
    } }),
  });
  return { protocol, store, calls, networks, runtimes, channels };
}

async function generate(protocol, accountId = 'account-a', session = sessionFor('a')) {
  const transport = await protocol.transportFactory({ id: accountId }, session);
  return { transport, result: await transport.generate('hello', { nonce: 'n-1' }) };
}

function poolStoreFor(initialSession) {
  const id = '00000000-0000-4000-8000-000000000099';
  const state = { session: structuredClone(initialSession), revision: 1 };
  const publicAccount = () => ({ id, enabled: true, status: 'active', hasSession: true,
    quarantined: false, cooldownUntil: null, revision: state.revision, sessionRevision: state.session.sessionRevision });
  return {
    id,
    store: {
      listPublic: () => [publicAccount()],
      getPublic: accountId => accountId === id ? publicAccount() : null,
      getPrivate: accountId => accountId === id ? { id, enabled: true, status: 'active', quarantinedAt: null, session: structuredClone(state.session) } : null,
      async updateAccount() { throw new Error('unexpected fake account mutation'); },
      async replaceSession(accountId, expectedRevision, bundle) {
        if (accountId !== id || state.session.sessionRevision !== expectedRevision) {
          throw Object.assign(new Error('stale fake session'), { code: 'session_conflict' });
        }
        state.session = { ...structuredClone(bundle), sessionRevision: expectedRevision + 1 };
        state.revision += 1;
        return { sessionRevision: state.session.sessionRevision };
      },
      state,
    },
  };
}

test('successful generation uses Muse HTTP bootstrap and waits for channel/runtime/network cleanup before CAS persistence', async () => {
  const order = [];
  const fake = setup({
    onChannelClose: async () => { order.push('channel'); },
    onRuntimeClose: () => { order.push('runtime'); },
    onNetworkClose: () => { order.push('network'); },
    onRuntimeOpen: (_runtime, url, options) => {
      order.push('opened');
      assert.equal(url, VM.endpoint_url);
      assert.equal(options.vmName, VM.vm_name);
    },
  });
  const { transport, result } = await generate(fake.protocol);
  assert.deepEqual(result, { text: 'safe answer', delivery: 'accepted' });
  assert.deepEqual(fake.calls.map(call => call.path), ['/api/session', '/api/hatch/vm/wake']);
  assert.deepEqual(order, ['opened', 'channel', 'runtime', 'network']);
  await transport.close();
  assert.equal(fake.store.replacements.length, 1);
  assert.equal(fake.store.replacements[0].revision, 4);
  assert.deepEqual(fake.store.replacements[0].bundle.device.upstream, {
    gatewayUrl: VM.endpoint_url, vmId: VM.vm_id, vmName: VM.vm_name,
  });
});

test('cookie jars are isolated between account transports', async () => {
  const fake = setup();
  const transportA = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('cookie-a'));
  const transportB = await fake.protocol.transportFactory({ id: 'account-b' }, sessionFor('cookie-b'));
  await transportA.generate('prompt A');
  await transportB.generate('prompt B');
  assert.deepEqual(fake.calls.filter(call => call.path === '/api/session').map(call => call.cookie), ['muse_session=cookie-a', 'muse_session=cookie-b']);
  assert.equal(fake.calls.some(call => call.cookie?.includes('must-not-be-forwarded')), false);
});

test('pre-generation Muse auth denial is a typed recoverable not-sent failure and never reaches generation', async () => {
  let generationCalls = 0;
  const failures = [];
  const fake = setup({
    responses: { '/api/session': () => makeResponse(401, { error: 'private response' }) },
    rpcGenerate: async () => { generationCalls++; return { text: 'never' }; },
    failureFactory: meta => { failures.push(meta); return Object.assign(new Error('safe failure'), meta); },
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(transport.generate('prompt'), error => error.code === 'authentication_expired');
  assert.equal(generationCalls, 0);
  assert.deepEqual(fake.calls.map(call => call.path), ['/api/session']);
  assert.equal(failures.at(-1).scope, 'account');
  assert.equal(failures.at(-1).delivery, 'not_sent');
  assert.equal(failures.at(-1).recoverable, true);
  assert.equal(JSON.stringify(failures).includes('private response'), false);
});

test('typed cold gateway connection failure is recoverable once through the real pool queue policy', async () => {
  const { id, store } = poolStoreFor(sessionFor('a', 1));
  let refreshes = 0;
  const sessionManager = {
    async ensureValid() {},
    async refresh() {
      refreshes += 1;
      const current = store.state.session;
      store.state.session = { ...current, sessionRevision: current.sessionRevision + 1 };
      store.state.revision += 1;
    },
  };
  let opens = 0;
  const fake = setup({
    failureFactory: meta => new TransportFailure(meta),
    vendorFactory: async () => ({ async open() { opens += 1; throw new NoiseRuntimeError('noise_runtime_failed'); }, async close() {} }),
  });
  const pool = new AccountPool({ store, sessionManager, transportFactory: (account, session) => fake.protocol.transportFactory(account, session) });
  const queue = new AccountQueue({ pool, maxAttempts: 3 });
  try {
    await assert.rejects(queue.run((_signal, lease) => lease.transport.generate('prompt'), undefined, { requestId: 'cold-gateway' }), error => {
      assert.equal(TransportFailure.is(error), true);
      assert.equal(error.transportCode, 'gateway_connect_failed');
      assert.equal(error.delivery, 'not_sent');
      assert.equal(error.scope, 'account');
      assert.equal(error.recoverable, true);
      assert.equal(error.quarantine, false);
      return true;
    });
    assert.equal(opens, 2, 'one initial attempt and one same-account recovery replay');
    assert.equal(refreshes, 1, 'the logical request refreshes this account at most once');
    assert.equal(pool.status().counts.busy, 0);
  } finally {
    await queue.close();
    await pool.close();
  }
});

test('typed missing assets remains service-scoped and runtime abort is request-scoped', async () => {
  const missing = setup({
    failureFactory: meta => new TransportFailure(meta),
    vendorFactory: async () => ({ async open() { throw new NoiseRuntimeError('needs_vendor_assets'); }, async close() {} }),
  });
  const missingTransport = await missing.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(missingTransport.generate('prompt'), error => {
    assert.equal(error.transportCode, 'needs_vendor_assets');
    assert.equal(error.delivery, 'not_sent');
    assert.equal(error.scope, 'service');
    assert.equal(error.recoverable, false);
    return true;
  });

  const aborted = setup({
    failureFactory: meta => new TransportFailure(meta),
    vendorFactory: async () => ({ async open() { throw new NoiseRuntimeError('runtime_aborted'); }, async close() {} }),
  });
  const abortedTransport = await aborted.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(abortedTransport.generate('prompt'), error => {
    assert.equal(error.transportCode, 'request_cancelled');
    assert.equal(error.delivery, 'not_sent');
    assert.equal(error.scope, 'request');
    assert.equal(error.quarantine, false);
    return true;
  });

  const controller = new AbortController();
  const callerAborted = setup({
    failureFactory: meta => new TransportFailure(meta),
    vendorFactory: async () => ({ async open() { controller.abort(); throw new NoiseRuntimeError('noise_runtime_failed'); }, async close() {} }),
  });
  const callerAbortedTransport = await callerAborted.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(callerAbortedTransport.generate('prompt', { signal: controller.signal }), error => {
    assert.equal(error.transportCode, 'request_cancelled');
    assert.equal(error.delivery, 'not_sent');
    assert.equal(error.scope, 'request');
    return true;
  });
});

test('forged NoiseRuntimeError lookalikes cannot gain retryability', async () => {
  const fake = setup({
    failureFactory: meta => new TransportFailure(meta),
    vendorFactory: async () => ({ async open() {
      throw Object.assign(new Error('untrusted'), { name: 'NoiseRuntimeError', code: 'noise_runtime_failed' });
    }, async close() {} }),
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(transport.generate('prompt'), error => {
    assert.equal(error.transportCode, 'muse_transport_failed');
    assert.equal(error.delivery, 'not_sent');
    assert.equal(error.recoverable, false);
    return true;
  });
});

test('a timeout after RPC generation starts remains unknown and non-retryable', async () => {
  let generations = 0;
  const fake = setup({
    rpcGenerate: async () => { generations += 1; throw new Error('synthetic timeout'); },
    failureFactory: meta => new TransportFailure(meta),
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(transport.generate('prompt'), error => {
    assert.equal(error.delivery, 'unknown');
    assert.equal(error.recoverable, false);
    assert.equal(error.quarantine, true);
    return true;
  });
  assert.equal(generations, 1);
});

test('transient refresh failure is service-scoped and closes the network runtime', async () => {
  const failures = [];
  const order = [];
  const fake = setup({
    responses: { '/api/auth/check': () => makeResponse(503, { secret: 'do-not-log' }) },
    onNetworkClose: () => order.push('network-closed'),
    failureFactory: meta => { failures.push(meta); return Object.assign(new Error(meta.code), meta); },
  });
  await assert.rejects(fake.protocol.refresh({ id: 'account-a' }, sessionFor('a')), error => error.code === 'session_refresh_unavailable');
  assert.deepEqual(fake.calls.map(call => call.path), ['/api/auth/check']);
  assert.deepEqual(order, ['network-closed']);
  assert.equal(failures[0].scope, 'service');
  assert.equal(failures[0].delivery, 'not_sent');
  assert.equal(JSON.stringify(failures).includes('do-not-log'), false);
});

test('refresh applies the configured per-request timeout to its auth health check', async () => {
  let networkClosed = false;
  const fake = setup({ timeoutMs: 20, onNetworkClose: () => { networkClosed = true; }, responses: {
    '/api/auth/check': ({ init }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(makeResponse(200, { outcome: 'validated' })), 100);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('synthetic abort')); }, { once: true });
    }),
  } });
  await assert.rejects(fake.protocol.refresh({ id: 'account-a' }, sessionFor('a')), error => error.code === 'timeout');
  assert.deepEqual(fake.calls.map(call => call.path), ['/api/auth/check']);
  assert.equal(networkClosed, true);
});

test('refresh performs bodyless uncached auth validation and stores only gateway credentials', async () => {
  for (const authCheckBody of [
    { outcome: 'validated' },
    { outcome: 'validated', access_token: { malformed: 'unused-app-token' } },
  ]) {
    const session = sessionFor('a');
    session.tokens.accessToken = 'existing-app-access-token';
    session.device.headers['content-type'] = 'application/json';
    session.device.headers['sec-fetch-site'] = 'cross-site';
    session.device.headers['sec-fetch-mode'] = 'navigate';
    session.device.headers['sec-fetch-dest'] = 'document';
    let tokenBody;
    const fake = setup({ responses: {
      '/api/auth/check': () => makeResponse(200, authCheckBody),
      '/api/session': () => makeResponse(200, { endpoint_url: VM.endpoint_url, vm_id: VM.vm_id }),
      '/api/hatch/token': ({ init }) => {
        tokenBody = JSON.parse(init.body);
        return makeResponse(200, { token: 'gateway-token', notary_token: 'gateway-notary' });
      },
    } });

    const result = await fake.protocol.refresh({ id: 'account-a' }, session);
    const [authCheck, sessionLookup, hatchToken] = fake.calls;
    assert.deepEqual(fake.calls.map(call => call.path), ['/api/auth/check', '/api/session', '/api/hatch/token']);
    assert.equal(authCheck.method, 'POST');
    assert.equal(authCheck.body, undefined);
    assert.equal(authCheck.headers.get('content-type'), null);
    assert.equal(authCheck.headers.get('cache-control'), 'no-store');
    assert.equal(authCheck.headers.get('cookie'), 'muse_session=a');
    assert.equal(sessionLookup.method, 'GET');
    assert.equal(hatchToken.method, 'POST');
    for (const call of [authCheck, sessionLookup, hatchToken]) {
      assert.equal(call.headers.get('sec-fetch-site'), 'same-origin');
      assert.equal(call.headers.get('sec-fetch-mode'), 'cors');
      assert.equal(call.headers.get('sec-fetch-dest'), 'empty');
    }
    assert.deepEqual(tokenBody, { vmAddress: VM.endpoint_url });
    assert.equal(result.ok, true);
    assert.equal(result.session.tokens.accessToken, 'existing-app-access-token');
    assert.deepEqual(result.session.tokens.gateway, { token: 'gateway-token', notaryToken: 'gateway-notary' });
    assert.equal(Object.hasOwn(result.session.device.upstream, 'vmName'), false);
    assert.equal(JSON.stringify(result.session).includes('unused-app-token'), false);
  }
});

test('only the exact first-party session invalidation marks refresh as needing relogin', async () => {
  const fake = setup({ responses: {
    '/api/auth/check': () => makeResponse(401, {
      type: 'hatchAdmissionInvalidated', reason: 'session', status: 401,
    }),
  } });
  assert.deepEqual(await fake.protocol.refresh({ id: 'account-a' }, sessionFor('a')),
    { ok: false, reason: 'needs_relogin' });
  assert.deepEqual(fake.calls.map(call => call.path), ['/api/auth/check']);
});

test('unknown or malformed auth-check results fail safely without probing or mutating the account', async () => {
  const cases = [
    { status: 200, body: { ok: true } },
    { status: 200, body: { outcome: 'not-validated' } },
    { status: 401, body: { type: 'hatch_admission_invalidated', reason: 'session', status: 401 } },
    { status: 401, body: { type: 'hatchAdmissionInvalidated', reason: 'session', status: 401, extra: true } },
    { status: 401, body: { type: 'hatchAdmissionInvalidated', reason: 'entitlement', status: 401 } },
    { status: 403, body: { type: 'hatchAdmissionInvalidated', reason: 'entitlement', status: 403 } },
    { status: 403, body: { type: 'checkpointRequired', checkpoint_url: '/checkpoint' } },
    { status: 419, body: { type: 'hatchAdmissionInvalidated', reason: 'session', status: 401 } },
  ];
  for (const item of cases) {
    const fake = setup({ responses: { '/api/auth/check': () => makeResponse(item.status, item.body) } });
    await assert.rejects(fake.protocol.refresh({ id: 'account-a' }, sessionFor('a')), error =>
      error.code === 'session_refresh_unavailable' && error.scope === 'service');
    assert.deepEqual(fake.calls.map(call => call.path), ['/api/auth/check']);
    assert.deepEqual(fake.store.replacements, []);
  }
});

test('hatch token 401 and 419 retain expiry handling while 403 stays transient', async () => {
  for (const status of [401, 419, 403]) {
    const fake = setup({ responses: {
      '/api/auth/check': () => makeResponse(200, { outcome: 'validated', access_token: 'app-token' }),
      '/api/session': () => makeResponse(200, VM),
      '/api/hatch/token': () => makeResponse(status, { secret: 'do-not-log' }),
    } });
    if (status === 403) {
      await assert.rejects(fake.protocol.refresh({ id: 'account-a' }, sessionFor('a')), error =>
        error.code === 'session_refresh_unavailable' && error.scope === 'service' && error.status === 403);
    } else {
      assert.deepEqual(await fake.protocol.refresh({ id: 'account-a' }, sessionFor('a')),
        { ok: false, reason: 'needs_relogin' });
    }
    assert.deepEqual(fake.calls.map(call => call.path), ['/api/auth/check', '/api/session', '/api/hatch/token']);
  }
});

test('channel shutdown is awaited before runtime and network shutdown', async () => {
  const order = [];
  let releaseChannel;
  const channelGate = new Promise(resolve => { releaseChannel = resolve; });
  const fake = setup({
    onChannelClose: async () => { order.push('channel-start'); await channelGate; order.push('channel-finish'); },
    onRuntimeClose: () => order.push('runtime'),
    onNetworkClose: () => order.push('network'),
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  const generating = transport.generate('prompt');
  for (let count = 0; count < 20 && order.length === 0; count++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['channel-start']);
  releaseChannel();
  await generating;
  assert.deepEqual(order, ['channel-start', 'channel-finish', 'runtime', 'network']);
});

test('stale session CAS conflict is ignored without overwriting the newer session', async () => {
  const fake = setup({ storeReplace: async () => { throw Object.assign(new Error('conflict'), { code: 'session_conflict' }); } });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a', 11));
  await transport.generate('prompt');
  await assert.doesNotReject(transport.close());
  assert.equal(fake.store.replacements.length, 1);
  assert.equal(fake.store.replacements[0].revision, 11);
});

test('unknown post-generation failure retains unknown delivery and is never downgraded to retryable', async () => {
  const failures = [];
  const fake = setup({
    rpcGenerate: async () => { throw new MuseRpcError('stream_failed', { delivery: 'unknown', quarantine: true }); },
    failureFactory: meta => { failures.push(meta); return Object.assign(new Error(meta.code), meta); },
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(transport.generate('prompt'), error => error.code === 'stream_failed');
  assert.equal(failures.at(-1).delivery, 'unknown');
  assert.equal(failures.at(-1).scope, 'account');
  assert.equal(failures.at(-1).recoverable, false);
  assert.equal(failures.at(-1).quarantine, true);
});

test('cleanup failure preserves the primary unknown RPC code while forcing quarantine and disabling retry', async () => {
  const fake = setup({
    rpcGenerate: async () => { throw new MuseRpcError('stream_failed', { delivery: 'unknown', quarantine: true }); },
    onChannelClose: async () => { throw new Error('private fake cleanup detail'); },
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(transport.generate('prompt'), error => {
    assert.equal(error.code, 'stream_failed');
    assert.equal(error.delivery, 'unknown');
    assert.equal(error.quarantine, true);
    assert.equal(error.recoverable, false);
    assert.equal(error.message.includes('private fake cleanup detail'), false);
    return true;
  });
});

test('optional vmName is omitted for missing, null, or empty official descriptor names', async () => {
  for (const name of [undefined, null, '']) {
    const calls = [];
    let openOptions;
    const descriptor = { endpoint_url: VM.endpoint_url, vm_id: VM.vm_id };
    if (name !== undefined) descriptor.vm_name = name;
    const fake = setup({ responses: { '/api/session': () => makeResponse(200, descriptor) },
      onRuntimeOpen: (_runtime, _url, options) => { calls.push('open'); openOptions = options; }, onChannelClose: () => calls.push('channel-close'),
      onNetworkClose: () => calls.push('network-close') });
    const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
    assert.deepEqual(await transport.generate('prompt'), { text: 'safe answer', delivery: 'accepted' });
    assert.deepEqual(calls, ['open', 'channel-close', 'network-close']);
    assert.equal(Object.hasOwn(openOptions, 'vmName'), false);
    assert.equal(fake.calls.some(call => call.path === '/api/hatch/vm/wake'), true);
  }
});

test('lazy vendor manifest is not prepared by probe and is prepared only immediately before first generation runtime', async () => {
  let prepareCount = 0;
  let preparedAt = null;
  let wakeAt = null;
  const fake = setup({
    vendorManifest: async () => {
      prepareCount++;
      preparedAt = fake.calls.map(call => call.path);
      return { assetsDirValidated: '/fake/lazily-prepared' };
    },
    responses: { '/api/hatch/vm/wake': () => { wakeAt = fake.calls.map(call => call.path); return makeResponse(200, { ok: true }); } },
    onVendorFactory: options => assert.deepEqual(options.assetsDirValidatedManifest, { assetsDirValidated: '/fake/lazily-prepared' }),
  });
  assert.deepEqual(await fake.protocol.probe({ id: 'account-a' }, sessionFor('a')), { valid: true, expiresAt: null });
  assert.equal(prepareCount, 0);
  const callsAfterProbe = fake.calls.length;
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await transport.generate('first request');
  assert.equal(prepareCount, 1);
  assert.deepEqual(wakeAt.slice(-2), ['/api/session', '/api/hatch/vm/wake']);
  assert.deepEqual(preparedAt.slice(-2), ['/api/session', '/api/hatch/vm/wake']);
  assert.deepEqual(fake.calls.slice(callsAfterProbe).map(call => call.path), ['/api/session', '/api/hatch/vm/wake']);
});

test('a branded service vendor failure stays service-scoped and causes no account retry or cooldown', async () => {
  const fake = setup({
    vendorManifest: async () => { throw new Error('private cache detail'); },
    failureFactory: meta => new TransportFailure(meta),
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  let failure;
  await assert.rejects(transport.generate('prompt'), error => {
    failure = error;
    assert.equal(TransportFailure.is(error), true);
    assert.equal(Object.isFrozen(error), true);
    assert.equal(error.transportCode, 'needs_vendor_assets');
    assert.equal(error.scope, 'service');
    assert.equal(error.delivery, 'not_sent');
    assert.equal(error.recoverable, false);
    return true;
  });

  const accountId = '00000000-0000-4000-8000-000000000010';
  const publicAccount = {
    id: accountId, emailMasked: 'a***@example.invalid', enabled: true, status: 'active',
    hasSession: true, quarantined: false, cooldownUntil: null,
  };
  const accountMutations = [];
  const pool = new AccountPool({
    store: {
      listPublic: () => [publicAccount],
      getPublic: () => null,
      getPrivate: () => null,
      async updateAccount(...args) { accountMutations.push(args); },
    },
    transportFactory: () => ({}),
  });
  const outcome = await pool.noteFailure({
    accountId, sessionRevision: 4,
  }, failure);
  assert.equal(outcome.scope, 'service');
  assert.equal(outcome.retrySameAccount, false);
  assert.equal(outcome.retryOtherAccount, false);
  assert.equal(accountMutations.length, 0);
  assert.equal(pool.status().counts.cooldown, 0);
  assert.equal(pool.accountState(accountId).busy, false);
  assert.equal(pool.status().state, 'service_blocked');
  await pool.close();
});

test('a later successful vendor HTTP step clears an earlier denial before handshake errors', async () => {
  let vendorFetch;
  const fake = setup({
    responses: {
      '/api/hatch/token': () => makeResponse(401, { private: 'denial body' }),
      '/api/auth/check': () => makeResponse(200, { ok: true }),
    },
    onVendorFactory: options => { vendorFetch = options.fetchImpl; },
    onRuntimeOpen: async () => {
      const denied = await vendorFetch('https://muse.ai/api/hatch/token', { method: 'POST', body: '{}' });
      assert.equal(denied.status, 401);
      const cleared = await vendorFetch('https://muse.ai/api/auth/check', { method: 'POST', body: '{}' });
      assert.equal(cleared.status, 200);
      throw Object.assign(new Error('private handshake detail'), {
        transportCode: 'forged_transport_code', scope: 'service', delivery: 'not_sent',
        recoverable: true, accountStatus: 'banned',
      });
    },
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(transport.generate('prompt'), error => {
    assert.equal(error.code, 'muse_transport_failed');
    assert.equal(error.scope, 'account');
    assert.equal(error.delivery, 'not_sent');
    assert.equal(error.message.includes('private handshake detail'), false);
    assert.equal(JSON.stringify(error).includes('denial body'), false);
    return true;
  });
});

test('non-200 bootstrap statuses are safe pre-generation failures, including 204', async () => {
  let generationCalls = 0;
  const fake = setup({
    responses: { '/api/session': () => makeResponse(204) },
    rpcGenerate: async () => { generationCalls++; return { text: 'never' }; },
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  await assert.rejects(transport.generate('prompt'), error => {
    assert.equal(error.code, 'upstream_unavailable');
    assert.equal(error.status, 204);
    assert.equal(error.delivery, 'not_sent');
    assert.equal(error.message.includes('undefined'), false);
    return true;
  });
  assert.equal(generationCalls, 0);
  assert.deepEqual(fake.calls.map(call => call.path), ['/api/session']);
});

test('vendor fetch constructs a legal null-body Response for status 204', async () => {
  let vendorFetch;
  const fake = setup({
    responses: { '/api/hatch/token': () => makeResponse(204) },
    onVendorFactory: options => { vendorFetch = options.fetchImpl; },
    onRuntimeOpen: async () => {
      const response = await vendorFetch('https://muse.ai/api/hatch/token', { method: 'POST', body: '{}' });
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
    },
  });
  const transport = await fake.protocol.transportFactory({ id: 'account-a' }, sessionFor('a'));
  assert.deepEqual(await transport.generate('prompt'), { text: 'safe answer', delivery: 'accepted' });
});

test('a successful probe persists only rotated cookies using the session revision as CAS', async () => {
  const fake = setup({ responses: {
    '/api/session': () => makeResponse(200, VM, { 'set-cookie': 'muse_session=rotated; Domain=muse.ai; Path=/; Secure; HttpOnly' }),
  } });
  const result = await fake.protocol.probe({ id: 'account-a' }, sessionFor('old-cookie', 23));
  assert.deepEqual(result, { valid: true, expiresAt: null });
  assert.equal(fake.store.replacements.length, 1);
  const replacement = fake.store.replacements[0];
  assert.equal(replacement.id, 'account-a');
  assert.equal(replacement.revision, 23);
  assert.equal(JSON.stringify(replacement.bundle.cookies).includes('rotated'), true, JSON.stringify(replacement.bundle.cookies));
});

test('probe does not rewrite the session when no cookie update was received', async () => {
  const fake = setup();
  assert.deepEqual(await fake.protocol.probe({ id: 'account-a' }, sessionFor('unchanged', 24)), { valid: true, expiresAt: null });
  assert.equal(fake.store.replacements.length, 0);
});

test('probe CAS conflict leaves a newer stored session untouched and still reports the probe as valid', async () => {
  const newer = { revision: 26, cookies: [{ name: 'muse_session', value: 'newer', domain: 'muse.ai', path: '/' }] };
  const fake = setup({
    responses: { '/api/session': () => makeResponse(200, VM, { 'set-cookie': 'muse_session=rotated; Domain=muse.ai; Path=/; Secure; HttpOnly' }) },
    storeReplace: async (_id, expectedRevision) => {
      assert.equal(expectedRevision, 25);
      throw Object.assign(new Error('private conflict detail'), { code: 'session_conflict' });
    },
  });
  const result = await fake.protocol.probe({ id: 'account-a' }, sessionFor('old', 25));
  assert.deepEqual(result, { valid: true, expiresAt: null });
  assert.deepEqual(newer.cookies, [{ name: 'muse_session', value: 'newer', domain: 'muse.ai', path: '/' }]);
  assert.equal(fake.store.replacements.length, 1);
  assert.equal(JSON.stringify(fake.store.replacements[0].bundle.cookies).includes('rotated'), true);
});

test('probe cookie persistence failure is a safe service failure', async () => {
  const fake = setup({
    responses: { '/api/session': () => makeResponse(200, VM, { 'set-cookie': 'muse_session=rotated; Domain=muse.ai; Path=/; Secure; HttpOnly' }) },
    storeReplace: async () => { throw new Error('private persistence detail'); },
  });
  await assert.rejects(fake.protocol.probe({ id: 'account-a' }, sessionFor('old', 27)), error => {
    assert.equal(error.code, 'probe_cookie_persistence_failed');
    assert.equal(error.scope, 'service');
    assert.equal(error.delivery, 'not_sent');
    assert.equal(error.message.includes('private persistence detail'), false);
    return true;
  });
});

function usageFlight(overrides = {}) {
  return [
    `0:${JSON.stringify({ a: '$@1' })}`,
    `1:${JSON.stringify({ success: true, subscription: {
      tier: { tierCode: 'power', name: 'Power', isPaid: true },
      usage: { state: 'active', percentUsed: 4, resetsAt: 1_800_000_000, quotaStatus: 'available' },
      topupBalance: 40_000_000, topupTotal: 50_000_000,
      topupRowValueLabel: '20% used (1B tokens left)',
      ...overrides,
    } })}`,
  ].join('\n');
}

function usageSession(revision = 7) {
  return {
    sessionRevision: revision,
    cookies: [{ name: 'muse_session', value: 'synthetic-cookie', domain: 'muse.ai', path: '/', secure: true, httpOnly: true }],
    tokens: {}, device: { headers: { 'user-agent': 'Synthetic test browser', 'accept-language': 'en-US' } }, expiresAt: null,
  };
}

function usageProtocol({ response, store, onClose, onNoise } = {}) {
  const calls = [];
  const network = {
    async fetchImpl(input, init = {}) {
      calls.push({ url: new URL(input), init, headers: new Headers(init.headers) });
      return response?.(calls.at(-1)) ?? new Response(usageFlight(), {
        status: 200, headers: { 'content-type': 'text/x-component' },
      });
    },
    async close() { onClose?.(); },
  };
  const protocol = createMuseProtocol({
    store: store ?? { async replaceSession() { return { sessionRevision: 8 }; } },
    vendorManifest: { assetsDirValidated: '/unused/synthetic-manifest' },
    networkFactory: () => network,
    vendorFactory: async () => { onNoise?.(); throw new Error('usage must not start Noise'); },
  });
  return { protocol, calls };
}

test('readUsage sends the confirmed read-only Next action request, projects response, and closes without generation bootstrap', async () => {
  let closed = false;
  let noiseCalls = 0;
  const fake = usageProtocol({ onClose: () => { closed = true; }, onNoise: () => { noiseCalls++; } });
  const result = await fake.protocol.readUsage({ id: 'synthetic-account' }, usageSession());
  const [{ url, init, headers }] = fake.calls;
  assert.equal(url.origin, 'https://muse.ai');
  assert.equal(url.pathname, '/');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, JSON.stringify([{ includeAgreement: false }]));
  assert.equal(headers.get('accept'), 'text/x-component');
  assert.equal(headers.get('content-type'), 'text/plain;charset=UTF-8');
  assert.equal(headers.get('next-action'), '4029ac5c4bd03136487d91ebde5de39c64b35229b4');
  assert.equal(headers.get('next-router-state-tree'), null);
  assert.equal(headers.get('origin'), 'https://muse.ai');
  assert.equal(headers.get('referer'), 'https://muse.ai/');
  assert.equal(headers.get('sec-fetch-site'), 'same-origin');
  assert.equal(headers.get('sec-fetch-mode'), 'cors');
  assert.equal(headers.get('sec-fetch-dest'), 'empty');
  assert.equal(headers.get('user-agent'), 'Synthetic test browser');
  assert.deepEqual(fake.calls.map(call => call.url.pathname), ['/']);
  assert.equal(result.weekly.percentUsed, 4);
  assert.deepEqual(result.additional, {
    remaining: 1_000_000_000, limit: null, used: null, percentUsed: 20, approximate: true,
    displayLabel: '20% used (1B tokens left)',
    raw: { remaining: 40_000_000, limit: 50_000_000, unit: 'muse_quota_units' },
  });
  assert.equal(result.sessionRevision, 7);
  assert.equal(noiseCalls, 0);
  assert.equal(closed, true);
});

test('readUsage persists rotated cookies by CAS before returning the observed balance', async () => {
  const replacements = [];
  const fake = usageProtocol({
    response: () => new Response(usageFlight(), { status: 200, headers: {
      'content-type': 'text/x-component', 'set-cookie': 'muse_session=rotated-cookie; Path=/; Secure; HttpOnly; SameSite=Lax',
    } }),
    store: { async replaceSession(id, revision, bundle) {
      replacements.push({ id, revision, bundle });
      return { sessionRevision: 8 };
    } },
  });
  const result = await fake.protocol.readUsage({ id: 'synthetic-account' }, usageSession());
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].id, 'synthetic-account');
  assert.equal(replacements[0].revision, 7);
  assert.ok(replacements[0].bundle.cookies.some(cookie => cookie.value === 'rotated-cookie'));
  assert.equal(result.sessionRevision, 8);
});

test('readUsage withholds a valid balance when cookie persistence detects a newer session', async () => {
  const fake = usageProtocol({
    response: () => new Response(usageFlight(), { status: 200, headers: {
      'set-cookie': 'muse_session=rotated-cookie; Path=/; Secure; HttpOnly',
    } }),
    store: { async replaceSession() { throw Object.assign(new Error('private conflict detail'), { code: 'session_conflict' }); } },
  });
  await assert.rejects(fake.protocol.readUsage({ id: 'synthetic-account' }, usageSession()), error => {
    assert.equal(error.code, 'usage_session_changed');
    assert.equal(error.message, 'The Muse session changed while usage was being read.');
    return true;
  });
});

test('readUsage maps upstream statuses safely and still closes the network', async () => {
  for (const [status, code] of [[401, 'usage_auth_required'], [419, 'usage_auth_required'], [403, 'usage_forbidden'], [503, 'usage_unavailable']]) {
    let closed = false;
    const fake = usageProtocol({ response: () => new Response('private upstream detail', { status }), onClose: () => { closed = true; } });
    await assert.rejects(fake.protocol.readUsage({ id: 'synthetic-account' }, usageSession()), error => {
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(error).includes('private upstream detail'), false);
      return true;
    });
    assert.equal(closed, true);
  }
});

test('readUsage preserves the primary response error when cookie CAS conflicts and shutdown also fails', async () => {
  let closed = false;
  const fake = usageProtocol({
    response: () => new Response('not a Flight response', { status: 200, headers: {
      'set-cookie': 'muse_session=rotated-cookie; Path=/; Secure; HttpOnly',
    } }),
    store: { async replaceSession() { throw Object.assign(new Error('private conflict detail'), { code: 'session_conflict' }); } },
    onClose() { closed = true; throw new Error('private close detail'); },
  });
  await assert.rejects(fake.protocol.readUsage({ id: 'synthetic-account' }, usageSession()), error => {
    assert.equal(error.code, 'usage_response_invalid');
    assert.equal(error.message, 'Muse returned an invalid usage response.');
    return true;
  });
  assert.equal(closed, true);
});

test('readUsage rejects an absent session before creating network state', async () => {
  let created = 0;
  const protocol = createMuseProtocol({
    store: {}, vendorManifest: { assetsDirValidated: '/unused/synthetic-manifest' },
    networkFactory: () => { created++; throw new Error('must not run'); },
  });
  await assert.rejects(protocol.readUsage({ id: 'synthetic-account' }, { cookies: [] }), error => error.code === 'usage_auth_required');
  assert.equal(created, 0);
});
