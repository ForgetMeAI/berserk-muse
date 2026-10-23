import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { prepareVendor } from './vendor-cache.mjs';
import { createPublicChunkLoader, declaredPublicExports, declaredPublicModuleIds } from './vendor-loader.mjs';

const ORIGIN = 'https://muse.ai';
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_SCRIPT_COUNT = 180;
const MAX_MODULE_COUNT = 2048;
const MAX_SHELL_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 20_000;
const MAX_METADATA_MS = 150;
const SHELL_DRIFT_TTL_MS = 10 * 60 * 1000;
const SEMANTIC_EXPORTS = Object.freeze(['openNoiseConnection', 'NoiseChannel', 'resolveHttpRouteRequest', 'isGatewayRequestError']);
const CHUNK_PATH = /^static\/chunks\/[A-Za-z0-9_-]+\.js$/;

function fail(code) { const error = new Error(code); error.code = code; return error; }

function publicChunkUrl(raw, base = ORIGIN) {
  if (typeof raw !== 'string' || raw.length > 2048) throw fail('vendor_discovery_invalid_shell');
  let url;
  try { url = new URL(raw, base); } catch { throw fail('vendor_discovery_invalid_shell'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || !/^\/_next\/static\/chunks\/[A-Za-z0-9_-]+\.js$/.test(url.pathname)) {
    throw fail('vendor_discovery_invalid_shell');
  }
  const params = [...url.searchParams.entries()];
  if (params.some(([key]) => key !== 'dpl') || params.length > 1 || (params.length === 1 && !/^dpl_[A-Za-z0-9_-]{1,128}$/.test(params[0][1]))) {
    throw fail('vendor_discovery_invalid_shell');
  }
  return url.href;
}

function scriptUrlsFromShell(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_SHELL_BYTES) throw fail('vendor_discovery_invalid_shell');
  const found = new Set();
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi)) {
    let parsed;
    try { parsed = new URL(match[2], ORIGIN); } catch { continue; }
    if (parsed.origin !== ORIGIN || !/^\/_next\/static\/chunks\/[A-Za-z0-9_-]+\.js$/.test(parsed.pathname)) continue;
    found.add(publicChunkUrl(parsed.href));
  }
  if (found.size === 0 || found.size > MAX_SCRIPT_COUNT) throw fail('vendor_discovery_script_limit');
  return [...found];
}

function shellAddsUnlockedPath(lock, html) {
  const lockedUrls = new Set(lock.assets.map(asset => new URL(asset.url).href));
  return scriptUrlsFromShell(html).some(url => !lockedUrls.has(new URL(url).href));
}

async function readBounded(response, signal) {
  if (response.status === 404 || response.status === 410) throw fail('vendor_asset_stale');
  if (response.status !== 200 || response.redirected) throw fail('vendor_discovery_fetch_rejected');
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_ASSET_BYTES)) throw fail('vendor_asset_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) throw fail('vendor_discovery_fetch_rejected');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw fail('vendor_download_aborted');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ASSET_BYTES) { await reader.cancel().catch(() => {}); throw fail('vendor_asset_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock?.(); }
  if (size < 1) throw fail('vendor_discovery_fetch_rejected');
  return Buffer.concat(chunks, size);
}

async function fetchAsset(url, fetchImpl, signal) {
  if (signal?.aborted) throw fail('vendor_download_aborted');
  const timeout = AbortSignal.timeout(MAX_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: combined });
    const bytes = await readBounded(response, combined);
    return {
      fileName: path.basename(new URL(url).pathname), url,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength,
      content: bytes,
    };
  } catch (error) {
    if (signal?.aborted || combined.aborted) throw fail('vendor_download_aborted');
    throw error?.code ? error : fail('vendor_discovery_fetch_failed');
  }
}

function makeMetadataContext() {
  const chunks = [];
  const noop = () => {};
  const context = vm.createContext({
    TURBOPACK: Object.freeze({ push(chunk) { chunks.push(chunk); return chunks.length; } }),
    console: Object.freeze({ debug: noop, error: noop, info: noop, log: noop, trace: noop, warn: noop }),
    document: Object.freeze({ currentScript: null, documentElement: Object.freeze({ lang: 'en-US' }) }),
    fetch: async () => { throw new Error('network_disabled'); },
    WebSocket: class { constructor() { throw new Error('network_disabled'); } },
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  }, { name: 'muse-public-chunk-metadata', codeGeneration: { strings: false, wasm: false } });
  context.globalThis = context;
  context.self = context;
  context.window = context;
  context.location = Object.freeze({ origin: ORIGIN, href: `${ORIGIN}/`, protocol: 'https:', host: 'muse.ai', hostname: 'muse.ai', pathname: '/', search: '', hash: '' });
  return { context, chunks };
}

