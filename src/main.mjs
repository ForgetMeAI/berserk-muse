import { pathToFileURL } from 'node:url';
import { ROOT, STATE, settings } from './config.mjs';
import { createApplication } from './application.mjs';
import { assertSupportedRuntime } from './platform.mjs';

/** One owned service shutdown; failures and deadlines never print raw causes. */
export function createShutdown({ close, timeoutMs = 45_000,
  exit = code => process.exit(code), log = message => console.error(message) } = {}) {
  if (typeof close !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid shutdown configuration');
  let promise;
  return () => {
    if (promise) return promise;
    promise = Promise.resolve().then(async () => {
      const timer = setTimeout(() => {
        log('Локальный API не завершил очистку вовремя; его процесс остановлен.');
        exit(1);
      }, timeoutMs);
      timer.unref?.();
      try { await close(); }
      catch {
        log('Очистка локального API завершилась с ошибкой; его процесс остановлен.');
        exit(1);
      } finally { clearTimeout(timer); }
    });
    return promise;
  };
}

export async function main() {
  try { assertSupportedRuntime(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  let app;
  const stop = createShutdown({ close: () => app?.close() });
  try {
    const config = settings();
    app = await createApplication({ config, root: ROOT, stateDir: STATE, onShutdown: stop });
    await app.listen(config.port);
    console.log(`Muse API: http://127.0.0.1:${config.port}/v1`);
    console.log(`Транспорт: ${config.transport}. Панель: npm run panel. Аккаунты: npm run account.`);
    console.log('Модель: muse-web. Инструменты: JSON; поток ответа буферизуется; расход оценивается локально.');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    await stop();
    console.error(error?.code === 'EADDRINUSE' ? 'Порт занят. Проверьте npm run status или задайте MUSE_PORT.' : 'Не удалось запустить локальный API. Проверьте локальное состояние и права файлов.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
