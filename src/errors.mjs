export class BridgeError extends Error {
  constructor(message, status = 503, code = 'upstream_unavailable') {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.type = status >= 500 ? 'upstream_error' : 'invalid_request_error';
  }
}

export function abortError() {
  return new BridgeError('Request cancelled.', 499, 'request_cancelled');
}

export function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
