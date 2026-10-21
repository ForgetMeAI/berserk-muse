import { EnvHttpProxyAgent } from 'undici';
import { createProcessWebSocketClass } from './websocket-process.mjs';

const LOCAL_NO_PROXY = ['localhost', '127.0.0.1', '[::1]'];
const SOCKET_CLOSE_TIMEOUT_MS = 5000;
const DESTROY_TIMEOUT_MS = 250;

export class NetworkCleanupError extends Error {
  constructor() {
    super('Network runtime cleanup failed.');
    this.name = 'NetworkCleanupError';
    this.code = 'network_cleanup_failed';
  }
}

function noProxyValue() {
  const configured = [process.env.no_proxy, process.env.NO_PROXY]
    .filter(value => typeof value === 'string' && value.trim())
    .flatMap(value => value.split(/[\s,]+/).filter(Boolean));
  return [...new Set([...configured, ...LOCAL_NO_PROXY])].join(',');
}

function isClosed(socket, WebSocketImpl) {
  return socket.readyState === WebSocketImpl.CLOSED || socket.readyState === 3;
}

function closeSocket(socket, WebSocketImpl) {
  if (isClosed(socket, WebSocketImpl)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => socket.removeEventListener?.('close', onClose);
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    if (typeof socket.addEventListener !== 'function') {
      reject(new NetworkCleanupError());
      return;
    }
    socket.addEventListener('close', onClose, { once: true });
    if (isClosed(socket, WebSocketImpl)) {
      onClose();
      return;
    }
    try {
      socket.close();
    } catch {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new NetworkCleanupError());
      }
    }
  });
}

async function destroyDispatcher(dispatcher) {
  if (typeof dispatcher?.destroy !== 'function') return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => dispatcher.destroy()),
      new Promise(resolve => { timer = setTimeout(resolve, DESTROY_TIMEOUT_MS); }),
    ]);
  } catch {
    // Cleanup errors are deliberately replaced with the typed public error.
  } finally {
    clearTimeout(timer);
  }
}

export function createNetworkRuntime({
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  dispatcher: providedDispatcher,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('A WebSocket implementation is required.');

  const dispatcher = providedDispatcher ?? new EnvHttpProxyAgent({
    allowH2: false,
    noProxy: noProxyValue(),
  });
  const sockets = new Set();
  const isolatedWebSocket = WebSocketImpl === globalThis.WebSocket;
  const SocketBase = isolatedWebSocket ? createProcessWebSocketClass() : WebSocketImpl;

  const runtimeFetch = (input, init = undefined) => {
    const options = init == null ? {} : { ...init };
    options.dispatcher = dispatcher;
    return fetchImpl(input, options);
  };

  class RuntimeWebSocket extends SocketBase {
    constructor(url, protocols = []) {
      const normalizedProtocols = Array.isArray(protocols) ? protocols : [protocols];
      if (isolatedWebSocket) super(url, normalizedProtocols);
      else super(url, { protocols: normalizedProtocols, dispatcher });
      sockets.add(this);
      this.addEventListener('close', () => sockets.delete(this), { once: true });
    }
  }

  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      let timeoutId;
      const shutdown = (async () => {
        await Promise.all([...sockets].map(socket => closeSocket(socket, WebSocketImpl)));
        sockets.clear();
        if (typeof dispatcher?.close === 'function') await dispatcher.close();
        else if (typeof dispatcher?.destroy === 'function') await dispatcher.destroy();
      })();
      const timedOut = Symbol('network-cleanup-timeout');
      let result;
      try {
        result = await Promise.race([
          shutdown,
          new Promise(resolve => { timeoutId = setTimeout(() => resolve(timedOut), SOCKET_CLOSE_TIMEOUT_MS); }),
        ]);
      } catch {
        await destroyDispatcher(dispatcher);
        throw new NetworkCleanupError();
      } finally {
        clearTimeout(timeoutId);
      }
      if (result === timedOut) {
        void shutdown.catch(() => {});
        await destroyDispatcher(dispatcher);
        throw new NetworkCleanupError();
      }
    })();
    return closePromise;
  };

  return { fetchImpl: runtimeFetch, WebSocketImpl: RuntimeWebSocket, close };
}
