import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../src/server.mjs';
import { TransportFailure } from '../src/accounts/pool.mjs';

const AUTH = 'Bearer muse-local';
const jsonHeaders = { 'content-type': 'application/json', authorization: AUTH };

function readContext(prompt) {
  const marker = 'CANONICAL_CONTEXT_JSON:\n';
  const index = prompt.indexOf(marker);
  assert.notEqual(index, -1, 'prompt includes canonical JSON context');
  return JSON.parse(prompt.slice(index + marker.length));
}

function driver(generate = (_prompt, { nonce }) => ({ text: JSON.stringify({ request_id: nonce, content: 'ok', tool_calls: [] }) })) {
  return {
    generate,
    async status() { return { ready: true, state: 'ready' }; },
    async close() {},
  };
}

async function withBridge(instance, fn, options = {}) {
  const bridge = createBridge({ driver: instance, ...options });
  const port = await bridge.listen(0);
  try { await fn({ bridge, port }); }
  finally { await bridge.close(); }
}

async function send(port, path, { method = 'GET', headers = {}, body } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('injects a queue lease, dispatches panel control before local auth, and reports bounded telemetry', async () => {
  const lease = { id: 'lease-1', attemptId: 'attempt-1', accountId: 'account-1', sessionRevision: 7, transport: { kind: 'fake' } };
  const queueCalls = [];
  const queue = {
    status: { active: false, activeCount: 0, waiting: 0, capacity: 4 },
    async run(fn, signal, metadata) {
      queueCalls.push({ signal, metadata });
      return fn(signal, lease);
    },
  };
  const panelPaths = [];
  const panelRouter = {
    async handle(_req, res, parsedURL) {
      panelPaths.push(parsedURL.pathname);
      if (parsedURL.pathname !== '/control/panel-ticket') return false;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'test-ticket' }));
      return true;
    },
    async close() {},
  };
  const telemetryAttempts = [];
  const telemetryResults = [];
  const started = [];
  const finished = [];
  let shutdownCalls = 0;
  let driverOptions;
  const instance = driver((prompt, options) => {
    driverOptions = options;
    assert.match(prompt, /CANONICAL_CONTEXT_JSON/);
    return { text: JSON.stringify({ request_id: options.nonce, content: 'ok', tool_calls: [] }) };
  });
  instance.login = async () => ({ ready: true });
  const bridge = createBridge({
    driver: instance,
    queue,
    panelRouter,
    telemetry: {
      async recordAttempt(record) { telemetryAttempts.push(record); },
      async recordResult(record) { telemetryResults.push(record); },
    },
    onRequestStarted(record) { started.push(record); },
    onRequestFinished(record) { finished.push(record); },
    onShutdown() { shutdownCalls++; },
  });
  const port = await bridge.listen(0);
  try {
    const panel = await send(port, '/control/panel-ticket', { method: 'POST' });
    assert.equal(panel.status, 201);
    assert.deepEqual(await panel.json(), { ticket: 'test-ticket' });

    const unauthenticatedLogin = await send(port, '/control/login', { method: 'POST' });
    assert.equal(unauthenticatedLogin.status, 401);
    const login = await send(port, '/control/login', { method: 'POST', headers: { authorization: AUTH } });
    assert.equal(login.status, 200);
    const stop = await send(port, '/control/stop', { method: 'POST', headers: { authorization: AUTH } });
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { stopping: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shutdownCalls, 1);
    assert.ok(panelPaths.includes('/control/panel-ticket'));
    assert.ok(panelPaths.includes('/control/login'));
    assert.ok(panelPaths.includes('/control/stop'));

    const response = await send(port, '/v1/chat/completions', {
      method: 'POST', headers: jsonHeaders,
      body: { model: 'muse', messages: [{ role: 'user', content: 'Use a fake lease.' }] },
    });
    assert.equal(response.status, 200);
    const completion = await response.json();
    const metadata = queueCalls[0].metadata;
    assert.equal(typeof metadata.requestId, 'string');
    assert.ok(metadata.estimatedInputTokens > 0);
    assert.equal(completion.id, `chatcmpl-${metadata.requestId}`);
    assert.equal(driverOptions.signal, queueCalls[0].signal);
    assert.equal(driverOptions.lease, lease);
    assert.equal(driverOptions.requestId, metadata.requestId);
    assert.equal(driverOptions.attemptId, lease.attemptId);
    assert.equal(telemetryAttempts.length, 1);
    assert.equal(telemetryAttempts[0].accountId, lease.accountId);
    assert.equal(telemetryAttempts[0].sessionRevision, lease.sessionRevision);
    assert.equal(telemetryResults.length, 1);
    assert.equal(telemetryResults[0].status, 'completed');
    assert.equal(telemetryResults[0].estimatedInputTokens, metadata.estimatedInputTokens);
    assert.equal(started.length, 1);
    assert.equal(finished.length, 1);
    assert.equal(started[0].requestId, metadata.requestId);
    assert.equal(finished[0].requestId, metadata.requestId);
    assert.equal(JSON.stringify(finished[0]).includes('Use a fake lease.'), false);
    assert.equal(panelPaths.includes('/v1/chat/completions'), false);
  } finally {
    await bridge.close();
  }
});

