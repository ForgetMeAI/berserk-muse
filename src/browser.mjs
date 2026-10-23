import { chromium } from 'playwright-core';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { BridgeError, checkAbort, delay } from './errors.mjs';
import { resolveBrowserExecutable } from './platform.mjs';

const ORIGIN = 'https://muse.ai';
const S = {
  composer: '[data-hatch-composer-root]',
  editor: '[data-hatch-composer-root] textarea, [data-lexical-editor="true"], [data-hatch-composer-root] [contenteditable="true"]',
  assistant: '[data-message-item][data-message-role="assistant"]',
  user: '[data-message-item][data-message-role="user"]',
  userBody: 'p.whitespace-pre-wrap',
  stop: '[data-testid="hatch-composer-stop-button"]',
  error: '[data-testid="assistant-response-error-notice"]',
  approval: '[data-hatch-composer-approval-stack]',
};

// Own browser profile only. Never calls cookies(), storageState(), auth/check,
// localStorage, network interception, or a user's existing browser/CDP session.
export class MuseBrowser {
  constructor({ profileDir, timeoutMs = 240000, readinessTimeoutMs = 15000, readinessStableMs = 500,
    responseStableMs = 1800, noStopStableMs = 4000, pollIntervalMs = 100,
    browserExecutable = resolveBrowserExecutable(), chromiumImpl = chromium, onDiagnostic }) {
    this.profileDir = profileDir;
    this.timeoutMs = timeoutMs;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.readinessStableMs = readinessStableMs;
    this.responseStableMs = responseStableMs;
    this.noStopStableMs = noStopStableMs;
    this.pollIntervalMs = pollIntervalMs;
    this.browserExecutable = browserExecutable;
    this.chromium = chromiumImpl;
    this.onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : null;
    this.context = null;
    this.page = null;
    this.blocked = false;
  }

