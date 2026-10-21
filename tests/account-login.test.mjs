import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserSessionBootstrapper } from '../src/accounts/login.mjs';
import { validateSessionInput } from '../src/accounts/store.mjs';

const ACCOUNT = Object.freeze({
  id: '123e4567-e89b-42d3-a456-426614174000',
  email: 'Person+tag@example.com',
  provider: 'luuvan',
  mailAccessUrl: 'https://luuvan.site/?address=person%2Btag%40example.com',
});

async function makeRoot() {
  const base = await realpath(os.tmpdir());
  return mkdtemp(path.join(base, 'berserk-login-test-'));
}

function sessionResponse({ headers = {}, status = 200, body = { endpoint_url: 'https://gateway.example/api', vm_name: 'vm-test', vm_id: 'vm-id-test' }, method = 'GET', onJson = null } = {}) {
  return {
    url: () => 'https://muse.ai/api/session',
    status: () => status,
    async json() {
      const result = onJson?.();
      return result && typeof result.then === 'function' ? result : body;
    },
    request() { return { method: () => method, async allHeaders() { return headers; } }; },
  };
}

function otpResponse(email, {
  status = 200, body = { success: true, status: 'ok' }, onJson = null,
  omitContentLength = false, bodyBytes = null, onBody = null,
} = {}) {
  const request = {
    url: () => 'https://muse.ai/api/auth/native/send-otp',
    method: () => 'POST',
    postDataJSON: () => ({ contact_point: email }),
  };
  return {
    url: () => 'https://muse.ai/api/auth/native/send-otp',
    status: () => status,
    request: () => request,
    headers: () => omitContentLength ? {} : ({ 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }),
    async body() {
      const result = onBody?.();
      if (result && typeof result.then === 'function') return result;
      return bodyBytes ?? Buffer.from(JSON.stringify(body));
    },
    async json() {
      const result = onJson?.();
      return result && typeof result.then === 'function' ? result : body;
    },
  };
}

class FakePage extends EventEmitter {
  constructor({ sessionOnContinue = true, sessionResponseOptions = {}, sessionResponseSequence = null, sessionProbeSequence = null, sessionProbePending = false, manual = {}, tokenStatus = 200, tokenData = { accessToken: 'token-from-fake-official-endpoint' }, otpFlow = false, tokenPending = false, otpAccessibleNameOnly = false, continueLabel = 'Continue' } = {}) {
    super();
    this.currentUrl = 'about:blank';
    this.sessionOnContinue = sessionOnContinue;
    this.sessionResponseOptions = sessionResponseOptions;
    this.sessionResponseSequence = sessionResponseSequence;
    this.sessionProbeSequence = sessionProbeSequence;
    this.sessionProbePending = sessionProbePending;
    this.sessionProbeCalls = 0;
    this.sessionProbeHook = null;
    this.manual = manual;
    this.tokenStatus = tokenStatus;
    this.tokenData = tokenData;
    this.tokenPending = tokenPending;
    this.otpAccessibleNameOnly = otpAccessibleNameOnly;
    this.continueLabel = continueLabel;
    this.filledEmail = null;
    this.emailFieldValue = '';
    this.emailFillValues = [];
    this.emailSequentialInputs = [];
    this.continueClicks = 0;
    this.clickTimeouts = [];
    this.routeHandler = null;
    this.tokenRequest = null;
    this.defaultTimeout = null;
    this.broughtToFront = false;
    this.closed = false;
    this.otpFlow = otpFlow;
    this.otpVisible = false;
    this.enteredOtp = null;
    this.otpFillValues = [];
    this.otpSequentialInputs = [];
    this.otpEnterCount = 0;
    this.otpEnterTimeouts = [];
    this.otpSendCount = 0;
    this.routeReady = new Promise(resolve => { this.resolveRouteReady = resolve; });
  }

