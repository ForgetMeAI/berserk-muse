import { ROOT_ID, settings } from '../src/config.mjs';
import { assertSupportedRuntime, isEntrypoint } from '../src/platform.mjs';

export async function localRequest(path, { method = 'GET' } = {}) {
  const { port } = settings();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Authorization: 'Bearer muse-local' }, signal: AbortSignal.timeout(path === '/control/login' ? 60000 : 10000),
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error?.message || 'Local request failed.'), { code: body.error?.code });
  return body;
}

export async function ownStatus() {
  const body = await localRequest('/health');
  if (body.service !== 'berserk-muse' || body.rootId !== ROOT_ID) throw new Error('На этом порту работает другой сервис. Задайте другой MUSE_PORT.');
  return body;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const action = process.argv[2] || 'status';
  try {
    assertSupportedRuntime();
    const status = await ownStatus();
    if (action === 'login') {
      const login = await localRequest('/control/login', { method: 'POST' });
      console.log(login.panelRequired ? 'Для управления аккаунтами откройте npm run panel.' : login.ready ? 'Muse готов к работе.' : 'Завершите вход и настройку Muse в открывшемся окне Chrome, затем запустите npm run status.');
    } else if (action === 'stop') {
      await localRequest('/control/stop', { method: 'POST' });
      console.log('Локальный Muse API останавливается.');
    } else if (action === 'status') {
      console.log(`Muse API: http://127.0.0.1:${settings().port}/v1`);
      console.log(`Состояние: ${status.state}. Готов: ${status.ready ? 'да' : 'нет'}. Очередь: ${status.queue.waiting}.`);
      console.log('Модель определяется приложением Muse; баланс аккаунтов доступен в панели.');
    } else throw new Error('Команда: status, login или stop.');
  } catch (error) {
    console.error(error?.cause?.code === 'ECONNREFUSED' ? 'API ещё не запущен. Запустите npm run launch.' : error.message);
    process.exitCode = 1;
  }
}
