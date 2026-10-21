import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { SerialQueue } from './queue.mjs';
import { BridgeError, checkAbort } from './errors.mjs';
import { normalizeRequest, buildPrompt, parseDecision } from './protocol.mjs';
import { anthropicToChat, chatToAnthropic, sendAnthropicSSE, anthropicError, anthropicUnsupportedOptions } from './anthropic.mjs';
import { TransportFailure } from './accounts/pool.mjs';

const MODELS = ['muse-web', 'muse'];
const modelObject = id => ({ id, object: 'model', created: 0, owned_by: 'local-muse-browser-bridge' });
const LOCAL_AUTH = 'Bearer muse-local'; // Public local-only placeholder, not a Meta credential.
const DELIVERY_STATES = new Set(['not_sent', 'rejected_before_acceptance', 'accepted', 'unknown']);
const SAFE_ERROR_CODE = /^[a-zA-Z0-9_.-]{1,64}$/;
const SAFE_TELEMETRY_ID = /^[a-zA-Z0-9_.:-]{1,120}$/;

function deliveryState(error, fallback = 'unknown') {
  return DELIVERY_STATES.has(error?.delivery) ? error.delivery : fallback;
}

function errorCode(error, fallback = 'internal_error') {
  if (TransportFailure.is(error) && typeof error.transportCode === 'string' && SAFE_ERROR_CODE.test(error.transportCode)) {
    return error.transportCode;
  }
  return typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code) ? error.code : fallback;
}

function telemetryId(value) {
  return typeof value === 'string' && SAFE_TELEMETRY_ID.test(value) ? value : null;
}

async function callOptional(target, method, fallback, record) {
  const fn = typeof target?.[method] === 'function' ? target[method].bind(target) : fallback;
  if (typeof fn !== 'function') return;
  try { await fn(record); } catch { /* Optional telemetry must not change request behavior. */ }
}

function writeJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > maxBytes) throw new BridgeError('Request is too large.', 413, 'request_too_large');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new BridgeError('Request body must be valid JSON.', 400, 'invalid_json'); }
}

function checkLocalRequest(req, port) {
  const host = req.headers.host;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) {
    throw new BridgeError('Unexpected local Host header.', 403, 'invalid_host');
  }
  if (req.headers.origin && ![ `http://127.0.0.1:${port}`, `http://localhost:${port}` ].includes(req.headers.origin)) {
    throw new BridgeError('Cross-origin requests are not supported.', 403, 'invalid_origin');
  }
}

async function sendSSE(res, response, includeUsage) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Muse-Streaming': 'buffered',
    'X-Muse-Tools': 'synthetic-json', 'X-Muse-Sampling': 'controlled-by-muse-app',
    'X-Muse-Usage': 'estimated-visible-payload',
  });
  const frame = delta => ({ id: response.id, object: 'chat.completion.chunk', created: response.created,
    model: response.model, choices: [{ index: 0, delta, finish_reason: null }] });
  const emit = async value => {
    if (res.destroyed) throw new BridgeError('Client disconnected.', 499, 'request_cancelled');
    if (!res.write(`data: ${JSON.stringify(value)}\n\n`)) await new Promise((resolve, reject) => {
      const cleanup = () => { res.removeListener('drain', onDrain); res.removeListener('close', onClose); res.removeListener('error', onClose); };
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new BridgeError('Client disconnected.', 499, 'request_cancelled')); };
      res.once('drain', onDrain); res.once('close', onClose); res.once('error', onClose);
    });
  };
  await emit(frame({ role: 'assistant' }));
  const message = response.choices[0].message;
  if (message.tool_calls) {
    await emit(frame({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }));
  } else {
    // The upstream reply is already complete and validated: intentionally buffered SSE.
    const text = message.content || '';
    for (let start = 0; start < text.length; start += 1024) await emit(frame({ content: text.slice(start, start + 1024) }));
  }
  const terminal = frame({});
  terminal.choices[0].finish_reason = response.choices[0].finish_reason;
  await emit(terminal);
  if (includeUsage) await emit({ id: response.id, object: 'chat.completion.chunk', created: response.created,
    model: response.model, choices: [], usage: response.usage, muse_usage: response.muse_usage });
  res.end('data: [DONE]\n\n');
}