  setDefaultTimeout(ms) { this.defaultTimeout = ms; }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async goto(url) {
    if (url === 'https://muse.ai' && this.gotoError) throw this.gotoError;
    this.currentUrl = url;
    if (url === 'https://muse.ai' && this.manual.sessionResponseOnMuseGoto) {
      this.emit('response', sessionResponse(this.manual.sessionResponseOptions));
    }
    if (url === 'https://muse.ai' && this.manual.otpOnMuseGoto) {
      this.otpVisible = true;
      this.emit('response', otpResponse(this.manual.otpRecipient || 'person+tag@example.com', this.manual.otpResponseOptions));
    }
  }
  async bringToFront() { this.broughtToFront = true; }
  setEmailByFill(value) {
    this.emailFillValues.push(value);
    if (!this.manual.controlledEmailInput) {
      this.emailFieldValue = value;
      this.filledEmail = value;
    }
  }
  async typeEmailSequentially(value, options) {
    this.emailSequentialInputs.push({ value, options });
    this.emailFieldValue = value;
    this.filledEmail = value;
    if (this.manual.clearEmailAfterTyping) this.emailFieldValue = '';
  }
  readEmailValue() {
    if (this.manual.emailValueOverride !== undefined) return this.manual.emailValueOverride;
    return this.manual.controlledEmailInput ? this.emailFieldValue : (this.filledEmail ?? '');
  }
  async waitForRoute(timeoutMs = 5_000) {
    if (this.routeHandler) return;
    let timer;
    try {
      await Promise.race([this.routeReady, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('route installation timed out')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  async route(_pattern, handler) { this.routeHandler = handler; this.resolveRouteReady(); }
  async unroute(_pattern, handler) { if (this.routeHandler === handler) this.routeHandler = null; }

  locator(selector) {
    if (selector === 'input[type="email"]:visible') {
      const input = {
        count: async () => this.manual.emailInput === false || this.manual.emailType === 'text' ? 0 : 1,
        fill: async value => { this.setEmailByFill(value); },
      };
      if (!this.manual.omitInputValue) {
        input.inputValue = async () => this.readEmailValue();
      }
      if (!this.manual.omitPressSequentially) {
        input.pressSequentially = async (value, options) => this.typeEmailSequentially(value, options);
      }
      return input;
    }
    if (selector === 'input[autocomplete="one-time-code"]:visible') {
      const otpCount = () => this.manual.otpInputMissing || (this.manual.otpDisappearAfterFill && this.enteredOtp !== null)
        ? 0 : this.manual.otpInputAmbiguous ? 2 : this.otpVisible && !this.otpAccessibleNameOnly ? 1 : 0;
      return {
        count: async () => otpCount(),
        isVisible: async () => otpCount() === 1 && this.manual.otpVisible !== false,
        isEnabled: async () => {
          this.manual.otpOnEnabled?.();
          return otpCount() === 1 && this.manual.otpEnabled !== false;
        },
        inputValue: async () => this.manual.otpValueOverride ?? this.enteredOtp ?? '',
        fill: async value => {
          this.otpFillValues.push(value);
          if (value === '') this.manual.otpOnClear?.();
          if (this.manual.otpFillFails) throw new Error('private otp fill sentinel');
          if (value === '' || !this.manual.controlledOtpInput) this.enteredOtp = value;
        },
        ...(!this.manual.omitOtpPressSequentially ? { pressSequentially: async (value, options) => {
          this.otpSequentialInputs.push({ value, options });
          this.enteredOtp = value;
          this.manual.otpOnSequentially?.();
        } } : {}),
        ...(!this.manual.omitOtpPress ? { press: async (key, options) => {
          if (key === 'Enter') {
            this.otpEnterCount++;
            this.otpEnterTimeouts.push(options?.timeout ?? null);
            if (this.manual.otpPressFails) throw new Error('private OTP press sentinel');
            this.manual.otpOnEnter?.();
          }
        } } : {}),
      };
    }
    return { count: async () => 0 };
  }

  getByRole(role, { name } = {}) {
    const isContinue = role === 'button' && name instanceof RegExp && name.test(this.continueLabel);
    const isEmailTextbox = role === 'textbox' && name instanceof RegExp && /e-?mail|электрон|почт/i.test(String(name));
    const isOtpTextbox = role === 'textbox' && name instanceof RegExp && /code|код/i.test(String(name));
    return {
      count: async () => {
        if (isContinue) return this.manual.continue === false || (this.otpVisible && this.manual.continueMissingAfterOtp) ? 0 : 1;
        if (isEmailTextbox) return this.manual.emailInput === false ? 0 : 1;
        if (isOtpTextbox) return this.manual.otpInputMissing ? 0 : this.manual.otpInputAmbiguous ? 2 : this.otpVisible && this.otpAccessibleNameOnly ? 1 : 0;
        return 0;
      },
      isVisible: async () => isContinue ? this.manual.continueVisible !== false && !(this.otpVisible && this.manual.continueHiddenAfterOtp) : isEmailTextbox || isOtpTextbox,
      ...(!this.manual.omitIsEnabled && isContinue ? {
        isEnabled: async () => {
          this.manual.onContinueEnabled?.();
          return this.manual.continueEnabled !== false;
        },
      } : {}),
      ...(!this.manual.omitInputValue && isEmailTextbox ? {
        inputValue: async () => this.readEmailValue(),
      } : {}),
      ...(!this.manual.omitPressSequentially && isEmailTextbox ? {
        pressSequentially: async (value, options) => this.typeEmailSequentially(value, options),
      } : {}),
      fill: async value => {
        if (isOtpTextbox) {
          if (this.manual.otpFillFails) throw new Error('private otp fill sentinel');
          this.enteredOtp = value;
        }
        else if (isEmailTextbox) this.setEmailByFill(value);
      },
      click: async options => {
        this.continueClicks++;
        if (isContinue) this.clickTimeouts.push(options?.timeout ?? null);
        if (isContinue && this.manual.continueClickFails) throw new Error('private click failure sentinel');
        if (isContinue && this.manual.continueEnabled === false) {
          if (this.manual.enableOnClick === true) this.manual.continueEnabled = true;
          else throw new Error('private disabled click sentinel');
        }
        if (isContinue && this.manual.clearEmailOnContinueClick) {
          this.emailFieldValue = '';
          this.filledEmail = '';
        }
        if (this.otpFlow && this.otpSendCount === 0) {
          this.otpSendCount++;
          const sequence = this.otpResponseSequence ?? [{ body: this.otpResponseBody ?? { success: true, status: 'ok' } }];
          for (const responseOptions of sequence) {
            this.emit('response', otpResponse(this.filledEmail, responseOptions));
            this.otpResponseObserver?.(responseOptions.status ?? 200);
          }
          this.otpVisible = true;
          return;
        }
        if (this.sessionOnContinue || (this.otpFlow && this.enteredOtp)) {
          const responses = this.sessionResponseSequence ?? [this.sessionResponseOptions];
          for (const options of responses) this.emit('response', sessionResponse({ ...options, headers: {
            'user-agent': 'Fake Chrome', accept: 'application/json', cookie: 'private-cookie',
            authorization: 'private-header', 'x-hatch-device': 'device-metadata',
            'referer': 'https://muse.ai/login?private=query', 'sec-fetch-site': 'same-origin',
          } }));
        }
      },
    };
  }

  async evaluate(_fn, args) {
    if (args?.probeSession === true) {
      this.sessionProbeCalls++;
      this.sessionProbeHook?.(this.sessionProbeCalls, args);
      if (this.sessionProbePending) return new Promise(() => {});
      const status = this.sessionProbeSequence?.length ? this.sessionProbeSequence.shift() : 401;
      if (status === 200) this.emit('response', sessionResponse());
      return { status };
    }
    if (args && Object.hasOwn(args, 'endpointUrl')) {
      this.tokenRequest = args;
      this.tokenEvaluateHook?.();
      if (this.tokenPending) return new Promise(() => {});
      return { status: this.tokenStatus, data: this.tokenData };
    }
    if (this.manual.delayManualInspection) await new Promise(resolve => setImmediate(resolve));
    return {
      captcha: this.manual.captcha === true,
      terms: this.manual.terms === true,
      otp: this.manual.otp === true || (this.otpVisible && !this.manual.otpUndetectable),
      password: this.manual.password === true,
      accept: this.manual.accept === true,
      signIn: this.manual.signIn === true,
    };
  }

  async triggerContactPoint(email) {
    if (!this.routeHandler) throw new Error('route not installed');
    let aborted = false;
    await this.routeHandler({
      request: () => ({
        url: () => 'https://muse.ai/api/auth/native/send-otp', method: () => 'POST',
        postDataJSON: () => ({ contact_point: email }),
      }),
      async abort() { aborted = true; },
      async continue() {},
    });
    return aborted;
  }
}

class FakeContext {
  constructor(page) { this.page = page; this.allPages = [page]; this.closeCalls = 0; this.cookieOrigins = []; }
  pages() { return [...this.allPages]; }
  async newPage() { const page = new FakePage(); this.allPages.push(page); return page; }
  async cookies(origin) {
    this.cookieOrigins.push(origin);
    return [{ name: 'muse-session', value: 'private-cookie-value', domain: '.muse.ai', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax' }];
  }
  async close() { this.closeCalls++; this.page.manual.onContextClose?.(); this.page.closed = true; }
}

function fakeChromium({ page = new FakePage(), launchCalls = [] } = {}) {
  const context = new FakeContext(page);
  return {
    context,
    page,
    chromium: {
      async launchPersistentContext(profileDir, options) {
        launchCalls.push({ profileDir, options });
        return context;
      },
    },
  };
}

test('returns a validated session bundle from only Muse session response and official token exchange', async () => {
  const rootDir = await makeRoot();
  const launchCalls = [];
  const fake = fakeChromium({ launchCalls });
  let mailCalls = 0;
  const progress = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, browserExecutable: null, rootDir,
      pollMs: 1,
      mailClient: { async fetchLatest() { mailCalls++; return []; } },
    });
    const session = await bootstrapper.login(ACCOUNT, { setProgress: value => progress.push(value) });
    assert.deepEqual(session, {
      schemaVersion: 1,
      cookies: [{ name: 'muse-session', value: 'private-cookie-value', domain: '.muse.ai', path: '/', expires: -1,
        httpOnly: true, secure: true, sameSite: 'Lax' }],
      tokens: { accessToken: 'token-from-fake-official-endpoint' },
      device: { id: session.device.id, headers: {
        'user-agent': 'Fake Chrome', accept: 'application/json', 'x-hatch-device': 'device-metadata',
        referer: 'https://muse.ai/login', 'sec-fetch-site': 'same-origin',
      } },
      upstream: { gatewayUrl: 'https://gateway.example/api', vmName: 'vm-test', vmId: 'vm-id-test' },
      expiresAt: null,
    });
    assert.match(session.device.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(fake.page.filledEmail, 'person+tag@example.com');
    assert.equal(fake.page.continueClicks, 1);
    assert.deepEqual(fake.page.tokenRequest, { endpointUrl: 'https://gateway.example/api', vmName: 'vm-test', timeoutMs: 30_000 });
    assert.equal(fake.context.cookieOrigins[0], 'https://muse.ai');
    assert.equal(fake.context.closeCalls, 1);
    assert.equal(fake.page.broughtToFront, true);
    assert.deepEqual(launchCalls[0].options, {
      channel: 'chrome', headless: false, chromiumSandbox: true,
      viewport: { width: 1200, height: 850 }, acceptDownloads: false, timeout: 30_000,
    });
    assert.equal(launchCalls[0].profileDir, path.join(rootDir, ACCOUNT.id, 'login-browser'));
    assert.deepEqual(progress, [5, 15, 25, 65, 95, 100]);
    assert.equal(mailCalls, 0, 'mail polling begins only after Muse confirms an OTP was sent');
    await assert.rejects(lstat(launchCalls[0].profileDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('uses an explicitly resolved browser executable instead of the Chrome channel fallback', async () => {
  const rootDir = await makeRoot();
  const launchCalls = [];
  const fake = fakeChromium({ launchCalls });
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium,
      browserExecutable: '/test/bin/chromium',
      rootDir,
      pollMs: 1,
    });
    await bootstrapper.login(ACCOUNT);
    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].options.executablePath, '/test/bin/chromium');
    assert.equal(Object.hasOwn(launchCalls[0].options, 'channel'), false);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('omits absent, null, and empty optional vm_name while preserving valid session input', async () => {
  for (const vmName of [undefined, null, '  ']) {
    const rootDir = await makeRoot();
    const options = { endpoint_url: 'https://gateway.example/api', vm_id: 'vm-id-test' };
    if (vmName !== undefined) options.vm_name = vmName;
    const fake = fakeChromium({ page: new FakePage({ sessionResponseOptions: { body: options } }) });
    try {
      const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir, pollMs: 1 });
      const session = await bootstrapper.login(ACCOUNT);
      assert.deepEqual(session.upstream, { gatewayUrl: 'https://gateway.example/api', vmId: 'vm-id-test' });
      assert.equal(Object.hasOwn(session.upstream, 'vmName'), false);
      assert.equal(Object.hasOwn(fake.page.tokenRequest, 'vmName'), false);
      assert.deepEqual(validateSessionInput({
        cookies: session.cookies,
        tokens: session.tokens,
        device: { ...session.device, upstream: session.upstream },
      }).device.upstream, session.upstream);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('captures a secure WebSocket gateway descriptor and stores it in a validated session', async () => {
  const rootDir = await makeRoot();
  const endpointUrl = 'wss://test.metaaivm.com/';
  const fake = fakeChromium({ page: new FakePage({ sessionResponseOptions: { body: {
    endpoint_url: endpointUrl, vm_name: 'test-vm', vm_id: 'test-vm-id',
  } } }) });
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir, pollMs: 1 });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(session.upstream.gatewayUrl, endpointUrl);
    assert.equal(fake.page.tokenRequest.endpointUrl, endpointUrl);
    const validated = validateSessionInput({
      cookies: session.cookies,
      tokens: session.tokens,
      device: { ...session.device, upstream: session.upstream },
    });
    assert.deepEqual(validated.device.upstream, session.upstream);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects invalid or overlong nonempty vm_name without exchanging a token', async () => {
  for (const vmName of [42, 'x'.repeat(256)]) {
    const rootDir = await makeRoot();
    const fake = fakeChromium({ page: new FakePage({ sessionResponseOptions: {
      body: { endpoint_url: 'https://gateway.example/api', vm_name: vmName, vm_id: 'vm-id-test' },
    } }) });
    try {
      const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir, timeoutMs: 30, manualTimeoutMs: 5, pollMs: 1 });
      await assert.rejects(bootstrapper.login(ACCOUNT));
      assert.equal(fake.page.tokenRequest, null);
      assert.deepEqual(fake.context.cookieOrigins, []);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('reports bounded safe metadata for exact Muse GET session responses and parses only HTTP 200', async () => {
  const rootDir = await makeRoot();
  let non200BodyReads = 0;
  const fake = fakeChromium({ page: new FakePage({ sessionResponseSequence: [
    { status: 401, body: { private: 'response sentinel' }, onJson: () => non200BodyReads++ },
    { status: 403, body: { private: 'response sentinel' }, onJson: () => non200BodyReads++ },
    { status: 200, body: { endpoint_url: 'https://gateway.example/api', vm_id: 'vm-id-test' } },
    { status: 200, body: { endpoint_url: 'https://gateway.example/api', vm_id: 'vm-id-test' } },
    { status: 202, body: { private: 'response sentinel' }, onJson: () => non200BodyReads++ },
    { status: 200, method: 'POST', body: { private: 'response sentinel' }, onJson: () => non200BodyReads++ },
  ] }) });
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir, pollMs: 1,
      onDiagnostic: event => diagnostics.push(event) });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(session.upstream.vmName, undefined);
    assert.equal(non200BodyReads, 0);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'session_response'), [
      { stage: 'session_response', httpStatus: 401, bodyParsed: false, endpointPresent: false, vmIdPresent: false, vmNamePresent: false, accepted: false },
      { stage: 'session_response', httpStatus: 403, bodyParsed: false, endpointPresent: false, vmIdPresent: false, vmNamePresent: false, accepted: false },
      { stage: 'session_response', httpStatus: 200, bodyParsed: true, endpointPresent: true, vmIdPresent: true, vmNamePresent: false, accepted: true },
    ]);
    assert.equal(JSON.stringify(diagnostics).includes('response sentinel'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('discovers an OTP-autoverified Muse session without a passive session response or OTP continue button', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({
    otpFlow: true, sessionOnContinue: false, sessionProbeSequence: [200],
    manual: { continueMissingAfterOtp: true, controlledOtpInput: true },
  }) });
  let now = 10_000;
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100, manualTimeoutMs: 500, pollMs: 1, clock: () => now,
      sleep: async ms => { now += ms; },
      onDiagnostic: event => diagnostics.push(event),
      mailClient: { async fetchLatest() { return [{
        id: 'message-1', from: 'notification@email.meta.com', to: 'person+tag@example.com',
        receivedAt: new Date(10_000).toISOString(), subject: 'Verification', text: 'Code: 123456',
      }]; } },
    });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.equal(fake.page.enteredOtp, '123456');
    assert.deepEqual(fake.page.otpFillValues, ['']);
    assert.deepEqual(fake.page.otpSequentialInputs, [{ value: '123456', options: { delay: 20, timeout: 5_000 } }]);
    assert.equal(fake.page.continueClicks, 1, 'only the initial email submit was clicked');
    assert.equal(fake.page.otpEnterCount, 1);
    assert.deepEqual(fake.page.otpEnterTimeouts, [5_000]);
    assert.equal(fake.page.sessionProbeCalls, 1);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'otp_submit'), [
      { stage: 'otp_submit', outcome: 'submitted_enter' },
    ]);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('manual completion can discover an already-authenticated session through the Muse page probe', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({
    sessionOnContinue: false, sessionProbeSequence: [200], manual: { password: true },
  }) });
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100, manualTimeoutMs: 500, pollMs: 1, sleep: async () => {},
    });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.equal(fake.page.sessionProbeCalls, 1);
    assert.equal(fake.page.continueClicks, 0);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('missing or disabled OTP input never triggers the Enter fallback', async () => {
  for (const item of [
    { manual: { continueMissingAfterOtp: true, otpDisappearAfterFill: true }, outcome: 'input_missing' },
    { manual: { continueMissingAfterOtp: true, otpEnabled: false }, outcome: 'input_disabled' },
  ]) {
    const rootDir = await makeRoot();
    const fake = fakeChromium({ page: new FakePage({
      otpFlow: true, sessionOnContinue: false, sessionProbeSequence: [401], manual: item.manual,
    }) });
    let now = 10_000;
    const diagnostics = [];
    try {
      const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
        timeoutMs: 100, manualTimeoutMs: 8, pollMs: 1, clock: () => now,
        sleep: async ms => { now += ms; },
        mailClient: { async fetchLatest() { return [{
          id: 'message-1', from: 'notification@email.meta.com', to: 'person+tag@example.com',
          receivedAt: new Date(10_000).toISOString(), subject: 'Verification', text: 'Code: 123456',
        }]; } },
        onDiagnostic: event => diagnostics.push(event),
      });
      await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
      assert.equal(fake.page.otpEnterCount, 0);
      assert.equal(fake.page.continueClicks, 1);
      assert.deepEqual(diagnostics.filter(event => event.stage === 'otp_submit'), [
        { stage: 'otp_submit', outcome: item.outcome },
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('abort before the OTP Enter action does not press the key or start a session probe', async () => {
  const rootDir = await makeRoot();
  const controller = new AbortController();
  let now = 10_000;
  const fake = fakeChromium({ page: new FakePage({
    otpFlow: true, sessionOnContinue: false, sessionProbeSequence: [200],
    manual: { continueMissingAfterOtp: true, otpOnEnabled: () => controller.abort() },
  }) });
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 1_000, manualTimeoutMs: 500, pollMs: 1, clock: () => now, sleep: async () => { now += 1; },
      mailClient: { async fetchLatest() { return [{
        id: 'message-1', from: 'notification@email.meta.com', to: 'person+tag@example.com',
        receivedAt: new Date(10_000).toISOString(), subject: 'Verification', text: 'Code: 123456',
      }]; } },
    });
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    assert.equal(fake.page.otpEnterCount, 0);
    assert.equal(fake.page.sessionProbeCalls, 0);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('abort after clearing OTP prevents sequential typing and Enter', async () => {
  const rootDir = await makeRoot();
  const controller = new AbortController();
  let now = 10_000;
  const fake = fakeChromium({ page: new FakePage({
    otpFlow: true, sessionOnContinue: false,
    manual: { otpOnClear: () => controller.abort() },
  }) });
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 1_000, manualTimeoutMs: 500, pollMs: 1, clock: () => now, sleep: async () => { now += 1; },
      mailClient: { async fetchLatest() { return [{
        id: 'message-1', from: 'notification@email.meta.com', to: 'person+tag@example.com',
        receivedAt: new Date(10_000).toISOString(), subject: 'Verification', text: 'Code: 123456',
      }]; } },
    });
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    assert.deepEqual(fake.page.otpFillValues, ['']);
    assert.deepEqual(fake.page.otpSequentialInputs, []);
    assert.equal(fake.page.otpEnterCount, 0);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('session probe retries only after ten seconds and permits a later 200 after an unauthorized response', async () => {
  const rootDir = await makeRoot();
  let now = 20_000;
  const fake = fakeChromium({ page: new FakePage({
    sessionOnContinue: false, sessionProbeSequence: [401, 200], manual: { password: true },
  }) });
  const probeTimes = [];
  fake.page.sessionProbeHook = (_count, args) => {
    probeTimes.push(now);
    assert.ok(args.timeoutMs > 0 && args.timeoutMs <= 10_000);
  };
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100_000, manualTimeoutMs: 30_000, pollMs: 1_000, clock: () => now,
      sleep: async ms => { now += ms; },
    });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.deepEqual(fake.page.sessionProbeCalls, 2);
    assert.equal(probeTimes.length, 2);
    assert.ok(probeTimes[1] - probeTimes[0] >= 10_000);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('abort interrupts a hung session probe and closes the owned context', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({
    sessionOnContinue: false, sessionProbePending: true, manual: { password: true },
  }) });
  const controller = new AbortController();
  let probeStartedResolve;
  const probeStarted = new Promise(resolve => { probeStartedResolve = resolve; });
  fake.page.sessionProbeHook = () => probeStartedResolve();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100_000, manualTimeoutMs: 60_000, pollMs: 1_000, sleep: async () => {},
    });
    const login = bootstrapper.login(ACCOUNT, { signal: controller.signal });
    await probeStarted;
    controller.abort();
    await assert.rejects(login, error => error.code === 'aborted');
    assert.equal(fake.page.sessionProbeCalls, 1);
    assert.equal(fake.context.closeCalls, 1);
    assert.deepEqual(fake.context.cookieOrigins, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('session probe is skipped when the owned page is not on the Muse origin', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: { password: true } }) });
  fake.page.gotoError = new Error('private navigation rejection');
  let now = 0;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 20, manualTimeoutMs: 5, pollMs: 1, clock: () => now,
      sleep: async ms => { now += ms; },
    });
    await assert.rejects(bootstrapper.login(ACCOUNT));
    assert.equal(fake.page.sessionProbeCalls, 0);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('submits a fresh OTP from the exact verified sender and account recipient', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  let now = 10_000;
  let mailCalls = 0;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 100, pollMs: 1,
      clock: () => now,
      sleep: async ms => { if (ms < 3_000) now += 1; },
      mailClient: {
        async fetchLatest() {
          mailCalls++;
          return [{
            id: 'message-1', from: 'notification@email.meta.com', to: 'person+tag@example.com',
            receivedAt: new Date(10_000).toISOString(), subject: 'Your verification code', text: 'Code: 123456',
          }];
        },
      },
    });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(fake.page.enteredOtp, '123456');
    assert.equal(fake.page.otpSendCount, 1);
    assert.ok(mailCalls >= 1);
    assert.equal(JSON.stringify(session).includes('123456'), false);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('falls back to the user after a mail provider error and opens one owned mail tab', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  const phases = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 100, manualTimeoutMs: 500, pollMs: 1,
      sleep: async () => {},
      mailClient: { async fetchLatest() { const error = new Error('private mail error'); error.code = 'needs_mail_auth'; throw error; } },
    });
    const session = await bootstrapper.login(ACCOUNT, {
      setPhase: phase => {
        phases.push(phase);
        if (phase === 'waiting_for_user') fake.page.emit('response', sessionResponse());
      },
    });
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.deepEqual(phases.filter(phase => phase === 'waiting_for_user'), ['waiting_for_user']);
    assert.equal(fake.context.allPages.length, 2);
    assert.equal(fake.context.allPages[1].currentUrl, ACCOUNT.mailAccessUrl);
    assert.equal(fake.page.broughtToFront, true);
    assert.ok(phases.every(phase => ['opening_browser', 'requesting_code', 'reading_mail', 'waiting_for_user', 'saving_session'].includes(phase)));
    assert.equal(JSON.stringify(phases).includes('private mail error'), false);
    assert.equal(JSON.stringify(phases).includes('Person+tag@example.com'), false);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

