import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://muse.ai';
const CHUNK_PATH = /^\/_next\/static\/chunks\/[A-Za-z0-9_-]+\.js$/;
const HASH = /^[a-f0-9]{64}$/;
const FILE = /^[A-Za-z0-9_-]+\.js$/;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_TIMEOUT_MS = 20_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 512) throw fail('invalid_manifest_url');
  let url;
  try { url = new URL(raw); } catch { throw fail('invalid_manifest_url'); }
  if (url.origin !== ORIGIN || !CHUNK_PATH.test(url.pathname) || url.username || url.password || url.hash) {
    throw fail('invalid_manifest_url');
  }
  const params = [...url.searchParams.entries()];
  if (params.some(([key]) => key !== 'dpl') || params.length > 1 || (params.length === 1 && !/^[A-Za-z0-9_-]{1,128}$/.test(params[0][1]))) {
    throw fail('invalid_manifest_url');
  }
  return url.href;
}

function validateManifest(manifest) {
  if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype || manifest.schema !== 1 || manifest.origin !== ORIGIN || !Array.isArray(manifest.assets)) {
    throw fail('invalid_manifest');
  }
  const seenFiles = new Set();
  const seenUrls = new Set();
  let total = 0;
  const assets = manifest.assets.map(asset => {
    if (!asset || Object.getPrototypeOf(asset) !== Object.prototype || !FILE.test(asset.fileName ?? '') || asset.fileName.startsWith('.') || !HASH.test(asset.sha256 ?? '') || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_ASSET_BYTES) {
      throw fail('invalid_manifest_asset');
    }
    const url = validateUrl(asset.url);
    if (seenFiles.has(asset.fileName) || seenUrls.has(url)) {
      throw fail('invalid_manifest_asset');
    }
    seenFiles.add(asset.fileName);
    seenUrls.add(url);
    total += asset.bytes;
    return Object.freeze({ fileName: asset.fileName, url, sha256: asset.sha256, bytes: asset.bytes });
  });
  if (total > MAX_TOTAL_BYTES) throw fail('manifest_too_large');

  const dynamicChunks = manifest.dynamicChunks;
  if (!dynamicChunks || Object.getPrototypeOf(dynamicChunks) !== Object.prototype) throw fail('invalid_dynamic_chunks');
  const dynamicCopy = Object.create(null);
  for (const [key, record] of Object.entries(dynamicChunks)) {
    if (!/^static\/chunks\/[A-Za-z0-9_-]+\.js$/.test(key) || !record || Object.getPrototypeOf(record) !== Object.prototype || !FILE.test(record.asset ?? '') || !seenFiles.has(record.asset) || !Array.isArray(record.moduleIds) || record.moduleIds.some(id => !Number.isSafeInteger(id) || id < 0)) {
      throw fail('invalid_dynamic_chunks');
    }
    dynamicCopy[key] = Object.freeze({ asset: record.asset, moduleIds: Object.freeze([...record.moduleIds]) });
  }
  return { assets, dynamicChunks: Object.freeze(dynamicCopy), total };
}

async function ensurePrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw fail('cache_directory_unavailable');
    }
    let stat;
    try { stat = await lstat(current); } catch { throw fail('cache_directory_unavailable'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('unsafe_cache_directory');
  }
  try { await chmod(absolute, 0o700); } catch { throw fail('cache_directory_unavailable'); }
  return absolute;
}

async function assertRegularCacheFile(file, expectedHash, expectedBytes) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'ELOOP') throw fail('unsafe_cache_file');
    throw fail('cache_file_unavailable');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedBytes) throw fail('unsafe_cache_file');
    if ((stat.mode & 0o777) !== 0o600) {
      try { await handle.chmod(0o600); } catch { throw fail('unsafe_cache_file'); }
    }
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw fail('corrupt_cache_file');
    return true;
  } finally {
    await handle.close();
  }
}

