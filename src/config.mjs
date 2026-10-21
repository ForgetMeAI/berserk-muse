import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const STATE = join(ROOT, '.state');
export const ROOT_ID = createHash('sha256').update(ROOT).digest('hex').slice(0, 16);

function number(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function settings() {
  const transport = process.env.MUSE_TRANSPORT ?? 'http';
  if (!['browser', 'http'].includes(transport)) throw new Error('Invalid MUSE_TRANSPORT');
  return { port: number('MUSE_PORT', 8787, 1024, 65535),
    timeoutMs: number('MUSE_TIMEOUT_MS', 240000, 30000, 600000),
    maxChars: number('MUSE_MAX_CONTEXT_CHARS', 250000, 10000, 500000),
    transport, maxActive: number('MUSE_MAX_ACTIVE', 1, 1, 8),
    queueLimit: number('MUSE_QUEUE_LIMIT', 4, 0, 100),
    accountsDir: join(STATE, 'accounts'),
    profileDir: join(STATE, 'browser'), rootId: ROOT_ID };
}
