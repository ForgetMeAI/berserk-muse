import { chromium } from 'playwright-core';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { BridgeError, checkAbort, delay } from './errors.mjs';
import { resolveBrowserExecutable } from './platform.mjs';

const ORIGIN = 'https://muse.ai';
const S = {
  composer: '[data-hatch-composer-root]',
  editor: '[data-hatch-composer-root] textarea, [data-hatch-composer-prehydration-input], [data-lexical-editor="true"], [data-hatch-composer-root] [contenteditable="true"]',
  assistant: '[data-message-item][data-message-role="assistant"]',
  user: '[data-message-item][data-message-role="user"]',
  stop: '[data-testid="hatch-composer-stop-button"]',
  error: '[data-testid="assistant-response-error-notice"]',
  approval: '[data-hatch-composer-approval-stack]',
};

// Own browser profile only. Never calls cookies(), storageState(), auth/check,
// localStorage, network interception, or a user's existing browser/CDP session.
export class MuseBrowser {
  constructor({ profileDir, timeoutMs = 240000, browserExecutable = resolveBrowserExecutable() }) {
    this.profileDir = profileDir;
    this.timeoutMs = timeoutMs;
    this.browserExecutable = browserExecutable;
    this.context = null;
    this.page = null;
    this.blocked = false;
  }

  #editor() {
    return this.page.locator(S.editor.split(',').map(selector => `${selector.trim()}:visible`).join(',')).first();
  }

  async open() {
    if (this.context && this.page && !this.page.isClosed()) return;
    if (this.context) await this.close();
    await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
    const st = await lstat(this.profileDir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new BridgeError('Browser profile must be a private directory.', 500, 'unsafe_profile');
    }
    await chmod(this.profileDir, 0o700);
    try {
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        ...(this.browserExecutable ? { executablePath: this.browserExecutable } : { channel: 'chrome' }),
        headless: false, chromiumSandbox: true, viewport: { width: 1200, height: 850 },
        acceptDownloads: false,
      });
      const currentContext = this.context;
      currentContext.on('close', () => {
        if (this.context === currentContext) { this.context = null; this.page = null; }
      });
      this.page = currentContext.pages()[0] || await currentContext.newPage();
      this.page.setDefaultTimeout(10000);
      await this.page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
      await this.close();
      throw new BridgeError('Could not open the dedicated Muse Chrome window. Check Chrome and its login window.', 503, 'browser_unavailable');
    }
  }

  async status() {
    if (!this.context || !this.page || this.page.isClosed()) {
      return { state: 'not_started', ready: false, mode: 'browser', model: 'Muse app selection' };
    }
    try {
      const page = this.page;
      const origin = new URL(page.url()).origin;
      const hasEditor = await this.#editor().isVisible().catch(() => false);
      const generating = await page.locator(S.stop).first().isVisible().catch(() => false);
      const approval = await this.#hasApproval();
      const ready = origin === ORIGIN && hasEditor && !generating && !approval;
      if (this.blocked && ready) this.blocked = false;
      return {
        state: approval ? 'approval_required' : generating ? 'generating' : ready ? 'ready' : 'login_or_setup_required',
        ready: ready && !this.blocked, mode: 'browser', model: 'Muse app selection',
      };
    } catch { return { state: 'browser_unavailable', ready: false, mode: 'browser' }; }
  }

  async #hasApproval() {
    return this.page.locator(S.approval).evaluateAll(nodes => nodes.some(node =>
      node.getClientRects().length > 0 && node.children.length > 0 && node.textContent.trim().length > 0,
    )).catch(() => false);
  }

  async login() {
    await this.open();
    await this.page.bringToFront();
    return this.status();
  }

  async #freshThread(signal) {
    checkAbort(signal);
    const state = await this.status();
    if (!state.ready) {
      throw new BridgeError('Open the Muse login window and finish sign-in or any required setup.', 503,
        state.state === 'approval_required' ? 'approval_required' : 'login_required');
    }
    // This route was verified through the real Muse "New side chat" UI.
    // It is a draft route: the service assigns a unique thread ID after send.
    try { await this.page.goto(`${ORIGIN}/thread/new`, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch { throw new BridgeError('Muse new side-chat page is unavailable.', 503, 'thread_isolation_unavailable'); }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      checkAbort(signal);
      const url = this.page.url();
      if (new URL(url).origin !== ORIGIN) throw new BridgeError('Muse requires sign-in.', 503, 'login_required');
      const editor = await this.#editor().isVisible().catch(() => false);
      const messages = await this.page.locator(`${S.assistant}, ${S.user}`).count();
      if (new URL(url).pathname === '/thread/new' && editor && messages === 0) {
        return;
      }
      await delay(200, signal);
    }
    throw new BridgeError('Could not prove a fresh isolated Muse chat. Nothing was submitted.', 503, 'thread_isolation_unavailable');
  }

  async generate(prompt, { signal, nonce } = {}) {
    await this.open();
    await this.#freshThread(signal);
    const page = this.page;
    const editor = this.#editor();
    let submitted = false;
    try {
      checkAbort(signal);
      await editor.fill(prompt);
      const delivered = await editor.evaluate(element => typeof element.value === 'string' ? element.value : element.textContent);
      if (delivered !== prompt) throw new BridgeError('Muse composer did not retain the complete request. Nothing was submitted.', 413, 'composer_context_mismatch');
      checkAbort(signal);
      await editor.press('Enter');
      submitted = true;
      let text = '', previous = '', changed = Date.now(), sawStop = false;
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        checkAbort(signal);
        if (new URL(page.url()).origin !== ORIGIN) throw new BridgeError('Muse requires sign-in.', 503, 'login_required');
        if (await this.#hasApproval()) throw new BridgeError('Muse is waiting for your approval in its window.', 409, 'approval_required');
        if (await page.locator(S.error).first().isVisible().catch(() => false)) {
          throw new BridgeError('Muse displayed an error. Check the dedicated browser window for details.', 502, 'muse_response_error');
        }
        const stop = await page.locator(S.stop).first().isVisible().catch(() => false);
        sawStop ||= stop;
        text = await page.locator(S.assistant).last().textContent({ timeout: 800 }).catch(() => '');
        if (text !== previous) { previous = text; changed = Date.now(); }
        // A fresh chat and nonce prevent accepting an old assistant response.
        if (text && !stop && Date.now() - changed >= (sawStop ? 1800 : 4000)) {
          return { text, streaming: 'buffered', toolCalling: 'synthetic-json' };
        }
        await delay(300, signal);
      }
      throw new BridgeError('Muse did not finish before the timeout. The request was not retried.', 504, 'upstream_timeout');
    } catch (error) {
      if (submitted) {
        // Only stop our own submitted generation. No retries or duplicate sends.
        try {
          const stop = page.locator(S.stop).first();
          if (await stop.isVisible()) await stop.click({ timeout: 2000 });
          await stop.waitFor({ state: 'hidden', timeout: 5000 });
        } catch { this.blocked = true; }
      }
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('The Muse page changed or closed during the request. Check its window.', 502, 'browser_interaction_failed');
    }
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close().catch(() => {});
  }
}
