/**
 * Minimal, crypto-free Muse chat RPC orchestration over an injected Noise
 * channel. The channel owns authentication, encryption, framing and endpoint
 * selection; this module never opens a socket or reads credentials.
 *
 * Channel contract:
 * - `channel.nodeId` is the caller's persisted local device id.
 * - `channel.openStream({method, path, body, signal})` sends one request and
 *   resolves to `{ack, events}` after the request acknowledgement is parsed.
 *   `events` is an AsyncIterable of already parsed JSON gateway envelopes:
 *   `{type:'event', event, payload}`. Relevant events include assistant
 *   `delta.presentation`, legacy `delta.text_append`, and terminal
 *   `delta.message_done`; user and unrelated events are ignored.
 *   It must be scoped to this request, not a global/private history feed.
 * - `channel.request({method, path, body, signal})` resolves to
 *   `{status, body}` for finite calls such as chat cancellation.
 * - `channel.close({quarantine:true})` aborts transport work, waits for the
 *   underlying socket to close, and settles outstanding channel operations.
 *   It must be bounded by the channel and resolve only after that cleanup.
 * - A pre-write failure may be signalled with `MuseChannelError` and the
 *   `not_sent` delivery state. Any unbranded failure after method invocation
 *   is treated as `unknown`; this client never retries a generation.
 *
 * Wire contracts follow the public first-party Muse client: POST `/chat/stream`
 * with `{message,node_id,session_id,capabilities}`. The session id is a fresh
 * local UUID v4 (the public composer uses `crypto.randomUUID()` for draft
 * routes), and the acknowledgement must echo it exactly. The acknowledgement also provides the user's
 * `message_id`. Assistant output is identified by an assistant-role
 * `delta.presentation` or legacy `delta.text_append`, then completed by
 * `delta.message_done` for that same assistant message. Transcript projection
 * reads only matching assistant text blocks, never arbitrary strings or tool
 * call payloads. Reply IDs are not used to filter events: the public UI uses
 * them for optimistic message mapping, while this client scopes by its fresh
 * acknowledged session and excludes acknowledgement-owned user IDs. `nonce`
 * is local-only and deliberately is not sent.
 */

export const MuseDelivery = Object.freeze({
  NOT_SENT: 'not_sent',
  ACCEPTED: 'accepted',
  UNKNOWN: 'unknown',
});

export const CHAT_STREAM_PATH = '/chat/stream';
export const CHAT_CANCEL_PATH = '/chat/cancel';
export const CHAT_CAPABILITIES = Object.freeze([
  'chat_cancel',
  'delta_stream',
  'custom_reactions',
  'custom_reactions_facebook_thumbs_up_v1',
]);

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_ALLOWED_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_ISSUED_SESSION_IDS = 100_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

/** Safe, typed failure with no raw transport message, URL, body or credentials. */
export class MuseRpcError extends Error {
  constructor(code, { delivery = MuseDelivery.UNKNOWN, cancelConfirmed = undefined, quarantine = false } = {}) {
    super(code);
    this.name = 'MuseRpcError';
    this.code = code;
    this.delivery = delivery;
    if (typeof cancelConfirmed === 'boolean') this.cancelConfirmed = cancelConfirmed;
    this.safe = Object.freeze({
      code,
      delivery,
      ...(typeof cancelConfirmed === 'boolean' ? { cancelConfirmed } : {}),
      ...(quarantine ? { quarantine: true } : {}),
    });
  }
}

/**
 * Optional branded error for a channel that can prove it failed before write.
 * Never use `not_sent` after the channel has invoked the network write.
 */
export class MuseChannelError extends Error {
  constructor(code, { delivery = MuseDelivery.UNKNOWN } = {}) {
    super(code);
    this.name = 'MuseChannelError';
    this.code = code;
    this.delivery = delivery;
  }
}

const systemClock = Object.freeze({
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
});

/**
 * Create a bounded RPC client.
 * `clock` has `setTimeout(callback, ms)` / `clearTimeout(handle)` methods.
 * `idFactory()` creates an opaque local operation id only; it is not sent.
 * `pollIntervalMs` is only a local async-iterator wait cadence and never polls
 * chat history or makes another server request.
 * @param {{channel:object,clock?:object,idFactory?:()=>string,sessionIdFactory?:()=>string,pollIntervalMs?:number,timeoutMs?:number,cancelTimeoutMs?:number,maxOutputBytes?:number,maxPromptBytes?:number}} options
 */
