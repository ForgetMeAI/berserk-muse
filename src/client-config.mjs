import path from 'node:path';
import os from 'node:os';
import { ROOT as BRIDGE_ROOT } from './config.mjs';

const MAX_PORT = 65535;
const USER_HOME = os.homedir();
const ALLOWED_PATH = [...new Set([path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin', path.join(USER_HOME, '.local', 'bin')])].join(path.delimiter);

export function validatePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PORT) {
    throw new TypeError('Bridge port must be an integer between 1 and 65535.');
  }
  return value;
}

export function clientConfig({ port, workDir, projectRoot = workDir }) {
  const bridgePort = validatePort(port);
  if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) throw new TypeError('workDir must be an absolute path.');
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new TypeError('projectRoot must be an absolute path.');
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'muse-local/muse-web',
    small_model: 'muse-local/muse-web',
    enabled_providers: ['muse-local'],
    plugin: [],
    share: 'disabled',
    autoupdate: false,
    lsp: false,
    provider: {
      'muse-local': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Muse local bridge',
        options: {
          baseURL: `http://127.0.0.1:${bridgePort}/v1`,
          apiKey: 'muse-local',
        },
        models: {
          'muse-web': {
            name: 'Muse Web',
            tool_call: true,
            limit: { context: 65536, output: 4096 },
          },
        },
      },
    },
  };
}

export function isolatedClientEnv({ projectRoot, pathValue = ALLOWED_PATH }) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new TypeError('projectRoot must be an absolute path.');
  const stateDir = path.join(projectRoot, '.state', 'client');
  const homeDir = path.join(stateDir, 'home');
  const xdgConfig = path.join(stateDir, 'xdg-config');
  const xdgData = path.join(stateDir, 'xdg-data');
  const xdgCache = path.join(stateDir, 'xdg-cache');
  const xdgState = path.join(stateDir, 'xdg-state');
  const tempDir = path.join(stateDir, 'tmp');
  return {
    stateDir,
    homeDir,
    tempDir,
    env: {
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      TMPDIR: tempDir,
      TEMP: tempDir,
      TMP: tempDir,
      PATH: pathValue,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: process.env.TERM && /^[a-zA-Z0-9_-]{1,40}$/.test(process.env.TERM) ? process.env.TERM : 'xterm-256color',
      NO_COLOR: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    },
  };
}

