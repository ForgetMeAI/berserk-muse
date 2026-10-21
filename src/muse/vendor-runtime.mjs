import {
  createPublicChunkLoader,
  MissingPublicModuleError,
  UnsupportedRuntimeOperationError,
} from './vendor-loader.mjs';

const MUSE_ORIGIN = 'https://muse.ai';
const NOISE_WS_ORIGIN = 'wss://hatch.metaaivm.com';
const NOISE_WS_PATH = '/v1/noise';
const NOISE_REQUIRED_QUERY = new Set(['vm_id', 'auth_token', 'app_id', 'request_id']);
const NOISE_OPTIONAL_QUERY = new Set(['notary_token', 'atod_token']);
export const NOISE_CHANNEL_MODULE_ID = 759572;
const FETCH_PATHS = new Map([
  ['/api/hatch/token', new Set(['POST'])],
  ['/api/hatch/noise-notary-token', new Set(['POST'])],
  ['/api/session', new Set(['GET'])],
  ['/api/auth/check', new Set(['POST'])],
]);

export class NoiseRuntimeError extends Error {
  constructor(code) {
    const messages = {
      needs_vendor_assets: 'Reviewed public vendor chunks are unavailable',
      runtime_aborted: 'Noise runtime operation was aborted',
      noise_runtime_failed: 'Noise runtime operation failed',
      runtime_closed: 'Noise runtime is closed',
      runtime_quarantined: 'Noise runtime shutdown did not settle safely',
      fetch_not_injected: 'Noise runtime fetch is unavailable',
      websocket_not_injected: 'Noise runtime WebSocket is unavailable',
    };
    super(messages[code] ?? messages.noise_runtime_failed);
    this.name = 'NoiseRuntimeError';
    this.code = Object.hasOwn(messages, code) ? code : 'noise_runtime_failed';
  }
}

function safeFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') return async () => { throw new NoiseRuntimeError('fetch_not_injected'); };
  return async (input, init = {}) => {
    let rawUrl;
    try {
      rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      if (typeof rawUrl !== 'string') throw new Error();
      const target = new URL(rawUrl, MUSE_ORIGIN);
      const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
      if (target.origin !== MUSE_ORIGIN || target.username || target.password || target.hash || target.search || !FETCH_PATHS.get(target.pathname)?.has(method)) throw new Error();
      if (init.redirect && init.redirect !== 'manual') throw new Error();
      const forwarded = { ...init, method, redirect: 'manual' };
      if (input && typeof input === 'object' && !(input instanceof URL)) {
        forwarded.headers ??= input.headers;
        forwarded.body ??= input.body;
        forwarded.signal ??= input.signal;
      }
      const response = await fetchImpl(target.href, forwarded);
      if (response?.redirected || response?.status >= 300 && response.status < 400) throw new Error();
      return response;
    } catch {
      throw new NoiseRuntimeError('noise_runtime_failed');
    }
  };
}

function sanitizeOpenError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return new NoiseRuntimeError('runtime_aborted');
  if (error instanceof MissingPublicModuleError || error instanceof UnsupportedRuntimeOperationError || error?.code === 'public_module_missing' || error?.code === 'unsupported_runtime_operation') {
    return new NoiseRuntimeError('needs_vendor_assets');
  }
  let cause = error;
  for (let depth = 0; cause && depth < 4; depth++, cause = cause.cause) {
    if (typeof cause.stack === 'string' && cause.stack.includes('0d_m8vbe2zoy9.js')) return new NoiseRuntimeError('needs_vendor_assets');
  }
  return new NoiseRuntimeError('noise_runtime_failed');
}