export class MuseRpcClient {
  #channel;
  #clock;
  #idFactory;
  #sessionIdFactory;
  #pollIntervalMs;
  #timeoutMs;
  #cancelTimeoutMs;
  #maxOutputBytes;
  #maxPromptBytes;
  #active = new Set();
  #quarantined = new Set();
  #issuedSessionIds = new Set();
  #closePromise = null;

  constructor({
    channel,
    clock = systemClock,
    idFactory = defaultId,
    sessionIdFactory = defaultId,
    pollIntervalMs = 1_000,
    timeoutMs = 240_000,
    cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS,
    maxOutputBytes = MAX_OUTPUT_BYTES,
    maxPromptBytes = MAX_ALLOWED_PROMPT_BYTES,
  } = {}) {
    if (!channel || typeof channel.openStream !== 'function' || typeof channel.request !== 'function' ||
      typeof channel.close !== 'function') {
      throw new MuseRpcError('invalid_channel', { delivery: MuseDelivery.NOT_SENT });
    }
    if (typeof channel.nodeId !== 'string' || channel.nodeId.trim().length === 0 || channel.nodeId.length > 255) {
      throw new MuseRpcError('invalid_node_id', { delivery: MuseDelivery.NOT_SENT });
    }
    if (!clock || typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') {
      throw new MuseRpcError('invalid_clock', { delivery: MuseDelivery.NOT_SENT });
    }
    if (typeof idFactory !== 'function') throw new MuseRpcError('invalid_id_factory', { delivery: MuseDelivery.NOT_SENT });
    if (typeof sessionIdFactory !== 'function') throw new MuseRpcError('invalid_session_id_factory', { delivery: MuseDelivery.NOT_SENT });
    if (!isBoundedInteger(pollIntervalMs, 1, 60_000) || !isBoundedInteger(timeoutMs, 1, 15 * 60_000) ||
      !isBoundedInteger(cancelTimeoutMs, 1, 60_000) || !isBoundedInteger(maxOutputBytes, 1, MAX_OUTPUT_BYTES)) {
      throw new MuseRpcError('invalid_limits', { delivery: MuseDelivery.NOT_SENT });
    }
    if (!isBoundedInteger(maxPromptBytes, 1, MAX_ALLOWED_PROMPT_BYTES)) {
      throw new MuseRpcError('invalid_limits', { delivery: MuseDelivery.NOT_SENT });
    }
    this.#channel = channel;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#sessionIdFactory = sessionIdFactory;
    this.#pollIntervalMs = pollIntervalMs;
    this.#timeoutMs = timeoutMs;
    this.#cancelTimeoutMs = cancelTimeoutMs;
    this.#maxOutputBytes = maxOutputBytes;
    this.#maxPromptBytes = maxPromptBytes;
  }

