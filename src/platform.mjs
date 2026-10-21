import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function isEntrypoint(moduleUrl, argvPath) {
  if (typeof argvPath !== 'string' || !argvPath) return false;
  try { return moduleUrl === pathToFileURL(path.resolve(argvPath)).href; }
  catch { return false; }
}

export function assertSupportedRuntime(platform = process.platform) {
  if (platform === 'win32') {
    throw new Error('Native Windows is not supported. Run Berserk inside WSL2 with Node.js 22 or newer.');
  }
}

function absoluteFor(platform, value) {
  return typeof value === 'string' && (platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value));
}

function browserCandidates(platform) {
  if (platform === 'linux') return [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
  return [];
}

export function resolveBrowserExecutable({
  platform = process.platform, env = process.env, fileExists = existsSync,
} = {}) {
  const configured = env.MUSE_BROWSER_EXECUTABLE;
  if (configured !== undefined && configured !== '') {
    if (!absoluteFor(platform, configured) || !fileExists(configured)) {
      throw new Error('MUSE_BROWSER_EXECUTABLE must be an absolute path to an installed browser executable.');
    }
    return configured;
  }
  const candidates = browserCandidates(platform);
  if (platform === 'linux' && typeof env.PATH === 'string') {
    for (const directory of env.PATH.split(path.delimiter)) {
      if (!directory || !path.posix.isAbsolute(directory)) continue;
      candidates.push(...['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']
        .map(binary => path.posix.join(directory, binary)));
    }
  }
  return candidates.find(fileExists) || null;
}

export function openBrowser(url, {
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  const command = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : null;
  if (!command) return false;
  try {
    const child = spawnProcess(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

