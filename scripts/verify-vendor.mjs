#!/usr/bin/env node
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareVendor } from '../src/muse/vendor-cache.mjs';
import { createPublicChunkLoader } from '../src/muse/vendor-loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPORTS = Object.freeze([
  'openNoiseConnection',
  'NoiseChannel',
  'resolveHttpRouteRequest',
  'isGatewayRequestError',
]);
const VERIFY_TIMEOUT_MS = 165_000;

function safeCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)
    ? error.code : 'vendor_verification_failed';
}

async function main() {
  let temporaryDirectory;
  let loader;
  let failureCode = null;
  let assetCount = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const lockPath = path.join(ROOT, 'docs', 'muse-vendor.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    temporaryDirectory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'muse-vendor-contract-'));
    await chmod(temporaryDirectory, 0o700);
    const prepared = await prepareVendor({
      cacheDir: temporaryDirectory,
      manifest: lock,
      signal: controller.signal,
      concurrency: 3,
    });
    assetCount = Object.keys(prepared.assets).length;
    loader = await createPublicChunkLoader({
      assetsDirValidatedManifest: prepared,
      approvedDynamicChunks: prepared.dynamicChunks,
      allowReviewedWasm: true,
    });
    for (const name of EXPORTS) {
      if (typeof loader.getExport(name) !== 'function') throw Object.assign(new Error(), { code: 'public_export_missing' });
    }
  } catch (error) {
    failureCode = safeCode(error);
  } finally {
    clearTimeout(timeout);
    try { loader?.close(); } catch { failureCode ??= 'vendor_loader_cleanup_failed'; }
    if (temporaryDirectory) {
      try { await rm(temporaryDirectory, { recursive: true, force: true }); }
      catch { failureCode ??= 'vendor_cache_cleanup_failed'; }
    }
  }

  if (failureCode) {
    process.stderr.write(`Public Muse asset contract failed (${failureCode}).\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Verified the pinned public Muse asset contract (${assetCount} assets; ${EXPORTS.length} semantic exports).\n`);
  process.stdout.write('This check verifies asset availability and export resolution; it does not verify generation.\n');
}

await main();