  /** Number of operations quarantined because cancellation could not be confirmed. */
  get quarantinedCount() { return this.#quarantined.size; }

  /**
   * Start exactly one new draft generation. No history, session lookup or retry
   * is performed. The returned message id is the completed assistant message id.
   * @param {string} prompt
   * @param {{signal?:AbortSignal,nonce?:string}} [options]
   * @returns {Promise<{text:string,sessionId:string,messageId:string,delivery:'accepted'}>}
   */
  async generate(prompt, { signal, nonce } = {}) {
    validatePrompt(prompt, this.#maxPromptBytes);
    if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      throw new MuseRpcError('invalid_signal', { delivery: MuseDelivery.NOT_SENT });
    }
    if (nonce != null && (typeof nonce !== 'string' || nonce.length > 256)) {
      throw new MuseRpcError('invalid_nonce', { delivery: MuseDelivery.NOT_SENT });
    }
    if (signal?.aborted) throw new MuseRpcError('aborted', { delivery: MuseDelivery.NOT_SENT });
    if (this.#closePromise != null) throw new MuseRpcError('channel_quarantined', { delivery: MuseDelivery.NOT_SENT, quarantine: true });

    let operationId;
    try { operationId = this.#idFactory(); }
    catch { throw new MuseRpcError('id_factory_failed', { delivery: MuseDelivery.NOT_SENT }); }
    if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 256 || this.#active.has(operationId)) {
      throw new MuseRpcError('invalid_operation_id', { delivery: MuseDelivery.NOT_SENT });
    }
    let requestedSessionId;
    try { requestedSessionId = this.#sessionIdFactory(); }
    catch { throw new MuseRpcError('session_id_factory_failed', { delivery: MuseDelivery.NOT_SENT }); }
    if (!isVersion4Uuid(requestedSessionId) || this.#issuedSessionIds.has(requestedSessionId) ||
      this.#issuedSessionIds.size >= MAX_ISSUED_SESSION_IDS) {
      throw new MuseRpcError('invalid_session_id', { delivery: MuseDelivery.NOT_SENT });
    }
    this.#issuedSessionIds.add(requestedSessionId);
    // `nonce` is intentionally local-only; it is never logged or serialized.
    void nonce;
    this.#active.add(operationId);

    const controller = new AbortController();
    let abortReason = null;
    let timeoutHandle;
    const onCallerAbort = () => {
      abortReason = 'aborted';
      controller.abort();
    };
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    timeoutHandle = this.#clock.setTimeout(() => {
      abortReason = 'timeout';
      controller.abort();
    }, this.#timeoutMs);

    const body = {
      message: prompt,
      node_id: this.#channel.nodeId,
      session_id: requestedSessionId,
      capabilities: [...CHAT_CAPABILITIES],
    };
    let sessionId = null;
    let userMessageId = null;
    let promptMessageIds = null;
    let accepted = false;
    let iterator = null;
    let pendingNext = null;
    const assistantMessages = new Map();

    try {
      const openPromise = Promise.resolve().then(() => this.#channel.openStream({
        method: 'POST', path: CHAT_STREAM_PATH, body, signal: controller.signal,
      }));
      const opened = await raceOpen(openPromise, controller.signal);
      if (opened.kind === 'aborted') {
        this.#quarantined.add(operationId);
        await this.#closeChannel(operationId);
        // A broken channel may never settle openStream, even after close. Keep
        // the operation quarantined and bound this wait; opened.settled already
        // converts late rejection to a value, so it cannot become unhandled.
        const settledOpen = await boundedSettle(opened.settled, this.#cancelTimeoutMs, this.#clock);
        const late = settledOpen.kind === 'resolved' ? settledOpen.value : null;
        if (late?.kind === 'value') {
          const lateIterator = late.value?.events?.[Symbol.asyncIterator]?.();
          if (lateIterator?.return) {
            const returned = await boundedSettle(
              Promise.resolve().then(() => lateIterator.return()),
              this.#cancelTimeoutMs,
              this.#clock,
            );
            if (returned.kind === 'timeout') {
              // Do not wait indefinitely for a late stream cleanup.
              await boundedSettle(returned.settled, this.#cancelTimeoutMs, this.#clock);
            }
          }
        }
        throw new MuseRpcError(abortReason ?? 'aborted', {
          delivery: MuseDelivery.UNKNOWN,
          cancelConfirmed: false,
          quarantine: true,
        });
      }
      if (opened.kind === 'error') {
        const failure = channelFailure(opened.error);
        if (failure.delivery !== MuseDelivery.NOT_SENT) {
          this.#quarantined.add(operationId);
          await this.#closeChannel(operationId);
          throw new MuseRpcError(failure.code, {
            delivery: failure.delivery,
            cancelConfirmed: false,
            quarantine: true,
          });
        }
        throw failure;
      }
      const stream = opened.value;
      const ack = stream?.ack;
      sessionId = readSessionId(ack);
      userMessageId = readMessageId(ack);
      promptMessageIds = readPromptMessageIds(ack);
      if (!sessionId || sessionId !== requestedSessionId || !userMessageId) {
        accepted = true;
        this.#quarantined.add(operationId);
        await this.#closeChannel(operationId);
        throw new MuseRpcError('invalid_stream_ack', {
          delivery: MuseDelivery.ACCEPTED,
          cancelConfirmed: false,
          quarantine: true,
        });
      }
      accepted = true;
      if (!stream.events || typeof stream.events[Symbol.asyncIterator] !== 'function') {
        const cleanup = await this.#cancel(sessionId, operationId);
        throw cleanupError('invalid_stream_events', cleanup);
      }
      iterator = stream.events[Symbol.asyncIterator]();

      while (true) {
        if (controller.signal.aborted) {
          const cleanup = await this.#cancel(sessionId, operationId);
          throw cleanupError(abortReason ?? 'aborted', cleanup);
        }
        if (pendingNext == null) pendingNext = Promise.resolve().then(() => iterator.next())
          .then((value) => ({ kind: 'next', value }), (error) => ({ kind: 'error', error }));
        const outcome = await nextOrControl(pendingNext, controller.signal, this.#clock, this.#pollIntervalMs);
        if (outcome.kind === 'poll') continue;
        pendingNext = null;
        if (outcome.kind === 'aborted') {
          const cleanup = await this.#cancel(sessionId, operationId);
          throw cleanupError(abortReason ?? 'aborted', cleanup);
        }
        if (outcome.kind === 'error') {
          const cleanup = await this.#cancel(sessionId, operationId);
          throw cleanupError('stream_failed', cleanup);
        }
        if (outcome.value.done) {
          const cleanup = await this.#cancel(sessionId, operationId);
          throw cleanupError('stream_ended_without_completion', cleanup);
        }

        const event = unwrapGatewayEvent(outcome.value.value);
        if (!event) continue;
        const payload = event.payload;
        // The public client routes chat updates by main lane and session.
        // Missing session ids are not treated as belonging to this draft.
        if (payload.session_id !== sessionId) continue;
        if (event.name === 'delta.presentation') {
          if (payload.transcript_surface != null && payload.transcript_surface !== 'main_chat') continue;
          if (payload.role !== 'assistant' || typeof payload.message_id !== 'string' ||
            promptMessageIds.has(payload.message_id)) continue;
          if (assistantMessages.size >= 32 && !assistantMessages.has(payload.message_id)) continue;
          const candidate = assistantMessages.get(payload.message_id) ?? { text: '', textBytes: 0 };
          const visible = firstNonEmptyString(payload.display_text, payload.fallback_text);
          if (visible != null) {
            candidate.text = visible;
            candidate.textBytes = encoder.encode(candidate.text).byteLength;
            if (candidate.textBytes > this.#maxOutputBytes) {
              const cleanup = await this.#cancel(sessionId, operationId);
              throw cleanupError('output_too_large', cleanup);
            }
          }
          assistantMessages.set(payload.message_id, candidate);
          continue;
        }
        if (event.name === 'delta.text_append') {
          if (typeof payload.message_id !== 'string' || typeof payload.text !== 'string') continue;
          if (payload.role != null && payload.role !== 'assistant') continue;
          if (promptMessageIds.has(payload.message_id) || !isMainChatEvent(payload)) continue;
          if (assistantMessages.size >= 32 && !assistantMessages.has(payload.message_id)) continue;
          const candidate = assistantMessages.get(payload.message_id) ?? { text: '', textBytes: 0 };
          candidate.textBytes += encoder.encode(payload.text).byteLength;
          if (candidate.textBytes > this.#maxOutputBytes) {
            const cleanup = await this.#cancel(sessionId, operationId);
            throw cleanupError('output_too_large', cleanup);
          }
          candidate.text += payload.text;
          assistantMessages.set(payload.message_id, candidate);
          continue;
        }
        if (event.name !== 'delta.message_done') continue;
        if (!isMainChatEvent(payload) || typeof payload.message_id !== 'string' ||
          !['completed', 'interrupted', 'failed'].includes(payload.status)) continue;
        // A terminal event alone never establishes assistant identity. Muse
        // also emits message_done for the user's prompt.
        if (promptMessageIds.has(payload.message_id)) continue;
        const candidate = assistantMessages.get(payload.message_id);
        if (candidate == null) continue;
        if (payload.status !== 'completed') {
          throw new MuseRpcError(`generation_${payload.status}`, { delivery: MuseDelivery.ACCEPTED });
        }
        const finalText = extractDoneVisibleText(payload, payload.message_id) ?? candidate.text;
        if (encoder.encode(finalText).byteLength > this.#maxOutputBytes) {
          throw new MuseRpcError('output_too_large', { delivery: MuseDelivery.ACCEPTED });
        }
        return {
          text: finalText,
          sessionId,
          messageId: payload.message_id,
          delivery: MuseDelivery.ACCEPTED,
        };
      }
    } catch (error) {
      if (error instanceof MuseRpcError) throw error;
      // openStream invocation may have written before a generic error; never
      // reinterpret it as not-sent or automatically retry it.
      const failure = accepted
        ? new MuseRpcError('rpc_failed', { delivery: MuseDelivery.ACCEPTED })
        : channelFailure(error);
      if (failure.delivery !== MuseDelivery.NOT_SENT) this.#quarantined.add(operationId);
      throw failure;
    } finally {
      this.#clock.clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', onCallerAbort);
      this.#active.delete(operationId);
      if (iterator?.return) {
        const returnPromise = Promise.resolve().then(() => iterator.return());
        const returned = await boundedSettle(returnPromise, this.#cancelTimeoutMs, this.#clock);
        if (returned.kind === 'timeout') {
          await this.#closeChannel(operationId);
          // close() normally settles blocked iterator operations, but a broken
          // channel must not keep generation pending after that bounded attempt.
          // The original return promise remains rejection-handled if it settles late.
          await boundedSettle(returned.settled, this.#cancelTimeoutMs, this.#clock);
          throw new MuseRpcError('iterator_cleanup_unconfirmed', {
            delivery: accepted ? MuseDelivery.ACCEPTED : MuseDelivery.UNKNOWN,
            cancelConfirmed: false,
          quarantine: true,
          });
        }
        if (returned.kind === 'rejected') {
          await this.#closeChannel(operationId);
          throw new MuseRpcError('iterator_cleanup_failed', {
            delivery: accepted ? MuseDelivery.ACCEPTED : MuseDelivery.UNKNOWN,
            cancelConfirmed: false,
            quarantine: true,
          });
        }
      }
    }
  }

  async #cancel(sessionId, operationId) {
    const controller = new AbortController();
    let timeout;
    let timedOut = false;
    const request = Promise.resolve().then(() => this.#channel.request({
      method: 'POST', path: CHAT_CANCEL_PATH, body: { session_id: sessionId }, signal: controller.signal,
    })).then((value) => ({ kind: 'response', value }), () => ({ kind: 'error' }));
    const timeoutPromise = new Promise((resolve) => {
      timeout = this.#clock.setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ kind: 'timeout' });
      }, this.#cancelTimeoutMs);
    });
    try {
      const result = await Promise.race([
        request,
        timeoutPromise,
      ]);
      const response = result.kind === 'response' ? result.value : null;
      const body = response?.body;
      const confirmed = !timedOut && Number.isInteger(response?.status) && response.status >= 200 &&
        response.status < 300 && body != null && typeof body === 'object' && body.cancelled === true;
      if (confirmed) {
        this.#quarantined.delete(operationId);
        return { confirmed: true, quarantined: false };
      }
      this.#quarantined.add(operationId);
      const closeConfirmed = await this.#closeChannel(operationId);
      // A close normally settles the original request. Bound that contract too:
      // if a broken channel leaves it pending, retain quarantine and return the
      // safe failure instead of hanging. `request` always converts rejections
      // to values, so a late settlement cannot become unhandled.
      const settled = await boundedSettle(request, this.#cancelTimeoutMs, this.#clock);
      if (settled.kind === 'timeout' || !closeConfirmed) {
        return { confirmed: false, quarantined: true, closeConfirmed: false };
      }
      return { confirmed: false, quarantined: true, closeConfirmed };
    } finally {
      this.#clock.clearTimeout(timeout);
    }
  }

  async #closeChannel(operationId) {
    this.#quarantined.add(operationId);
    if (this.#closePromise == null) {
      this.#closePromise = Promise.resolve().then(() => this.#channel.close({ quarantine: true }))
        .then(() => true, () => false);
    }
    return this.#closePromise;
  }
}

function validatePrompt(prompt, maxPromptBytes) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || encoder.encode(prompt).byteLength > maxPromptBytes) {
    throw new MuseRpcError('invalid_prompt', { delivery: MuseDelivery.NOT_SENT });
  }
}

