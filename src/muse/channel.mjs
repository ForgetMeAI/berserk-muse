import { MuseChannelError, MuseDelivery } from './rpc.mjs';

export const NOISE_CHANNEL_EXPORT = 'NoiseChannel';
export const HTTP_ROUTE_EXPORT = 'resolveHttpRouteRequest';
export const GATEWAY_ERROR_EXPORT = 'isGatewayRequestError';

const MAX_PENDING_EVENTS = 1_000;
const MAX_PENDING_EVENT_BYTES = 1024 * 1024;
const MAX_CLOSE_WAIT_MS = 5_000;
const ALLOWED_METHODS = new Map([
  ['POST /chat/stream', 'chat.stream'],
  // Used only by openStream after the acknowledged draft session is known.
  ['POST /chat/subscribe', 'chat.subscribe'],
  ['POST /chat/cancel', 'chat.cancel'],
]);

/**
 * Bind one owned Noise connection to the restricted MuseRpcClient contract.
 * One channel instance owns at most one fresh chat.stream for an internally
 * supplied UUID v4, and supports a
 * matching chat.cancel only. It never reconnects, retries, logs frames, or
 * exposes requests for arbitrary routes.
 *
 * The semantic export manifest resolves NoiseChannel,
 * resolveHttpRouteRequest, and isGatewayRequestError from the reviewed public
 * chunk set. `NoiseChannel.sendHttpRequest` resolves the
 * subscription acknowledgement and dispatches subsequent parsed envelopes
 * to the constructor's handleGatewayMessage callback. The callback is scoped
 * here by the exact session_id proposed in the owned stream request; envelopes
 * without that id are dropped.
 *
 * The public UI sends chat.stream as `{items:[{type:'text',text}],node_id,
 * capabilities}`. The RPC-facing contract supplies `message`; this adapter
 * converts that field to the observed public payload shape.
 */
export class MuseNoiseChannel {
  #runtime;
  #connection;
  #nodeId;
  #noise;
  #routes;
  #gatewayErrors;
  #stream = null;
  #sessionId = null;
  #usedStream = false;
  #cancelUsed = false;
  #closingController = new AbortController();
  #controllers = new Set();
  #operations = new Set();
  #closePromise = null;
  #messageHandler;
  #closeHandler;
  #socketClosedPromise;
  #resolveSocketClosed;
  #maxEvents;
  #maxEventBytes;
  #closeWaitMs;

