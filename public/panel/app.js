import { aggregateAccounts, quotaView, aggregateMuseBalances } from './model.js';

const byId = id => document.getElementById(id);
const number = value => Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) : '—';
const labels = { active: 'Активен', ready: 'Готов', needs_relogin: 'Нужен вход', expired: 'Сессия истекла', banned: 'Заблокирован',
  cooldown: 'Пауза', error: 'Ошибка', failed: 'Ошибка', completed: 'Успешно', succeeded: 'Готово', running: 'Выполняется',
  queued: 'В очереди', cancelled: 'Отменено', timeout: 'Время истекло', rejected: 'Отклонён', unknown: 'Неизвестно', blocked: 'Карантин' };
const errors = { invalid_input: 'Проверьте формат: почта | HTTPS-ссылка. Перед почтой можно указать номер и |.', invalid_account_input: 'Некорректная запись аккаунта.',
  unsupported_provider: 'Поддерживаются HTTPS-ссылки Luuvan, Gmail, Outlook и Generator.email без пароля, порта или фрагмента.',
  import_conflict: 'Эта почта уже связана с другой ссылкой, либо ссылка — с другой почтой. Исправьте список.',
  request_too_large: 'Список слишком большой. Разделите его на части до 100 строк и 64 КБ.',
  csrf: 'Сервис перезапустился. Повторите действие.', needs_user_interaction: 'Вход не завершён. Нажмите «Войти» и закончите его в браузере.',
  needs_mail_auth: 'Код из почты не получен. Нажмите «Войти» для ручного входа.', mail_auth_failed: 'Не удалось войти в почту.',
  mail_unavailable: 'Почтовый сервис недоступен.', login_timeout: 'Время на вход истекло. Нажмите «Войти» ещё раз.',
  account_busy: 'Аккаунт занят. Дождитесь завершения текущей задачи.', job_queue_full: 'Очередь входа заполнена. Повторите вход позже.',
  browser_unavailable: 'Не удалось открыть браузер. Проверьте, что установлен Chrome или Chromium.',
  browser_launch_failed: 'Не удалось запустить Chrome. Проверьте установку браузера.',
  browser_launch_timeout: 'Chrome не запустился вовремя. Закройте зависшее окно входа и повторите.',
  browser_permission_denied: 'Система запретила запуск Chrome. Проверьте права приложения.',
  muse_navigation_failed: 'Не удалось открыть Muse в браузере. Проверьте подключение к сети.',
  muse_navigation_timeout: 'Страница Muse не загрузилась вовремя. Повторите вход позже.',
  muse_dns_error: 'Браузер не смог найти сервер Muse. Проверьте DNS и подключение.',
  muse_proxy_error: 'Браузер не смог подключиться через прокси. Проверьте настройки сети.',
  muse_tls_error: 'Браузер не подтвердил защищённое соединение с Muse. Проверьте сертификаты и дату устройства.',
  token_exchange_failed: 'Muse не выдал сессию. Повторите вход.', invalid_token_response: 'Muse вернул неполную сессию. Повторите вход.',
  needs_relogin: 'Нужно заново войти в Muse.', session_missing: 'Войдите, чтобы подключить аккаунт.', session_unavailable: 'Сессия недоступна.',
  session_probe_failed: 'Не удалось проверить сессию.', probe_failed: 'Проверка сессии не пройдена.', refresh_failed: 'Не удалось обновить сессию.',
  usage_auth_required: 'Для баланса нужно заново войти в Muse.', usage_forbidden: 'Muse отклонил запрос баланса.',
  usage_unavailable: 'Muse временно не сообщил баланс.', usage_response_invalid: 'Формат баланса Muse изменился.',
  usage_session_changed: 'Сессия обновилась. Баланс будет запрошен заново.', session_changed: 'Сессия обновилась. Баланс будет запрошен заново.',
  usage_cancelled: 'Обновление баланса остановлено.', cancelled: 'Обновление баланса остановлено.' };
const jobPhases = { opening_browser: 'Открываем браузер Muse', requesting_code: 'Запрашиваем код входа',
  reading_mail: 'Пробуем получить код из почты', waiting_for_user: 'Завершите вход в браузере', saving_session: 'Сохраняем сессию Muse' };