for (const [name, message] of [
  ['mismatched sender', { from: 'attacker@example.net', to: 'person+tag@example.com', receivedAt: new Date(10_000).toISOString() }],
  ['mismatched recipient', { from: 'notification@email.meta.com', to: 'other@example.com', receivedAt: new Date(10_000).toISOString() }],
  ['message received before the successful send', { from: 'notification@email.meta.com', to: 'person+tag@example.com', receivedAt: new Date(9_999).toISOString() }],
]) {
  test(`never submits an OTP from a ${name}`, async () => {
    const rootDir = await makeRoot();
    const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
    let now = 10_000;
    try {
      const bootstrapper = new BrowserSessionBootstrapper({
        chromium: fake.chromium, rootDir, timeoutMs: 30, pollMs: 1,
        clock: () => now,
        sleep: async ms => { if (ms < 3_000) now += 1; },
        mailClient: { async fetchLatest() { return [{ id: `bad-${name}`, ...message, subject: 'Code 654321', text: '654321' }]; } },
      });
      await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
      assert.equal(fake.page.enteredOtp, null);
      assert.equal(fake.page.continueClicks, 1, 'only the email step sent the OTP; no OTP submit occurred');
      assert.equal(fake.context.closeCalls, 1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
}

test('keeps Gmail verification manual when its own OAuth authorization is missing', async () => {
  const rootDir = await makeRoot();
  const account = { ...ACCOUNT, provider: 'gmail', mailAccessUrl: 'https://mail.google.com/' };
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  const phases = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 100, manualTimeoutMs: 500, pollMs: 1,
      sleep: async () => {},
      mailClient: { async fetchLatest() { const error = new Error('OAuth required'); error.code = 'needs_mail_auth'; throw error; } },
    });
    const session = await bootstrapper.login(account, {
      setPhase: phase => {
        phases.push(phase);
        if (phase === 'waiting_for_user') fake.page.emit('response', sessionResponse());
      },
    });
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.ok(phases.includes('waiting_for_user'));
    assert.equal(fake.page.enteredOtp, null);
    assert.equal(fake.context.allPages.length, 2);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

for (const host of ['generator.email', 'www.generator.email']) {
  test(`generator provider submits a fresh automatic OTP for ${host}`, async () => {
    const rootDir = await makeRoot();
    const mailAccessUrl = `https://${host}/person%2Btag%40example.com`;
    const account = { ...ACCOUNT, provider: 'generator', mailAccessUrl };
    const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
    let mailCalls = 0;
    const phases = [];
    const diagnostics = [];
    let expectedEmail;
    let now = 10_000;
    try {
      const bootstrapper = new BrowserSessionBootstrapper({
        chromium: fake.chromium, rootDir, timeoutMs: 100, manualTimeoutMs: 500, pollMs: 1,
        clock: () => now,
        sleep: async () => { now += 1; },
        mailClient: {
          detect: () => 'generator',
          async fetchLatest(_provider, _url, options) {
            mailCalls++;
            expectedEmail = options.expectedEmail;
            return [{ id: `message-${mailCalls}`, from: 'notification@email.meta.com', to: 'person+tag@example.com',
              receivedAt: new Date(10_000).toISOString(), subject: 'Your verification code', text: 'Code: 123456' }];
          },
        },
        onDiagnostic: event => diagnostics.push(event),
      });
      const session = await bootstrapper.login(account, { setPhase: phase => phases.push(phase) }).catch(error => {
        assert.deepEqual(diagnostics.find(event => event.stage === 'email_submit'), {
          stage: 'email_submit', outcome: 'submitted', buttonCount: 'one', buttonVisible: true,
          buttonEnabled: true, emailMatches: true,
        });
        throw error;
      });
      assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
      assert.ok(mailCalls >= 1);
      assert.equal(expectedEmail, 'person+tag@example.com');
      assert.equal(fake.page.enteredOtp, '123456');
      assert.ok(phases.includes('reading_mail'));
      assert.equal(phases.includes('waiting_for_user'), false);
      assert.equal(fake.context.allPages.length, 1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
}

test('a visible sign-in button does not interrupt a named text email field; Next submits the OTP', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({
    manual: { signIn: true, emailType: 'text' }, otpFlow: true, sessionOnContinue: false,
    otpAccessibleNameOnly: true, continueLabel: 'Далее',
  }) });
  let now = 10_000;
  const phases = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 100, pollMs: 1,
      clock: () => now, sleep: async () => { now += 1; },
      mailClient: {
        async fetchLatest(_provider, _url, options) {
          assert.equal(options.expectedEmail, 'person+tag@example.com');
          return [{ id: 'message-text-email', from: 'notification@email.meta.com', to: 'person+tag@example.com',
            receivedAt: new Date(10_000).toISOString(), subject: 'Your verification code', text: 'Code: 123456' }];
        },
      },
    });
    const session = await bootstrapper.login(ACCOUNT, { setPhase: phase => phases.push(phase) });
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.equal(fake.page.filledEmail, 'person+tag@example.com');
    assert.equal(fake.page.enteredOtp, '123456');
    assert.equal(fake.page.continueClicks, 2);
    assert.equal(phases.includes('waiting_for_user'), false);
    assert.ok(phases.includes('reading_mail'));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('a computed-label OTP field prevents the sign-in header from forcing manual mode when email is absent', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: true, manual: {
    signIn: true, emailInput: false, otpUndetectable: true, otpOnMuseGoto: true,
    otpRecipient: 'person+tag@example.com',
  }, otpAccessibleNameOnly: true }) });
  const diagnostics = [];
  const phases = [];
  const now = 10_000;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100, manualTimeoutMs: 8, pollMs: 1,
      clock: () => now, sleep: async () => {},
      mailClient: {
        detect: () => 'luuvan',
        async fetchLatest(_provider, _url, options) {
          assert.equal(options.expectedEmail, 'person+tag@example.com');
          return [{ id: 'synthetic-otp', from: 'notification@email.meta.com', to: options.expectedEmail,
            receivedAt: new Date(now).toISOString(), subject: 'Verification code', text: 'Code: 123456' }];
        },
      },
      onDiagnostic: event => diagnostics.push(event) });
    const session = await bootstrapper.login(ACCOUNT, { setPhase: phase => phases.push(phase) });
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.equal(fake.page.filledEmail, null);
    assert.equal(fake.page.enteredOtp, '123456');
    assert.equal(fake.page.continueClicks, 1);
    assert.equal(phases.includes('waiting_for_user'), false);
    assert.deepEqual(diagnostics.filter(event => ['verification', 'otp_submit'].includes(event.stage)), [
      { stage: 'verification', outcome: 'ready' },
      { stage: 'otp_submit', outcome: 'submitted' },
    ]);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes('123456'), false);
    assert.equal(serialized.includes('person+tag@example.com'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('a manual CAPTCHA discovered after mail readiness reports interaction_required without submitting OTP', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: {
    signIn: true, emailInput: false, otpUndetectable: true, otpOnMuseGoto: true,
    otpRecipient: 'person+tag@example.com', delayManualInspection: true,
  }, otpAccessibleNameOnly: true }) });
  const diagnostics = [];
  let now = 10_000;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100, manualTimeoutMs: 8, pollMs: 1,
      clock: () => now, sleep: async () => { now += 1; },
      mailClient: {
        detect: () => 'luuvan',
        async fetchLatest(_provider, _url, options) {
          return [{ id: 'synthetic-otp', from: 'notification@email.meta.com', to: options.expectedEmail,
            receivedAt: new Date(10_000).toISOString(), subject: 'Verification code', text: 'Code: 123456' }];
        },
      },
      onDiagnostic: event => {
        diagnostics.push(event);
        if (event.stage === 'verification' && event.outcome === 'ready') fake.page.manual.captcha = true;
      } });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
    assert.equal(fake.page.enteredOtp, null);
    assert.equal(fake.page.continueClicks, 0);
    assert.deepEqual(diagnostics.filter(event => ['verification', 'otp_submit'].includes(event.stage)), [
      { stage: 'verification', outcome: 'ready' },
      { stage: 'otp_submit', outcome: 'interaction_required' },
    ]);
    assert.equal(JSON.stringify(diagnostics).includes('123456'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('terminal mail outcomes are reduced to the fixed verification enum', async () => {
  for (const item of [
    { code: 'verification_timeout', outcome: 'verification_timeout', finalCode: 'needs_user_interaction' },
    { code: 'needs_mail_auth', outcome: 'needs_mail_auth', finalCode: 'needs_user_interaction' },
    { code: 'mail_timeout', outcome: 'mail_timeout', finalCode: 'needs_user_interaction' },
    { code: 'mail_unavailable', outcome: 'mail_unavailable', finalCode: 'needs_user_interaction' },
    { code: 'mail_auth_failed', outcome: 'mail_auth_failed', finalCode: 'needs_user_interaction' },
    { code: 'mail_response_invalid', outcome: 'mail_response_invalid', finalCode: 'needs_user_interaction' },
    { code: 'mail_rate_limited', outcome: 'mail_rate_limited', finalCode: 'needs_user_interaction' },
    { code: 'private-error-code-sentinel', outcome: 'unknown', finalCode: 'needs_user_interaction' },
  ]) {
    const rootDir = await makeRoot();
    const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
    const diagnostics = [];
    try {
      const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
        timeoutMs: 100, manualTimeoutMs: 8, pollMs: 1,
        mailClient: { async fetchLatest() {
          const error = new Error('private-mail-content-sentinel');
          error.code = item.code;
          throw error;
        } },
        onDiagnostic: event => diagnostics.push(event) });
      await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === item.finalCode);
      assert.deepEqual(diagnostics.filter(event => event.stage === 'verification'), [
        { stage: 'verification', outcome: item.outcome },
      ]);
      assert.equal(diagnostics.some(event => event.stage === 'otp_submit'), false);
      const serialized = JSON.stringify(diagnostics);
      assert.equal(serialized.includes('private-mail-content-sentinel'), false);
      assert.equal(serialized.includes('private-error-code-sentinel'), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('external abort during a pending mail poll suppresses verification and OTP submit diagnostics', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  const controller = new AbortController();
  const diagnostics = [];
  let fetchStarted = false;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 1_000, manualTimeoutMs: 100, pollMs: 1,
      sleep: async () => { if (fetchStarted) controller.abort(); },
      mailClient: {
        detect: () => 'luuvan',
        async fetchLatest(_provider, _url, { signal }) {
          fetchStarted = true;
          return new Promise(resolve => signal.addEventListener('abort', () => resolve([]), { once: true }));
        },
      },
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    assert.equal(fetchStarted, true);
    assert.deepEqual(diagnostics.filter(event => ['verification', 'otp_submit'].includes(event.stage)), []);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('OTP submit reports missing input once, then reports the specific terminal field/button outcome', async () => {
  for (const item of [
    { manual: { otpInputMissing: true }, outcome: 'input_missing', finalCode: 'needs_user_interaction' },
    { manual: { otpInputAmbiguous: true }, outcome: 'input_ambiguous', finalCode: 'needs_user_interaction' },
    { manual: { continueMissingAfterOtp: true, otpDisappearAfterFill: true }, outcome: 'input_missing', finalCode: 'needs_user_interaction' },
    { manual: { continueMissingAfterOtp: true, otpVisible: false }, outcome: 'input_hidden', finalCode: 'needs_user_interaction' },
    { manual: { continueMissingAfterOtp: true, otpEnabled: false }, outcome: 'input_disabled', finalCode: 'needs_user_interaction' },
    { manual: { continueMissingAfterOtp: true, otpValueOverride: 'stale-code' }, outcome: 'input_value_changed', finalCode: 'needs_user_interaction' },
    { manual: { continueMissingAfterOtp: true, omitOtpPress: true, omitOtpPressSequentially: true }, outcome: 'button_unavailable', finalCode: 'needs_user_interaction' },
    { manual: { otpFillFails: true }, outcome: 'failed', finalCode: 'needs_user_interaction' },
  ]) {
    const rootDir = await makeRoot();
    const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false, manual: item.manual }) });
    const diagnostics = [];
    let now = 10_000;
    try {
      const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
        timeoutMs: 100, manualTimeoutMs: 8, pollMs: 1,
        clock: () => now, sleep: async () => { now += 1; },
        mailClient: {
          detect: () => 'luuvan',
          async fetchLatest(_provider, _url, options) {
            return [{ id: 'synthetic-otp', from: 'notification@email.meta.com', to: options.expectedEmail,
              receivedAt: new Date(now).toISOString(), subject: 'Verification code', text: 'Code: 123456' }];
          },
        },
        onDiagnostic: event => diagnostics.push(event) });
      await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === item.finalCode);
      assert.deepEqual(diagnostics.filter(event => event.stage === 'otp_submit'), [
        { stage: 'otp_submit', outcome: item.outcome },
      ]);
      assert.equal(fake.page.continueClicks, 1, 'only the send-code click occurred');
      const serialized = JSON.stringify(diagnostics);
      assert.equal(serialized.includes('123456'), false);
      assert.equal(serialized.includes('person+tag@example.com'), false);
      assert.equal(serialized.includes('private otp fill sentinel'), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('email submission failures hand off once with fixed button-state diagnostics', async () => {
  for (const item of [
    { manual: { continue: false }, outcome: 'button_missing', count: 'none', visible: null, enabled: null, clicks: 0 },
    { manual: { continueEnabled: false }, outcome: 'button_disabled', count: 'one', visible: true, enabled: false, clicks: 1 },
    { manual: { continueClickFails: true }, outcome: 'click_failed', count: 'one', visible: true, enabled: true, clicks: 1 },
  ]) {
    const rootDir = await makeRoot();
    const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: item.manual }) });
    const diagnostics = [];
    const phases = [];
    try {
      const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
        timeoutMs: 100, manualTimeoutMs: 8, pollMs: 1,
        mailClient: { async fetchLatest() { throw new Error('must not poll before a submitted request'); } },
        onDiagnostic: event => diagnostics.push(event) });
      await assert.rejects(bootstrapper.login(ACCOUNT, { setPhase: phase => phases.push(phase) }),
        error => error.code === 'needs_user_interaction');
      assert.deepEqual(diagnostics.filter(event => event.stage === 'email_submit'), [{
        stage: 'email_submit', outcome: item.outcome, buttonCount: item.count,
        buttonVisible: item.visible, buttonEnabled: item.enabled, emailMatches: true,
      }]);
      assert.equal(fake.page.continueClicks, item.clicks);
      assert.equal(fake.page.filledEmail, 'person+tag@example.com');
      assert.ok(phases.includes('waiting_for_user'));
      assert.equal(phases.includes('reading_mail'), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('email diagnostic says submitted only after one continue click, including older locators without isEnabled', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ manual: { omitIsEnabled: true } }) });
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      onDiagnostic: event => diagnostics.push(event) });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.equal(fake.page.continueClicks, 1);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'email_submit'), [{
      stage: 'email_submit', outcome: 'submitted', buttonCount: 'one', buttonVisible: true, buttonEnabled: true,
      emailMatches: true,
    }]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('email submit waits for one initially disabled button click and reports only whether the value remains', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ manual: {
    emailType: 'text', continueEnabled: false, enableOnClick: true, clearEmailOnContinueClick: true,
  } }) });
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      onDiagnostic: event => diagnostics.push(event) });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.equal(fake.page.continueClicks, 1);
    assert.deepEqual(fake.page.clickTimeouts, [5_000]);
    const event = diagnostics.find(item => item.stage === 'email_submit');
    assert.deepEqual(event, {
      stage: 'email_submit', outcome: 'submitted', buttonCount: 'one', buttonVisible: true,
      buttonEnabled: true, emailMatches: false,
    });
    assert.equal(JSON.stringify(event).includes('person+tag@example.com'), false);
    assert.equal(fake.page.readEmailValue(), '');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('controlled email input ignores fill but accepts one sequential typing pass before the single submit', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ manual: { controlledEmailInput: true } }) });
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      onDiagnostic: event => diagnostics.push(event) });
    const session = await bootstrapper.login(ACCOUNT);
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.deepEqual(fake.page.emailFillValues, ['']);
    assert.deepEqual(fake.page.emailSequentialInputs, [{
      value: 'person+tag@example.com', options: { delay: 20, timeout: 10_000 },
    }]);
    assert.equal(fake.page.readEmailValue(), 'person+tag@example.com');
    assert.equal(fake.page.continueClicks, 1);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'email_submit'), [{
      stage: 'email_submit', outcome: 'submitted', buttonCount: 'one', buttonVisible: true,
      buttonEnabled: true, emailMatches: true,
    }]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('email value cleared after sequential typing hands off without clicking or polling mail', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: {
    controlledEmailInput: true, clearEmailAfterTyping: true,
  } }) });
  const diagnostics = [];
  const phases = [];
  let mailCalls = 0;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100, manualTimeoutMs: 8, pollMs: 1,
      mailClient: { async fetchLatest() { mailCalls++; return []; } },
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT, { setPhase: phase => phases.push(phase) }),
      error => error.code === 'needs_user_interaction');
    assert.deepEqual(fake.page.emailSequentialInputs, [{
      value: 'person+tag@example.com', options: { delay: 20, timeout: 10_000 },
    }]);
    assert.equal(fake.page.readEmailValue(), '');
    assert.equal(fake.page.continueClicks, 0);
    assert.equal(mailCalls, 0);
    assert.ok(phases.includes('waiting_for_user'));
    assert.deepEqual(diagnostics.filter(event => event.stage === 'email_submit'), [{
      stage: 'email_submit', outcome: 'email_not_retained', buttonCount: 'one', buttonVisible: true,
      buttonEnabled: true, emailMatches: false,
    }]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('email submission cancellation does not click or emit diagnostics after abort', async () => {
  const rootDir = await makeRoot();
  const controller = new AbortController();
  const fake = fakeChromium({ page: new FakePage({ manual: {
    onContinueEnabled: () => controller.abort(),
  } }) });
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    assert.equal(fake.page.continueClicks, 0);
    assert.deepEqual(diagnostics, []);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('a mail fetch resolving after manual handoff cannot auto-fill or submit its OTP', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  let now = 10_000;
  let resolveMail;
  let fetchStarted = false;
  let resolvedAfterHandoff = false;
  const phases = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 100, manualTimeoutMs: 500, pollMs: 1,
      clock: () => now, sleep: async () => { now += 1; },
      mailClient: {
        async fetchLatest(_provider, _url, options) {
          assert.equal(options.expectedEmail, 'person+tag@example.com');
          fetchStarted = true;
          fake.page.manual.captcha = true;
          return new Promise(resolve => { resolveMail = resolve; });
        },
      },
    });
    const session = await bootstrapper.login(ACCOUNT, { setPhase: phase => {
      phases.push(phase);
      if (phase === 'waiting_for_user') {
        if (resolveMail) {
          resolveMail([{ id: 'late-message', from: 'notification@email.meta.com', to: 'person+tag@example.com',
            receivedAt: new Date(10_000).toISOString(), subject: 'Your verification code', text: 'Code: 123456' }]);
          resolvedAfterHandoff = true;
        }
        fake.page.emit('response', sessionResponse());
      }
    } });
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.equal(fetchStarted, true);
    assert.equal(resolvedAfterHandoff, true);
    assert.equal(fake.page.enteredOtp, null);
    assert.equal(fake.page.continueClicks, 1, 'only the initial request-code click is made');
    assert.ok(phases.includes('waiting_for_user'));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a Luuvan URL query bound to another mailbox before opening the browser', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir });
    await assert.rejects(bootstrapper.login({
      ...ACCOUNT, mailAccessUrl: 'https://luuvan.site/?address=other%40example.com',
    }), error => error.code === 'invalid_account');
    assert.equal(fake.context.closeCalls, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a generator mailbox URL whose path belongs to another account', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir });
    await assert.rejects(bootstrapper.login({
      ...ACCOUNT, provider: 'generator', mailAccessUrl: 'https://www.generator.email/other%40example.com',
    }), error => error.code === 'invalid_account');
    assert.equal(fake.context.closeCalls, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('manual wait is bounded and abort closes the owned context', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: { password: true } }) });
  let now = 0;
  const controller = new AbortController();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 8, manualTimeoutMs: 12, pollMs: 3,
      clock: () => now,
      sleep: async ms => { now += ms; },
    });
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'needs_user_interaction');
    assert.ok(now <= 20);
    assert.equal(fake.context.closeCalls, 1);
    const second = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: { password: true } }) });
    const aborting = new BrowserSessionBootstrapper({
      chromium: second.chromium, rootDir, timeoutMs: 100, manualTimeoutMs: 500, pollMs: 1,
      sleep: async () => controller.abort(),
    });
    await assert.rejects(aborting.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    assert.equal(second.context.closeCalls, 1, 'abort after manual mode closes the owned browser context');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('manual password handoff does not auto-fill a subsequently discovered email field', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: { password: true } }) });
  let now = 0;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 100, manualTimeoutMs: 8, pollMs: 3,
      clock: () => now, sleep: async ms => { now += ms; },
    });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
    assert.equal(fake.page.filledEmail, null);
    assert.equal(fake.page.continueClicks, 0);
    assert.equal(fake.context.allPages.length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('pending official token exchange is cut off by the manual deadline and closes the context', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ manual: { password: true }, tokenPending: true }) });
  const startedAt = Date.now();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 100, manualTimeoutMs: 35, pollMs: 1,
    });
    await assert.rejects(bootstrapper.login(ACCOUNT, {
      setPhase: phase => { if (phase === 'waiting_for_user') fake.page.emit('response', sessionResponse()); },
    }), error => error.code === 'token_exchange_failed');
    assert.ok(Date.now() - startedAt < 1_000);
    assert.ok(fake.page.tokenRequest.timeoutMs > 0 && fake.page.tokenRequest.timeoutMs <= 35);
    assert.equal(fake.context.closeCalls, 1);
    assert.deepEqual(fake.context.cookieOrigins, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('abort interrupts a pending official token exchange and closes the context promptly', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ tokenPending: true }) });
  const controller = new AbortController();
  let reachedSavingPhase = false;
  const startedAt = Date.now();
  fake.page.tokenEvaluateHook = () => controller.abort();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 1_000, manualTimeoutMs: 1_000, pollMs: 1,
    });
    await assert.rejects(bootstrapper.login(ACCOUNT, {
      signal: controller.signal,
      setPhase: phase => {
        if (phase === 'saving_session') reachedSavingPhase = true;
      },
    }), error => error.code === 'aborted');
    assert.equal(reachedSavingPhase, true);
    assert.ok(Date.now() - startedAt < 250);
    assert.equal(fake.context.closeCalls, 1);
    assert.deepEqual(fake.context.cookieOrigins, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('blocks a Muse OTP request whose contact point differs from the selected account', async () => {
  const rootDir = await makeRoot();
  const page = new FakePage({ sessionOnContinue: false });
  const fake = fakeChromium({ page });
  let now = 10_000;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100, pollMs: 1, clock: () => now, sleep: async ms => { now += ms; } });
    // Wait for the exact route-install event; a fixed number of event-loop turns flakes under load.
    const profileDir = path.join(rootDir, ACCOUNT.id, 'login-browser');
    await mkdir(path.dirname(profileDir), { recursive: true, mode: 0o700 });
    const result = bootstrapper.login(ACCOUNT);
    await page.waitForRoute();
    assert.equal(typeof page.routeHandler, 'function');
    assert.equal(await page.triggerContactPoint('different@example.com'), true);
    await assert.rejects(result, error => error.code === 'account_mismatch' && !error.message.includes('different@example.com'));
    assert.equal(fake.context.closeCalls, 1);
    await assert.rejects(lstat(profileDir), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('does not return cookies when the official hatch token exchange is rejected', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ tokenStatus: 401 }) });
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir, pollMs: 1 });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'token_exchange_failed');
    assert.deepEqual(fake.context.cookieOrigins, []);
    assert.equal(fake.context.closeCalls, 1);
    await assert.rejects(lstat(path.join(rootDir, ACCOUNT.id, 'login-browser')), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects an HTTP-200 token response that contains no recognized nonempty token string', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ tokenData: { message: 'ok', token: { value: 'not-a-string' } } }) });
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir, pollMs: 1 });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'invalid_token_response');
    assert.deepEqual(fake.context.cookieOrigins, []);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('leaves terms or CAPTCHA for the user and returns a bounded interaction error', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ manual: { terms: true } }) });
  let now = 1_000;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 8, manualTimeoutMs: 8, pollMs: 3,
      clock: () => now,
      sleep: async ms => { now += ms; },
    });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
    assert.equal(fake.page.filledEmail, null);
    assert.equal(fake.page.continueClicks, 0);
    assert.equal(fake.context.closeCalls, 1);
    assert.ok(now <= 1_016);
    await assert.rejects(lstat(path.join(rootDir, ACCOUNT.id, 'login-browser')), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects an account directory symlink before launching Chrome', async () => {
  const rootDir = await makeRoot();
  const outside = await makeRoot();
  const fake = fakeChromium();
  try {
    await symlink(outside, path.join(rootDir, ACCOUNT.id), 'dir');
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'unsafe_workspace');
    assert.equal(fake.context.closeCalls, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('aborts before browser creation and rejects provider/email mismatches safely', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    await assert.rejects(bootstrapper.login({ ...ACCOUNT, mailAccessUrl: 'https://gmail.com/' }), error => error.code === 'invalid_account');
    assert.equal(fake.context.closeCalls, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('reports safe launch and Muse navigation diagnostics without exposing raw causes', async () => {
  for (const [error, expectedCode] of [
    [new Error('launch private sentinel'), 'browser_launch_failed'],
    [Object.assign(new Error('launch private sentinel'), { name: 'TimeoutError' }), 'browser_launch_timeout'],
    [Object.assign(new Error('private sentinel'), { code: 'EPERM' }), 'browser_permission_denied'],
  ]) {
    const rootDir = await makeRoot();
    const fake = fakeChromium();
    const diagnostics = [];
    fake.chromium.launchPersistentContext = async () => { throw error; };
    try {
      const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
        onDiagnostic: item => diagnostics.push(item) });
      await assert.rejects(bootstrapper.login(ACCOUNT), failure => {
        assert.equal(failure.code, expectedCode);
        assert.equal(failure.message.includes('sentinel'), false);
        return true;
      });
      const expectedReason = expectedCode === 'browser_launch_timeout' ? 'timeout' :
        expectedCode === 'browser_permission_denied' ? 'permission_denied' : 'unknown';
      assert.deepEqual(diagnostics, [{ stage: 'launch', reason: expectedReason }]);
      assert.equal(fake.context.closeCalls, 0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }

  const rootDir = await makeRoot();
  const fake = fakeChromium();
  fake.page.gotoError = new Error('net::ERR_ABORTED private navigation sentinel');
  const diagnostics = [];
  const phases = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 12, pollMs: 2,
      mailClient: { detect: () => 'luuvan', async fetchLatest() { throw new Error('must not poll'); } },
      onDiagnostic: item => diagnostics.push(item) });
    await assert.rejects(bootstrapper.login(ACCOUNT, { setPhase: phase => phases.push(phase) }), failure => {
      assert.equal(failure.code, 'muse_navigation_failed');
      assert.equal(failure.message.includes('private navigation sentinel'), false);
      return true;
    });
    assert.deepEqual(diagnostics, [{ stage: 'navigation', reason: 'ERR_ABORTED', pageState: 'blank',
      errorType: 'Error', signals: ['navigation', 'net'] }]);
    assert.equal(JSON.stringify(diagnostics).includes('private navigation sentinel'), false);
    assert.ok(phases.includes('waiting_for_user'));
    assert.equal(phases.includes('reading_mail'), false);
    assert.equal(fake.context.allPages.length, 2);
    assert.equal(fake.context.allPages[1].url(), ACCOUNT.mailAccessUrl);
    assert.equal(fake.page.filledEmail, null);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('a live Muse page can recover from a navigation rejection through manual sign-in', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium();
  fake.page.gotoError = new Error('net::ERR_NAME_NOT_RESOLVED private DNS sentinel');
  const phases = [];
  let mailCalls = 0;
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 200, pollMs: 2,
      mailClient: { detect: () => 'luuvan', async fetchLatest() { mailCalls++; return []; } } });
    const session = await bootstrapper.login(ACCOUNT, { setPhase: phase => {
      phases.push(phase);
      if (phase === 'waiting_for_user') {
        fake.page.currentUrl = 'https://muse.ai/';
        fake.page.emit('response', sessionResponse());
      }
    } });
    assert.equal(session.tokens.accessToken, 'token-from-fake-official-endpoint');
    assert.ok(phases.includes('waiting_for_user'));
    assert.equal(fake.page.filledEmail, null);
    assert.equal(mailCalls, 0);
    assert.equal(fake.context.allPages.length, 2);
    assert.equal(fake.context.allPages[1].url(), ACCOUNT.mailAccessUrl);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('closed page after navigation failure fails without starting manual mode', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium();
  fake.page.gotoError = new Error('net::ERR_NAME_NOT_RESOLVED private DNS sentinel');
  fake.page.closed = true;
  const phases = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir });
    await assert.rejects(bootstrapper.login(ACCOUNT, { setPhase: phase => phases.push(phase) }),
      error => error.code === 'muse_dns_error');
    assert.equal(phases.includes('waiting_for_user'), false);
    assert.equal(fake.context.allPages.length, 1);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('diagnostic callback maps unallowlisted net error text to unknown without leaking it', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium();
  const diagnostics = [];
  fake.page.gotoError = new Error('net::ERR_UNTRUSTED private error sentinel');
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 8, pollMs: 2,
      onDiagnostic: item => diagnostics.push(item) });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'muse_navigation_failed');
    assert.deepEqual(diagnostics, [{ stage: 'navigation', reason: 'unknown', pageState: 'blank',
      errorType: 'Error', signals: ['net', 'error'] }]);
    assert.equal(JSON.stringify(diagnostics).includes('private error sentinel'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('navigation diagnostics pass through only official Chromium NET_ERROR identifiers', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium();
  const diagnostics = [];
  fake.page.currentUrl = 'chrome-error://chromewebdata/';
  fake.page.gotoError = new Error('net::ERR_UNKNOWN_URL_SCHEME https://private.example/path?secret=sentinel');
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 8, pollMs: 2, onDiagnostic: item => diagnostics.push(item) });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'muse_navigation_failed');
    assert.deepEqual(diagnostics, [{ stage: 'navigation', reason: 'ERR_UNKNOWN_URL_SCHEME',
      pageState: 'browser_error', errorType: 'Error', signals: ['net'] }]);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes('private.example'), false);
    assert.equal(serialized.includes('/path'), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('sentinel'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('navigation diagnostics expose only fixed page, error-type and ordered signal enums', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium();
  const diagnostics = [];
  fake.page.currentUrl = 'https://auth.muse.ai/aymh/?secret-path=private-sentinel';
  fake.page.gotoError = new TypeError('Invalid argument was not a function; undefined properties rejected by protocol in Playwright; private-message-sentinel');
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 8, pollMs: 2,
      onDiagnostic: item => diagnostics.push(item) });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'muse_navigation_failed');
    assert.deepEqual(diagnostics, [{
      stage: 'navigation', reason: 'unknown', pageState: 'muse_auth', errorType: 'TypeError',
      signals: ['invalid', 'argument', 'not', 'function', 'undefined', 'properties', 'protocol', 'playwright'],
    }]);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes('auth.muse.ai'), false);
    assert.equal(serialized.includes('secret-path'), false);
    assert.equal(serialized.includes('private-sentinel'), false);
    assert.equal(serialized.includes('private-message-sentinel'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('navigation diagnostic classifies provider auth, browser error and closed pages safely', async () => {
  for (const item of [
    { state: 'https://www.facebook.com/login/?private=1', expected: 'provider_auth' },
    { state: 'chrome-error://chromewebdata/', expected: 'browser_error' },
    { state: 'https://muse.ai/login?private=1', expected: 'muse' },
  ]) {
    const rootDir = await makeRoot();
    const fake = fakeChromium();
    const diagnostics = [];
    fake.page.currentUrl = item.state;
    fake.page.gotoError = new Error('navigation failed private-sentinel');
    try {
      const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
        manualTimeoutMs: 5, pollMs: 1, onDiagnostic: event => diagnostics.push(event) });
      await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'muse_navigation_failed');
      assert.equal(diagnostics[0]?.pageState, item.expected);
      assert.equal(JSON.stringify(diagnostics).includes('private=1'), false);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  }

  const rootDir = await makeRoot();
  const fake = fakeChromium();
  const diagnostics = [];
  fake.page.closed = true;
  fake.page.gotoError = new Error('navigation failed private-sentinel');
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'muse_navigation_failed');
    assert.equal(diagnostics[0]?.pageState, 'closed');
    assert.equal(JSON.stringify(diagnostics).includes('private-sentinel'), false);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test('matched OTP response emits only the allowlisted HTTP/body-shape metadata', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  fake.page.otpResponseBody = {
    success: false, status: 'error', error: 'private-otp-error-sentinel', errors: ['private-code-sentinel'],
    token: 'private-token-sentinel', id: 'private-id-sentinel',
  };
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 10, pollMs: 1,
      mailClient: { detect: () => 'luuvan', async fetchLatest() { throw new Error('synthetic provider failure'); } },
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
    const otpEvents = diagnostics.filter(event => event.stage === 'otp_response');
    assert.deepEqual(otpEvents, [{ stage: 'otp_response', httpStatus: 200, bodyKind: 'object',
      successFlag: false, statusFlag: 'error', hasError: true }]);
    const serialized = JSON.stringify(otpEvents);
    for (const sentinel of ['private-otp-error-sentinel', 'private-code-sentinel', 'private-token-sentinel', 'private-id-sentinel']) {
      assert.equal(serialized.includes(sentinel), false);
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('reads a bounded chunked OTP response body and reports only safe response flags', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  fake.page.otpResponseSequence = [{ omitContentLength: true, body: {
    success: false, status: 'error', error: 'private-chunked-error-sentinel', token: 'private-chunked-token-sentinel',
  } }];
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 10, pollMs: 1,
      mailClient: { detect: () => 'luuvan', async fetchLatest() { throw new Error('synthetic provider failure'); } },
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
    const otpEvents = diagnostics.filter(event => event.stage === 'otp_response');
    assert.deepEqual(otpEvents, [{ stage: 'otp_response', httpStatus: 200, bodyKind: 'object',
      successFlag: false, statusFlag: 'error', hasError: true }]);
    const serialized = JSON.stringify(otpEvents);
    assert.equal(serialized.includes('private-chunked-error-sentinel'), false);
    assert.equal(serialized.includes('private-chunked-token-sentinel'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('does not parse an oversized chunked OTP response body', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  let bodyReads = 0;
  fake.page.otpResponseSequence = [{ omitContentLength: true, bodyBytes: Buffer.alloc(1_048_577, 65), onBody() { bodyReads++; } }];
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 10, pollMs: 1,
      mailClient: { detect: () => 'luuvan', async fetchLatest() { throw new Error('synthetic provider failure'); } },
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
    assert.equal(bodyReads, 1);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'otp_response'), [{
      stage: 'otp_response', httpStatus: 200, bodyKind: 'unavailable',
      successFlag: null, statusFlag: 'absent', hasError: false,
    }]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('abort interrupts a pending chunked OTP response body read without publishing diagnostics', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  let releaseBody;
  let markBodyStarted;
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  fake.page.otpResponseSequence = [{ omitContentLength: true, onBody: () => new Promise(resolve => {
    releaseBody = resolve;
    markBodyStarted();
  }) }];
  const controller = new AbortController();
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 100, pollMs: 1,
      sleep: async () => { await bodyStarted; controller.abort(); },
      mailClient: { detect: () => 'luuvan', async fetchLatest() { return []; } },
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    assert.equal(fake.context.closeCalls, 1);
    releaseBody(Buffer.from('{"success":false,"error":"private-late-body-sentinel"}'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(diagnostics.filter(event => event.stage === 'otp_response'), []);
    assert.equal(JSON.stringify(diagnostics).includes('private-late-body-sentinel'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('a stalled chunked OTP response body is cut off at the login deadline', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  let releaseBody;
  let markBodyStarted;
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  fake.page.otpResponseSequence = [{ omitContentLength: true, onBody: () => new Promise(resolve => {
    releaseBody = resolve;
    markBodyStarted();
  }) }];
  const diagnostics = [];
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 120, manualTimeoutMs: 50, pollMs: 2,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))),
      mailClient: { detect: () => 'luuvan', async fetchLatest() { return []; } },
      onDiagnostic: event => diagnostics.push(event) });
    const startedAt = Date.now();
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
    const elapsed = Date.now() - startedAt;
    await Promise.race([bodyStarted, new Promise(resolve => setTimeout(resolve, 500))]);
    assert.equal(typeof releaseBody, 'function', 'chunked body read should have started');
    assert.ok(elapsed < 1_000, `login should finish promptly at its deadline (elapsed ${elapsed}ms)`);
    assert.equal(fake.context.closeCalls, 1);
    releaseBody(Buffer.from('{"success":true}'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(diagnostics).includes('success'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('matched non-2xx OTP responses are diagnosed without polling; a later matched 2xx starts polling', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  fake.page.otpResponseSequence = [
    { status: 403, body: { success: false, status: 'error', error: 'private-error-sentinel' } },
    { status: 200, body: { success: true, status: 'success', token: 'private-token-sentinel' } },
  ];
  const diagnostics = [];
  const pollsAtResponse = [];
  let mailPolls = 0;
  fake.page.otpResponseObserver = () => pollsAtResponse.push(mailPolls);
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 100, manualTimeoutMs: 8, pollMs: 1,
      mailClient: { detect: () => 'luuvan', async fetchLatest() { mailPolls++; return []; } },
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT), error => error.code === 'needs_user_interaction');
    assert.deepEqual(pollsAtResponse, [0, 1]);
    assert.ok(mailPolls > 0);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'otp_response'), [
      { stage: 'otp_response', httpStatus: 403, bodyKind: 'object', successFlag: false, statusFlag: 'error', hasError: true },
      { stage: 'otp_response', httpStatus: 200, bodyKind: 'object', successFlag: true, statusFlag: 'success', hasError: false },
    ]);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes('private-error-sentinel'), false);
    assert.equal(serialized.includes('private-token-sentinel'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('pending OTP metadata diagnostic cannot publish after abort and owned-context cleanup', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ otpFlow: true, sessionOnContinue: false }) });
  let releaseBody;
  fake.page.otpResponseBody = new Promise(resolve => { releaseBody = resolve; });
  const diagnostics = [];
  const controller = new AbortController();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      manualTimeoutMs: 100, pollMs: 1,
      sleep: async () => { controller.abort(); },
      mailClient: { detect: () => 'luuvan', async fetchLatest() { throw new Error('synthetic provider failure'); } },
      onDiagnostic: event => diagnostics.push(event) });
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    assert.equal(fake.context.closeCalls, 1);
    releaseBody({ success: false, error: 'private-after-abort-sentinel' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(diagnostics.filter(event => event.stage === 'otp_response'), []);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'email_submit'), [{
      stage: 'email_submit', outcome: 'submitted', buttonCount: 'one', buttonVisible: true, buttonEnabled: true,
      emailMatches: true,
    }]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('abort interrupts a pending session JSON read without waiting for its body', async () => {
  const rootDir = await makeRoot();
  const controller = new AbortController();
  let resolveJson;
  let jsonStartedResolve;
  const jsonStarted = new Promise(resolve => { jsonStartedResolve = resolve; });
  const diagnostics = [];
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: {
    sessionResponseOnMuseGoto: true,
    sessionResponseOptions: {
      onJson() {
        jsonStartedResolve();
        return new Promise(resolve => { resolveJson = resolve; });
      },
    },
  } }) });
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 10_000, manualTimeoutMs: 500, pollMs: 1,
      onDiagnostic: event => diagnostics.push(event),
    });
    const login = bootstrapper.login(ACCOUNT, { signal: controller.signal });
    await jsonStarted;
    controller.abort();
    await assert.rejects(login, error => error.code === 'aborted');
    assert.equal(fake.context.closeCalls, 1);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'session_response'), []);
    resolveJson({ endpoint_url: 'https://gateway.example/api', vm_name: 'late-vm', vm_id: 'late-id' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.page.tokenRequest, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('late OTP and session responses after abort are ignored before mail polling or body parsing', async () => {
  const rootDir = await makeRoot();
  const controller = new AbortController();
  let mailCalls = 0;
  let otpBodyReads = 0;
  let sessionBodyReads = 0;
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: { password: true } }) });
  fake.page.manual.onContextClose = () => {
    fake.page.emit('response', otpResponse(ACCOUNT.email, { status: 201, onJson: () => { otpBodyReads++; } }));
    fake.page.emit('response', sessionResponse({ onJson: () => { sessionBodyReads++; } }));
  };
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 1_000, manualTimeoutMs: 500, pollMs: 1,
      mailClient: { async fetchLatest() { mailCalls++; return []; } },
    });
    await assert.rejects(bootstrapper.login(ACCOUNT, {
      signal: controller.signal,
      setPhase(phase) { if (phase === 'waiting_for_user') controller.abort(); },
    }), error => error.code === 'aborted');
    assert.equal(mailCalls, 0);
    assert.equal(otpBodyReads, 0);
    assert.equal(sessionBodyReads, 0);
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('stalled session response JSON is bounded by login deadline and cannot mutate capture later', async () => {
  const rootDir = await makeRoot();
  let resolveJson;
  let jsonReads = 0;
  const diagnostics = [];
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: {
    sessionResponseOnMuseGoto: true,
    sessionResponseOptions: {
      onJson() {
        jsonReads++;
        return new Promise(resolve => { resolveJson = resolve; });
      },
    },
  } }) });
  const startedAt = Date.now();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({ chromium: fake.chromium, rootDir,
      timeoutMs: 60, manualTimeoutMs: 10, pollMs: 1,
      onDiagnostic: event => diagnostics.push(event),
    });
    await assert.rejects(bootstrapper.login(ACCOUNT));
    assert.ok(Date.now() - startedAt < 500, 'capture should stop at the login deadline');
    assert.equal(jsonReads, 1);
    assert.equal(fake.page.tokenRequest, null);
    assert.deepEqual(diagnostics.filter(event => event.stage === 'session_response'), [{
      stage: 'session_response', httpStatus: 200, bodyParsed: false,
      endpointPresent: false, vmIdPresent: false, vmNamePresent: false, accepted: false,
    }]);
    resolveJson({ endpoint_url: 'https://gateway.example/api', vm_name: 'late-vm', vm_id: 'late-id' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.page.tokenRequest, null);
    assert.equal(diagnostics.some(event => event.accepted), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('active cancellation closes the owned visible context before cleanup completes', async () => {
  const rootDir = await makeRoot();
  const fake = fakeChromium({ page: new FakePage({ sessionOnContinue: false, manual: { password: true } }) });
  const controller = new AbortController();
  try {
    const bootstrapper = new BrowserSessionBootstrapper({
      chromium: fake.chromium, rootDir, timeoutMs: 1_000, pollMs: 5,
      sleep: async () => { controller.abort(); },
    });
    await assert.rejects(bootstrapper.login(ACCOUNT, { signal: controller.signal }), error => error.code === 'aborted');
    assert.equal(fake.context.closeCalls, 1);
    await assert.rejects(lstat(path.join(rootDir, ACCOUNT.id, 'login-browser')), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