function readSessionId(ack) {
  return ack && typeof ack === 'object' && typeof ack.session_id === 'string' && ack.session_id.length > 0
    ? ack.session_id : null;
}

function readMessageId(ack) {
  return ack && typeof ack === 'object' && typeof ack.message_id === 'string' &&
    ack.message_id.trim().length > 0 && ack.message_id.length <= 512 ? ack.message_id : null;
}

function readPromptMessageIds(ack) {
  const ids = new Set();
  const messageId = readMessageId(ack);
  if (messageId) ids.add(messageId);
  const replyToMessageId = ack && typeof ack === 'object' && typeof ack.reply_to_message_id === 'string' &&
    ack.reply_to_message_id.trim().length > 0 && ack.reply_to_message_id.length <= 512
    ? ack.reply_to_message_id : null;
  if (replyToMessageId) ids.add(replyToMessageId);
  return ids;
}

function unwrapGatewayEvent(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'event' || typeof value.event !== 'string' || value.payload == null ||
    typeof value.payload !== 'object' || Array.isArray(value.payload)) return null;
  if (value.event !== 'delta.presentation' && value.event !== 'delta.text_append' &&
    value.event !== 'delta.message_done') return null;
  return { name: value.event, payload: value.payload };
}

function firstNonEmptyString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0) ?? null;
}

