import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./websocket-worker.mjs', import.meta.url));
const MAX_BYTES = 8 * 1024 * 1024;
const ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

function workerEnvironment() {
  const env = {};
  for (const key of ENV_KEYS) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  env.NO_PROXY = [...new Set(['localhost', '127.0.0.1', '[::1]', ...(env.NO_PROXY ?? env.no_proxy ?? '').split(',').filter(Boolean)])].join(',');
  return env;
}

function frame(data) {
  if (typeof data === 'string') return { binary: false, data, bytes: Buffer.byteLength(data) };
  if (data instanceof ArrayBuffer) {
    const copy = Buffer.from(new Uint8Array(data));
    return { binary: true, data: copy, bytes: copy.byteLength };
  }
  if (ArrayBuffer.isView(data)) {
    const copy = Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return { binary: true, data: copy, bytes: copy.byteLength };
  }
  throw new TypeError('Unsupported WebSocket frame.');
}

/** Bound aggregate IPC retention until send callbacks release each message. */
export function createBoundedIpcWriter(send, { onFailure, maxBytes = MAX_BYTES, maxMessages = 1024 } = {}) {
  if (typeof send !== 'function' || typeof onFailure !== 'function'
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new TypeError('Invalid IPC writer configuration.');
  let bytes = 0;
  let count = 0;
  let failed = false;
  const fail = () => { if (!failed) { failed = true; onFailure(); } };
  return (message, size = 256) => {
    if (failed) return false;
    if (!Number.isSafeInteger(size) || size < 0 || bytes + size > maxBytes || count >= maxMessages) { fail(); return false; }
    bytes += size; count++;
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true; bytes -= size; count--;
      if (error) fail();
    };
    try { send(message, done); return true; }
    catch { done(new Error('IPC delivery failed.')); return false; }
  };
}

