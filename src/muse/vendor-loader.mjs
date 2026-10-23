import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const ASSET_NAME = /^[A-Za-z0-9_-]+\.js$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_PUBLIC_EXPORTS = new Set([
  'openNoiseConnection',
  'NoiseChannel',
  'resolveHttpRouteRequest',
  'isGatewayRequestError',
]);
const MAX_FACTORY_SOURCE_BYTES = 256 * 1024;
const MAX_EXPORT_TABLE_BYTES = 64 * 1024;
const MAX_FACTORY_EXECUTION_MS = 3_000;

export class VendorAssetsError extends Error {
  constructor() {
    super('needs_vendor_assets');
    this.name = 'VendorAssetsError';
    this.code = 'needs_vendor_assets';
  }
}

export class MissingPublicModuleError extends Error {
  constructor(id) {
    super(`Public module ${id} is not present in the local chunk set`);
    this.name = 'MissingPublicModuleError';
    this.code = 'public_module_missing';
    this.moduleId = id;
  }
}

export class MissingPublicExportError extends Error {
  constructor(name) {
    super(`Public export ${name} is not uniquely available in the local chunk set`);
    this.name = 'MissingPublicExportError';
    this.code = 'public_export_missing';
    this.exportName = name;
  }
}

export class UnsupportedRuntimeOperationError extends Error {
  constructor() {
    super('unsupported_runtime_operation');
    this.name = 'UnsupportedRuntimeOperationError';
    this.code = 'unsupported_runtime_operation';
  }
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return Object.freeze({
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(String(key)); },
    setItem(key, value) { values.set(String(key), String(value)); },
  });
}