function isMainChatEvent(payload) {
  return payload.stream_lane === 'main' || payload.transcript_surface === 'main' ||
    payload.transcript_surface === 'main_chat';
}

/** Read only the same explicit visible projection fields used by Muse's UI. */
function extractDoneVisibleText(payload, assistantMessageId) {
  return transcriptVisibleText(payload.transcript, assistantMessageId) ??
    transcriptVisibleText(payload.payload?.transcript, assistantMessageId) ??
    firstNonEmptyString(payload.display_text, payload.content, payload.payload?.content,
      payload.fallback_text, payload.payload?.fallback_text);
}

function transcriptVisibleText(value, assistantMessageId) {
  let transcript = value;
  if (typeof transcript === 'string') {
    try { transcript = JSON.parse(transcript); } catch { return null; }
  }
  if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript) ||
    !Array.isArray(transcript.messages)) return null;
  const row = transcript.messages.find((message) => message && typeof message === 'object' &&
    message.role === 'assistant' && message.id === assistantMessageId);
  if (!row || !Array.isArray(row.content)) return null;
  const parts = [];
  collectVisibleTextBlocks(row.content, parts, 0);
  const joined = parts.join('');
  return joined.trim().length > 0 ? joined : null;
}

function collectVisibleTextBlocks(blocks, output, depth) {
  if (depth > 8 || output.length > 4096 || !Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') output.push(block.text);
    else if (block.type === 'sub_agent') collectVisibleTextBlocks(block.content, output, depth + 1);
  }
}