/** Native WebSocket runs in one owned process; CLOSED means its process exited. */
export function createProcessWebSocketClass({ forkImpl = fork, workerPath = WORKER, graceMs = 500, killMs = 500 } = {}) {
  if (typeof forkImpl !== 'function' || !Number.isSafeInteger(graceMs) || graceMs < 1
    || !Number.isSafeInteger(killMs) || killMs < 1) throw new TypeError('Invalid WebSocket lifecycle configuration.');
  const ProcessWebSocket = class ProcessWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    #child;
    #state = 0;
    #buffered = 0;
    #closeTimer;
    #killTimer;
    #finished = false;
    #errorEmitted = false;
    #code = 1006;
    #clean = false;
    #protocol = '';
    #extensions = '';
    #binaryType = 'arraybuffer';
    #url;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;

    constructor(input, protocols = []) {
      super();
      let url;
      try { url = new URL(String(input)); } catch { throw new TypeError('Invalid WebSocket destination.'); }
      const requested = Array.isArray(protocols) ? protocols : [protocols];
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash
        || requested.length > 16 || requested.some(value => typeof value !== 'string' || value.length > 255)) {
        throw new TypeError('Invalid WebSocket destination.');
      }
      this.#url = url.href;
      this.#child = forkImpl(workerPath, [], {
        execPath: process.execPath,
        execArgv: process.allowedNodeEnvironmentFlags.has('--use-system-ca') ? ['--use-system-ca'] : [],
        env: workerEnvironment(), serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      this.#child.on('message', message => this.#receive(message));
      this.#child.once('exit', () => this.#finish());
      this.#child.once('error', () => {
        this.#emitError();
        if (!this.#child.pid) this.#finish();
        else this.#terminate();
      });
      this.#child.once('disconnect', () => { if (!this.#finished) this.#terminate(); });
      this.#post({ type: 'start', url: this.#url, protocols: requested });
    }

    get readyState() { return this.#state; }
    get bufferedAmount() { return this.#buffered; }
    get url() { return this.#url; }
    get protocol() { return this.#protocol; }
    get extensions() { return this.#extensions; }
    get binaryType() { return this.#binaryType; }
    set binaryType(value) { if (value === 'arraybuffer' || value === 'blob') this.#binaryType = value; }

    send(data) {
      if (this.#state !== 1) throw new DOMException('WebSocket is not open.', 'InvalidStateError');
      const value = frame(data);
      if (value.bytes > MAX_BYTES || this.#buffered + value.bytes > MAX_BYTES) {
        this.#emitError(); this.#terminate();
        throw new RangeError('WebSocket frame limit exceeded.');
      }
      this.#buffered += value.bytes;
      this.#post({ type: 'send', binary: value.binary, data: value.data }, () => { this.#buffered = Math.max(0, this.#buffered - value.bytes); });
    }

    close(code, reason = '') {
      if (code !== undefined && code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) throw new DOMException('Invalid WebSocket close code.', 'InvalidAccessError');
      if (Buffer.byteLength(String(reason)) > 123) throw new DOMException('WebSocket close reason is too long.', 'SyntaxError');
      if (this.#state >= 2) return;
      this.#state = 2;
      this.#post({ type: 'close', code, reason: String(reason) });
      this.#closeTimer = setTimeout(() => this.#terminate(), graceMs);
    }

    #post(message, completed) {
      if (this.#finished || !this.#child.connected) { completed?.(); return this.#terminate(); }
      try { this.#child.send(message, error => { completed?.(); if (error) { this.#emitError(); this.#terminate(); } }); }
      catch { completed?.(); this.#emitError(); this.#terminate(); }
    }

    #receive(message) {
      if (this.#finished || !message || typeof message !== 'object') return;
      if (message.type === 'open') {
        if (this.#state !== 0) return;
        this.#state = 1;
        this.#protocol = typeof message.protocol === 'string' ? message.protocol : '';
        this.#extensions = typeof message.extensions === 'string' ? message.extensions : '';
        this.#dispatch(new Event('open'));
      } else if (message.type === 'message' && this.#state === 1) {
        const data = message.data;
        if ((message.binary ? !Buffer.isBuffer(data) : typeof data !== 'string')
          || (message.binary ? data.byteLength : Buffer.byteLength(data)) > MAX_BYTES) return this.#terminate();
        const value = message.binary ? (this.#binaryType === 'blob' ? new Blob([data]) : new Uint8Array(data).buffer) : data;
        this.#dispatch(new MessageEvent('message', { data: value }));
      } else if (message.type === 'closed') {
        this.#code = Number.isInteger(message.code) && message.code >= 1000 && message.code <= 4999 ? message.code : 1006;
        this.#clean = message.clean === true;
        this.#state = 2;
        // The child exits after posting this notification. Never release on IPC alone.
        this.#armKill();
      } else if (message.type === 'error') {
        this.#emitError(); this.#terminate();
      }
    }

    #emitError() {
      if (this.#finished || this.#errorEmitted) return;
      this.#errorEmitted = true;
      const event = new Event('error');
      Object.defineProperty(event, 'error', { value: new Error('Native WebSocket operation failed.') });
      this.#dispatch(event);
    }

    #dispatch(event) {
      this.dispatchEvent(event);
      const handler = this[`on${event.type}`];
      if (typeof handler === 'function') {
        try { handler.call(this, event); } catch { this.#terminate(); }
      }
    }

    #terminate() {
      if (this.#finished) return;
      this.#state = 2;
      clearTimeout(this.#closeTimer);
      try { this.#child.kill('SIGTERM'); } catch {}
      this.#armKill();
    }

    #armKill() {
      if (this.#killTimer || this.#finished) return;
      this.#killTimer = setTimeout(() => { try { this.#child.kill('SIGKILL'); } catch {} }, killMs);
    }

    #finish() {
      if (this.#finished) return;
      this.#finished = true;
      clearTimeout(this.#closeTimer); clearTimeout(this.#killTimer);
      this.#state = 3;
      this.#buffered = 0;
      const event = new Event('close');
      Object.defineProperties(event, { code: { value: this.#code }, wasClean: { value: this.#clean }, reason: { value: '' } });
      this.#dispatch(event);
    }
  };
  for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Object.defineProperty(ProcessWebSocket.prototype, name, { value: ProcessWebSocket[name], enumerable: true });
  return ProcessWebSocket;
}
