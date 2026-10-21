import test from 'node:test';
import assert from 'node:assert/strict';
import { apiEndpointForClient, clientProcessEnv, parseVerifyCliOptions } from '../scripts/verify-clients.mjs';
import { clientSettings } from '../src/agent-clients.mjs';

const settings = clientSettings('hermes', {
  profileDir: '/tmp/berserk-hermes-test', workDir: '/tmp/berserk-fixture',
  platform: 'darwin', pathValue: '/usr/bin:/bin',
});

test('counts Claude and Hermes model responses only from their own API endpoint', () => {
  assert.equal(apiEndpointForClient('claude'), '/v1/messages');
  assert.equal(apiEndpointForClient('hermes'), '/v1/chat/completions');
  assert.throws(() => apiEndpointForClient('unknown'), /client must be/);
});

test('isolated Hermes CLI execution requires an explicit target and approval flag', () => {
  assert.equal(parseVerifyCliOptions(['hermes'], {}), null);
  assert.equal(parseVerifyCliOptions(['hermes', '--approve-isolated-hermes'], {}).approveIsolatedHermes, true);
  assert.equal(parseVerifyCliOptions(['claude'], {}).clients.includes('hermes'), false);
  assert.equal(parseVerifyCliOptions(['claude', '--approve-isolated-hermes'], {}), null);
  assert.equal(parseVerifyCliOptions([], {}), null);
});

test('Hermes YOLO is added only to an explicitly approved isolated child environment', () => {
  assert.equal(Object.hasOwn(settings.env, 'HERMES_YOLO_MODE'), false);
  assert.throws(() => clientProcessEnv('hermes', settings, '/tmp/berserk-hermes-test'), /requires --approve/);
  const approved = clientProcessEnv('hermes', settings, '/tmp/berserk-hermes-test', { approveIsolatedHermes: true });
  assert.equal(approved.HERMES_YOLO_MODE, '1');
  assert.equal(approved.HERMES_HOME, '/tmp/berserk-hermes-test/hermes');
  const claude = clientProcessEnv('claude', clientSettings('claude', {
    profileDir: '/tmp/berserk-claude-test', workDir: '/tmp/berserk-fixture',
    platform: 'darwin', pathValue: '/usr/bin:/bin',
  }), '/tmp/berserk-claude-test', { approveIsolatedHermes: true });
  assert.equal(Object.hasOwn(claude, 'HERMES_YOLO_MODE'), false);
});
