import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { MuseBrowser } from '../src/browser.mjs';

class FakePage {
  constructor({ hydrateAfter = 0, acknowledge = true, replaceAtCheck = null } = {}) {
    this.path = '/';
    this.hydrateAfter = hydrateAfter;
    this.acknowledge = acknowledge;
    this.hydrationChecks = 0;
    this.prompt = '';
    this.sends = 0;
    this.acknowledged = false;
    this.generating = false;
    this.stopChecks = 0;
    this.response = '';
    this.codeBlocks = [];
    this.closed = false;
    this.abortOnPress = null;
    this.pressError = null;
    this.editorNode = {};
    this.replaceAtCheck = replaceAtCheck;
    this.replacements = 0;
  }
  isClosed() { return this.closed; }
  url() { return `https://muse.ai${this.path}`; }
  setDefaultTimeout() {}
  async goto(url) {
    this.path = new URL(url).pathname;
    this.hydrationChecks = 0;
    this.editorNode = {};
    this.stopChecks = 0;
  }
  locator(selector) { return new FakeLocator(this, selector); }
}

class FakeLocator {
  constructor(page, selector) { this.page = page; this.selector = selector; }
  first() { return this; }
  last() { return this; }
  locator(selector) { return new FakeLocator(this.page, selector); }
  async isVisible() {
    if (this.selector.includes('hatch-composer-root')) {
      this.page.hydrationChecks += 1;
      if (this.page.path === '/thread/new' && this.page.hydrationChecks === this.page.replaceAtCheck) {
        this.page.editorNode = {};
        this.page.replacements += 1;
      }
      return this.page.path === '/' || (this.page.path === '/thread/new' && this.page.hydrationChecks > this.page.hydrateAfter);
    }
    if (this.selector.includes('hatch-composer-stop-button')) {
      if (this.page.generating) {
        this.page.stopChecks += 1;
        if (this.page.stopChecks > 2) this.page.generating = false;
      }
      return this.page.generating;
    }
    return false;
  }
  async isEnabled() { return this.page.path === '/' || this.page.hydrationChecks > this.page.hydrateAfter; }
  async evaluate(fn) {
    const hydrated = this.page.path === '/' || this.page.hydrationChecks > this.page.hydrateAfter;
    return fn({
      value: this.page.prompt,
      disabled: false,
      readOnly: false,
      isContentEditable: false,
      getAttribute: name => name === 'data-hatch-composer-prehydration-input' ? '' : null,
      ...(hydrated ? { '__reactProps$fake': { onChange() {}, onKeyDown() {} } } : {}),
    });
  }
  async elementHandle() {
    const node = this.page.editorNode;
    return { node, async evaluate(fn, previous) { return fn(node, previous?.node); }, async dispose() {} };
  }
  async evaluateAll(fn, arg) {
    if (this.selector.includes('assistant-response-error')) return false;
    if (this.selector.includes('hatch-composer-approval-stack')) return false;
    if (this.selector.includes('data-message-role="user"')) {
      const nodes = this.page.acknowledged ? [{ textContent: this.page.prompt }] : [];
      return fn(nodes, arg);
    }
    return false;
  }
  async count() {
    if (this.selector === 'pre code') return this.page.codeBlocks.length;
    if (this.selector === 'p.whitespace-pre-wrap') return this.page.acknowledged ? 1 : 0;
    if (this.selector.includes('data-message-role="assistant"') || this.selector.includes('data-message-role="user"')) {
      return (this.page.acknowledged ? 1 : 0) + (this.page.acknowledged && this.page.response ? 1 : 0);
    }
    return 0;
  }
  async fill(value) { this.page.prompt = value; }
  async press(key) {
    assert.equal(key, 'Enter');
    this.page.sends += 1;
    assert.ok(this.page.hydrationChecks > this.page.hydrateAfter, 'Enter must wait for hydrated editor');
    if (this.page.pressError) throw this.page.pressError;
    this.page.acknowledged = this.page.acknowledge;
    this.page.generating = true;
    this.page.response ||= 'Muse response';
    this.page.abortOnPress?.abort();
  }
  async textContent() {
    if (this.selector === 'pre code') return this.page.codeBlocks[0] ?? '';
    if (this.selector === 'p.whitespace-pre-wrap') return this.page.prompt;
    return this.page.response;
  }
  async click() { this.page.generating = false; }
  async waitFor() {}
}

