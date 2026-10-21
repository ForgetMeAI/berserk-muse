import { randomBytes } from 'node:crypto';

const DEFAULT_CAPACITY = 256;
const EVENT_TYPES = new Set(['snapshot', 'account.updated', 'request.finished', 'job.updated', 'queue.updated', 'server.shutdown', 'accounts', 'requests', 'jobs', 'status', 'error']);

export function createPanelEventBus({ capacity = DEFAULT_CAPACITY, epoch = randomBytes(8).toString('hex') } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new TypeError('Invalid event capacity');
  const ring = [];
  const listeners = new Set();
  let sequence = 0;
  let closed = false;

  function publish(type, data = {}) {
    if (closed) return null;
    if (!EVENT_TYPES.has(type)) throw new TypeError('Unsupported panel event type');
    const event = { id: `${epoch}:${++sequence}`, type, data, at: Date.now() };
    ring.push(event);
    if (ring.length > capacity) ring.shift();
    for (const listener of [...listeners]) listener(event);
    return event.id;
  }

  function replay(lastEventId) {
    if (typeof lastEventId !== 'string' || lastEventId.length > 96) return { reset: true, events: [] };
    const [seenEpoch, rawSequence, extra] = lastEventId.split(':');
    if (extra !== undefined || seenEpoch !== epoch || !/^\d+$/.test(rawSequence || '')) return { reset: true, events: [] };
    const seen = Number(rawSequence);
    if (!Number.isSafeInteger(seen) || seen > sequence) return { reset: true, events: [] };
    const oldest = ring[0] ? Number(ring[0].id.split(':')[1]) : sequence + 1;
    if (seen < oldest - 1) return { reset: true, events: [] };
    return { reset: false, events: ring.filter(event => Number(event.id.split(':')[1]) > seen) };
  }

  function subscribe(listener) {
    if (closed) throw new Error('Panel event bus is closed');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function closeAll() {
    if (closed) return;
    closed = true;
    listeners.clear();
    ring.length = 0;
  }

  return { publish, replay, subscribe, closeAll, get size() { return listeners.size; }, get epoch() { return epoch; } };
}