async function readResponseBounded(response, maxBytes, signal) {
  if (response.status !== 200 || response.redirected) throw fail('vendor_download_rejected');
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw fail('vendor_asset_too_large');
  if (!response.body?.getReader) throw fail('vendor_download_rejected');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw fail('vendor_download_aborted');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw fail('vendor_asset_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size);
}

function makeTimedSignal(parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, MAX_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function writeAtomic(directory, fileName, bytes) {
  const destination = path.join(directory, fileName);
  const temporary = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
    await assertRegularCacheFile(destination, createHash('sha256').update(bytes).digest('hex'), bytes.byteLength);
  } catch {
    try { await handle?.close(); } catch {}
    try { await unlink(temporary); } catch {}
    throw fail('cache_write_failed');
  }
}

/**
 * Populate a private cache from an exact public asset lock. No caller headers,
 * credentials, redirects, URL discovery, or retries are used.
 */
export async function prepareVendor({ cacheDir, manifest, fetchImpl = globalThis.fetch, signal, concurrency = 3, repairCorrupt = false } = {}) {
  if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir)) throw new TypeError('cacheDir must be absolute');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new RangeError('concurrency must be between 1 and 3');
  if (typeof repairCorrupt !== 'boolean') throw new TypeError('repairCorrupt must be a boolean');
  if (signal !== undefined && (!(signal instanceof AbortSignal) || typeof signal.addEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal');
  const checked = validateManifest(manifest);
  const assetsDirValidated = await ensurePrivateDirectory(path.join(path.resolve(cacheDir), 'assets'));
  const rootDir = path.dirname(assetsDirValidated);
  await ensurePrivateDirectory(rootDir);

  let nextIndex = 0;
  let aborted = false;
  const worker = async () => {
    while (true) {
      if (signal?.aborted) { aborted = true; return; }
      const index = nextIndex++;
      if (index >= checked.assets.length) return;
      const asset = checked.assets[index];
      const file = path.join(assetsDirValidated, asset.fileName);
      try {
        if (await assertRegularCacheFile(file, asset.sha256, asset.bytes)) continue;
      } catch (error) {
        if (error.code !== 'corrupt_cache_file' || !repairCorrupt) throw error;
        // A repaired cache entry is still required to be a regular, singly linked file.
        let stat;
        try { stat = await lstat(file); } catch { throw fail('cache_file_unavailable'); }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('unsafe_cache_file');
        await unlink(file);
      }
      const timed = makeTimedSignal(signal);
      let response;
      try {
        if (timed.signal.aborted) throw fail('vendor_download_aborted');
        response = await fetchImpl(asset.url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: timed.signal,
        });
        const bytes = await readResponseBounded(response, Math.min(MAX_ASSET_BYTES, asset.bytes), timed.signal);
        if (bytes.byteLength !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw fail('vendor_asset_integrity_mismatch');
        await writeAtomic(assetsDirValidated, asset.fileName, bytes);
      } catch (error) {
        if (signal?.aborted) aborted = true;
        if (timed.timedOut) throw fail('vendor_download_timeout');
        if (signal?.aborted || timed.signal.aborted) throw fail('vendor_download_aborted');
        throw error?.code ? error : fail('vendor_download_failed');
      } finally {
        timed.dispose();
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, checked.assets.length) }, () => worker());
  const results = await Promise.allSettled(workers);
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  if (aborted || signal?.aborted) throw fail('vendor_download_aborted');

  const assets = Object.create(null);
  for (const asset of checked.assets) {
    if (!(await assertRegularCacheFile(path.join(assetsDirValidated, asset.fileName), asset.sha256, asset.bytes))) throw fail('vendor_cache_incomplete');
    assets[asset.fileName] = asset.sha256;
  }
  return Object.freeze({
    schema: 1,
    origin: ORIGIN,
    assetsDirValidated,
    assets: Object.freeze(assets),
    dynamicChunks: checked.dynamicChunks,
  });
}
