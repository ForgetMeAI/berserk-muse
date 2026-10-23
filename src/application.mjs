import { readFile, mkdir, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountStore } from './accounts/store.mjs';
import { AccountPool, TransportFailure } from './accounts/pool.mjs';
import { SessionManager } from './muse/session.mjs';
import { createMuseProtocol } from './muse/http.mjs';
import { createVendorResolver } from './muse/vendor-discovery.mjs';
import { createNetworkRuntime } from './net/runtime.mjs';
import { Telemetry } from './telemetry.mjs';
import { AccountQueue } from './queue.mjs';
import { JobManager } from './accounts/jobs.mjs';
import { BrowserSessionBootstrapper } from './accounts/login.mjs';
import { createAccountService } from './accounts/service.mjs';
import { AccountUsageService } from './accounts/usage.mjs';
import { createPanelAuth } from './panel/auth.mjs';
import { createPanelEventBus } from './panel/events.mjs';
import { createPanelRouter } from './panel/routes.mjs';
import { createRequestView } from './panel/requests.mjs';
import { MuseBrowser } from './browser.mjs';
import { createBridge } from './server.mjs';

/** Application composition. Account secrets remain behind the store/transport boundary. */
export async function createApplication({ config, root, stateDir, onShutdown = null, dependencies = {} } = {}) {
  if (!config || !root || !stateDir) throw new TypeError('Application paths and config are required.');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const entry = await lstat(stateDir);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) throw new Error('Unsafe runtime directory');
  await chmod(stateDir, 0o700);
  const store = dependencies.store ?? new AccountStore({ rootDir: config.accountsDir });
  let telemetry, pool, queue, service, jobs, sessionManager, browser, panelRouter, eventBus, usageService;
  let closed = false;
  const closeResources = async () => {
    if (closed) return;
    closed = true;
    let failure = false;
    for (const close of [() => usageService?.close(), () => service?.close(), () => jobs?.close(), () => queue?.close?.(),
      () => pool?.close(), () => sessionManager?.close?.(), () => browser?.close(),
      () => telemetry?.close(), () => store.close()]) {
      try { await close(); } catch { failure = true; }
    }
    eventBus?.closeAll();
    if (failure) throw new Error('Application cleanup failed');
  };
  try {
    await store.init();
    telemetry = dependencies.telemetry ?? new Telemetry({ rootDir: join(stateDir, 'telemetry') });
    await telemetry.ready?.();
    await telemetry.init?.();
    eventBus = createPanelEventBus();
    let vendorResolverPromise;
    const vendorManifest = async options => {
      vendorResolverPromise ??= (async () => {
        const lock = JSON.parse(await readFile(join(root, 'docs', 'muse-vendor.lock.json'), 'utf8'));
        return createVendorResolver({ cacheDir: join(stateDir, 'vendor', 'muse-client-v1'), lock });
      })().catch(error => { vendorResolverPromise = undefined; throw error; });
      const resolveVendor = await vendorResolverPromise;
      const net = createNetworkRuntime();
      try { return await resolveVendor({ ...options, fetchImpl: net.fetchImpl }); }
      finally { await net.close(); }
    };
    const protocol = dependencies.protocol ?? createMuseProtocol({ store, vendorManifest, timeoutMs: config.timeoutMs,
      failureFactory: fields => new TransportFailure(fields) });
    sessionManager = dependencies.sessionManager ?? new SessionManager({ store, protocol });
    pool = dependencies.pool ?? new AccountPool({ store, sessionManager, transportFactory: protocol.transportFactory });
    usageService = new AccountUsageService({ store, pool, protocol, eventBus });
    jobs = new JobManager({ onUpdate: job => eventBus.publish('job.updated', job) });
    const bootstrapper = dependencies.bootstrapper ?? new BrowserSessionBootstrapper({ rootDir: config.accountsDir,
      onDiagnostic: event => {
        // The bootstrapper emits only fixed enums, never the browser's raw cause.
        console.warn(`Muse login diagnostic: ${JSON.stringify(event)}`);
      },
    });
    service = createAccountService({ store, pool, sessionManager, bootstrapper, jobs, telemetry, eventBus });
    store.on('change', () => {
      eventBus.publish('accounts', {});
      try { usageService.requestAll(); } catch { /* A later refresh retries transient store failures. */ }
    });
    const attempts = new Map();
    const activeRequests = new Set();
    const requestView = createRequestView({ telemetry, isActive: id => activeRequests.has(id) });
    const observedTelemetry = {
      async recordAttempt(record) {
        const attempt = (attempts.get(record.requestId) ?? 0) + 1;
        attempts.set(record.requestId, attempt);
        return telemetry.recordAttempt({ ...record, modelAlias: record.model, attempt });
      },
      async recordResult(record) {
        attempts.delete(record.requestId);
        return telemetry.recordResult({ ...record, modelAlias: record.model,
          status: record.status === 'completed' ? 'ok' : record.status });
      },
    };
    let driver;
    if (config.transport === 'http') {
      queue = new AccountQueue({ pool, limit: config.queueLimit, maxActive: config.maxActive, maxAttempts: 3 });
      driver = {
        status: () => pool.status(),
        generate: (prompt, options) => {
          if (!options?.lease?.transport?.generate) throw new Error('Account lease required');
          return options.lease.transport.generate(prompt, options);
        },
        login: async () => ({ panelRequired: true, path: '/panel', command: 'npm run panel' }),
        close: closeResources,
      };
    } else {
      browser = dependencies.browser ?? new MuseBrowser(config);
      driver = { status: () => browser.status(), generate: (...args) => browser.generate(...args),
        login: () => browser.login(), close: closeResources };
    }
    const auth = createPanelAuth({ stateDir });
    await auth.ready();
    const listPanelAccounts = () => service.listAccounts().map(account => {
      const museUsage = usageService.getPublic(account.id);
      const additional = museUsage.sample?.additional;
      const upstreamQuota = Number.isFinite(additional?.remaining) ? {
        unit: 'tokens', remaining: additional.remaining,
        ...(Number.isFinite(additional.limit) ? { limit: additional.limit } : {}),
        ...(Number.isFinite(additional.used) ? { used: additional.used } : {}),
        observedAt: museUsage.sample.observedAt,
      } : null;
      return { ...account, museUsage, upstreamQuota };
    });
    panelRouter = createPanelRouter({ root, stateDir, port: config.port, auth, eventBus,
      getSnapshot: async () => ({ status: (await driver.status()).state, queue: queue?.status ?? null,
        statistics: telemetry.snapshot?.() ?? null, jobs: jobs.list() }),
      listAccounts: listPanelAccounts,
      listRequests: options => requestView.list(options),
      relogin: id => service.relogin(id), healthCheck: id => service.healthCheck(id),
      getJob: id => service.getJob(id), importAccounts: body => service.importAccounts(body),
      refreshUsage: id => id === null ? usageService.requestAll({ force: true }) : usageService.request(id, { force: true }),
    });
    const app = createBridge({ driver, ...config, timeoutMs: config.timeoutMs + 20000, onShutdown, queue, panelRouter,
      telemetry: observedTelemetry,
      onRequestStarted: record => { activeRequests.add(record.requestId); eventBus.publish('queue.updated', {}); },
      onRequestFinished: record => {
        activeRequests.delete(record.requestId); eventBus.publish('request.finished', {});
        if (record.accountId) {
          try { usageService.request(record.accountId, { force: true }); } catch { /* Usage cannot alter a completed generation. */ }
        }
      },
    });
    usageService.start();
    return { ...app, accounts: service, store, telemetry, pool, auth, eventBus, usageService };
  } catch (error) {
    await panelRouter?.close?.().catch(() => {});
    await closeResources().catch(() => {});
    throw error;
  }
}