function makeBrowser(page, options = {}) {
  const browser = new MuseBrowser({ profileDir: '/unused-in-tests', pollIntervalMs: 1,
    readinessStableMs: 2, readinessTimeoutMs: 100, responseStableMs: 2,
    noStopStableMs: 2, timeoutMs: 25, ...options });
  browser.context = { async close() {} };
  browser.page = page;
  return browser;
}

test('waits through composer hydration before sending and accepts only the acknowledged response', async () => {
  const page = new FakePage({ hydrateAfter: 5 });
  const browser = makeBrowser(page);
  const result = await browser.generate('a request with exact text');
  assert.equal(page.sends, 1);
  assert.equal(result.text, 'Muse response');
  await browser.close();
});

test('restarts the stable-empty window when Muse replaces the hydrated editor', async () => {
  const page = new FakePage({ hydrateAfter: 3, replaceAtCheck: 7 });
  const browser = makeBrowser(page, { readinessStableMs: 10 });
  await browser.generate('request after editor replacement');
  assert.equal(page.replacements, 1);
  assert.ok(page.hydrationChecks >= 10, 'readiness must observe the replacement and its stable period');
  assert.equal(page.sends, 1);
  await browser.close();
});

test('a visible prehydration-only editor never qualifies as a fresh usable thread', async () => {
  const page = new FakePage({ hydrateAfter: Number.POSITIVE_INFINITY });
  const browser = makeBrowser(page, { readinessTimeoutMs: 12 });
  await assert.rejects(browser.generate('must not send'), error => error.code === 'thread_isolation_unavailable');
  assert.equal(page.sends, 0);
  await browser.close();
});

test('does not treat assistant text as a response until this exact prompt is acknowledged', async () => {
  const page = new FakePage({ acknowledge: false });
  const diagnostics = [];
  const browser = makeBrowser(page, { timeoutMs: 12, onDiagnostic: event => diagnostics.push(event) });
  await assert.rejects(browser.generate('own prompt'), error => error.code === 'upstream_timeout');
  assert.equal(page.sends, 1, 'ambiguous submission must not be retried');
  assert.deepEqual(diagnostics, [{ stage: 'acknowledgement', reason: 'timeout' }]);
  await browser.close();
});

test('uses a single nonce-matched fenced JSON block to preserve Windows paths and regex escapes', async () => {
  const page = new FakePage();
  const expected = { request_id: 'exact-nonce', content: 'path C:\\temp\\folder\nregex \\d+', tool_calls: [] };
  page.codeBlocks = [JSON.stringify(expected)];
  page.response = 'rendered prose whose inline escaping is ambiguous';
  const browser = makeBrowser(page);
  const result = await browser.generate('return the envelope', { nonce: 'exact-nonce' });
  assert.deepEqual(JSON.parse(result.text), expected);
  await browser.close();
});

test('falls back to full assistant text for stale nonce or multiple code blocks', async () => {
  const page = new FakePage();
  page.codeBlocks = [JSON.stringify({ request_id: 'stale', content: 'old', tool_calls: [] }), '{}'];
  page.response = 'full assistant text';
  const browser = makeBrowser(page);
  const result = await browser.generate('return the envelope', { nonce: 'current' });
  assert.equal(result.text, 'full assistant text');
  await browser.close();
});

test('abort after an ambiguous submission stops only that generation and never retries', async () => {
  const page = new FakePage();
  const controller = new AbortController();
  page.abortOnPress = controller;
  const browser = makeBrowser(page);
  await assert.rejects(browser.generate('cancel this request', { signal: controller.signal }),
    error => error.code === 'request_cancelled');
  assert.equal(page.sends, 1);
  assert.equal(page.generating, false);
  await browser.close();
});

