import assert from 'node:assert/strict';
import test from 'node:test';
import { TTL_MS, createContextFeed } from '../src/main/context-feed.mjs';

const GAME = { id: 7, path: 'C:\\Games\\game.exe', owner: 'Game', title: 'Game - Level 1' };
const BROWSER = { id: 8, path: 'C:\\Apps\\chrome.exe', owner: 'Chrome', title: 'Bank' };

function setup() {
  const state = { win: GAME, outcome: { ok: true }, given: [], cleared: 0, captured: [], logs: [] };
  const settings = { commentaryEnabled: true, allowList: [{ process: 'game.exe', name: 'Test Game', persona: 'A grumpy scout.' }] };
  const capture = {
    foreground: async () => state.win,
    captureJpeg: async (id, maxBytes) => { state.captured.push([id, maxBytes]); return Buffer.from([0xff, 0xd8, 0xff]); },
  };
  const host = {
    setContext: async req => { state.given.push(req); return state.outcome; },
    clearContext: async () => { state.cleared += 1; return { ok: true }; },
  };
  const feed = createContextFeed({ capture, host, settings: () => settings, locale: () => 'zh-CN', gameInfo: { get: () => ({ source: 'Wikipedia', text: 'A world of rings.' }) }, log: line => state.logs.push(line) });
  return { feed, state, settings, capture, host };
}

test('a listed game in front gives the device its screen, character and background', async () => {
  const { feed, state } = setup();
  assert.equal(await feed.tick(), 'given');
  const [{ image, text, ttlMs }] = state.given;
  assert.ok(Buffer.isBuffer(image));
  assert.equal(ttlMs, TTL_MS);
  assert.match(text, /The user is playing Test Game/);
  assert.match(text, /<character>A grumpy scout\.<\/character>/);
  assert.match(text, /From Wikipedia: A world of rings\./);
  assert.match(text, /Speak only Simplified Chinese/);
  // The image has to fit codie-host's 1 MiB of JSON as base64.
  assert.ok(state.captured[0][1] * 4 / 3 < 1 << 20);
});

test('away from the game, or with Commentary off, the device is told once to forget it', async () => {
  const { feed, state, settings } = setup();
  await feed.tick();
  state.win = BROWSER;
  assert.equal(await feed.tick(), 'cleared');
  assert.equal(await feed.tick(), 'none');
  state.win = GAME;
  await feed.tick();
  settings.commentaryEnabled = false;
  assert.equal(await feed.tick(), 'cleared');
  assert.equal(state.cleared, 2);
  assert.equal(state.given.length, 2);
});

test('a device that keeps refusing is logged once, and again when it takes the context', async () => {
  const { feed, state } = setup();
  state.outcome = { ok: false, kind: 'error', error: { code: 'NOT_FOUND', message: 'no such route' } };
  assert.equal(await feed.tick(), 'error');
  await feed.tick();
  assert.deepEqual(state.logs, ['context: error NOT_FOUND no such route']);
  state.outcome = { ok: true };
  await feed.tick();
  assert.deepEqual(state.logs.slice(1), ['context: given']);
});


test('a failed delete is retried until the device confirms removal', async () => {
  const { feed, state, host } = setup();
  await feed.tick();
  state.win = BROWSER;
  let attempts = 0;
  host.clearContext = async () => ({ ok: ++attempts > 1, kind: 'offline' });
  assert.equal(await feed.tick(), 'offline');
  assert.equal(await feed.tick(), 'cleared');
  assert.equal(await feed.tick(), 'none');
  assert.equal(attempts, 2);
});

test('turning off or changing foreground during capture never pushes that frame', async () => {
  for (const change of ['disabled', 'foreground']) {
    const { feed, state, settings, capture } = setup();
    capture.captureJpeg = async () => {
      if (change === 'disabled') settings.commentaryEnabled = false;
      else state.win = BROWSER;
      return Buffer.from('frame');
    };
    await feed.tick();
    assert.equal(state.given.length, 0);
  }
});

test('stop waits behind a push and then clears the device', async () => {
  const { feed, state, host } = setup();
  let release;
  host.setContext = async req => {
    state.given.push(req);
    await new Promise(resolve => { release = resolve; });
    return { ok: true };
  };
  const pushing = feed.tick();
  await new Promise(resolve => setImmediate(resolve));
  const stopping = feed.stop();
  release();
  await pushing;
  await stopping;
  assert.equal(state.cleared, 1);
  await feed.tick();
  assert.equal(state.given.length, 1);
});