test('parses localhost panel requests using their validated Host origin', async () => {
  let observed;
  const panelRouter = {
    async handle(req, res, parsedURL) {
      if (parsedURL.pathname !== '/panel/api/bootstrap') return false;
      observed = { origin: parsedURL.origin, host: req.headers.host, requestOrigin: req.headers.origin };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return true;
    },
    async close() {},
  };
  const bridge = createBridge({ driver: driver(), panelRouter });
  const port = await bridge.listen(0);
  try {
    const response = await fetch(`http://localhost:${port}/panel/api/bootstrap`, {
      headers: { origin: `http://localhost:${port}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(observed, {
      origin: `http://localhost:${port}`,
      host: `localhost:${port}`,
      requestOrigin: `http://localhost:${port}`,
    });
  } finally {
    await bridge.close();
  }
});

test('closes panel SSE streams before awaiting the HTTP server close', async () => {
  let activeResponse;
  let panelClosed = false;
  const panelRouter = {
    async handle(_req, res, parsedURL) {
      if (parsedURL.pathname !== '/panel/api/events') return false;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: snapshot\ndata: {}\n\n');
      activeResponse = res;
      return true;
    },
    async close() {
      panelClosed = true;
      if (activeResponse && !activeResponse.writableEnded) activeResponse.end();
    },
  };
  const bridge = createBridge({ driver: driver(), panelRouter });
  const port = await bridge.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/panel/api/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    let timeout;
    await Promise.race([
      bridge.close(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('bridge close hung on panel SSE')), 2000); }),
    ]);
    clearTimeout(timeout);
    const body = await response.text();
    assert.match(body, /event: snapshot/);
    assert.equal(panelClosed, true);
  } finally {
    if (!panelClosed) await bridge.close();
  }
});

test('surfaces only the branded transportCode without exposing transport details or retrying', async () => {
  let queueCalls = 0;
  let generateCalls = 0;
  let resultRecord;
  const queue = {
    status: { active: false, activeCount: 0, waiting: 0, capacity: 4 },
    async run(fn, signal) {
      queueCalls++;
      return fn(signal, { attemptId: 'attempt-unknown', accountId: 'account-A', sessionRevision: 2 });
    },
  };
  const instance = driver(() => {
    generateCalls++;
    const failure = new TransportFailure({
      code: 'muse_transport_failure', scope: 'request', delivery: 'unknown',
    });
    throw failure;
  });
  const bridge = createBridge({ driver: instance, queue, telemetry: {
    async recordResult(record) { resultRecord = record; },
  } });
  const port = await bridge.listen(0);
  try {
    const response = await send(port, '/v1/chat/completions', {
      method: 'POST', headers: jsonHeaders,
      body: { model: 'muse', messages: [{ role: 'user', content: 'Fail once.' }] },
    });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(text.includes('The Muse transport failed to complete the request.'), false);
    assert.equal(JSON.parse(text).error.code, 'muse_transport_failure');
    assert.equal(queueCalls, 1);
    assert.equal(generateCalls, 1);
    assert.equal(resultRecord.delivery, 'unknown');
    assert.equal(resultRecord.status, 'error');
    assert.equal(resultRecord.errorCode, 'muse_transport_failure');
  } finally {
    await bridge.close();
  }
});

test('does not treat an unbranded lookalike transportCode as trusted', async () => {
  const instance = driver(() => {
    throw Object.assign(new Error('private detail'), {
      name: 'TransportFailure', transportCode: 'forged_code', delivery: 'unknown',
    });
  });
  const bridge = createBridge({ driver: instance });
  const port = await bridge.listen(0);
  try {
    const response = await send(port, '/v1/chat/completions', {
      method: 'POST', headers: jsonHeaders,
      body: { model: 'muse', messages: [{ role: 'user', content: 'Do not trust an unbranded code.' }] },
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'upstream_unavailable');
    assert.equal(JSON.stringify(body).includes('private detail'), false);
  } finally {
    await bridge.close();
  }
});
