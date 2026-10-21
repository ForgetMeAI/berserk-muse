#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBrowser } from '../src/platform.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const root = path.resolve(process.env.MUSE_ROOT || path.join(scriptDir, '..'));
  const configPath = path.join(root, 'src/config.mjs');
  const { ROOT_ID, settings } = await import(pathToFileURL(configPath));
  const port = settings().port;
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer muse-local' }, signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('The local Muse service is unavailable. Start it, then try again.');
  }
  if (!response.ok) throw new Error('The local Muse service is unavailable. Start it, then try again.');
  const result = await response.json().catch(() => null);
  if (result?.service !== 'berserk-muse' || result.rootId !== ROOT_ID) throw new Error('Another service is using the local Muse port.');
  const url = `http://127.0.0.1:${port}/panel`;
  process.stdout.write(`${url}\n`);
  openBrowser(url);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Could not open the local panel.'}\n`);
  process.exitCode = 1;
});
