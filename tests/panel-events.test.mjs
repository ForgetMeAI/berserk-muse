import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelEventBus } from '../src/panel/events.mjs';

test('event ring replays bounded events and requests reset for stale or foreign cursors', () => {
  const bus = createPanelEventBus({ capacity: 2, epoch: 'epoch' });
  const one = bus.publish('status', { status: 'ready' });
  const two = bus.publish('jobs', {});
  const three = bus.publish('accounts', {});
  const replay = bus.replay(two);
  assert.equal(replay.reset, false);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].id, three);
  assert.equal(replay.events[0].type, 'accounts');
  assert.deepEqual(replay.events[0].data, {});
  assert.equal(bus.replay(one).reset, false);
  assert.equal(bus.replay('epoch:0').reset, true);
  assert.equal(bus.replay('other:2').reset, true);
  assert.equal(bus.replay('epoch:900').reset, true);

  const received = [];
  const stop = bus.subscribe(event => received.push(event.id));
  bus.publish('requests', {});
  stop();
  bus.publish('status', {});
  assert.equal(received.length, 1);
  bus.closeAll();
  assert.equal(bus.publish('status', {}), null);
});

test('event bus rejects unknown types and unsafe capacities', () => {
  assert.throws(() => createPanelEventBus({ capacity: 5000 }), /capacity/);
  const bus = createPanelEventBus();
  assert.throws(() => bus.publish('private-data'), /Unsupported/);
  bus.closeAll();
});