  #editor() {
    return this.page.locator(S.editor.split(',').map(selector => `${selector.trim()}:visible`).join(',')).first();
  }

  async #editorReady() {
    const editor = this.#editor();
    if (!(await editor.isVisible().catch(() => false)) || !(await editor.isEnabled().catch(() => false))) return false;
    return editor.evaluate(element => {
      const contentEditable = element.getAttribute('contenteditable');
      // Muse keeps the prehydration attribute on the hydrated textarea too. The
      // first-party bundle shows React's randomized __reactProps$ key carries the
      // controlled onChange/onKeyDown handlers, so use those as the hydration marker.
      const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps$'));
      const props = propsKey ? element[propsKey] : null;
      const hasInputHandlers = typeof props?.onChange === 'function'
        && typeof props?.onKeyDown === 'function';
      return hasInputHandlers && !element.disabled && !element.readOnly
        && element.getAttribute('aria-disabled') !== 'true'
        && (typeof element.value === 'string' || element.isContentEditable || contentEditable === 'true');
    }).catch(() => false);
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
      this.context = await this.chromium.launchPersistentContext(this.profileDir, {
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
      const hasEditor = await this.#editorReady();
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

  async #assistantText(message, nonce) {
    if (typeof nonce === 'string' && nonce) {
      const codeBlocks = message.locator('pre code');
      if (await codeBlocks.count().catch(() => 0) === 1) {
        const candidate = await codeBlocks.first().textContent({ timeout: 800 }).catch(() => '');
        try {
          const envelope = JSON.parse(candidate);
          if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && envelope.request_id === nonce) {
            return candidate;
          }
        } catch { /* The strict response parser will reject the full rendered message. */ }
      }
    }
    return message.textContent({ timeout: 800 }).catch(() => '');
  }

  #diagnose(stage, reason) {
    try { this.onDiagnostic?.({ stage, reason }); } catch { /* Diagnostics cannot alter generation. */ }
  }

  async login() {
    await this.open();
    await this.page.bringToFront();
    return this.status();
  }

  async #freshThread(signal) {
    checkAbort(signal);
    const firstReadyDeadline = Date.now() + this.readinessTimeoutMs;
    let state;
    while (Date.now() < firstReadyDeadline) {
      checkAbort(signal);
      state = await this.status();
      if (state.ready) break;
      if (state.state === 'approval_required') {
        throw new BridgeError('Muse is waiting for your approval in its window.', 409, 'approval_required');
      }
      if (this.page.isClosed() || new URL(this.page.url()).origin !== ORIGIN) {
        throw new BridgeError('Muse requires sign-in.', 503, 'login_required');
      }
      await delay(this.pollIntervalMs, signal);
    }
    if (!state?.ready) {
      throw new BridgeError('Open the Muse login window and finish sign-in or any required setup.', 503, 'login_required');
    }
    // This route was verified through the real Muse "New side chat" UI.
    // It is a draft route: the service assigns a unique thread ID after send.
    try { await this.page.goto(`${ORIGIN}/thread/new`, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch { throw new BridgeError('Muse new side-chat page is unavailable.', 503, 'thread_isolation_unavailable'); }
    const deadline = Date.now() + this.readinessTimeoutMs;
    let stableSince = null;
    let stableEditor = null;
    try {
      while (Date.now() < deadline) {
        checkAbort(signal);
        const url = this.page.url();
        const currentUrl = new URL(url);
        if (currentUrl.origin !== ORIGIN || currentUrl.pathname !== '/thread/new') {
          throw new BridgeError('Muse requires sign-in.', 503, 'login_required');
        }
        const editor = this.#editor();
        const editorReady = await this.#editorReady();
        const messages = await this.page.locator(`${S.assistant}, ${S.user}`).count();
        const generating = await this.page.locator(S.stop).first().isVisible().catch(() => false);
        const approval = await this.#hasApproval();
        if (approval) throw new BridgeError('Muse is waiting for your approval in its window.', 409, 'approval_required');
        const candidate = editorReady ? await editor.elementHandle().catch(() => null) : null;
        const sameEditor = Boolean(candidate && stableEditor
          && await candidate.evaluate((node, previous) => node === previous, stableEditor).catch(() => false));
        if (editorReady && candidate && messages === 0 && !generating) {
          if (!sameEditor) {
            await stableEditor?.dispose().catch(() => {});
            stableEditor = candidate;
            stableSince = Date.now();
          } else {
            await candidate.dispose().catch(() => {});
            if (Date.now() - stableSince >= this.readinessStableMs) return;
          }
        } else {
          await candidate?.dispose().catch(() => {});
          await stableEditor?.dispose().catch(() => {});
          stableEditor = null;
          stableSince = null;
        }
        await delay(this.pollIntervalMs, signal);
      }
    } finally {
      await stableEditor?.dispose().catch(() => {});
    }
    throw new BridgeError('Could not prove a fresh isolated Muse chat. Nothing was submitted.', 503, 'thread_isolation_unavailable');
  }

  async generate(prompt, { signal, nonce } = {}) {
    await this.open();
    await this.#freshThread(signal);
    const page = this.page;
    const editor = this.#editor();
    let submitted = false;
    let stage = 'fill';
    try {
      checkAbort(signal);
      stage = 'fill';
      await editor.fill(prompt);
      stage = 'verify_input';
      const delivered = await editor.evaluate(element => typeof element.value === 'string' ? element.value : element.textContent);
      if (delivered !== prompt) throw new BridgeError('Muse composer did not retain the complete request. Nothing was submitted.', 413, 'composer_context_mismatch');
      checkAbort(signal);
      // Once Enter is attempted, its delivery may be ambiguous if the page changes.
      // Never retry it: wait for this exact user message as the submission acknowledgement.
      const deadline = Date.now() + this.timeoutMs;
      submitted = true;
      stage = 'submit';
      await editor.press('Enter');
      stage = 'acknowledgement';
      let text = '', previous = '', changed = Date.now(), sawStop = false, acknowledged = false;
      while (Date.now() < deadline) {
        checkAbort(signal);
        if (new URL(page.url()).origin !== ORIGIN) throw new BridgeError('Muse requires sign-in.', 503, 'login_required');
        if (await this.#hasApproval()) throw new BridgeError('Muse is waiting for your approval in its window.', 409, 'approval_required');
        if (await page.locator(S.error).first().isVisible().catch(() => false)) {
          throw new BridgeError('Muse displayed an error. Check the dedicated browser window for details.', 502, 'muse_response_error');
        }
        const stop = await page.locator(S.stop).first().isVisible().catch(() => false);
        sawStop ||= stop;
        if (!acknowledged) {
          const ownUserMessage = page.locator(S.user).last();
          const body = ownUserMessage.locator(S.userBody);
          acknowledged = await body.count().then(async count => count === 1
            && await body.textContent({ timeout: 800 }).catch(() => '') === prompt).catch(() => false);
          if (!acknowledged) {
            await delay(this.pollIntervalMs, signal);
            continue;
          }
        }
        stage = 'response';
        text = await this.#assistantText(page.locator(S.assistant).last(), nonce);
        if (text !== previous) { previous = text; changed = Date.now(); }
        // A fresh chat and nonce prevent accepting an old assistant response.
        if (text && !stop && Date.now() - changed >= (sawStop ? this.responseStableMs : this.noStopStableMs)) {
          return { text, streaming: 'buffered', toolCalling: 'synthetic-json' };
        }
        await delay(this.pollIntervalMs, signal);
      }
      throw new BridgeError('Muse did not finish before the timeout. The request was not retried.', 504, 'upstream_timeout');
    } catch (error) {
      const reason = error?.name === 'TimeoutError' || error?.code === 'upstream_timeout' ? 'timeout'
        : (() => { try { return page.isClosed() ? 'target_closed' : error instanceof TypeError ? 'type_error' : 'error'; } catch { return 'target_closed'; } })();
      this.#diagnose(stage, reason);
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