  constructor({
    runtime,
    connection,
    nodeId,
    maxEvents = MAX_PENDING_EVENTS,
    maxEventBytes = MAX_PENDING_EVENT_BYTES,
    closeWaitMs = MAX_CLOSE_WAIT_MS,
  } = {}) {
    if (!runtime || typeof runtime.getExport !== 'function' || !connection?.ws || !connection?.transport) {
      throw channelError('invalid_channel', MuseDelivery.NOT_SENT);
    }
    if (typeof nodeId !== 'string' || nodeId.trim().length === 0 || nodeId.length > 255) {
      throw channelError('invalid_node_id', MuseDelivery.NOT_SENT);
    }
    if (!isBoundedInteger(maxEvents, 1, MAX_PENDING_EVENTS) ||
      !isBoundedInteger(maxEventBytes, 1, MAX_PENDING_EVENT_BYTES) ||
      !isBoundedInteger(closeWaitMs, 1, MAX_CLOSE_WAIT_MS)) {
      throw channelError('invalid_limits', MuseDelivery.NOT_SENT);
    }
    const NoiseChannel = runtime.getExport(NOISE_CHANNEL_EXPORT);
    const resolveHttpRouteRequest = runtime.getExport(HTTP_ROUTE_EXPORT);
    const isGatewayRequestError = runtime.getExport(GATEWAY_ERROR_EXPORT);
    if (typeof NoiseChannel !== 'function' ||
      typeof resolveHttpRouteRequest !== 'function' ||
      typeof isGatewayRequestError !== 'function') {
      throw channelError('needs_vendor_assets', MuseDelivery.NOT_SENT);
    }

    this.#runtime = runtime;
    this.#connection = connection;
    this.#nodeId = nodeId;
    this.#routes = { resolveHttpRouteRequest };
    this.#gatewayErrors = { isGatewayRequestError };
    this.#maxEvents = maxEvents;
    this.#maxEventBytes = maxEventBytes;
    this.#closeWaitMs = closeWaitMs;
    this.#socketClosedPromise = new Promise((resolve) => { this.#resolveSocketClosed = resolve; });

    this.#messageHandler = (event) => {
      if (this.#closePromise != null) return;
      if (!(event?.data instanceof ArrayBuffer)) {
        this.#failStream('invalid_noise_frame');
        return;
      }
      try { this.#noise.handleInboundBinary(new Uint8Array(event.data)); }
      catch { this.#failStream('noise_frame_failed'); }
    };
    this.#closeHandler = () => {
      this.#resolveSocketClosed();
      // A peer closing an owned socket is a stream failure unless this
      // channel has already begun its own bounded close sequence.
      if (!this.#closePromise) this.#failStream('noise_socket_closed');
    };
    const ws = connection.ws;
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('message', this.#messageHandler);
      ws.addEventListener('close', this.#closeHandler, { once: true });
    } else if ('onmessage' in ws) {
      this.#previousOnMessage = ws.onmessage;
      ws.onmessage = this.#messageHandler;
      ws.addEventListener?.('close', this.#closeHandler, { once: true });
    } else {
      throw channelError('invalid_websocket', MuseDelivery.NOT_SENT);
    }
    if (ws.readyState === 3) this.#resolveSocketClosed();

    this.#noise = new NoiseChannel({
      ws,
      transport: connection.transport,
      websocketConnectionID: globalThis.crypto.randomUUID(),
      handleGatewayMessage: (message) => this.#handleGatewayMessage(message),
      onFatal: () => this.#failStream('noise_channel_failed'),
      enableRequestCompression: false,
      closeOnRequestTimeout: true,
    });
  }

  get nodeId() { return this.#nodeId; }

  /** Send one new-draft stream request and return session-scoped events. */
  async openStream({ method, path, body, signal } = {}) {
    this.#assertAllowed('openStream', method, path);
    if (this.#usedStream) throw channelError('stream_already_used', MuseDelivery.NOT_SENT);
    if (!body || typeof body.message !== 'string' || body.message.trim().length === 0 ||
      body.node_id !== this.#nodeId || !Array.isArray(body.capabilities) ||
      body.capabilities.some((item) => typeof item !== 'string') ||
      !isVersion4Uuid(body.session_id)) {
      throw channelError('invalid_stream_request', MuseDelivery.NOT_SENT);
    }
    this.#assertUsable(signal);
    this.#usedStream = true;
    const stream = createEventQueue({
      maxEvents: this.#maxEvents,
      maxBytes: this.#maxEventBytes,
      onReturn: () => this.close({ quarantine: true }),
    });
    this.#stream = stream;
    const route = this.#resolve('chat.stream');
    const requestBody = {
      items: [{ type: 'text', text: body.message }],
      node_id: body.node_id,
      session_id: body.session_id,
      capabilities: [...body.capabilities],
    };
    let ack;
    try {
      ack = await this.#send('chat.stream', route, { signal, body: requestBody, onResponseMeta: noop });
    } catch (error) {
      stream.fail(error);
      throw error;
    }
    const sessionId = readSessionId(ack);
    if (sessionId !== body.session_id) {
      stream.fail(channelError('invalid_stream_ack', MuseDelivery.UNKNOWN));
      await this.close({ quarantine: true }).catch(() => {});
      throw channelError('invalid_stream_ack', MuseDelivery.UNKNOWN);
    }
    this.#sessionId = body.session_id;
    stream.setSessionId(body.session_id);
    if (stream.failed) throw stream.failure;
    try {
      const subscribeAck = await this.#send('chat.subscribe', this.#resolve('chat.subscribe'), {
        signal,
        body: {
          session_id: sessionId,
          after_stream_seq: 0,
          after_chat_event_seq: 0,
          capabilities: [...body.capabilities],
        },
        onResponseMeta: noop,
      });
      if (readSessionId(subscribeAck) !== sessionId) {
        stream.fail(channelError('subscription_ack_mismatch', MuseDelivery.UNKNOWN));
        await this.close({ quarantine: true }).catch(() => {});
        throw channelError('subscription_ack_mismatch', MuseDelivery.UNKNOWN);
      }
    } catch (error) {
      if (error instanceof MuseChannelError && error.code === 'subscription_ack_mismatch') throw error;
      stream.fail(channelError('subscription_failed', MuseDelivery.UNKNOWN));
      await this.close({ quarantine: true }).catch(() => {});
      // The draft stream was already accepted: a later subscription failure
      // cannot establish that generation was never sent.
      throw channelError('subscription_failed', MuseDelivery.UNKNOWN);
    }
    return { ack, events: stream.iterable };
  }

  /** Send one cancel only for the session acknowledged by this channel. */
  async request({ method, path, body, signal } = {}) {
    this.#assertAllowed('request', method, path);
    if (method !== 'POST' || path !== '/chat/cancel' || !this.#sessionId || this.#cancelUsed ||
      !body || body.session_id !== this.#sessionId || Object.keys(body).length !== 1) {
      throw channelError('invalid_cancel_request', MuseDelivery.NOT_SENT);
    }
    this.#assertUsable(signal);
    this.#cancelUsed = true;
    const route = this.#resolve('chat.cancel');
    let status;
    try {
      const responseBody = await this.#send('chat.cancel', route, {
        signal,
        body,
        onResponseMeta: (meta) => { status = meta?.status; },
      });
      return { status, body: responseBody };
    } catch (error) {
      if (error instanceof MuseChannelError && error.code === 'http_response' && Number.isInteger(error.httpStatus)) {
        // Preserve status for the RPC's exact cancellation-confirmation check;
        // never infer acceptance or rejection from generic HTTP status alone.
        return { status: error.httpStatus, body: null };
      }
      throw error;
    }
  }