function sbxQuote(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function sandboxProfile({ projectRoot, port, writablePaths = [], protectedPaths = [], runtimePaths = [], allowNetwork = true }) {
  if (process.platform !== 'darwin') return { supported: false, reason: 'macOS sandbox-exec is unavailable on this platform.' };
  const bridgePort = validatePort(port);
  const writePaths = [...new Set(writablePaths)];
  const readPaths = [...new Set([projectRoot, ...writePaths, '/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/Library/Developer/CommandLineTools', '/opt/homebrew'])];
  const devicePaths = ['/dev/null', '/dev/urandom', '/dev/random', '/dev/tty', '/dev/ptmx'];
  const validatePaths = [...readPaths, ...writePaths, ...protectedPaths, ...runtimePaths];
  if (validatePaths.some(item => typeof item !== 'string' || !path.isAbsolute(item))) throw new TypeError('Sandbox paths must be absolute paths.');

  const protectedDirs = [
    path.join(BRIDGE_ROOT, '.state', 'accounts'),
    path.join(BRIDGE_ROOT, '.state', 'refactor-research'),
    path.join(BRIDGE_ROOT, '.state', 'panel.key'),
    path.join(projectRoot, '.state', 'accounts'),
    path.join(projectRoot, '.state', 'panel.key'),
    path.join(projectRoot, '.state', 'browser'),
    path.join(projectRoot, '.state', 'browser-profile'),
    path.join(projectRoot, '.state', 'chrome'),
    path.join(projectRoot, '.state', 'chromium'),
    path.join(projectRoot, '.state', 'firefox'),
    path.join(projectRoot, '.state', 'playwright'),
    path.join(projectRoot, '.state', 'browser-data'),
    path.join(projectRoot, '.state', 'user-data'),
    path.join(projectRoot, '.state', 'profiles'),
    ...protectedPaths,
  ];
  const deniedPaths = [
    path.join(projectRoot, '.env'),
    path.join(projectRoot, '.env.local'),
    path.join(projectRoot, '.env.production'),
    path.join(projectRoot, '.env.development'),
    path.join(projectRoot, '.env.test'),
    path.join(projectRoot, '.env.development.local'),
    path.join(projectRoot, '.env.test.local'),
    path.join(projectRoot, '.env.production.local'),
    path.join(projectRoot, '.npmrc'),
    path.join(projectRoot, '.netrc'),
    path.join(projectRoot, '.git-credentials'),
    path.join(projectRoot, '.git', 'config'),
    path.join(projectRoot, '.pypirc'),
    path.join(projectRoot, '.ssh'),
    path.join(projectRoot, '.aws'),
    path.join(projectRoot, '.docker'),
    path.join(projectRoot, '.config', 'gcloud'),
    ...['.hermes', '.ssh', '.aws', '.config', '.local/share', '.gitconfig', '.npmrc', '.netrc', '.pypirc', '.docker', '.kube', '.terraform.d', '.zshrc', '.zprofile', '.bashrc', '.bash_profile'].map(item => path.join(USER_HOME, item)),
    path.join(USER_HOME, 'Library', 'Keychains'),
    ...['Google/Chrome', 'Microsoft Edge', 'Firefox', 'BraveSoftware', 'Arc'].map(item => path.join(USER_HOME, 'Library', 'Application Support', item)),
    path.join(USER_HOME, 'Library', 'Safari'),
    path.join(USER_HOME, 'Library', 'Cookies'),
  ];
  const profile = [
    '(version 1)',
    '(deny default)',
    // Apple's minimal loader bootstrap; no system.sb networking/Mach defaults.
    '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow file-read* (literal "/var/select") (literal "/private/var/select") (literal "/var/select/developer_dir") (literal "/private/var/select/developer_dir"))',
    '(allow file-read-metadata (path-ancestors "/private/var/select/developer_dir"))',
    ...[...readPaths, ...runtimePaths].map(item => `(allow file-read-metadata (path-ancestors ${sbxQuote(item)}))`),
    ...readPaths.map(item => `(allow file-read* (subpath ${sbxQuote(item)}))`),
    ...readPaths.map(item => `(allow file-map-executable (subpath ${sbxQuote(item)}))`),
    ...runtimePaths.map(item => `(allow file-read* (literal ${sbxQuote(item)}))`),
    ...runtimePaths.map(item => `(allow file-map-executable (literal ${sbxQuote(item)}))`),
    ...devicePaths.map(item => `(allow file-read* (literal ${sbxQuote(item)}))`),
    ...devicePaths.map(item => `(allow file-write* (literal ${sbxQuote(item)}))`),
    '(allow file-read* (subpath "/dev/fd"))',
    '(allow file-write* (subpath "/dev/fd"))',
    '(allow file-read* (subpath "/dev/pts"))',
    '(allow file-write* (subpath "/dev/pts"))',
    ...writePaths.map(item => `(allow file-write* (subpath ${sbxQuote(item)}))`),
    ...deniedPaths.map(item => `(deny file-read* (subpath ${sbxQuote(item)}))`),
    ...protectedDirs.filter(item => !protectedPaths.includes(item)).map(item => `(deny file-read* (subpath ${sbxQuote(item)}))`),
    ...deniedPaths.map(item => `(deny file-map-executable (subpath ${sbxQuote(item)}))`),
    ...protectedDirs.filter(item => !protectedPaths.includes(item)).map(item => `(deny file-map-executable (subpath ${sbxQuote(item)}))`),
    ...[...new Set([...protectedDirs, ...deniedPaths])].map(item => `(deny file-write* (subpath ${sbxQuote(item)}))`),
    ...[...new Set([...protectedDirs, ...deniedPaths])].map(item => `(deny file-write* (literal ${sbxQuote(item)}))`),
    ...(allowNetwork ? [`(allow network-outbound (remote ip "localhost:${bridgePort}"))`] : []),
  ].join('\n');
  return { supported: true, profile };
}
