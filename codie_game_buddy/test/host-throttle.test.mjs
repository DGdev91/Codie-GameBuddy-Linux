import assert from 'node:assert/strict';
import test from 'node:test';
import { throttleByHost } from '../src/main/host-throttle.mjs';

// A fake clock: sleep moves it on at once.
function setup(gapMs = 1000) {
  const state = { clock: 0, started: [] };
  const fetch = async url => { state.started.push([new URL(url).host, state.clock]); return { ok: true }; };
  const throttled = throttleByHost(fetch, { gapMs, now: () => state.clock, sleep: async ms => { state.clock += ms; } });
  return { state, throttled };
}

test('requests to one host start at least gapMs apart, in the order they were made', async () => {
  const { state, throttled } = setup();
  await Promise.all([
    throttled('https://wiki.biligame.com/wiki/api.php?a=1'),
    throttled('https://wiki.biligame.com/eldenring/api.php?a=2'),
    throttled('https://wiki.biligame.com/wukong/api.php?a=3'),
  ]);
  assert.deepEqual(state.started, [['wiki.biligame.com', 0], ['wiki.biligame.com', 1000], ['wiki.biligame.com', 2000]]);
});

test('other hosts do not wait for each other', async () => {
  const { state, throttled } = setup();
  await Promise.all([throttled('https://wiki.biligame.com/x'), throttled('https://eldenring.fandom.com/api.php')]);
  assert.deepEqual(state.started, [['wiki.biligame.com', 0], ['eldenring.fandom.com', 0]]);
});

test('a request made after the gap has passed starts at once', async () => {
  const { state, throttled } = setup();
  await throttled('https://wiki.biligame.com/x');
  state.clock += 5000;
  await throttled('https://wiki.biligame.com/y');
  assert.deepEqual(state.started.map(s => s[1]), [0, 5000]);
});

test('a failed request still holds its slot, and its error reaches the caller', async () => {
  const state = { clock: 0, started: [] };
  let first = true;
  const fetch = async () => {
    state.started.push(state.clock);
    if (first) { first = false; throw new Error('network down'); }
    return { ok: true };
  };
  const throttled = throttleByHost(fetch, { gapMs: 1000, now: () => state.clock, sleep: async ms => { state.clock += ms; } });
  const [a, b] = await Promise.allSettled([throttled('https://x.org/1'), throttled('https://x.org/2')]);
  assert.equal(a.status, 'rejected');
  assert.match(a.reason.message, /network down/);
  assert.equal(b.status, 'fulfilled');
  assert.deepEqual(state.started, [0, 1000]);
});