function channelFailure(error) {
  if (error instanceof MuseChannelError) {
    const delivery = Object.values(MuseDelivery).includes(error.delivery) ? error.delivery : MuseDelivery.UNKNOWN;
    return new MuseRpcError(safeCode(error.code), { delivery });
  }
  return new MuseRpcError('channel_failed', { delivery: MuseDelivery.UNKNOWN });
}

function safeCode(code) {
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'channel_failed';
}

function raceOpen(promise, signal) {
  let abortListener;
  const abortPromise = new Promise((resolve) => {
    abortListener = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  const settled = promise.then((value) => ({ kind: 'value', value }), (error) => ({ kind: 'error', error }));
  return Promise.race([settled, abortPromise]).then((result) =>
    result.kind === 'aborted' ? { ...result, settled } : result,
  ).finally(() => {
    signal.removeEventListener('abort', abortListener);
  });
}

function boundedSettle(promise, timeoutMs, clock) {
  let timeout;
  const timed = new Promise((resolve) => {
    timeout = clock.setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const settled = Promise.resolve(promise).then(
    (value) => ({ kind: 'resolved', value }),
    () => ({ kind: 'rejected' }),
  );
  return Promise.race([settled, timed]).then((result) => ({ ...result, settled }))
    .finally(() => clock.clearTimeout(timeout));
}

function cleanupError(code, cleanup) {
  return new MuseRpcError(code, {
    delivery: MuseDelivery.ACCEPTED,
    cancelConfirmed: cleanup.confirmed,
    quarantine: cleanup.quarantined,
  });
}

function nextOrControl(nextPromise, signal, clock, pollIntervalMs) {
  let timer;
  let abortListener;
  const pollPromise = new Promise((resolve) => {
    timer = clock.setTimeout(() => resolve({ kind: 'poll' }), pollIntervalMs);
  });
  const abortPromise = new Promise((resolve) => {
    abortListener = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  return Promise.race([nextPromise, pollPromise, abortPromise]).finally(() => {
    clock.clearTimeout(timer);
    signal.removeEventListener('abort', abortListener);
  });
}

function defaultId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('secure random UUID unavailable');
}

function isVersion4Uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isBoundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}