function captureAssetModules(asset, moduleRecords, virtualIds) {
  const { context, chunks } = makeMetadataContext();
  try { vm.runInContext(asset.content.toString('utf8'), context, { filename: asset.fileName, timeout: MAX_METADATA_MS, displayErrors: false }); }
  catch { throw fail('vendor_discovery_metadata_failed'); }
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    let ids = [];
    for (const item of chunk.slice(1)) {
      if (Number.isSafeInteger(item)) ids.push(item);
      else if (typeof item === 'function') {
        if (ids.length) {
          const record = { ids: [...ids], factory: item, asset: asset.fileName, source: Function.prototype.toString.call(item) };
          for (const id of ids) if (!moduleRecords.has(id)) moduleRecords.set(id, record);
          for (const alias of declaredPublicModuleIds(item)) virtualIds.add(alias);
        }
        ids = [];
      }
    }
  }
}

function moduleDependencies(source) {
  const ids = new Set();
  for (const match of source.matchAll(/\.\s*(?:i|r|A)\s*\(\s*(\d+)/g)) ids.add(Number(match[1]));
  return ids;
}

function dynamicLoadInfo(source) {
  if (!/\.v\s*\(/.test(source)) return { paths: [], moduleIds: [] };
  const paths = new Set([...source.matchAll(/["'](static\/chunks\/[A-Za-z0-9_-]+\.js)["']/g)].map(match => match[1]));
  const moduleIds = new Set([...source.matchAll(/\.then\(\s*\(\s*\)\s*=>\s*[A-Za-z_$][\w$]*\(\s*(\d+)\s*\)\s*\)/g)].map(match => Number(match[1])));
  if (paths.size === 0 && moduleIds.size === 0) return { paths: [], moduleIds: [] };
  if (paths.size === 0 || moduleIds.size === 0) throw fail('vendor_discovery_dynamic_unresolved');
  for (const chunkPath of paths) if (!CHUNK_PATH.test(chunkPath)) throw fail('vendor_discovery_dynamic_unresolved');
  return { paths: [...paths], moduleIds: [...moduleIds] };
}

function semanticCandidates(moduleRecords) {
  const candidates = new Map(SEMANTIC_EXPORTS.map(name => [name, new Set()]));
  for (const record of new Set(moduleRecords.values())) {
    for (const name of declaredPublicExports(record.factory)) candidates.get(name)?.add(record);
  }
  for (const [name, records] of candidates) if (records.size !== 1) throw fail('vendor_discovery_semantic_contract');
  return new Map([...candidates].map(([name, records]) => [name, [...records][0]]));
}

/** Discover only shell scripts and async chunks reachable from the required semantic module closure. */
async function discoverVendorSnapshot({ shellHtml, getShell, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (signal !== undefined && (!(signal instanceof AbortSignal) || typeof signal.addEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal');
  if (signal?.aborted) throw fail('vendor_download_aborted');
  if (shellHtml === undefined) {
    if (typeof getShell !== 'function') throw fail('vendor_discovery_shell_unavailable');
    shellHtml = await getShell({ signal });
  }
  const initialUrls = scriptUrlsFromShell(shellHtml);
  const assetsByName = new Map();
  const urls = new Set(initialUrls);
  const moduleRecords = new Map();
  const virtualIds = new Set();
  let totalBytes = 0;

  async function addAsset(url) {
    const name = path.basename(new URL(url).pathname);
    if (assetsByName.has(name)) return;
    if (assetsByName.size >= MAX_SCRIPT_COUNT) throw fail('vendor_discovery_script_limit');
    const asset = await fetchAsset(url, fetchImpl, signal);
    totalBytes += asset.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw fail('manifest_too_large');
    assetsByName.set(name, asset);
    captureAssetModules(asset, moduleRecords, virtualIds);
  }

  let nextUrl = 0;
  const workers = Array.from({ length: 3 }, async () => {
    while (nextUrl < initialUrls.length) {
      if (signal?.aborted) throw fail('vendor_download_aborted');
      const url = initialUrls[nextUrl++];
      await addAsset(url);
    }
  });
  const initialResults = await Promise.allSettled(workers);
  const initialFailure = initialResults.find(result => result.status === 'rejected');
  if (initialFailure) throw initialFailure.reason;

  const candidates = semanticCandidates(moduleRecords);
  const pendingModules = [...new Set([...candidates.values()].flatMap(record => record.ids))];
  const seenModules = new Set();
  const dynamicChunks = {};
  while (pendingModules.length) {
    if (signal?.aborted) throw fail('vendor_download_aborted');
    const id = pendingModules.pop();
    if (seenModules.has(id)) continue;
    seenModules.add(id);
    if (seenModules.size > MAX_MODULE_COUNT) throw fail('vendor_discovery_module_limit');
    const record = moduleRecords.get(id);
    if (!record) {
      if (virtualIds.has(id)) continue;
      throw fail('vendor_discovery_incomplete_closure');
    }
    for (const dependency of moduleDependencies(record.source)) pendingModules.push(dependency);
    const dynamic = dynamicLoadInfo(record.source);
    for (const dynamicId of dynamic.moduleIds) pendingModules.push(dynamicId);
    const missingPaths = dynamic.paths.filter(chunkPath => !Object.hasOwn(dynamicChunks, chunkPath));
    for (const chunkPath of missingPaths) {
      const url = publicChunkUrl(`/_next/${chunkPath}`);
      urls.add(url);
      await addAsset(url);
      const assetName = path.basename(new URL(url).pathname);
      const idsForAsset = [...new Set([...moduleRecords.values()].filter(item => item.asset === assetName).flatMap(item => item.ids))].sort((a, b) => a - b);
      dynamicChunks[chunkPath] = { asset: assetName, moduleIds: idsForAsset };
    }
  }

  const records = [...assetsByName.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const assets = records.map(({ content: _content, ...asset }) => asset);
  return {
    lock: { schema: 1, origin: ORIGIN, assets, dynamicChunks },
    contents: new Map(records.map(record => [record.url, record.content])),
  };
}

export async function discoverVendorLock(options = {}) {
  return (await discoverVendorSnapshot(options)).lock;
}

async function ensurePrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw fail('unsafe_cache_directory'); }
    let stat;
    try { stat = await lstat(current); } catch { throw fail('unsafe_cache_directory'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('unsafe_cache_directory');
  }
  await chmod(absolute, 0o700);
  return absolute;
}

function generationKey(lock) {
  const assets = lock.assets.map(asset => ({
    fileName: asset.fileName,
    url: asset.url,
    sha256: asset.sha256,
    bytes: asset.bytes,
  })).sort((a, b) => a.fileName.localeCompare(b.fileName));
  const dynamicChunks = Object.fromEntries(Object.entries(lock.dynamicChunks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, record]) => [name, {
      asset: record.asset,
      moduleIds: [...record.moduleIds].sort((a, b) => a - b),
    }]));
  return createHash('sha256').update(JSON.stringify({ schema: lock.schema, origin: lock.origin, assets, dynamicChunks })).digest('hex');
}

async function readStoredLock(file) {
  let handle;
  try { handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (error.code === 'ENOENT') return null; if (error.code === 'ELOOP') throw fail('unsafe_vendor_lock'); return null; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o777) !== 0o600) throw fail('unsafe_vendor_lock');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) { if (error?.code === 'unsafe_vendor_lock') throw error; return null; }
  finally { await handle.close(); }
}

async function writeStoredLock(directory, lock) {
  await ensurePrivateDirectory(directory);
  const target = path.join(directory, 'active-lock.json');
  const temporary = path.join(directory, `.active-lock-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(JSON.stringify(lock));
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, target);
  } catch {
    try { await handle?.close(); } catch {}
    try { await unlink(temporary); } catch {}
    throw fail('vendor_lock_write_failed');
  }
}

async function verifySemanticContract(prepared) {
  let loader;
  try {
    loader = await createPublicChunkLoader({ assetsDirValidatedManifest: prepared, approvedDynamicChunks: prepared.dynamicChunks });
    for (const name of SEMANTIC_EXPORTS) if (typeof loader.getExport(name) !== 'function') throw fail('vendor_discovery_semantic_contract');
  } catch { throw fail('vendor_discovery_semantic_contract'); }
  finally { try { loader?.close(); } catch {} }
}

/**
 * Return a resolver that repairs one stale lock using an authenticated shell
 * callback and an unauthenticated, hash-pinned public asset graph.
 */
export function createVendorResolver({ cacheDir, lock, now = Date.now } = {}) {
  if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir)) throw new TypeError('cacheDir must be absolute');
  if (!lock || typeof lock !== 'object') throw new TypeError('A bundled vendor lock is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  let cached = null;
  let cachedLock = null;
  let lastShellCheckAt = null;
  let inFlight = null;
  async function runVendorResolution({ signal, getShell, fetchImpl, shellCheckDue }) {
    await ensurePrivateDirectory(cacheDir);
    const stored = await readStoredLock(path.join(cacheDir, 'active-lock.json'));
    let selectedLock = cachedLock ?? stored ?? lock;
    let shellHtml;
    let checkedShell = false;
    let snapshot = null;
    if (shellCheckDue) {
      shellHtml = await getShell({ signal });
      checkedShell = true;
      if (shellAddsUnlockedPath(selectedLock, shellHtml)) {
        snapshot = await discoverVendorSnapshot({ shellHtml, fetchImpl, signal });
        selectedLock = snapshot.lock;
      }
    }
    if (cached && selectedLock === cachedLock && !snapshot) {
      lastShellCheckAt = now();
      return cached;
    }
    try {
      const prepared = await prepareVendor({
        cacheDir: path.join(cacheDir, 'generations', generationKey(selectedLock)),
        manifest: selectedLock,
        fetchImpl: snapshot ? async url => {
          const bytes = snapshot.contents.get(url);
          return bytes ? new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } }) : fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
        } : fetchImpl,
        signal,
        concurrency: 3,
      });
      await verifySemanticContract(prepared);
      if (selectedLock !== (cachedLock ?? stored ?? lock)) await writeStoredLock(cacheDir, selectedLock);
      cachedLock = selectedLock;
      if (checkedShell) lastShellCheckAt = now();
      cached = prepared;
      return prepared;
    } catch (error) {
      if (error?.code !== 'vendor_asset_stale') throw error;
    }
    if (!shellHtml) {
      if (typeof getShell !== 'function') throw fail('vendor_discovery_shell_unavailable');
      shellHtml = await getShell({ signal });
      checkedShell = true;
    }
    snapshot = await discoverVendorSnapshot({ shellHtml, fetchImpl, signal });
    const candidate = snapshot.lock;
    const candidateKey = generationKey(candidate);
    const verifiedFetch = async (url, init) => {
      const bytes = snapshot.contents.get(url);
      return bytes ? new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } }) : fetchImpl(url, init);
    };
    const prepared = await prepareVendor({ cacheDir: path.join(cacheDir, 'generations', candidateKey), manifest: candidate, fetchImpl: verifiedFetch, signal, concurrency: 3 });
    await verifySemanticContract(prepared);
    if (signal?.aborted) throw fail('vendor_download_aborted');
    await writeStoredLock(cacheDir, candidate);
    cachedLock = candidate;
    cached = prepared;
    if (checkedShell) lastShellCheckAt = now();
    return prepared;
  }

  function joinResolution(job, callerSignal, owner) {
    job.activeWaiters++;
    let active = true;
    let canceled = false;
    let rejectCancellation;
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    cancellation.catch(() => {});
    const release = () => {
      if (!active) return;
      active = false;
      job.activeWaiters--;
      if (job.activeWaiters === 0 && !job.settled) job.controller.abort();
    };
    const cancel = () => {
      if (!active) return;
      canceled = true;
      release();
      rejectCancellation(fail('vendor_download_aborted'));
    };
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    const work = owner
      ? job.promise.then(value => ({ value }), error => ({ error })).then(outcome => {
        if (canceled || callerSignal?.aborted) throw fail('vendor_download_aborted');
        if (outcome.error) throw outcome.error;
        return outcome.value;
      })
      : Promise.race([job.promise, cancellation]);
    return work.finally(() => {
      callerSignal?.removeEventListener('abort', cancel);
      release();
    });
  }

  return async function resolveVendor({ signal, getShell, fetchImpl = globalThis.fetch } = {}) {
    if (signal?.aborted) throw fail('vendor_download_aborted');
    const checkedAt = now();
    if (!Number.isFinite(checkedAt)) throw new TypeError('now must return a finite timestamp');
    const shellCheckDue = typeof getShell === 'function' &&
      (lastShellCheckAt === null || checkedAt - lastShellCheckAt >= SHELL_DRIFT_TTL_MS);
    if (cached && !shellCheckDue) return cached;
    if (inFlight) return joinResolution(inFlight, signal, false);
    const job = { controller: new AbortController(), activeWaiters: 0, settled: false, promise: null };
    inFlight = job;
    job.promise = Promise.resolve().then(() => runVendorResolution({
      signal: job.controller.signal,
      getShell,
      fetchImpl,
      shellCheckDue,
    })).finally(() => {
      job.settled = true;
      if (inFlight === job) inFlight = null;
    });
    job.promise.catch(() => {});
    return joinResolution(job, signal, true);
  };
}
