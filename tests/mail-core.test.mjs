import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, MailError, normalizeEmail, parseImport, validateMailUrl } from '../src/mail/index.mjs';

test('email normalization preserves plus tags and dots', () => {
  assert.equal(normalizeEmail(' First.Last+tag@Example.COM '), 'first.last+tag@example.com');
});

test('import parses all valid rows and detects providers', () => {
  const parsed = parseImport('\nUser+tag@gmail.com|https://mail.google.com/mail/u/0/\n\nbox@example.org|https://outlook.live.com/mail/\n');
  assert.deepEqual(parsed.map(row => row.provider), ['gmail', 'outlook']);
  assert.equal(parsed[0].emailNormalized, 'user+tag@gmail.com');
  assert.equal(parsed[0].mailAccessUrl, parsed[0].url);
  assert.equal(detect(parsed[0].email, parsed[0].url), 'gmail');
});

test('numbered import rows ignore a numeric prefix and accept exact generator mailbox URLs', () => {
  const [row] = parseImport('143 | demo.inbox@sample.test | https://generator.email/demo.inbox@sample.test');
  assert.equal(row.emailNormalized, 'demo.inbox@sample.test');
  assert.equal(row.provider, 'generator');
  assert.equal(detect(row.email, row.url), 'generator');
  assert.equal(parseImport('demo.inbox@sample.test|https://www.generator.email/demo.inbox@sample.test')[0].provider, 'generator');
});

test('import rejects malformed batches and dangerous or unknown URLs', () => {
  for (const input of [
    'a@example.com|https://mail.google.com|extra',
    'a@example.com|http://mail.google.com',
    'a@example.com|https://user:pass@mail.google.com',
    'a@example.com|https://mail.google.com:443/inbox',
    'a@example.com|https://127.0.0.1/inbox',
    'a@example.com|https://quickinbox.invalid/inbox',
    'a@example.com|https://luuvan.site/inbox?address=b@example.com',
    'a@example.com|https://luuvan.site/inbox?address=a@example.com&address=b@example.com',
    'a@example.com|https://luuvan.com/inbox?address=a@example.com',
    'abc | a@example.com | https://mail.google.com/',
    'a@example.com | https://generator.email/other@example.com',
    'a@example.com | https://generator.email/mailbox/other@example.com',
    '123 | a@example.com | https://mail.google.com/ | extra',
  ]) assert.throws(() => parseImport(input), MailError);
  assert.throws(() => validateMailUrl('https://[::1]/'), MailError);
  assert.equal(detect('a@example.com', 'https://luuvan.site/?address=a%40example.com'), 'luuvan');
  assert.throws(() => parseImport(Array.from({ length: 101 }, () => 'a@example.com|https://mail.google.com/').join('\n')), MailError);
  assert.throws(() => parseImport('\n\ninvalid'), error => error.message.includes('line 3'));
});