export function createBridge({ driver, rootId = 'test', maxChars = 250000, maxBytes = 1048576,
  timeoutMs = 300000, queueLimit = 4, onShutdown = null, queue: injectedQueue = null,
  panelRouter = null, telemetry = null, onRequestStarted = null, onRequestFinished = null } = {}) {
  if (!driver?.generate || !driver?.status) throw new TypeError('A driver is required');
  if (injectedQueue && typeof injectedQueue.run !== 'function') throw new TypeError('An injected queue must implement run().');
  if (panelRouter && typeof panelRouter.handle !== 'function') throw new TypeError('A panel router must implement handle().');
  const queue = injectedQueue || new SerialQueue(queueLimit);
  const active = new Set();
  let shuttingDown = false;
  const stats = { requests: 0, completed: 0, errors: 0, lastError: null };

  const server = http.createServer(async (req, res) => {
    const anthropicWire = ['/v1/messages', '/v1/messages/count_tokens'].includes(req.url?.split('?')[0]);
    let controller;
    let deadlineHit = false;
    let telemetryRequest = null;
    try {
      const port = server.address().port;
      checkLocalRequest(req, port);
      if (shuttingDown) throw new BridgeError('Service is stopping.', 503, 'shutting_down');
      // Host was validated against the two loopback forms above. Keep the
      // parsed origin aligned with the caller so `localhost` panel requests
      // pass the panel's same-origin checks without weakening Origin policy.
      const parsedURL = new URL(req.url, `http://${req.headers.host}`);
      const path = parsedURL.pathname;
      // Claude Code probes base-URL reachability before attaching API auth.
      if (req.method === 'HEAD' && path === '/') {
        res.writeHead(200, { 'Cache-Control': 'no-store', 'X-Berserk-Service': 'berserk-muse' });
        res.end();
        return;
      }
      const panelPath = path.startsWith('/panel') || path === '/control' || path.startsWith('/control/');
      if (panelRouter && panelPath && await panelRouter.handle(req, res, parsedURL)) return;
      if (req.method === 'GET' && ['/health', '/healthz', '/readyz'].includes(path)) {
        const transport = await driver.status();
        return writeJson(res, path === '/readyz' && !transport.ready ? 503 : 200, {
          service: 'berserk-muse', rootId, version: '0.1.0', ...transport,
          queue: queue.status, tools: 'synthetic-json', streaming: 'buffered',
          upstreamUsageAvailable: false, usage: 'estimated-visible-payload', stats: { ...stats },
        });
      }
      if (req.headers.authorization !== LOCAL_AUTH && !(anthropicWire && req.headers['x-api-key'] === 'muse-local')) throw new BridgeError('Use the local placeholder authorization.', 401, 'invalid_api_key');
      if (req.method === 'GET' && ['/v1/models', '/models'].includes(path)) {
        return writeJson(res, 200, { object: 'list', data: MODELS.map(modelObject) });
      }
      if (req.method === 'GET' && /^\/v1\/models\/[^/]+$/.test(path)) {
        const model = decodeURIComponent(path.slice('/v1/models/'.length));
        if (!MODELS.includes(model)) throw new BridgeError('Unknown local model alias.', 404, 'model_not_found');
        return writeJson(res, 200, modelObject(model));
      }
      if (req.method === 'POST' && path === '/control/login') {
        if (queue.status.active) throw new BridgeError('Wait for the current generation to finish.', 409, 'generation_in_progress');
        if (!driver.login) throw new BridgeError('Login is unavailable for this driver.', 404, 'not_found');
        return writeJson(res, 200, await driver.login());
      }
      if (req.method === 'POST' && path === '/control/stop' && onShutdown) {
        writeJson(res, 200, { stopping: true });
        setImmediate(() => onShutdown());
        return;
      }
      if (!(req.method === 'POST' && ['/v1/chat/completions', '/chat/completions', '/v1/messages', '/v1/messages/count_tokens'].includes(path))) {
        return writeJson(res, 404, { error: { message: 'Endpoint not supported.', type: 'invalid_request_error', code: 'not_found', param: null } });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        throw new BridgeError('Content-Type must be application/json.', 415, 'invalid_content_type');
      }
      const body = await readBody(req, maxBytes);
      const converted = anthropicWire ? anthropicToChat(body, { countOnly: path.endsWith('/count_tokens') }) : body;
      const unsupported = anthropicWire ? anthropicUnsupportedOptions(converted) : [];
      if (unsupported.length) res.setHeader('X-Muse-Unsupported-Options', unsupported.join(','));
      const request = normalizeRequest(converted, { maxChars });
      if (!MODELS.includes(request.model)) throw new BridgeError('Unknown local model alias.', 404, 'model_not_found');
      if (anthropicWire && path.endsWith('/count_tokens')) {
        const serialized = buildPrompt(request, { nonce: 'count-tokens-estimate' });
        res.setHeader('X-Muse-Usage', 'estimated-visible-payload');
        return writeJson(res, 200, { input_tokens: Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3) });
      }
      stats.requests++;
      const requestId = randomUUID();
      const nonce = randomUUID();
      const prompt = buildPrompt(request, { nonce });
      if (prompt.length > maxChars + 12000) throw new BridgeError('Serialized context is too large.', 413, 'context_length_exceeded');
      const inputEstimate = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 3);
      telemetryRequest = {
        requestId, model: request.model, startedAt: Date.now(), estimatedInputTokens: inputEstimate,
        estimatedOutputTokens: null, accountId: null, sessionRevision: null, attemptId: null,
        delivery: 'not_sent', status: 'running', errorCode: null,
      };
      controller = new AbortController();
      active.add(controller);
      const timeout = setTimeout(() => { deadlineHit = true; controller.abort(); }, timeoutMs);
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      req.once('aborted', abort);
      res.once('close', abort);
      await callOptional(null, null, onRequestStarted, {
        requestId, model: request.model, startedAt: telemetryRequest.startedAt, estimatedInputTokens: inputEstimate,
      });
      try {
        const response = await queue.run(async (signal, lease) => {
          checkAbort(signal);
          const attemptId = telemetryId(lease?.attemptId) || randomUUID();
          const attemptStartedAt = Date.now();
          telemetryRequest = {
            ...telemetryRequest,
            attemptId,
            accountId: telemetryId(lease?.accountId),
            sessionRevision: Number.isSafeInteger(lease?.sessionRevision) ? lease.sessionRevision : null,
            delivery: 'not_sent', status: 'running', errorCode: null,
          };
          await callOptional(telemetry, 'recordAttempt', null, {
            requestId, attemptId, accountId: telemetryRequest.accountId,
            sessionRevision: telemetryRequest.sessionRevision, model: request.model,
            startedAt: attemptStartedAt, estimatedInputTokens: inputEstimate, delivery: 'not_sent',
          });
          let generationInvoked = false;
          let result;
          try {
            generationInvoked = true;
            result = await driver.generate(prompt, { signal, nonce, lease, requestId, attemptId });
            telemetryRequest = { ...telemetryRequest, delivery: 'accepted' };
          } catch (error) {
            telemetryRequest = {
              ...telemetryRequest,
              delivery: deliveryState(error, generationInvoked ? 'unknown' : 'not_sent'),
              errorCode: errorCode(error),
            };
            throw error;
          }
          checkAbort(signal);
          if (!result || typeof result.text !== 'string' || result.text.length > 524288) {
            throw new BridgeError('Muse returned an invalid or oversized response.', 502, 'invalid_model_response');
          }
          const decision = parseDecision(result.text, request, { nonce });
          // A labelled length estimate supports client compaction. These are NOT
          // provider counters, billable tokens, quota measurements, or hidden reasoning.
          const outputEstimate = Math.ceil(Buffer.byteLength(result.text, 'utf8') / 3);
          telemetryRequest = {
            ...telemetryRequest, delivery: 'accepted', estimatedOutputTokens: outputEstimate,
          };
          return {
            id: `chatcmpl-${requestId}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [{ index: 0, message: { role: 'assistant', content: decision.content,
              ...(decision.tool_calls ? { tool_calls: decision.tool_calls } : {}) }, finish_reason: decision.finish_reason }],
            usage: { prompt_tokens: inputEstimate, completion_tokens: outputEstimate, total_tokens: inputEstimate + outputEstimate },
            muse_usage: { estimated: true, method: 'ceil_utf8_bytes_div_3', scope: 'adapter_visible_payload_only' },
          };
        }, controller.signal, { requestId, estimatedInputTokens: inputEstimate });
        res.setHeader('X-Muse-Tools', 'synthetic-json');
        res.setHeader('X-Muse-Streaming', 'buffered');
        res.setHeader('X-Muse-Sampling', 'controlled-by-muse-app');
        res.setHeader('X-Muse-Usage', 'estimated-visible-payload');
        if (anthropicWire) {
          const message = chatToAnthropic(response);
          res.setHeader('request-id', requestId);
          if (request.stream) await sendAnthropicSSE(res, message);
          else writeJson(res, 200, message);
        } else if (request.stream) await sendSSE(res, response, request.includeUsage);
        else writeJson(res, 200, response);
        stats.completed++;
        stats.lastError = null;
        telemetryRequest = { ...telemetryRequest, status: 'completed', errorCode: null };
      } finally {
        clearTimeout(timeout);
        active.delete(controller);
        req.removeListener('aborted', abort);
        res.removeListener('close', abort);
      }
    } catch (error) {
      const typedDelivery = DELIVERY_STATES.has(error?.delivery);
      const safe = error instanceof BridgeError || ['ProtocolError', 'AnthropicProtocolError'].includes(error?.name) || typedDelivery;
      const status = deadlineHit ? 504 : safe ? (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : typedDelivery ? 502 : 500) : 500;
      const code = deadlineHit ? 'request_timeout' : safe ? errorCode(error, 'upstream_unavailable') : 'internal_error';
      stats.errors++;
      stats.lastError = code;
      if (telemetryRequest) telemetryRequest = {
        ...telemetryRequest,
        status: deadlineHit ? 'timeout' : code === 'request_cancelled' ? 'cancelled' : 'error',
        errorCode: code,
        delivery: deliveryState(error, telemetryRequest.delivery),
      };
      const message = deadlineHit ? 'The queued or active request exceeded its deadline.' : typedDelivery ? 'The upstream transport failed. Check account readiness before retrying.' : safe ? error.message : 'Local bridge failed. Restart it and check account readiness.';
      if (!res.headersSent) writeJson(res, status, anthropicWire ? anthropicError(status, code, message) : { error: {
        message,
        type: status >= 500 || typedDelivery ? 'upstream_error' : safe ? (error.type || 'upstream_error') : 'server_error',
        code, param: safe && !typedDelivery ? (error.param || null) : null,
      } });
      else res.destroy();
      // No raw exception messages, browser data, request/response bodies, or headers in logs.
    } finally {
      if (telemetryRequest) {
        const finishedAt = Date.now();
        const record = {
          requestId: telemetryRequest.requestId, attemptId: telemetryRequest.attemptId,
          accountId: telemetryRequest.accountId, sessionRevision: telemetryRequest.sessionRevision,
          model: telemetryRequest.model, startedAt: telemetryRequest.startedAt, finishedAt,
          durationMs: Math.max(0, finishedAt - telemetryRequest.startedAt),
          status: telemetryRequest.status, delivery: telemetryRequest.delivery,
          errorCode: telemetryRequest.errorCode,
          estimatedInputTokens: telemetryRequest.estimatedInputTokens,
          estimatedOutputTokens: telemetryRequest.estimatedOutputTokens,
        };
        await callOptional(telemetry, 'recordResult', null, record);
        await callOptional(null, null, onRequestFinished, record);
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return {
    server, stats,
    async listen(port = 0) {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      return server.address().port;
    },
    async close() {
      shuttingDown = true;
      for (const controller of active) controller.abort();
      try { await panelRouter?.close?.(); } catch { /* Close active panel streams before closing the HTTP listener. */ }
      server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
      await driver.close?.();
    },
  };
}
