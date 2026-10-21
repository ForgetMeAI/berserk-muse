import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertSupportedRuntime, isEntrypoint, openBrowser, resolveBrowserExecutable,
} from '../src/platform.mjs';
import { start } from '../scripts/start.mjs';

test('runtime refuses native Windows with an explicit WSL2 direction', () => {
  assert.throws(() => assertSupportedRuntime('win32'), /inside WSL2/);
  assert.doesNotThrow(() => assertSupportedRuntime('linux'));
  assert.doesNotThrow(() => assertSupportedRuntime('darwin'));
});

test('launch refuses native Windows before touching service state', async () => {
  await assert.rejects(start({ platform: 'win32' }), /inside WSL2/);
});

test('entrypoint comparison handles absolute and relative paths through file URLs', () => {
  const absolute = path.join(os.tmpdir(), 'berserk # entry.mjs');
  assert.equal(isEntrypoint(pathToFileURL(absolute).href, absolute), true);
  assert.equal(isEntrypoint(pathToFileURL(absolute).href, path.relative(process.cwd(), absolute)), true);
  assert.equal(isEntrypoint(pathToFileURL(absolute).href, `${absolute}.other`), false);
  assert.equal(isEntrypoint(pathToFileURL(absolute).href, undefined), false);
});

test('browser discovery honors an explicit absolute path and checks common OS locations', () => {
  const exists = new Set(['/opt/google/chrome/chrome', '/usr/bin/chromium']);
  assert.equal(resolveBrowserExecutable({
    platform: 'linux', env: { MUSE_BROWSER_EXECUTABLE: '/opt/google/chrome/chrome' },
    fileExists: file => exists.has(file),
  }), '/opt/google/chrome/chrome');
  assert.equal(resolveBrowserExecutable({
    platform: 'linux', env: {}, fileExists: file => exists.has(file),
  }), '/usr/bin/chromium');
  assert.equal(resolveBrowserExecutable({
    platform: 'linux', env: { PATH: '/home/test/bin:/usr/bin' },
    fileExists: file => file === '/home/test/bin/chromium',
  }), '/home/test/bin/chromium');
  assert.equal(resolveBrowserExecutable({ platform: 'darwin', env: {}, fileExists: () => true }), null);
  assert.equal(resolveBrowserExecutable({ platform: 'linux', env: {}, fileExists: () => false }), null);
  assert.throws(() => resolveBrowserExecutable({
    platform: 'linux', env: { MUSE_BROWSER_EXECUTABLE: 'relative/chrome' }, fileExists: () => true,
  }), /absolute path/);
  assert.equal(resolveBrowserExecutable({
    platform: 'win32', env: { MUSE_BROWSER_EXECUTABLE: 'C:\\Program Files\\Chrome\\chrome.exe' }, fileExists: () => true,
  }), 'C:\\Program Files\\Chrome\\chrome.exe');
});

test('browser opener uses native OS command without a shell and unsupported platforms fall back', () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return { once() {}, unref() {} };
  };
  assert.equal(openBrowser('http://127.0.0.1:3210/panel', { platform: 'linux', spawnProcess }), true);
  assert.equal(openBrowser('http://127.0.0.1:3210/panel', { platform: 'darwin', spawnProcess }), true);
  assert.equal(openBrowser('http://127.0.0.1:3210/panel', { platform: 'win32', spawnProcess }), false);
  assert.deepEqual(calls.map(call => call.command), ['xdg-open', 'open']);
  assert.deepEqual(calls[0].args, ['http://127.0.0.1:3210/panel']);
  assert.equal(calls[0].options.detached, true);
  assert.equal('shell' in calls[0].options, false);
  assert.equal(openBrowser('http://127.0.0.1/panel', {
    platform: 'linux', spawnProcess: () => { throw new Error('not installed'); },
  }), false);
});

test('explicit browser executable may be validated using a temporary harmless file', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'berserk-platform-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'dummy-browser');
  await writeFile(executable, 'test fixture');
  assert.equal(resolveBrowserExecutable({
    platform: process.platform, env: { MUSE_BROWSER_EXECUTABLE: executable },
  }), executable);
});