function validNoiseWebSocketUrl(input) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : '';
    if (!raw || raw.length > 32_768) return false;
    const target = new URL(raw);
    if (target.origin !== NOISE_WS_ORIGIN || target.protocol !== 'wss:' || target.pathname !== NOISE_WS_PATH
      || target.username || target.password || target.hash || target.port) return false;
    const seen = new Set();
    for (const [key, value] of target.searchParams) {
      if ((!NOISE_REQUIRED_QUERY.has(key) && !NOISE_OPTIONAL_QUERY.has(key)) || seen.has(key)
        || value.length < 1 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return false;
      seen.add(key);
    }
    for (const key of NOISE_REQUIRED_QUERY) if (!seen.has(key)) return false;
    if ((target.searchParams.get('vm_id') ?? '').length > 255) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the public official Noise client using only the validated prepared
 * asset cache and narrowly allowlisted Muse endpoints.
 */
export async function createNoiseRuntime({
  fetchImpl,
  WebSocketImpl,
  storage,
  assetsDirValidatedManifest,
  loaderFactory = createPublicChunkLoader,
} = {}) {
  const manifest = assetsDirValidatedManifest;
  if (!manifest || typeof manifest.assetsDirValidated !== 'string') throw new NoiseRuntimeError('needs_vendor_assets');
  if (typeof loaderFactory !== 'function') throw new TypeError('loaderFactory must be a function');
  const sockets = new Map();
  const controllers = new Set();
  let closed = false;
  let closePromise = null;
  const injectedFetch = safeFetch(fetchImpl);
  const InjectedWebSocket = WebSocketImpl ?? class MissingWebSocket {
    constructor() { throw new NoiseRuntimeError('websocket_not_injected'); }
  };
  if (typeof InjectedWebSocket !== 'function') throw new TypeError('WebSocketImpl must be a constructor');
  class TrackedWebSocket {
    constructor(...args) {
      if (args.length !== 1 || !validNoiseWebSocketUrl(args[0])) throw new NoiseRuntimeError('noise_runtime_failed');
      const socket = new InjectedWebSocket(...args);
      let resolveClosed;
      const closed = new Promise(resolve => { resolveClosed = resolve; });
      const finish = () => {
        sockets.delete(socket);
        resolveClosed();
      };
      sockets.set(socket, { closed, finish });
      try { socket.addEventListener?.('close', finish, { once: true }); } catch {}
      return socket;
    }
  }
  for (const [name, fallback] of [['CONNECTING', 0], ['OPEN', 1], ['CLOSING', 2], ['CLOSED', 3]]) {
    Object.defineProperty(TrackedWebSocket, name, {
      value: Number.isInteger(InjectedWebSocket[name]) ? InjectedWebSocket[name] : fallback,
      enumerable: true,
    });
  }
  let loader;
  try {
    loader = await loaderFactory({
      fetchImpl: injectedFetch,
      WebSocketImpl: TrackedWebSocket,
      storage,
      assetsDirValidatedManifest: manifest,
      approvedDynamicChunks: manifest.dynamicChunks,
      allowReviewedWasm: true,
    });
  } catch {
    throw new NoiseRuntimeError('needs_vendor_assets');
  }

  function getModule(id) {
    if (closed) throw new NoiseRuntimeError('runtime_closed');
    try { return loader.getModule(id); }
    catch (error) { throw sanitizeOpenError(error); }
  }

  async function open(gatewayUrl, { vmName, signal, credentialProvider } = {}) {
    if (closed) throw new NoiseRuntimeError('runtime_closed');
    if (!fetchImpl) throw new NoiseRuntimeError('fetch_not_injected');
    if (!WebSocketImpl) throw new NoiseRuntimeError('websocket_not_injected');
    let target;
    try { target = new URL(gatewayUrl); } catch { throw new NoiseRuntimeError('noise_runtime_failed'); }
    if (!['https:', 'wss:'].includes(target.protocol) || !target.hostname.endsWith('.metaaivm.com') || target.port && target.port !== '443' || target.pathname !== '/' || target.search || target.username || target.password || target.hash) {
      throw new NoiseRuntimeError('noise_runtime_failed');
    }
    if (signal !== undefined && (!(signal instanceof AbortSignal) || typeof signal.addEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal');
    if (vmName !== undefined && typeof vmName !== 'string') throw new TypeError('vmName must be a string');
    if (credentialProvider !== undefined && (!credentialProvider || typeof credentialProvider.getToken !== 'function' || typeof credentialProvider.getNoiseNotaryToken !== 'function')) {
      throw new TypeError('credentialProvider does not implement the Noise credential provider contract');
    }

    const controller = new AbortController();
    controllers.add(controller);
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const options = { signal: combinedSignal };
    if (typeof vmName === 'string') options.vmName = vmName;
    if (credentialProvider) options.credentialProvider = credentialProvider;
    try {
      const connect = getModule(499475).openNoiseConnection;
      const connection = await connect(target.href, options);
      if (closed || combinedSignal.aborted) {
        try { connection?.ws?.close(); } catch {}
        throw new NoiseRuntimeError('runtime_aborted');
      }
      // Return the opaque official connection only to the in-process adapter.
      return connection;
    } catch (error) {
      controller.abort();
      controllers.delete(controller);
      throw error instanceof NoiseRuntimeError ? error : sanitizeOpenError(error);
    }
  }

  return Object.freeze({
    open,
    getModule,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const controller of controllers) controller.abort();
        controllers.clear();
        const pending = [...sockets.entries()];
        for (const [socket, entry] of pending) {
          if (socket.readyState === TrackedWebSocket.CLOSED) {
            entry.finish();
            continue;
          }
          try { socket.close(); } catch {}
        }
        loader.close();
        if (pending.length === 0) return;
        let timeout;
        const timedOut = new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new NoiseRuntimeError('runtime_quarantined')), 5_000);
        });
        try {
          await Promise.race([Promise.all(pending.map(([, entry]) => entry.closed)), timedOut]);
        } finally {
          clearTimeout(timeout);
        }
      })();
      return closePromise;
    },
  });
}
