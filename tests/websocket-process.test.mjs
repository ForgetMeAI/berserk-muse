import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createProcessWebSocketClass, createBoundedIpcWriter } from '../src/net/websocket-process.mjs';

test('IPC retention is bounded across individually valid frames and callbacks release capacity', () => {
  const callbacks = [];
  let failures = 0, sent = 0;
  const write = createBoundedIpcWriter((_message, callback) => { sent++; callbacks.push(callback); return false; }, { maxBytes: 12, maxMessages: 2, onFailure: () => failures++ });
  assert.equal(write({}, 6), true);
  assert.equal(write({}, 6), true);
  callbacks.shift()(null);
  assert.equal(write({}, 6), true);
  assert.equal(write({}, 1), false);
  assert.equal(write({}, 1), false);
  assert.equal(sent, 3);
  assert.equal(failures, 1);
  for (const callback of callbacks) callback(null);
});

test('IPC writer handles an errored or throwing send without exposing its cause', () => {
  let failures = 0;
  const write = createBoundedIpcWriter(() => { throw new Error('PRIVATE_IPC_CANARY'); }, { onFailure: () => failures++ });
  assert.equal(write({}), false);
  assert.equal(failures, 1);
  const callbackFailure = createBoundedIpcWriter((_message, callback) => { callback(new Error('PRIVATE_CALLBACK_CANARY')); callback(new Error('duplicate')); }, { onFailure: () => failures++ });
  assert.equal(callbackFailure({}), true);
  assert.equal(callbackFailure({}), false);
  assert.equal(failures, 2);
});

async function fixture({ remoteClose = false } = {}) {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (remoteClose) socket.write(Buffer.from([0x88, 2, 3, 232]));
    let replied = false;
    socket.on('data', data => {
      if ((data[0] & 15) === 8) {
        if (remoteClose) socket.end();
        return; // Deliberately ignore the close handshake in the main test.
      }
      if (!replied) { replied = true; socket.write(Buffer.from([0x82, 2, 79, 75])); }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `ws://127.0.0.1:${server.address().port}/socket?auth_token=FAKE_URL_CANARY`,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

test('native socket frames use local IPC and CLOSED waits for the owned process exit', { timeout: 10_000 }, async () => {
  const server = await fixture();
  let child;
  const saved = process.env.BERSERK_PRIVATE_ENV_CANARY;
  process.env.BERSERK_PRIVATE_ENV_CANARY = 'FAKE_ENV_CANARY';
  const Socket = createProcessWebSocketClass({ graceMs: 40, killMs: 40,
    forkImpl(file, args, options) {
      assert.deepEqual(args, []);
      assert.equal(options.serialization, 'advanced');
      assert.equal(JSON.stringify({ args, options }).includes('FAKE_URL_CANARY'), false);
      assert.equal(JSON.stringify(options.env).includes('FAKE_ENV_CANARY'), false);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      child = fork(file, args, options); return child;
    },
  });
  const socket = new Socket(server.url);
  try {
    await once(socket, 'open');
    const received = once(socket, 'message');
    socket.send(new Uint8Array([1, 2, 3]));
    const [message] = await received;
    assert.ok(message.data instanceof ArrayBuffer);
    assert.equal(Buffer.from(message.data).toString(), 'OK');
    const closed = once(socket, 'close');
    socket.close();
    assert.equal(socket.readyState, Socket.CLOSING);
    await closed;
    assert.equal(socket.readyState, Socket.CLOSED);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
  } finally {
    if (saved === undefined) delete process.env.BERSERK_PRIVATE_ENV_CANARY;
    else process.env.BERSERK_PRIVATE_ENV_CANARY = saved;
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await server.close();
  }
});

test('a normal remote close preserves metadata but still waits for process exit', { timeout: 10_000 }, async () => {
  const server = await fixture({ remoteClose: true });
  const Socket = createProcessWebSocketClass();
  const socket = new Socket(server.url);
  const closed = once(socket, 'close');
  try { const [event] = await closed; assert.equal(event.code, 1000); assert.equal(socket.readyState, Socket.CLOSED); }
  finally { await server.close(); }
});

test('unresponsive child is killed only by its own handle and closes only after exit', { timeout: 5_000 }, async () => {
  const child = new EventEmitter();
  child.connected = true; child.pid = 42;
  child.send = (_message, callback) => { callback?.(null); return true; };
  const kills = [];
  let exited = false;
  child.kill = signal => {
    kills.push(signal);
    if (signal === 'SIGKILL') { exited = true; child.emit('exit', null, signal); }
    return true;
  };
  const Socket = createProcessWebSocketClass({ forkImpl: () => child, graceMs: 1, killMs: 1 });
  const socket = new Socket('wss://example.invalid/?auth_token=FAKE_SECRET');
  child.emit('message', { type: 'open' });
  const closed = once(socket, 'close');
  socket.close();
  await closed;
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(exited, true);
  assert.equal(socket.readyState, 3);
});

test('an IPC close notification alone cannot claim a confirmed socket close', async () => {
  const child = new EventEmitter();
  child.connected = true; child.pid = 42;
  child.send = (_message, callback) => callback?.(null);
  child.kill = () => true;
  const Socket = createProcessWebSocketClass({ forkImpl: () => child });
  const socket = new Socket('wss://example.invalid/');
  let closed = false;
  socket.onclose = () => { closed = true; };
  child.emit('message', { type: 'closed', code: 1000, clean: true });
  assert.equal(socket.readyState, Socket.CLOSING);
  assert.equal(closed, false);
  child.emit('exit', 0, null);
  assert.equal(closed, true);
  assert.equal(socket.readyState, Socket.CLOSED);
});

test('worker exits if its parent IPC disconnects', { timeout: 10_000 }, async () => {
  const server = await fixture();
  const worker = fileURLToPath(new URL('../src/net/websocket-worker.mjs', import.meta.url));
  const child = fork(worker, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, NO_PROXY: '127.0.0.1' } });
  try {
    child.send({ type: 'start', url: server.url, protocols: [] });
    let opened = false;
    while (!opened) { const [message] = await once(child, 'message'); opened = message.type === 'open'; }
    const exited = once(child, 'exit');
    child.disconnect();
    const [code] = await exited;
    assert.equal(code, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await server.close();
  }
});