function frozenWindow(localStorage, sessionStorage) {
  const location = Object.freeze({
    href: 'https://muse.ai/',
    origin: 'https://muse.ai',
    protocol: 'https:',
    host: 'muse.ai',
    hostname: 'muse.ai',
    port: '',
    pathname: '/',
    search: '',
    hash: '',
  });
  return Object.freeze({
    location,
    localStorage,
    sessionStorage,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
}

function safeConsole() {
  const noop = () => {};
  return Object.freeze({ debug: noop, error: noop, info: noop, log: noop, trace: noop, warn: noop });
}

/** Read only the compact export tables emitted by the public chunk runtime. */
export function declaredPublicExports(factory) {
  let source;
  try { source = Function.prototype.toString.call(factory); } catch { return new Set(); }
  if (Buffer.byteLength(source, 'utf8') > MAX_FACTORY_SOURCE_BYTES) return new Set();
  const names = new Set();
  // Turbopack's runtime.s call has alternating export-name/marker/value entries.
  // The bounded capture avoids parsing or executing arbitrary module bodies.
  const tables = /\.s\s*\(\s*\[([\s\S]{0,65536}?)\]\s*(?:,\s*\d+\s*)?\)/g;
  for (const table of source.matchAll(tables)) {
    const body = table[1];
    if (Buffer.byteLength(body, 'utf8') > MAX_EXPORT_TABLE_BYTES) continue;
    const entries = /(?:^|,)\s*(["'])([A-Za-z_$][\w$]*)\1\s*,\s*(?:\d+\s*,|function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
    for (const entry of body.matchAll(entries)) {
      if (REQUIRED_PUBLIC_EXPORTS.has(entry[2])) names.add(entry[2]);
    }
  }
  return names;
}

export function declaredPublicModuleIds(factory) {
  let source;
  try { source = Function.prototype.toString.call(factory); } catch { return new Set(); }
  if (Buffer.byteLength(source, 'utf8') > MAX_FACTORY_SOURCE_BYTES) return new Set();
  const ids = new Set();
  const tables = /\.s\s*\(\s*\[[\s\S]{0,65536}?\]\s*,\s*(\d+)\s*\)/g;
  for (const match of source.matchAll(tables)) {
    if (Number.isSafeInteger(Number(match[1]))) ids.add(Number(match[1]));
  }
  return ids;
}

/**
 * Loads only hash-pinned files from a prepared private vendor cache. The input
 * manifest is produced by prepareVendor; this loader validates it again before
 * reading any source into the isolated VM.
 */
export async function createPublicChunkLoader({
  crypto = globalThis.crypto,
  fetchImpl,
  WebSocketImpl,
  storage,
  assetsDirValidatedManifest,
  allowReviewedWasm = false,
  approvedDynamicChunks = {},
} = {}) {
  const assetsDir = assetsDirValidatedManifest?.assetsDirValidated;
  const expectedAssets = assetsDirValidatedManifest?.assets;
  if (typeof assetsDir !== 'string' || !path.isAbsolute(assetsDir) || path.resolve(assetsDir) !== assetsDir || !expectedAssets || Object.getPrototypeOf(expectedAssets) !== null) {
    throw new VendorAssetsError();
  }
  const resolvedAssets = assetsDir;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (WebSocketImpl !== undefined && typeof WebSocketImpl !== 'function') throw new TypeError('WebSocketImpl must be a constructor');
  if (storage !== undefined && (storage === null || Object.getPrototypeOf(storage) !== Object.prototype)) throw new TypeError('storage snapshot must be a plain object');
  const copyStorage = value => {
    if (value === undefined) return {};
    if (value === null || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('storage snapshot must be a plain object');
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string') throw new TypeError('storage snapshot values must be strings');
      copy[key] = item;
    }
    return copy;
  };
  const localStorage = memoryStorage(copyStorage(storage?.localStorage));
  const sessionStorage = memoryStorage(copyStorage(storage?.sessionStorage));
  if (assetsDirValidatedManifest.schema !== 1 || assetsDirValidatedManifest.origin !== 'https://muse.ai' || approvedDynamicChunks !== assetsDirValidatedManifest.dynamicChunks || !approvedDynamicChunks || Object.getPrototypeOf(approvedDynamicChunks) !== null) throw new VendorAssetsError();
  const declaredAssets = Object.entries(expectedAssets);
  if (declaredAssets.length === 0 || declaredAssets.some(([name, hash]) => !ASSET_NAME.test(name) || !SHA256.test(hash))) throw new VendorAssetsError();
  for (const [key, entry] of Object.entries(approvedDynamicChunks)) {
    if (!/^static\/chunks\/[A-Za-z0-9_-]+\.js$/.test(key) || !entry || Object.getPrototypeOf(entry) !== Object.prototype || !ASSET_NAME.test(entry.asset ?? '') || !Object.hasOwn(expectedAssets, entry.asset) || !Array.isArray(entry.moduleIds) || entry.moduleIds.some(id => !Number.isSafeInteger(id) || id < 0)) throw new VendorAssetsError();
  }
  const timerHandles = new Set();
  const trackedTimeout = (callback, delay, ...args) => {
    let handle;
    handle = setTimeout(() => { timerHandles.delete(handle); callback(...args); }, delay);
    timerHandles.add(handle);
    return handle;
  };
  const trackedInterval = (callback, delay, ...args) => {
    const handle = setInterval(callback, delay, ...args);
    timerHandles.add(handle);
    return handle;
  };
  const trackedClearTimeout = handle => { timerHandles.delete(handle); clearTimeout(handle); };
  const trackedClearInterval = handle => { timerHandles.delete(handle); clearInterval(handle); };

  const window = frozenWindow(localStorage, sessionStorage);
  const chunks = [];
  let registeringAssetName = null;
  const sandbox = {
    AbortController,
    AbortSignal,
    ArrayBuffer: globalThis.ArrayBuffer,
    BigInt64Array: globalThis.BigInt64Array,
    BigUint64Array: globalThis.BigUint64Array,
    Blob,
    DataView: globalThis.DataView,
    DOMException,
    Event,
    Headers,
    Int8Array: globalThis.Int8Array,
    Int16Array: globalThis.Int16Array,
    Int32Array: globalThis.Int32Array,
    ReadableStream,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    TransformStream,
    Uint8Array: globalThis.Uint8Array,
    Uint8ClampedArray: globalThis.Uint8ClampedArray,
    Uint16Array: globalThis.Uint16Array,
    Uint32Array: globalThis.Uint32Array,
    Float32Array: globalThis.Float32Array,
    Float64Array: globalThis.Float64Array,
    URL,
    URLSearchParams,
    WebAssembly: allowReviewedWasm ? WebAssembly : undefined,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    clearInterval: trackedClearInterval,
    clearTimeout: trackedClearTimeout,
    console: safeConsole(),
    crypto,
    document: Object.freeze({
      currentScript: null,
      documentElement: Object.freeze({ lang: 'en-US' }),
      addEventListener() {},
      removeEventListener() {},
    }),
    fetch: fetchImpl ?? (async () => { throw new Error('network_disabled'); }),
    performance,
    queueMicrotask,
    setInterval: trackedInterval,
    setTimeout: trackedTimeout,
    self: window,
    window,
  };
  sandbox.globalThis = sandbox;
  sandbox.location = window.location;
  sandbox.localStorage = window.localStorage;
  sandbox.sessionStorage = window.sessionStorage;
  sandbox.WebSocket = WebSocketImpl ?? class DisabledWebSocket {
    constructor() { throw new Error('network_disabled'); }
  };
  sandbox.TURBOPACK = Object.freeze({ push(chunk) { chunks.push({ chunk, asset: registeringAssetName }); return chunks.length; } });
  const context = vm.createContext(sandbox, { name: 'public-noise-chunk-inspector', codeGeneration: { strings: false, wasm: false } });

  let directoryStat;
  try {
    if (await realpath(resolvedAssets) !== resolvedAssets) throw new Error();
    directoryStat = await lstat(resolvedAssets);
  } catch { throw new VendorAssetsError(); }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700) throw new VendorAssetsError();

  const assetRecords = [];
  let totalBytes = 0;
  for (const [name, expectedHash] of declaredAssets.sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.join(resolvedAssets, name);
    let handle;
    let bytes;
    try {
      handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > MAX_ASSET_BYTES) throw new Error();
      bytes = await handle.readFile();
      if (bytes.byteLength !== stat.size || createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error();
    } catch {
      try { await handle?.close(); } catch {}
      throw new VendorAssetsError();
    }
    try { await handle.close(); } catch { throw new VendorAssetsError(); }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new VendorAssetsError();
    const source = bytes.toString('utf8');
    assetRecords.push({ name, sha256: expectedHash, bytes: bytes.byteLength });
    if (!source.includes('TURBOPACK')) continue;
    try {
      registeringAssetName = name;
      vm.runInContext(source, context, { filename: name, timeout: 3_000, displayErrors: false });
    } catch {
      throw new VendorAssetsError();
    } finally {
      registeringAssetName = null;
    }
  }

  const modules = new Map();
  const assetModuleIds = new Map();
  for (const registered of chunks) {
    const { chunk, asset } = registered;
    if (!Array.isArray(chunk)) continue;
    let pendingIds = [];
    for (const item of chunk.slice(1)) {
      if (Number.isSafeInteger(item)) {
        pendingIds.push(item);
      } else if (typeof item === 'function') {
        if (pendingIds.length > 0) {
          const record = { ids: [...pendingIds], factory: item, asset, declaredExports: declaredPublicExports(item) };
          const idsForAsset = assetModuleIds.get(asset) ?? new Set();
          for (const id of pendingIds) idsForAsset.add(id);
          assetModuleIds.set(asset, idsForAsset);
          for (const id of pendingIds) if (!modules.has(id)) modules.set(id, record);
        }
        pendingIds = [];
      }
    }
  }

  const namespaces = new Map();
  const state = new Map();
  const commonJsModules = new Set();
  const dependencyGraph = new Map();
  let currentGroup = [];
  let currentModuleId = null;
  let activeModuleObject = null;
  const factoryInvocationKey = `__museVendorFactory_${randomUUID().replaceAll('-', '')}`;

  const exportCandidates = new Map([...REQUIRED_PUBLIC_EXPORTS].map(name => [name, new Set()]));
  for (const record of new Set(modules.values())) {
    for (const name of record.declaredExports) exportCandidates.get(name)?.add(record);
  }

  function getExport(name) {
    if (!REQUIRED_PUBLIC_EXPORTS.has(name)) throw new MissingPublicExportError(name);
    const candidates = exportCandidates.get(name);
    if (!candidates || candidates.size !== 1) throw new MissingPublicExportError(name);
    const [record] = candidates;
    for (const id of record.ids) {
      let module;
      try { module = requireModule(id); } catch { continue; }
      if (typeof module?.[name] === 'function') return module[name];
    }
    throw new MissingPublicExportError(name);
  }

  function recordDependency(id) {
    const normalized = Number(id);
    if (currentGroup.length > 0) {
      for (const parent of currentGroup) {
        const edges = dependencyGraph.get(parent) ?? new Set();
        edges.add(normalized);
        dependencyGraph.set(parent, edges);
      }
    }
    return normalized;
  }

  const runtime = Object.freeze({
    g: vm.runInContext('globalThis', context),
    i(id) {
      const normalized = recordDependency(id);
      const module = requireModule(normalized);
      if (!commonJsModules.has(normalized)) return module;
      return Object.freeze(Object.assign(Object.create(null), module, { default: module }));
    },
    r(id) {
      return requireModule(recordDependency(id));
    },
    s(exports, id = currentModuleId ?? currentGroup[0]) {
      const normalized = Number(id);
      const namespace = namespaces.get(normalized) ?? Object.create(null);
      namespaces.set(normalized, namespace);
      if (!Array.isArray(exports)) throw new TypeError(`Unsupported export table for module ${normalized}`);
      for (let index = 0; index < exports.length;) {
        const name = exports[index++];
        if (typeof name !== 'string' || index >= exports.length) continue;
        const marker = exports[index++];
        if (typeof marker === 'number') {
          if (index >= exports.length) continue;
          Object.defineProperty(namespace, name, { value: exports[index++], enumerable: true, configurable: true });
        } else if (typeof marker === 'function') {
          Object.defineProperty(namespace, name, { get: marker, enumerable: true, configurable: true });
        }
      }
    },
    A(id) {
      try {
        const loaded = requireModule(Number(id));
        return Promise.resolve(typeof loaded === 'function' ? loaded() : loaded);
      }
      catch (error) { return Promise.reject(error); }
    },
    v(loadModule) {
      if (typeof loadModule !== 'function' || !activeModuleObject) throw new UnsupportedRuntimeOperationError();
      activeModuleObject.exports = () => loadModule((id) => requireModule(id));
    },
    l(chunkPath) {
      const entry = approvedDynamicChunks[chunkPath];
      if (!entry || !assetRecords.some(asset => asset.name === entry.asset) || !Array.isArray(entry.moduleIds) || !entry.moduleIds.every(id => assetModuleIds.get(entry.asset)?.has(id))) {
        return Promise.reject(new UnsupportedRuntimeOperationError());
      }
      return Promise.resolve();
    },
  });

  function requireModule(id) {
    const normalized = Number(id);
    if (!Number.isSafeInteger(normalized)) throw new MissingPublicModuleError(id);
    const existing = namespaces.get(normalized);
    if (state.get(normalized) === 'loaded') return existing;
    if (state.get(normalized) === 'loading') return existing ?? Object.create(null);
    const record = modules.get(normalized);
    if (!record) {
      if (existing && Object.keys(existing).length > 0) return existing;
      throw new MissingPublicModuleError(normalized);
    }

    for (const member of record.ids) {
      if (!namespaces.has(member)) namespaces.set(member, Object.create(null));
      if (!state.has(member)) state.set(member, 'loading');
    }
    const previousGroup = currentGroup;
    const previousModuleId = currentModuleId;
    const previousModuleObject = activeModuleObject;
    currentGroup = record.ids;
    currentModuleId = normalized;
    try {
      const moduleObject = { exports: namespaces.get(normalized) };
      activeModuleObject = moduleObject;
      const previousInvocation = Object.getOwnPropertyDescriptor(context, factoryInvocationKey);
      Object.defineProperty(context, factoryInvocationKey, {
        value: { factory: record.factory, runtime, moduleObject },
        configurable: true,
        enumerable: false,
        writable: false,
      });
      try {
        vm.runInContext(`(() => { const current = globalThis[${JSON.stringify(factoryInvocationKey)}]; current.factory(current.runtime, current.moduleObject, current.moduleObject.exports); })()`, context, {
          timeout: MAX_FACTORY_EXECUTION_MS,
          displayErrors: false,
        });
      } finally {
        const currentInvocation = Object.getOwnPropertyDescriptor(context, factoryInvocationKey);
        if (!currentInvocation?.configurable) throw new VendorAssetsError();
        if (previousInvocation) Object.defineProperty(context, factoryInvocationKey, previousInvocation);
        else delete context[factoryInvocationKey];
      }
      if (moduleObject.exports !== namespaces.get(normalized)) {
        namespaces.set(normalized, moduleObject.exports);
        commonJsModules.add(normalized);
      }
      for (const member of record.ids) state.set(member, 'loaded');
    } catch (error) {
      for (const member of record.ids) state.delete(member);
      throw error;
    } finally {
      currentGroup = previousGroup;
      currentModuleId = previousModuleId;
      activeModuleObject = previousModuleObject;
    }

    const namespace = namespaces.get(normalized);
    if (namespace === undefined || namespace === null) throw new MissingPublicModuleError(normalized);
    return namespace;
  }

  return Object.freeze({
    assets: Object.freeze(assetRecords.map(record => Object.freeze(record))),
    getModule(id) { return requireModule(Number(id)); },
    getExport,
    getModuleAsset(id) { return modules.get(Number(id))?.asset ?? null; },
    getAvailableModuleIds() { return Object.freeze([...modules.keys()].sort((a, b) => a - b)); },
    getDependencyGraph() {
      return Object.freeze(Object.fromEntries([...dependencyGraph].map(([id, edges]) => [id, Object.freeze([...edges].sort((a, b) => a - b))])));
    },
    getMissingDynamicModule(id) {
      try {
        const module = requireModule(Number(id));
        return typeof module === 'function' ? Object.freeze({ id: Number(id), code: 'unsupported_runtime_operation' }) : null;
      }
      catch { return Object.freeze({ id: Number(id), code: 'unsupported_runtime_operation' }); }
    },
    loadDynamicModule(id) { return runtime.A(Number(id)); },
    sandboxCapabilities: Object.freeze({
      hasProcess: false,
      hasRequire: false,
      hasFilesystem: false,
      fetch: fetchImpl ? 'trusted injection' : 'throws network_disabled',
      websocket: WebSocketImpl ? 'trusted injection' : 'throws network_disabled',
      storage: 'isolated in-memory only',
      console: 'no-op',
      wasmCompilation: allowReviewedWasm ? 'enabled for reviewed public assets' : 'disabled',
    }),
    getSandboxGlobals() {
      return Object.freeze(vm.runInContext(`({ process: typeof process, require: typeof require, module: typeof module, fetch: typeof fetch, WebSocket: typeof WebSocket, WebAssembly: typeof WebAssembly, crypto: typeof crypto, ArrayBuffer: ArrayBuffer === globalThis.ArrayBuffer, Uint8Array: Uint8Array === globalThis.Uint8Array, locationOrigin: location.origin })`, context));
    },
    async verifyNetworkDisabled() {
      const fetchError = await vm.runInContext(`fetch('https://muse.ai/').then(() => 'unexpected_success', error => error.message)`, context);
      const webSocketError = vm.runInContext(`(() => { try { new WebSocket('wss://muse.ai/'); return 'unexpected_success'; } catch (error) { return error.message; } })()`, context);
      return Object.freeze({ fetchError, webSocketError });
    },
    getStorageSnapshot() {
      const snapshot = storage => Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index);
        return [key, storage.getItem(key)];
      }));
      return Object.freeze({ localStorage: Object.freeze(snapshot(localStorage)), sessionStorage: Object.freeze(snapshot(sessionStorage)) });
    },
    close() {
      for (const handle of timerHandles) {
        clearTimeout(handle);
        clearInterval(handle);
      }
      timerHandles.clear();
    },
  });
}