  /** Close the owned connection, await in-flight calls and socket close. */
  close({ quarantine = true } = {}) {
    if (quarantine !== true) return Promise.reject(channelError('invalid_close_mode', MuseDelivery.NOT_SENT));
    if (this.#closePromise) return this.#closePromise;
    // Publish the close state before calling WebSocket.close(); a fake or
    // implementation may dispatch `close` synchronously from that call.
    this.#closePromise = Promise.resolve().then(() => this.#closeOwnedConnection());
    return this.#closePromise;
  }

  #assertAllowed(kind, method, path) {
    if (typeof method !== 'string' || typeof path !== 'string' ||
      !ALLOWED_METHODS.has(`${method} ${path}`) ||
      (kind === 'openStream' && `${method} ${path}` !== 'POST /chat/stream') ||
      (kind === 'request' && `${method} ${path}` !== 'POST /chat/cancel') ||
      (kind !== 'openStream' && kind !== 'request')) {
      throw channelError('route_not_allowed', MuseDelivery.NOT_SENT);
    }
  }

  #assertUsable(signal) {
    if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      throw channelError('invalid_signal', MuseDelivery.NOT_SENT);
    }
    if (signal?.aborted) throw channelError('aborted', MuseDelivery.NOT_SENT);
    if (this.#closePromise || !this.#noise?.isAlive?.() || this.#connection.ws.readyState !== 1) {
      throw channelError('channel_not_ready', MuseDelivery.NOT_SENT);
    }
  }

  #resolve(method) {
    try {
      const resolved = this.#routes.resolveHttpRouteRequest(method, {});
      if (!resolved?.route?.noiseOnly || resolved.route.method !== method ||
        resolved.route.streamMode !== (method === 'chat.cancel' ? undefined : 'subscription')) {
        throw new Error('invalid typed route');
      }
      return resolved;
    } catch {
      throw channelError('route_unavailable', MuseDelivery.NOT_SENT);
    }
  }

  async #send(method, route, { signal, body, onResponseMeta }) {
    this.#assertUsable(signal);
    const controller = new AbortController();
    this.#controllers.add(controller);
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal, this.#closingController.signal])
      : AbortSignal.any([controller.signal, this.#closingController.signal]);
    const options = { signal: combinedSignal, onResponseMeta };
    let invoked = false;
    let operation;
    try {
      // The reviewed API's second argument is the resolved typed route with
      // route params; its body is serialized from that argument. Keep POST
      // payloads in route params only where the public request contract expects.
      const requestRoute = body === undefined ? route : { ...route, params: { ...body } };
      invoked = true;
      operation = Promise.resolve().then(() => this.#noise.sendHttpRequest(method, requestRoute, options));
      this.#operations.add(operation);
      return await operation;
    } catch (error) {
      const isOfficialPrewrite = invoked && this.#gatewayErrors.isGatewayRequestError(error) &&
        error.kind === 'transport' && error.deliveryState === 'not_sent';
      if (method === 'chat.cancel' && this.#gatewayErrors.isGatewayRequestError(error) &&
        Number.isInteger(error.httpStatus)) {
        const wrapped = channelError('http_response', MuseDelivery.UNKNOWN);
        wrapped.httpStatus = error.httpStatus;
        throw wrapped;
      }
      throw channelError(isOfficialPrewrite ? 'request_not_sent' : 'request_outcome_unknown',
        isOfficialPrewrite ? MuseDelivery.NOT_SENT : MuseDelivery.UNKNOWN);
    } finally {
      if (operation) this.#operations.delete(operation);
      this.#controllers.delete(controller);
    }
  }

  #handleGatewayMessage(message) {
    const stream = this.#stream;
    if (!stream || this.#closePromise || !message || typeof message !== 'object' || Array.isArray(message)) return;
    // User-message echoes can repeat the full submitted prompt in both
    // `content` and `display_text`. The RPC only consumes assistant deltas and
    // completion events, so discard this known-unconsumed event before JSON
    // cloning or charging it against the bounded pending-event queue.
    if (message.type === 'event' && message.event === 'message.user') return;
    const sessionId = typeof message.session_id === 'string' ? message.session_id
      : typeof message.payload?.session_id === 'string' ? message.payload.session_id : null;
    if (!sessionId) return;
    let serialized;
    try { serialized = JSON.stringify(message); } catch { return this.#failStream('invalid_gateway_event'); }
    if (typeof serialized !== 'string') return;
    stream.push(sessionId, message, new TextEncoder().encode(serialized).byteLength);
    if (stream.failed) this.#quarantineAfterQueueFailure();
  }

  #failStream(code) {
    this.#stream?.fail(channelError(code, MuseDelivery.UNKNOWN));
    this.#quarantineAfterQueueFailure();
  }

  #quarantineAfterQueueFailure() {
    if (!this.#closePromise) void this.close({ quarantine: true }).catch(() => {});
  }

  async #closeOwnedConnection() {
    const ws = this.#connection.ws;
    this.#stream?.fail(channelError('channel_closed', MuseDelivery.UNKNOWN));
    this.#closingController.abort();
    try { this.#noise.dispose(new Error('Channel closed')); } catch {}
    for (const controller of this.#controllers) controller.abort();
    try { ws.close(); } catch {}

    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(channelError('channel_close_unconfirmed', MuseDelivery.UNKNOWN)), this.#closeWaitMs);
    });
    try {
      await Promise.race([
        Promise.allSettled([...this.#operations]),
        timeoutPromise,
      ]);
      await Promise.race([this.#socketClosedPromise, timeoutPromise]);
    } catch {
      this.#stream?.fail(channelError('channel_close_unconfirmed', MuseDelivery.UNKNOWN));
      throw channelError('channel_close_unconfirmed', MuseDelivery.UNKNOWN);
    } finally {
      clearTimeout(timeout);
      this.#removeSocketHandlers();
    }
  }

  #removeSocketHandlers() {
    const ws = this.#connection.ws;
    if (typeof ws.removeEventListener === 'function') {
      ws.removeEventListener('message', this.#messageHandler);
      ws.removeEventListener('close', this.#closeHandler);
    } else if (ws.onmessage === this.#messageHandler) {
      ws.onmessage = this.#previousOnMessage ?? null;
    }
  }

  #previousOnMessage;
}

function createEventQueue({ maxEvents, maxBytes, onReturn }) {
  let sessionId = null;
  let queued = [];
  let bytes = 0;
  let pendingBeforeAck = [];
  let pendingBeforeAckBytes = 0;
  let waiters = [];
  let ended = false;
  let error = null;
  let failed = false;

  function deliver(item) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value: item.value, done: false });
    else {
      queued.push(item);
      bytes += item.bytes;
      if (queued.length > maxEvents || bytes > maxBytes) {
        fail(channelError('event_buffer_overflow', MuseDelivery.UNKNOWN));
      }
    }
  }
  function fail(reason) {
    if (ended) return;
    failed = true;
    error = reason;
    ended = true;
    queued = [];
    pendingBeforeAck = [];
    bytes = 0;
    pendingBeforeAckBytes = 0;
    for (const waiter of waiters.splice(0)) waiter.reject(reason);
  }
  const iterator = {
    next() {
      if (queued.length > 0) {
        const item = queued.shift();
        bytes -= item.bytes;
        return Promise.resolve({ value: item.value, done: false });
      }
      if (error) return Promise.reject(error);
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async return() {
      ended = true;
      queued = [];
      pendingBeforeAck = [];
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
      await onReturn?.();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() { return this; },
  };

  return {
    iterable: iterator,
    get failed() { return failed; },
    get failure() { return error; },
    setSessionId(value) {
      sessionId = value;
      for (const item of pendingBeforeAck) if (item.sessionId === sessionId) deliver(item);
      pendingBeforeAck = [];
      pendingBeforeAckBytes = 0;
    },
    push(messageSessionId, value, size) {
      if (ended || failed) return;
      const item = { sessionId: messageSessionId, value: JSON.parse(JSON.stringify(value)), bytes: size };
      if (sessionId) {
        if (item.sessionId === sessionId) deliver(item);
      } else {
        pendingBeforeAck.push(item);
        pendingBeforeAckBytes += size;
        if (pendingBeforeAck.length > maxEvents || pendingBeforeAckBytes > maxBytes) {
          fail(channelError('event_buffer_overflow', MuseDelivery.UNKNOWN));
        }
      }
    },
    fail,
  };
}

function readSessionId(ack) {
  return ack && typeof ack === 'object' && typeof ack.session_id === 'string' &&
    isVersion4Uuid(ack.session_id) ? ack.session_id : null;
}

function isVersion4Uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function channelError(code, delivery) {
  return new MuseChannelError(code, { delivery });
}

function isBoundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function noop() {}
