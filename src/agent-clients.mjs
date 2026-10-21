import path from 'node:path';

const MODEL = 'muse-web';
const LOCAL_KEY = 'muse-local';
const HERMES_AUX_TASKS = [
  'vision', 'web_extract', 'compression', 'skills_hub', 'approval', 'mcp',
  'title_generation', 'tts_audio_tags', 'triage_specifier', 'kanban_decomposer',
  'profile_describer', 'curator',
];

function invalid(message) { throw new TypeError(message); }

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function checkedPath(value, label, pathImpl) {
  if (typeof value !== 'string' || !pathImpl.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    invalid(`${label} must be an absolute path without control characters.`);
  }
  return pathImpl.normalize(value);
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('port must be an integer from 1 through 65535.');
}

function q(value) { return JSON.stringify(value); }

function hermesConfig({ baseUrl, workDir }) {
  const lines = [
    'model:',
    '  provider: custom',
    `  default: ${q(MODEL)}`,
    `  base_url: ${q(baseUrl)}`,
    `  api_key: ${q(LOCAL_KEY)}`,
    '  api_mode: chat_completions',
    '  context_length: 65536',
    'agent:',
    '  api_max_retries: 1',
    'providers: {}',
    'fallback_providers: []',
    'toolsets:',
    '  - hermes-cli',
    'memory:',
    '  memory_enabled: false',
    '  user_profile_enabled: false',
    '  provider: ""',
    'auxiliary:',
  ];
  for (const task of HERMES_AUX_TASKS) {
    lines.push(`  ${task}:`, '    provider: custom', `    model: ${q(MODEL)}`, `    base_url: ${q(baseUrl)}`,
      `    api_key: ${q(LOCAL_KEY)}`, '    api_mode: chat_completions', '    fallback_chain: []');
  }
  lines.push('terminal:', `  cwd: ${q(workDir)}`, '');
  return lines.join('\n');
}

/**
 * Build an isolated process environment and config files for a CLI coding agent.
 * The returned env is an allowlist and must replace, not merge with, process.env.
 */
export function clientSettings(client, {
  port = 8787,
  profileDir,
  workDir,
  platform = process.platform,
  pathValue = process.env.PATH ?? '',
} = {}) {
  checkPort(port);
  if (typeof pathValue !== 'string' || !pathValue || /[\0\r\n]/.test(pathValue)) invalid('pathValue must be a non-empty PATH string.');
  const pathImpl = pathApi(platform);
  const profile = checkedPath(profileDir, 'profileDir', pathImpl);
  const work = checkedPath(workDir, 'workDir', pathImpl);
  const home = pathImpl.join(profile, 'home');
  const temp = pathImpl.join(profile, 'tmp');
  const common = {
    PATH: pathValue,
    HOME: home,
    TMPDIR: temp,
    TMPPREFIX: pathImpl.join(temp, 'zsh'),
    TEMP: temp,
    TMP: temp,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    NO_COLOR: '1',
  };
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (typeof systemRoot === 'string' && path.win32.isAbsolute(systemRoot) && /^windows$/i.test(path.win32.basename(systemRoot)) && !/[\0\r\n]/.test(systemRoot)) {
      common.SystemRoot = path.win32.normalize(systemRoot);
    }
    common.USERPROFILE = home;
    common.APPDATA = pathImpl.join(profile, 'AppData', 'Roaming');
    common.LOCALAPPDATA = pathImpl.join(profile, 'AppData', 'Local');
  } else {
    common.XDG_CONFIG_HOME = pathImpl.join(profile, 'xdg', 'config');
    common.XDG_DATA_HOME = pathImpl.join(profile, 'xdg', 'data');
    common.XDG_CACHE_HOME = pathImpl.join(profile, 'xdg', 'cache');
    common.XDG_STATE_HOME = pathImpl.join(profile, 'xdg', 'state');
  }

  if (client === 'claude' || client === 'claude-code') {
    const configDir = pathImpl.join(profile, 'claude');
    return {
      env: {
        ...common,
        CLAUDE_CODE_TMPDIR: temp,
        CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_AUTH_TOKEN: LOCAL_KEY,
        ANTHROPIC_MODEL: MODEL,
        ANTHROPIC_DEFAULT_MODEL: MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
        ANTHROPIC_DEFAULT_FABLE_MODEL: MODEL,
        ANTHROPIC_CUSTOM_MODEL_OPTION: MODEL,
        CLAUDE_CODE_SIMPLE: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      },
      files: [{ name: 'settings.json', contents: `${JSON.stringify({ model: MODEL }, null, 2)}\n` }],
      args: ['--model', MODEL],
    };
  }

  if (client === 'hermes') {
    const hermesHome = pathImpl.join(profile, 'hermes');
    return {
      env: { ...common, HERMES_HOME: hermesHome, HERMES_STREAM_RETRIES: '0' },
      files: [{ name: 'config.yaml', contents: hermesConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, workDir: work }) }],
      args: ['chat', '--provider', 'custom', '--model', MODEL, '--source', 'tool'],
    };
  }
  invalid('client must be claude, claude-code, or hermes.');
}
