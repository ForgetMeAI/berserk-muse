import test from 'node:test';
import assert from 'node:assert/strict';
import { clientSettings } from '../src/agent-clients.mjs';
import { createClaudeLiveLaunchSpec } from '../scripts/verify-clients.mjs';

const POSIX = { profileDir: '/tmp/berserk-agent-test', workDir: '/work/project', platform: 'darwin', pathValue: '/usr/bin:/bin' };

test('builds Claude Code settings with a local Anthropic endpoint and isolated config/home paths', () => {
  const result = clientSettings('claude-code', { ...POSIX, port: 8899 });
  assert.deepEqual(result.args, ['--model', 'muse-web']);
  assert.equal(result.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8899');
  assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, 'muse-local');
  assert.equal(result.env.ANTHROPIC_MODEL, 'muse-web');
  assert.equal(result.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'muse-web');
  assert.equal(result.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'muse-web');
  assert.equal(result.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'muse-web');
  assert.equal(result.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'muse-web');
  assert.equal(result.env.CLAUDE_CONFIG_DIR, '/tmp/berserk-agent-test/claude');
  assert.equal(result.env.CLAUDE_CODE_TMPDIR, '/tmp/berserk-agent-test/tmp');
  assert.equal(result.env.CLAUDE_CODE_MAX_RETRIES, '0');
  assert.equal(result.env.TMPPREFIX, '/tmp/berserk-agent-test/tmp/zsh');
  assert.equal(result.env.HOME, '/tmp/berserk-agent-test/home');
  assert.equal(result.env.CLAUDE_CODE_SIMPLE, '1');
  assert.equal(Object.hasOwn(result.env, 'ANTHROPIC_API_KEY'), false);
  assert.equal(Object.hasOwn(result.env, 'OPENAI_API_KEY'), false);
  assert.equal(result.files[0].name, 'settings.json');
  assert.deepEqual(JSON.parse(result.files[0].contents), { model: 'muse-web' });
  assert.deepEqual(Object.keys(result.env).sort(), [
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_CODE_TMPDIR',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CONFIG_DIR', 'DISABLE_TELEMETRY',
    'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'TMPPREFIX', 'TERM', 'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  ].sort());
});

test('builds Hermes config with custom OpenAI chat mode and routes every auxiliary task to Muse', () => {
  const result = clientSettings('hermes', { ...POSIX, port: 8787 });
  assert.deepEqual(result.args, ['chat', '--provider', 'custom', '--model', 'muse-web', '--source', 'tool']);
  assert.equal(result.env.HERMES_HOME, '/tmp/berserk-agent-test/hermes');
  assert.equal(result.env.HERMES_STREAM_RETRIES, '0');
  assert.equal(result.env.TMPPREFIX, '/tmp/berserk-agent-test/tmp/zsh');
  assert.equal(result.env.HOME, '/tmp/berserk-agent-test/home');
  assert.equal(Object.hasOwn(result.env, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(result.env, 'ANTHROPIC_API_KEY'), false);
  const yaml = result.files[0].contents;
  assert.equal(result.files[0].name, 'config.yaml');
  assert.match(yaml, /provider: custom\n  default: "muse-web"\n  base_url: "http:\/\/127\.0\.0\.1:8787\/v1"\n  api_key: "muse-local"\n  api_mode: chat_completions\n  context_length: 65536/);
  assert.match(yaml, /fallback_providers: \[\]/);
  assert.match(yaml, /agent:\n  api_max_retries: 1/);
  assert.match(yaml, /memory_enabled: false/);
  assert.match(yaml, /user_profile_enabled: false/);
  assert.match(yaml, /cwd: "\/work\/project"/);
  for (const slot of ['vision', 'web_extract', 'compression', 'skills_hub', 'approval', 'mcp', 'title_generation', 'tts_audio_tags', 'triage_specifier', 'kanban_decomposer', 'profile_describer', 'curator']) {
    assert.ok(yaml.includes(`  ${slot}:\n    provider: custom\n    model: "muse-web"\n    base_url: "http://127.0.0.1:8787/v1"\n    api_key: "muse-local"\n    api_mode: chat_completions\n    fallback_chain: []`), slot);
  }
});

test('keeps Windows profile locations isolated and includes only a canonical SystemRoot', () => {
  const oldSystemRoot = process.env.SystemRoot;
  try {
    process.env.SystemRoot = 'C:\\Temp\\not-windows';
    const withoutRoot = clientSettings('hermes', {
      profileDir: 'C:\\Users\\test\\berserk-profile', workDir: 'C:\\work\\project',
      platform: 'win32', pathValue: 'C:\\Windows\\System32',
    });
    assert.equal(Object.hasOwn(withoutRoot.env, 'SystemRoot'), false);
    assert.equal(withoutRoot.env.USERPROFILE, 'C:\\Users\\test\\berserk-profile\\home');
    assert.equal(withoutRoot.env.APPDATA, 'C:\\Users\\test\\berserk-profile\\AppData\\Roaming');
    assert.equal(withoutRoot.env.HERMES_HOME, 'C:\\Users\\test\\berserk-profile\\hermes');
    assert.match(withoutRoot.files[0].contents, /cwd: "C:\\\\work\\\\project"/);
    process.env.SystemRoot = 'C:\\Windows';
    const withRoot = clientSettings('claude', {
      profileDir: 'C:\\Users\\test\\berserk-profile', workDir: 'C:\\work\\project',
      platform: 'win32', pathValue: 'C:\\Windows\\System32',
    });
    assert.equal(withRoot.env.SystemRoot, 'C:\\Windows');
  } finally {
    if (oldSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = oldSystemRoot;
  }
});

test('rejects unknown clients, relative profiles, invalid ports and unsafe PATH values', () => {
  assert.throws(() => clientSettings('unknown', POSIX), /client must be/);
  assert.throws(() => clientSettings('hermes', { ...POSIX, profileDir: 'relative' }), /absolute path/);
  assert.throws(() => clientSettings('hermes', { ...POSIX, port: 65536 }), /port must/);
  assert.throws(() => clientSettings('claude', { ...POSIX, pathValue: '/usr/bin\nINJECTED=value' }), /PATH string/);
});

test('prepares a live-Claude launch spec without spawning or bypassing normal tool approvals', () => {
  const spec = createClaudeLiveLaunchSpec({
    executable: '/opt/claude/bin/claude', prompt: 'Inspect the local invoice fixture.',
    port: 8899, profileDir: '/tmp/berserk-profile', workDir: '/tmp/invoice', pathValue: '/usr/bin:/bin',
  });
  assert.equal(spec.binary, '/opt/claude/bin/claude');
  assert.equal(spec.cwd, '/tmp/invoice');
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8899');
  assert.equal(spec.env.CLAUDE_CODE_TMPDIR, '/tmp/berserk-profile/tmp');
  assert.equal(spec.env.CLAUDE_CODE_MAX_RETRIES, '0');
  assert.equal(spec.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.ok(spec.args.includes('Inspect the local invoice fixture.'));
  assert.equal(spec.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(spec.args.includes('--allowedTools'), false);
  assert.equal(spec.files.length, 1);
  assert.throws(() => createClaudeLiveLaunchSpec({ executable: 'claude', prompt: 'x', ...POSIX }), /absolute path/);
});
