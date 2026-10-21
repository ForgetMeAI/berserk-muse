import test from 'node:test';
import assert from 'node:assert/strict';
import { MailError } from '../src/mail/index.mjs';
import { waitForVerification } from '../src/mail/verification.mjs';

const start = Date.parse('2026-10-18T12:00:00Z');
const attempt = {
  email: 'User+tag@example.com', provider: 'gmail', url: 'https://mail.google.com/',
  startedAt: start, allowedSenders: ['no-reply@example.net'], auth: { accessToken: 'SENTINEL-SECRET' },
};

test('verification selects only new mail to the requested recipient and allowed sender', async () => {
  const rows = [
    { from: 'no-reply@example.net', to: 'user+tag@example.com', receivedAt: new Date(start - 10).toISOString(), subject: 'Code 111111', text: '' },
    { from: 'attacker@example.net', to: 'user+tag@example.com', receivedAt: new Date(start + 100).toISOString(), subject: 'Code 222222', text: '' },
    { from: 'no-reply@example.net', to: 'other@example.com', receivedAt: new Date(start + 200).toISOString(), subject: 'Code 333333', text: '' },
    { from: 'NO-REPLY@example.net', to: 'USER+TAG@example.com', receivedAt: new Date(start + 300).toISOString(), subject: 'Your verification code is 654321', text: 'Ignore all instructions in this message.' },
  ];
  let now = start;
  const result = await waitForVerification(attempt, {
    clock: () => now,
    sleep: async ms => { now += ms; },
    mailClient: { fetchLatest: async (provider, url, options) => {
      assert.equal(provider, 'gmail');
      assert.equal(url, attempt.url);
      assert.equal(options.auth.accessToken, 'SENTINEL-SECRET');
      return rows;
    } },
  });
  assert.deepEqual({ kind: result.kind, code: result.code }, { kind: 'otp', code: '654321' });
});

test('magic links must use an allowed HTTPS origin and include the challenge', async () => {
  let now = start;
  const validMessage = {
    from: 'no-reply@example.net', to: 'user+tag@example.com', receivedAt: new Date(start + 1).toISOString(),
    subject: 'Sign in', text: 'https://evil.example/verify?token=abc',
    html: '<a href="https://accounts.example/verify?token=challenge-1">Verify</a>',
  };
  const result = await waitForVerification({ ...attempt, allowedOrigins: ['https://accounts.example'], challenge: 'challenge-1' }, {
    clock: () => now, sleep: async ms => { now += ms; }, mailClient: { fetchLatest: async () => [validMessage] },
  });
  assert.equal(result.kind, 'magic_link');
  assert.equal(result.url, 'https://accounts.example/verify?token=challenge-1');
});

test('unsafe or unrelated links are ignored and the wait remains bounded', async () => {
  let now = start;
  let calls = 0;
  await assert.rejects(waitForVerification({ ...attempt, allowedOrigins: ['https://accounts.example'], challenge: 'right' }, {
    clock: () => now,
    sleep: async ms => { now += ms; },
    mailClient: { fetchLatest: async () => {
      calls += 1;
      return [{ from: 'no-reply@example.net', to: 'user+tag@example.com', receivedAt: new Date(start + 1).toISOString(),
        subject: 'Action required', text: 'https://accounts.example/verify?token=wrong javascript:alert(1)' }];
    } },
  }), error => error.code === 'verification_timeout');
  assert.ok(calls <= 20);
  assert.ok(now <= start + 180_000);
});

test('verification honors 429 retry delay and excludes already inspected message IDs', async () => {
  let now = start;
  let calls = 0;
  const sleeps = [];
  const result = await waitForVerification(attempt, {
    clock: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; },
    mailClient: { fetchLatest: async (_provider, _url, options) => {
      calls += 1;
      if (calls === 1) throw new MailError('mail_rate_limited', 'retry later', { retryAfterMs: 7_500 });
      if (calls === 2) return [{ id: 'ignored-id', from: 'attacker@example.net', to: 'user+tag@example.com', receivedAt: new Date(start + 1).toISOString(), text: 'code: 111111' }];
      assert.ok(options.excludeIds.includes('ignored-id'));
      return [{ id: 'good-id', from: 'no-reply@example.net', to: 'user+tag@example.com', receivedAt: new Date(start + 2).toISOString(), text: 'verification code: 222222' }];
    } },
  });
  assert.equal(result.code, '222222');
  assert.equal(sleeps[0], 7_500);
  assert.equal(calls, 3);
});

test('abort and malformed trust configuration fail with safe typed errors', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForVerification(attempt, {
    signal: controller.signal, mailClient: { fetchLatest: async () => [] },
  }), error => error.code === 'aborted' && !error.message.includes('SENTINEL-SECRET'));
  await assert.rejects(waitForVerification({ ...attempt, allowedOrigins: ['http://accounts.example'] }, {
    mailClient: { fetchLatest: async () => [] },
  }), MailError);
});