const providerLabels = { luuvan: 'Luuvan', gmail: 'Gmail', outlook: 'Outlook', generator: 'Generator.email' };
let csrf = '', source = null, snapshot = null, toastTimer = null, requestsCursor = null;
let requestRows = [], importRevision = 0, previewRevision = -1, importPending = false, previewPending = false, generation = 0, snapshotRevision = 0;
let previewAbort = null, allJobs = false;
const jobs = new Map(), pendingActions = new Set();
const MAX_IMPORT_BYTES = 64 * 1024;

function text(node, value) { node.textContent = value == null || value === '' ? '—' : String(value); }
function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) text(element, value);
  return element;
}
function showToast(message) {
  text(byId('toast'), message); byId('toast').dataset.visible = 'true';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { byId('toast').dataset.visible = 'false'; }, 4500);
}
function formatTime(value) {
  if (value === null || value === undefined || value === '') return 'Нет данных';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Нет данных';
}
function setConnected(online) {
  byId('connection').dataset.state = online ? 'online' : 'offline';
  text(byId('connection').querySelector('span'), online ? 'В реальном времени' : 'Переподключение');
}
function pill(element, value) { text(element, labels[value] || 'Неизвестно'); element.dataset.state = value || 'unknown'; }
function unitLabel(unit) { return unit === 'tokens' || unit === 'token' ? 'токенов' : unit || ''; }
function shortId(id) { return typeof id === 'string' ? id.slice(0, 8) : '—'; }
function usageTotal(usage) {
  if (Number.isFinite(usage)) return usage;
  return usage && Number.isFinite(usage.totalTokens) ? usage.totalTokens : null;
}
function meter(track, fill, percent, label) {
  track.classList.toggle('unknown', !Number.isFinite(percent));
  track.dataset.level = percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : 'normal';
  fill.style.width = Number.isFinite(percent) ? `${Math.max(0, Math.min(100, percent))}%` : '0%';
  track.setAttribute('aria-label', label);
  if (Number.isFinite(percent)) {
    track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(Math.round(percent))); track.setAttribute('aria-valuetext', label);
  } else {
    track.setAttribute('role', 'img');
    for (const attr of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) track.removeAttribute(attr);
  }
}
function renderAccounts() {
  const accounts = snapshot?.accounts || [], filter = byId('account-filter').value, search = byId('account-search').value.trim().toLowerCase();
  const visible = accounts.filter(account => {
    const stats = aggregateAccounts([account]);
    return (filter === 'all' || (filter === 'active' && stats.active) || (filter === 'attention' && stats.needsAttention) || (filter === 'busy' && stats.busy))
      && (!search || `${account.emailMasked || ''} ${account.id || ''}`.toLowerCase().includes(search));
  });
  byId('accounts-list').replaceChildren();
  text(byId('accounts-total'), visible.length === accounts.length ? accounts.length : `${visible.length} / ${accounts.length}`);
  byId('accounts-empty').hidden = accounts.length > 0;
  byId('accounts-no-match').hidden = !accounts.length || visible.length > 0;
  for (const account of visible) {
    const row = node('tr'), name = node('td', 'account-cell');
    name.append(node('span', 'account-name', account.emailMasked || `Аккаунт ${shortId(account.id)}`), node('span', 'account-secondary', `${providerLabels[account.mailProvider] || account.mailProvider || 'Muse'} · ${shortId(account.id)}`));
    const stateCell = node('td'), state = node('span', 'state-label');
    pill(state, account.quarantined ? 'blocked' : account.busy ? 'running' : account.status);
    stateCell.append(state);
    if (account.enabled === false) stateCell.append(node('span', 'account-secondary', 'Отключён'));
    if (account.reasonCode) stateCell.append(node('span', 'account-reason', errors[account.reasonCode] || account.reasonCode));
    if (account.cooldownUntil) stateCell.append(node('span', 'account-secondary', `Пауза до ${formatTime(account.cooldownUntil)}`));
    const quota = quotaView(account.upstreamQuota), quotaCell = node('td', 'quota-cell');
    const museUsage = account.museUsage, weekly = museUsage?.sample?.weekly, additional = museUsage?.sample?.additional;
    quotaCell.append(node('span', 'quota-value', quota.remaining === null ? 'Баланс ещё не получен' : `${additional?.approximate ? '≈ ' : ''}${number(quota.remaining)} ${unitLabel(quota.unit)}`));
    const track = node('div', 'meter meter-small'), fill = node('span'); track.append(fill);
    const caption = additional?.displayLabel ? `Muse: ${additional.displayLabel}` : quota.remaining === null ? 'Muse не сообщил читаемый остаток токенов' : 'Дополнительные токены';
    meter(track, fill, additional?.percentUsed ?? quota.percent, caption); quotaCell.append(track, node('small', 'account-secondary', caption));
    if (additional?.approximate) quotaCell.append(node('small', 'account-secondary', 'Значение округлено Muse'));
    if (weekly) {
      const weeklyTrack = node('div', 'meter meter-small weekly-meter'), weeklyFill = node('span'); weeklyTrack.append(weeklyFill);
      const weeklyCaption = Number.isFinite(weekly.percentUsed) ? `Недельный лимит: использовано ${number(weekly.percentUsed)}%` : 'Недельный лимит: Muse не сообщил процент';
      meter(weeklyTrack, weeklyFill, weekly.percentUsed, weeklyCaption);
      quotaCell.append(weeklyTrack, node('small', 'account-secondary', weeklyCaption));
    }
    if (quota.observedAt !== null) quotaCell.append(node('small', 'account-secondary', `Данные на ${formatTime(quota.observedAt)}`));
    const stale = museUsage?.state === 'stale';
    if (museUsage?.pending) quotaCell.append(node('small', 'balance-status', 'Обновляем баланс…'));
    else if (stale || museUsage?.errorCode) quotaCell.append(node('small', 'balance-status balance-warning',
      `${stale ? 'Последние известные данные. ' : ''}${errors[museUsage?.errorCode] || 'Ожидается обновление.'}`));
    else if (!museUsage?.sample) quotaCell.append(node('small', 'account-secondary', account.hasSession ? 'Нажмите «Баланс», чтобы запросить данные.' : 'Баланс появится после входа в Muse.'));
    const usage = node('td', 'usage-cell');
    usage.append(node('span', 'quota-value', usageTotal(account.estimatedUsage) === null ? 'Нет оценки' : `≈ ${number(usageTotal(account.estimatedUsage))}`),
      node('span', 'account-secondary', Number.isFinite(account.estimatedUsage?.requests) ? `${number(account.estimatedUsage.requests)} запросов в истории` : 'Запросов в истории нет'));
    const actions = node('td'), group = node('div', 'actions');
    for (const [label, action, capability] of [['Баланс', 'usage-refresh', null], ['Войти', 'relogin', 'relogin'], ['Проверить', 'health-check', 'healthCheck']]) {
      const button = node('button', 'button button-quiet button-small', account.quarantined && action === 'health-check' ? 'Проверить и снять карантин' : label);
      button.type = 'button'; button.disabled = (capability && account.capabilities?.[capability] === false) || pendingActions.has(`${account.id}:${action}`)
        || (action === 'usage-refresh' && (account.hasSession === false || account.status === 'banned' || account.busy || museUsage?.pending));
      button.addEventListener('click', () => {
        if (account.quarantined && action !== 'usage-refresh' && !window.confirm('Предыдущий запрос Muse может ещё выполняться. Убедитесь, что он завершён или остановлен. Успешная проверка может снять карантин. Продолжить?')) return;
        void runAction(account.id, action);
      }); group.append(button);
    }
    actions.append(group); row.append(name, stateCell, quotaCell, usage, actions); byId('accounts-list').append(row);
  }
}
function renderRequests() {
  byId('requests-list').replaceChildren();
  for (const request of requestRows) {
    const row = node('div', 'request-row'), identity = node('div', 'request-identity');
    identity.append(node('span', 'request-id', shortId(request.id)), node('span', 'account-secondary', request.accountId ? `Аккаунт ${shortId(request.accountId)}` : 'Локальный запрос'));
    const state = node('span', 'state-label'); pill(state, request.status);
    const tokens = Number.isFinite(request.estimatedInputTokens) || Number.isFinite(request.estimatedOutputTokens)
      ? `≈ ${number((request.estimatedInputTokens || 0) + (request.estimatedOutputTokens || 0))} ток.` : 'Нет оценки';
    row.append(identity, state, node('span', 'request-tokens', tokens), node('time', 'request-time', formatTime(request.startedAt)));
    if (request.error) row.append(node('span', 'request-error', errors[request.error.code] || `Ошибка: ${request.error.code || 'internal_error'}`));
    byId('requests-list').append(row);
  }
  text(byId('requests-total'), `Показано ${number(requestRows.length)}`); byId('requests-empty').hidden = requestRows.length > 0;
  byId('requests-more').hidden = !requestsCursor;
}
function renderJobs() {
  const ordered = [...jobs.values()].sort((a, b) => {
    const pending = value => ['queued', 'running'].includes(value.status) ? 1 : 0;
    return pending(b) - pending(a) || new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
  });
  byId('jobs-card').hidden = !ordered.length; byId('jobs-list').replaceChildren();
  text(byId('jobs-total'), `${ordered.filter(job => ['queued', 'running'].includes(job.status)).length} в работе · ${ordered.length} всего`);
  for (const job of allJobs ? ordered : ordered.slice(0, 5)) {
    const row = node('div', 'job-row'), heading = node('div', 'job-heading'), title = node('div');
    title.append(node('span', 'job-name', `${job.type === 'health_check' ? 'Проверка сессии' : 'Вход в аккаунт'} · ${shortId(job.id)}`));
    const waitingForUser = job.status === 'running' && job.phase === 'waiting_for_user';
    const state = node('span', 'state-label'); pill(state, job.status);
    if (waitingForUser) { text(state, 'Ожидает вас'); row.classList.add('job-waiting'); }
    heading.append(title, state);
    const track = node('div', 'meter'), fill = node('span'); track.append(fill);
    const progress = Number.isFinite(job.progress) ? job.progress : null;
    meter(track, fill, progress, `${labels[job.status] || 'Задача'}${progress === null ? '' : `, ${number(progress)}%`}`);
    track.dataset.level = job.status === 'failed' ? 'danger' : 'normal';
    const detail = job.error ? errors[job.error.code] || `Ошибка: ${job.error.code}`
      : waitingForUser ? 'Завершите вход в открывшемся окне Muse. Если нужен код, возьмите его во вкладке почты. После входа аккаунт активируется автоматически. Ожидание — до 10 минут.'
        : `${jobPhases[job.phase] || (progress === null ? 'Выполняется' : `${number(progress)}%`)} · ${formatTime(job.updatedAt || job.createdAt)}`;
    row.append(heading, track, node('p', `job-detail${job.error ? ' error-text' : ''}`, detail)); byId('jobs-list').append(row);
  }
  byId('jobs-more').hidden = ordered.length <= 5; text(byId('jobs-more'), allJobs ? 'Свернуть задачи' : `Показать все задачи (${ordered.length})`);
}
function rememberJob(job) {
  if (!job?.id) return;
  const previous = jobs.get(job.id);
  if (previous && new Date(previous.updatedAt) > new Date(job.updatedAt)) return;
  jobs.set(job.id, job);
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value);
}
function renderSnapshot(value) {
  snapshot = value; if (!snapshot) return;
  snapshotRevision += 1;
  const accounts = snapshot.accounts || [], summary = aggregateAccounts(accounts), stats = snapshot.statistics;
  pill(byId('service-status'), snapshot.status);
  text(byId('account-count'), number(summary.total)); text(byId('active-count'), number(summary.active));
  text(byId('active-note'), `Свободно ${number(summary.active - summary.busy)} · занято ${number(summary.busy)}`);
  text(byId('attention-count'), number(summary.needsAttention));
  text(byId('account-note'), summary.disabled ? `Отключено: ${number(summary.disabled)}` : 'Загружено в Berserk');
  text(byId('queue-count'), number(snapshot.queue?.waiting));
  text(byId('queue-note'), `Сейчас выполняется: ${number(snapshot.queue?.activeCount)}`);
  const quota = aggregateMuseBalances(accounts);
  const isTokens = quota.unit === 'tokens' || quota.unit === 'token';
  text(byId('remaining-value'), quota.remaining === null ? 'Нет данных' : `${quota.approximate ? '≈ ' : ''}${number(quota.remaining)}`);
  const staleBalances = accounts.filter(account => account.museUsage?.sample && account.museUsage.state === 'stale').length;
  const pendingBalances = accounts.filter(account => account.museUsage?.pending).length;
  text(byId('quota-badge'), pendingBalances ? (quota.remaining === null ? 'ЗАГРУЗКА' : 'ОБНОВЛЯЕТСЯ') : quota.remaining === null ? 'НЕТ ДАННЫХ' : staleBalances ? 'УСТАРЕЛО' : !quota.complete ? 'ЧАСТИЧНО' : quota.approximate ? 'ОКРУГЛЕНО MUSE' : 'ДАННЫЕ MUSE');
  byId('quota-badge').dataset.stale = String(staleBalances > 0);
  byId('refresh-balances').disabled = pendingActions.has('all:usage-refresh') || pendingBalances > 0;
  text(byId('refresh-balances'), pendingBalances ? `Обновляем: ${pendingBalances}` : 'Обновить балансы');
  text(byId('remaining-note'), quota.remaining === null ? (quota.coverage ? 'Доступные остатки указаны у аккаунтов.' : pendingBalances ? 'Запрашиваем данные Muse…' : accounts.some(account => account.hasSession) ? 'Не удалось получить баланс. Подробности — у аккаунтов.' : 'Для баланса требуется активная сессия Muse.')
    : `${pendingBalances ? 'Последняя известная сумма' : quota.complete ? (quota.approximate ? 'Сумма округлённых остатков всех аккаунтов' : 'Сумма по всем аккаунтам') : 'Сумма только известных остатков'} · ${unitLabel(quota.unit)}${staleBalances ? ` · устарело: ${staleBalances}` : ''}`);
  // A token headline must never display quotas in another unit as if they were tokens.
  if (quota.remaining !== null && !isTokens) text(byId('remaining-value'), `${number(quota.remaining)} ${unitLabel(quota.unit)}`);
  text(byId('quota-coverage'), `Данные: ${quota.coverage} / ${accounts.length} аккаунтов`);
  const observations = accounts.map(account => quotaView(account.upstreamQuota)).filter(item => item.remaining !== null)
    .map(item => typeof item.observedAt === 'number' ? item.observedAt : Date.parse(item.observedAt)).sort((a, b) => a - b);
  byId('quota-observed').hidden = !observations.length;
  text(byId('quota-observed'), observations.length ? `Данные Muse: ${formatTime(observations[0])}${observations.at(-1) === observations[0] ? '' : ` — ${formatTime(observations.at(-1))}`}.`  : '');
  const caption = quota.percent === null ? (quota.remaining === 0 && quota.complete ? 'Дополнительные токены отсутствуют' : 'Общий процент недоступен при неполных данных') : `Использовано ${number(quota.percent)}% дополнительного запаса`;
  meter(byId('total-quota-track'), byId('total-quota-fill'), quota.percent, caption); text(byId('quota-caption'), caption);
  const total = stats && (Number.isFinite(stats.inputTokens) || Number.isFinite(stats.outputTokens)) ? (stats.inputTokens || 0) + (stats.outputTokens || 0) : summary.estimatedTokens;
  text(byId('usage-value'), total === null ? 'Нет оценки' : `≈ ${number(total)}`);
  text(byId('input-value'), number(stats?.inputTokens ?? summary.inputTokens)); text(byId('output-value'), number(stats?.outputTokens ?? summary.outputTokens));
  const unknown = stats ? (stats.inputUnknown || 0) + (stats.outputUnknown || 0) : summary.unknownRequests;
  text(byId('usage-note'), unknown ? `${number(unknown)} записей без оценки; фактический расход может быть выше.` : 'Оценка текста, а не списание по счёту Muse.');
  text(byId('request-count'), number(stats?.requests)); text(byId('success-count'), number(stats?.completed)); text(byId('failed-count'), number(stats?.failed));
  const days = stats?.windowMs / 86400000;
  text(byId('history-note'), Number.isFinite(days) ? `Сохранённая история: до ${number(days)} дней, до 5 000 событий.` : 'Статистика доступна за сохранённую историю.');
  byId('service-error').hidden = !snapshot.error; text(byId('service-error'), snapshot.error?.message);
  renderAccounts();
  const latest = snapshot.requests || [], latestIds = new Set(latest.map(request => request.id));
  // Preserve previously loaded older pages as live snapshots arrive.
  const older = requestRows.filter(request => !latestIds.has(request.id));
  requestRows = [...latest, ...older].slice(0, 500);
  if (!requestRows.length || older.length === 0) requestsCursor = snapshot.requestsNextCursor || null;
  renderRequests();
  for (const job of snapshot.jobs || []) rememberJob(job);
  renderJobs(); text(byId('updated-at'), `Обновлено ${new Date().toLocaleTimeString('ru-RU')}`);
}
async function api(path, options = {}, retryCsrf = true) {
  const current = generation;
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-Panel-CSRF', csrf);
  const response = await fetch(`/panel/api${path}`, { ...options, headers, credentials: 'omit', cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (response.status === 403 && result.error?.code === 'csrf' && retryCsrf && path !== '/bootstrap') {
    // A CSRF rejection happens before the action. Renew only this guard after restart.
    await refresh();
    if (current !== generation) throw new DOMException('Page is no longer active.', 'AbortError');
    options.signal?.throwIfAborted();
    return api(path, options, false);
  }
  if (!response.ok) throw Object.assign(new Error(errors[result.error?.code] || 'Не удалось выполнить действие. Попробуйте обновить панель.'), { code: result.error?.code });
  return result;
}
async function refresh() {
  const current = generation, revision = snapshotRevision, result = await api('/bootstrap');
  if (current !== generation) return;
  csrf = result.csrf;
  if (revision === snapshotRevision) renderSnapshot(result.snapshot);
}
async function runAction(id, action) {
  if (!id) return;
  const key = `${id}:${action}`, current = generation; pendingActions.add(key); renderAccounts();
  try {
    const result = await api(`/accounts/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    if (current !== generation) return;
    if (action === 'usage-refresh') {
      showToast(result.queued ? 'Запрашиваем баланс Muse.' : 'Баланс уже обновляется, обновлён недавно или аккаунт занят.');
      await refresh(); return;
    }
    rememberJob(result.job); renderJobs(); showToast(action === 'relogin' ? 'Вход добавлен в очередь. При необходимости завершите его в браузере.' : 'Проверка добавлена в очередь.');
  } catch (error) { if (current === generation) handleError(error); }
  finally { pendingActions.delete(key); if (current === generation) renderAccounts(); }
}
function handleError(error) { showToast(error.message || 'Не удалось подключиться к локальному сервису.'); }
function importTextChanged() {
  importRevision += 1; previewRevision = -1; previewAbort?.abort(); previewPending = false;
  byId('import-preview').hidden = true; byId('submit-import').hidden = true; byId('import-error').hidden = true;
  const value = byId('import-text').value, lines = value.split(/\r?\n/).filter(line => line.trim()).length, bytes = new TextEncoder().encode(value).length;
  text(byId('import-count'), `${lines} / 100 строк · ${number(Math.ceil(bytes / 1024))} / 64 КБ`);
  byId('import-count').classList.toggle('error-text', lines > 100 || bytes > MAX_IMPORT_BYTES);
  byId('preview-import').disabled = !lines || lines > 100 || bytes > MAX_IMPORT_BYTES || importPending;
  text(byId('import-action-note'), 'Проверка списка не добавляет аккаунты.');
  text(byId('preview-import'), 'Проверить список');
}
function clearImport() {
  byId('import-text').value = ''; byId('import-file').value = ''; importTextChanged(); byId('preview-list').replaceChildren();
}
function setImportBusy(busy) {
  importPending = busy; byId('import-text').disabled = busy; byId('import-file').disabled = busy; byId('clear-import').disabled = busy;
  byId('preview-import').disabled = busy || previewPending || !byId('import-text').value.trim(); byId('submit-import').disabled = busy;
  byId('import-form').setAttribute('aria-busy', String(busy));
}
function openImporter(open) {
  byId('import-card').hidden = !open; byId('open-import').setAttribute('aria-expanded', String(open));
  if (open) { byId('import-card').scrollIntoView({ behavior: 'auto', block: 'nearest' }); byId('import-text').focus(); }
}
async function previewImport(event) {
  event.preventDefault();
  if (importPending || previewPending) return;
  const value = byId('import-text').value;
  if (!value.trim() || new TextEncoder().encode(value).length > MAX_IMPORT_BYTES) return;
  const revision = importRevision, current = generation; previewAbort = new AbortController(); previewPending = true;
  byId('preview-import').disabled = true; text(byId('preview-import'), 'Проверяем…'); byId('import-error').hidden = true;
  try {
    const result = await api('/accounts/preview', { method: 'POST', body: JSON.stringify({ accounts: value }), signal: previewAbort.signal });
    if (revision !== importRevision || current !== generation) return;
    byId('preview-list').replaceChildren();
    for (const item of result.rows || []) {
      const row = node('tr'); row.append(node('td', '', item.line), node('td', '', item.emailMasked || 'Некорректная запись'), node('td', '', providerLabels[item.provider] || item.provider || '—'));
      const verdict = node('td', item.status === 'error' ? 'error-text' : item.status === 'ready' ? 'positive' : 'muted',
        item.status === 'error' ? errors[item.code] || 'Исправьте формат строки.' : item.status === 'duplicate' ? 'Дубль в этом списке' : 'Формат верный');
      row.append(verdict); byId('preview-list').append(row);
    }
    text(byId('preview-summary'), `Строк: ${result.total} · готовы: ${result.ready} · дубли: ${result.duplicates} · ошибки: ${result.errors}`);
    byId('import-preview').hidden = false; previewRevision = result.valid ? revision : -1;
    byId('submit-import').hidden = !result.valid; text(byId('submit-import'), `Добавить аккаунты (${result.ready})`);
    text(byId('import-action-note'), result.valid ? 'Добавим весь список и запустим вход. Уже загруженные записи пропустим.' : 'Исправьте ошибки, затем проверьте список ещё раз. Ничего не добавлено.');
    byId('preview-heading').focus();
  } catch (error) {
    if (error.name !== 'AbortError' && current === generation && revision === importRevision) {
      text(byId('import-error'), error.message); byId('import-error').hidden = false;
    }
  } finally {
    if (revision === importRevision && current === generation) { previewPending = false; byId('preview-import').disabled = false; text(byId('preview-import'), 'Проверить ещё раз'); }
  }
}
async function submitImport() {
  if (importPending || previewRevision !== importRevision) return;
  const current = generation; setImportBusy(true); byId('import-error').hidden = true;
  try {
    const result = await api('/accounts/import', { method: 'POST', body: JSON.stringify({ accounts: byId('import-text').value }) });
    if (current !== generation) return;
    clearImport();
    for (const job of result.jobs || []) rememberJob(job);
    const banner = byId('import-result'); banner.replaceChildren(node('strong', '', `Добавлено: ${number(result.imported)} · Пропущено дублей: ${number(result.duplicates)}`),
      node('span', '', result.imported ? `Запущено задач входа: ${(result.jobs || []).length}. Активные аккаунты появятся после успешного входа.` : 'Все записи уже были загружены. Повторно ничего не добавлено.'));
    banner.hidden = false;
    openImporter(false); renderJobs();
    try { await refresh(); } catch { showToast('Аккаунты добавлены. Обновите панель, чтобы увидеть актуальные статусы.'); }
  } catch (error) {
    if (current === generation) {
      text(byId('import-error'), error.message || 'Не удалось получить результат. Проверьте список аккаунтов перед повтором.'); byId('import-error').hidden = false;
    }
  } finally { if (current === generation) { setImportBusy(false); if (!byId('import-text').value) byId('preview-import').disabled = true; } }
}
async function loadMoreRequests() {
  if (!requestsCursor) return;
  const button = byId('requests-more'), current = generation; button.disabled = true;
  try {
    const page = await api(`/requests?limit=50&cursor=${encodeURIComponent(requestsCursor)}`);
    if (current !== generation) return;
    const ids = new Set(requestRows.map(request => request.id)); requestRows.push(...(page.data || []).filter(request => !ids.has(request.id)));
    requestsCursor = page.nextCursor || null; renderRequests();
  } catch (error) { if (current === generation) handleError(error); }
  finally { button.disabled = false; }
}
async function load() {
  const current = generation;
  try {
    // Old bookmarks with a ticket still lead to the same permanent local URL.
    if (new URLSearchParams(location.hash.slice(1)).has('ticket')) history.replaceState(null, '', `${location.pathname}${location.search}`);
    await refresh();
    if (current !== generation) return;
    byId('unavailable-state').hidden = true; byId('dashboard').hidden = false; connectEvents();
  } catch {
    if (current !== generation) return;
    byId('unavailable-state').hidden = false; byId('dashboard').hidden = true; setConnected(false);
  }
}
function connectEvents() {
  source?.close(); source = new EventSource('/panel/api/events');
  const current = generation;
  source.onopen = () => {
    if (current !== generation) return;
    setConnected(true);
    void refresh().catch(() => { if (current === generation) setConnected(false); });
  };
  source.onerror = () => {
    if (current !== generation) return;
    setConnected(false);
  };
  const update = event => {
    if (current !== generation) return;
    try { const payload = JSON.parse(event.data); if (payload.snapshot) renderSnapshot(payload.snapshot); if (payload.job) { rememberJob(payload.job); renderJobs(); } }
    catch { /* A malformed local event cannot replace the last valid snapshot. */ }
  };
  for (const type of ['snapshot', 'account.updated', 'request.finished', 'job.updated', 'queue.updated', 'accounts', 'requests', 'jobs', 'status', 'error', 'reset']) source.addEventListener(type, update);
  source.addEventListener('server.shutdown', () => { if (current !== generation) return; setConnected(false); showToast('Сервис перезапускается. Панель переподключится автоматически.'); });
}
byId('retry').addEventListener('click', load);
byId('refresh').addEventListener('click', async () => { try { await refresh(); if (!source || source.readyState === EventSource.CLOSED) connectEvents(); showToast('Данные обновлены.'); } catch (error) { handleError(error); } });
byId('refresh-balances').addEventListener('click', async () => {
  const key = 'all:usage-refresh', current = generation; pendingActions.add(key); byId('refresh-balances').disabled = true;
  try {
    const result = await api('/usage/refresh', { method: 'POST' });
    if (current !== generation) return;
    showToast(result.queued ? `Запрашиваем баланс: ${result.queued} аккаунтов.` : 'Балансы уже обновляются, обновлены недавно или аккаунты заняты.');
    await refresh();
  } catch (error) { if (current === generation) handleError(error); }
  finally { pendingActions.delete(key); if (current === generation && snapshot) renderSnapshot(snapshot); }
});
byId('open-import').addEventListener('click', () => openImporter(byId('import-card').hidden));
byId('close-import').addEventListener('click', () => { openImporter(false); byId('open-import').focus(); });
byId('clear-import').addEventListener('click', clearImport);
byId('import-text').addEventListener('input', importTextChanged);
byId('import-form').addEventListener('submit', previewImport);
byId('submit-import').addEventListener('click', submitImport);
byId('import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0], current = generation, revision = importRevision;
  if (!file || importPending) return;
  if (file.size > MAX_IMPORT_BYTES) { text(byId('import-error'), errors.request_too_large); byId('import-error').hidden = false; event.target.value = ''; return; }
  try {
    const value = await file.text();
    if (current !== generation || revision !== importRevision || importPending) return;
    byId('import-text').value = value; importTextChanged(); byId('import-text').focus();
  } catch { showToast('Не удалось прочитать файл. Вставьте список вручную.'); }
  finally { event.target.value = ''; }
});
for (const id of ['account-search', 'account-filter']) byId(id).addEventListener('input', renderAccounts);
byId('jobs-more').addEventListener('click', () => { allJobs = !allJobs; renderJobs(); });
byId('requests-more').addEventListener('click', loadMoreRequests);
window.addEventListener('pagehide', () => { generation += 1; source?.close(); clearImport(); setImportBusy(false); });
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
importTextChanged(); setConnected(false); void load();
