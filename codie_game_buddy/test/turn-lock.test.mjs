import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnLock } from '../src/main/turn-lock.mjs';

test('turns run one at a time, in order', async () => {
  const lock = createTurnLock();
  const order = [];
  let release;
  const first = lock.run(() => new Promise(r => { order.push('first start'); release = r; }));
  const second = lock.run(async () => { order.push('second'); return 2; });
  await new Promise(r => setImmediate(r));
  assert.equal(lock.busy, true);
  assert.deepEqual(order, ['first start']);
  release(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first start', 'second']);
  assert.equal(lock.busy, false);
});

test('a failed turn does not block the next one', async () => {
  const lock = createTurnLock();
  await assert.rejects(lock.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(lock.busy, false);
  assert.equal(await lock.run(async () => 'next'), 'next');
  assert.equal(lock.busy, false);
});
