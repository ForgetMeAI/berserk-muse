import { mkdir, writeFile, readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, ROOT_ID, settings } from '../src/config.mjs';

const { port } = settings();
const origin = `http://127.0.0.1:${port}`;
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
const report = { runId, time: new Date().toISOString(), evidenceMode: 'live-browser-synthetic-tools',
  modelAlias: 'muse-web', resolvedModel: 'Muse app selection (not independently identified)',
  upstream: 'https://muse.ai', tools: 'synthetic-json', nativeTools: false,
  faasN3: 'NOT_APPLICABLE', faasN4: 'NOT_APPLICABLE', status: 'PENDING', checks: {} };

async function call(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer muse-local', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(280000),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error('Live endpoint did not complete the check.'), { code: data.error?.code || `http_${response.status}` });
  return data;
}

async function collectSourceFiles(relativeRoot, include) {
  const root = join(ROOT, relativeRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Unsafe source directory.');
  const files = [];
  async function visit(relativeDirectory) {
    const directory = join(ROOT, relativeDirectory);
    for (const name of (await readdir(directory)).sort()) {
      const relative = `${relativeDirectory}/${name}`;
      const file = join(ROOT, relative);
      const st = await lstat(file);
      if (st.isSymbolicLink()) throw new Error('Unsafe source entry.');
      if (st.isDirectory()) { await visit(relative); continue; }
      if (!st.isFile() || st.nlink !== 1) throw new Error('Unsafe source entry.');
      // Relative paths are assembled with '/', so the manifest key is POSIX on every host.
      if (include(relative)) files.push(relative);
    }
  }
  await visit(relativeRoot);
  return files;
}

async function sourceManifest() {
  const files = [];
  const selected = new Set([
    ...await collectSourceFiles('src', relative => relative.endsWith('.mjs')),
    ...await collectSourceFiles('scripts', () => true),
    ...await collectSourceFiles('public/panel', () => true),
    'docs/muse-vendor.lock.json',
  ]);
  for (const relative of [...selected].sort()) {
    const file = join(ROOT, relative);
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('Unsafe source entry.');
    files.push([relative, createHash('sha256').update(await readFile(file)).digest('hex')]);
  }
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

try {
  const health = await call('/readyz');
  if (health.service !== 'berserk-muse' || health.rootId !== ROOT_ID) throw Object.assign(new Error('Different local service.'), { code: 'wrong_service' });
  report.checks.ready = true;
  report.transport = health.mode;
  report.evidenceMode = health.mode === 'http' ? 'live-native-noise-synthetic-tools' : 'live-browser-synthetic-tools';
  const catalog = await call('/v1/models');
  report.checks.catalog = catalog.data?.some(model => model.id === 'muse-web') === true;
  const detail = await call('/v1/models/muse-web');
  report.checks.modelDetail = detail.id === 'muse-web';
  console.log('Проверяю короткий ответ настоящего Muse…');
  const plain = await call('/v1/chat/completions', { model: 'muse-web', messages: [{ role: 'user', content: 'Reply with exactly MUSE_CONNECTION_OK.' }] });
  report.checks.plain = plain.choices?.[0]?.message?.content?.trim() === 'MUSE_CONNECTION_OK';
  if (!report.checks.plain) throw Object.assign(new Error('Unexpected plain response.'), { code: 'plain_mismatch' });
  console.log('Проверяю выбор инструмента и продолжение после его результата…');
  const tools = [{ type: 'function', function: { name: 'add_numbers', description: 'Add two integers in the local client.', parameters: {
    type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false,
  } } }];
  const messages = [{ role: 'user', content: 'Call add_numbers with a=17 and b=25. After I return the result, reply with only the number.' }];
  const selected = await call('/v1/chat/completions', { model: 'muse-web', messages, tools, tool_choice: 'required', parallel_tool_calls: false });
  const choice = selected.choices?.[0];
  const tool = choice?.message?.tool_calls?.[0];
  const args = tool ? JSON.parse(tool.function.arguments) : {};
  report.checks.toolSelection = choice?.finish_reason === 'tool_calls' && tool?.function?.name === 'add_numbers' && args.a === 17 && args.b === 25;
  if (!report.checks.toolSelection) throw Object.assign(new Error('Unexpected tool decision.'), { code: 'tool_mismatch' });
  // This arithmetic is the actual client-side tool execution, never a model result.
  messages.push(choice.message, { role: 'tool', tool_call_id: tool.id, content: String(args.a + args.b) });
  const final = await call('/v1/chat/completions', { model: 'muse-web', messages, tools, tool_choice: 'none' });
  report.checks.toolContinuation = final.choices?.[0]?.message?.content?.trim() === '42' && final.choices?.[0]?.finish_reason === 'stop';
  report.status = Object.values(report.checks).every(Boolean) ? 'PASS_EXPERIMENTAL' : 'FAIL';
} catch (error) {
  report.status = ['login_required', 'approval_required', 'browser_unavailable'].includes(error.code) ? 'BLOCKED' : 'FAIL';
  report.errorCode = /^[a-z0-9_]+$/i.test(error.code || '') ? error.code : 'live_check_failed';
  process.exitCode = 1;
} finally {
  report.sourceHash = await sourceManifest();
  const directory = join(ROOT, '.verification', `live-${runId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Живая проверка: ${report.status}${report.errorCode ? ` (${report.errorCode})` : ''}.`);
  console.log(`Отчёт: .verification/live-${runId}/report.json`);
}