test('diagnostics expose only the fixed stage and reason when a browser call throws', async () => {
  const page = new FakePage();
  page.pressError = new TypeError('sensitive browser exception text');
  const diagnostics = [];
  const browser = makeBrowser(page, { onDiagnostic: event => diagnostics.push(event) });
  await assert.rejects(browser.generate('do not include this prompt in diagnostics'),
    error => error.code === 'browser_interaction_failed');
  assert.deepEqual(diagnostics, [{ stage: 'submit', reason: 'type_error' }]);
  assert.equal(JSON.stringify(diagnostics).includes('sensitive'), false);
  assert.equal(page.sends, 1);
  await browser.close();
});

test('real DOM waits for delayed React handlers while the prehydration marker persists', { timeout: 15000 }, async t => {
  let playwright;
  const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    .find(candidate => existsSync(candidate));
  if (!executablePath) { t.skip('No local Chromium executable is available for the real-DOM fixture.'); return; }
  try { playwright = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath }); }
  catch { t.skip('Playwright Chromium cannot launch in this sandbox.'); return; }
  const context = await playwright.newContext();
  const page = await context.newPage();
  let path = '/';
  const fixture = `
    <div data-hatch-composer-root>
      <textarea data-hatch-composer-prehydration-input="true" aria-label="Message"></textarea>
    </div><div id="messages"></div>
    <script>(() => {
      const input = document.querySelector('textarea');
      window.filledBeforeReactHandlers = null;
      input.addEventListener('input', () => {
        window.filledBeforeReactHandlers = typeof input[Object.keys(input).find(key => key.startsWith('__reactProps$')) || '']?.onChange !== 'function';
      });
    })();</script>`;
  const installHandlers = () => page.evaluate(() => {
    const input = document.querySelector('textarea');
    input.__reactProps$fixture = {
      onChange() {},
      onKeyDown(event) {
        if (event.key !== 'Enter') return;
        const user = document.createElement('div');
        user.dataset.messageItem = '';
        user.dataset.messageRole = 'user';
        const surrogate = document.createElement('span');
        surrogate.className = 'sr-only';
        surrogate.dataset.messageAccessibilitySurrogate = 'true';
        surrogate.textContent = `User message: ${input.value}`;
        user.append(surrogate);
        const body = document.createElement('p');
        body.className = 'text-[16px] leading-[22px] whitespace-pre-wrap';
        body.textContent = input.value;
        user.append(body);
        user.appendChild(document.createElement('button')).textContent = 'Copy';
        document.querySelector('#messages').append(user);
        const assistant = document.createElement('div');
        assistant.dataset.messageItem = '';
        assistant.dataset.messageRole = 'assistant';
        assistant.textContent = 'Fixture response';
        document.querySelector('#messages').append(assistant);
      },
    };
    input.addEventListener('keydown', event => input.__reactProps$fixture.onKeyDown(event));
  });
  let releaseHydration;
  const hydrationGate = new Promise(resolve => { releaseHydration = resolve; });
  page.url = () => `https://muse.ai${path}`;
  page.goto = async url => {
    path = new URL(url).pathname;
    await page.setContent(fixture);
    setTimeout(async () => { await hydrationGate; await installHandlers(); }, 0);
  };
  await page.setContent(fixture);
  const browser = new MuseBrowser({ profileDir: '/unused-in-tests', timeoutMs: 3000,
    readinessTimeoutMs: 3000, readinessStableMs: 10, responseStableMs: 2,
    noStopStableMs: 2, pollIntervalMs: 2 });
  browser.context = context;
  browser.page = page;
  try {
    assert.equal((await browser.status()).ready, false, 'visible textarea without React handlers is not ready');
    await installHandlers();
    const pending = browser.generate('wait for hydration');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(await page.locator('textarea').inputValue(), '', 'fresh composer stays untouched before React handlers attach');
    releaseHydration();
    const result = await pending;
    assert.equal(result.text, 'Fixture response');
    assert.equal(await page.locator('textarea').getAttribute('data-hatch-composer-prehydration-input'), 'true');
    assert.equal(await page.evaluate(() => window.filledBeforeReactHandlers), false);
    assert.equal((await browser.status()).ready, true, 'hydrated textarea is ready while its prehydration marker persists');
  } finally {
    releaseHydration();
    await browser.close();
    await playwright.close();
  }
});
