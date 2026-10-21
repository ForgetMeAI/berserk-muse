import { extractImportEmail, parseImport } from '../mail/index.mjs';

export const MAX_PANEL_IMPORT_BYTES = 64 * 1024;
export const MAX_PANEL_IMPORT_LINES = 100;

const SAFE_IMPORT_CODES = new Set(['invalid_input', 'unsupported_provider', 'import_conflict']);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function maskEmail(email) {
  const at = email.lastIndexOf('@');
  const first = text => Array.from(text)[0] ?? '';
  const labels = email.slice(at + 1).split('.');
  return `${first(email.slice(0, at))}***@${first(labels[0])}***${labels.length > 1 ? `.${labels.at(-1)}` : ''}`;
}

function maskValidatedEmail(line) {
  const email = extractImportEmail(line);
  return email ? maskEmail(email) : null;
}

function physicalLines(text) {
  if (typeof text !== 'string') fail('invalid_input');
  if (Buffer.byteLength(text, 'utf8') > MAX_PANEL_IMPORT_BYTES) fail('request_too_large');
  const lines = text.split(/\r?\n/).map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim());
  if (lines.length === 0 || lines.length > MAX_PANEL_IMPORT_LINES) fail('invalid_input');
  return lines;
}

/** Preview a pasted import batch without reading state or performing network requests. */
export function previewAccountImport(text) {
  const lines = physicalLines(text);
  const emails = new Map();
  const urls = new Map();
  const rows = [];
  let ready = 0;
  let duplicates = 0;
  let errors = 0;

  for (const { line, lineNumber } of lines) {
    let entry;
    try {
      [entry] = parseImport(line);
    } catch (error) {
      const code = SAFE_IMPORT_CODES.has(error?.code) ? error.code : 'invalid_input';
      rows.push({ line: lineNumber, emailMasked: maskValidatedEmail(line), provider: null, status: 'error', code });
      errors += 1;
      continue;
    }

    const knownUrl = emails.get(entry.emailNormalized);
    const knownEmail = urls.get(entry.mailAccessUrl);
    if (knownUrl === entry.mailAccessUrl && knownEmail === entry.emailNormalized) {
      rows.push({ line: lineNumber, emailMasked: maskEmail(entry.emailNormalized), provider: entry.provider,
        status: 'duplicate', code: null });
      duplicates += 1;
      continue;
    }
    if ((knownUrl !== undefined && knownUrl !== entry.mailAccessUrl)
      || (knownEmail !== undefined && knownEmail !== entry.emailNormalized)) {
      rows.push({ line: lineNumber, emailMasked: maskEmail(entry.emailNormalized), provider: entry.provider,
        status: 'error', code: 'import_conflict' });
      errors += 1;
      continue;
    }

    emails.set(entry.emailNormalized, entry.mailAccessUrl);
    urls.set(entry.mailAccessUrl, entry.emailNormalized);
    rows.push({ line: lineNumber, emailMasked: maskEmail(entry.emailNormalized), provider: entry.provider,
      status: 'ready', code: null });
    ready += 1;
  }

  return { valid: errors === 0, total: lines.length, ready, duplicates, errors: rows.filter(row => row.status === 'error').length, rows };
}
