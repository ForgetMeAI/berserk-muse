import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSupportedRuntime, isEntrypoint } from '../src/platform.mjs';
import { ROOT, STATE, settings } from '../src/config.mjs';
import { ownStatus, localRequest } from './control.mjs';

export async function start({ login = false, platform = process.platform } = {}) {
  assertSupportedRuntime(platform);
  const stopDeadline = Date.now() + 12000;
  while (true) {
  try {
    const existing = await ownStatus();
    if (login) await localRequest('/control/login', { method: 'POST' });
    return existing;
  } catch (error) {
    // A listening service with a different identity must never be replaced.
    if (error.message.startsWith('На этом порту')) throw error;
    if (error.code === 'shutting_down' && Date.now() < stopDeadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    if (error?.cause?.code !== 'ECONNREFUSED') throw error;
  }
  break;
  }
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  const log = await open(join(STATE, 'server.log'), 'a', 0o600);
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'MUSE_BROWSER_EXECUTABLE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const config = settings();
  env.MUSE_PORT = String(config.port);
  env.MUSE_TRANSPORT = config.transport;
  env.MUSE_MAX_ACTIVE = String(config.maxActive);
  env.MUSE_QUEUE_LIMIT = String(config.queueLimit);
  env.MUSE_TIMEOUT_MS = String(config.timeoutMs);
  env.MUSE_MAX_CONTEXT_CHARS = String(config.maxChars);
  const child = spawn(process.execPath, [...(process.allowedNodeEnvironmentFlags.has('--use-system-ca') ? ['--use-system-ca'] : []), join(ROOT, 'src/main.mjs')], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  let failed = false;
  child.once('error', () => { failed = true; });
  child.unref();
  await log.close();
  const deadline = Date.now() + 12000;
  let started;
  while (Date.now() < deadline) {
    if (failed) throw new Error('Не удалось запустить процесс локального API.');
    try {
      started = await ownStatus();
      break;
    } catch (error) {
      if (error.message.startsWith('На этом порту')) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  if (!started) throw new Error('API не запустился вовремя. Проверьте свободный порт и зависимости npm ci.');
  if (login) await localRequest('/control/login', { method: 'POST' });
  return started;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  try {
    await start({ login: process.argv.includes('--login') });
    console.log(`Muse API запущен: http://127.0.0.1:${settings().port}/v1`);
    console.log('Панель: npm run panel. Аккаунты: npm run account. Агент: npm run agent. Остановка: npm run stop.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
