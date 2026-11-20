import assert from 'node:assert/strict';
import test from 'node:test';
import { matchAllowList, nextTickMs, shouldSend } from '../src/main/trigger.mjs';

const games = [{ process: 'EldenRing.exe', name: 'Elden Ring' }];
const settings = { cooldownMs: 60000, changeThreshold: 12 };

test('the allow list matches the exe file name, ignoring case and folders', () => {
  const win = p => ({ id: 1, path: p, owner: '', title: '' });
  assert.deepEqual(matchAllowList(win('C:\\Games\\ELDEN RING\\eldenring.exe'), games), games[0]);
  assert.equal(matchAllowList(win('C:\\Windows\\explorer.exe'), games), null);
  assert.equal(matchAllowList(win(''), games), null);
  assert.equal(matchAllowList(null, games), null);
});

test('of the games that share a program, the one not switched off matches', () => {
  const win = { id: 1, path: 'C:\\Apps\\chrome.exe', owner: '', title: '' };
  const shared = [{ process: 'chrome.exe', name: 'A', off: true }, { process: 'Chrome.exe', name: 'B' }];
  assert.deepEqual(matchAllowList(win, shared), shared[1]);
  assert.equal(matchAllowList(win, [shared[0]]), null);
});

test('the first frame is sent once the cooldown allows it', () => {
  assert.equal(shouldSend({ hash: 5n, lastSentHash: null, now: 0, lastSentAt: -Infinity, settings }), true);
});

test('a frame waits for the cooldown and for a large enough change', () => {
  const base = { lastSentHash: 0n, lastSentAt: 1000, settings };
  const big = (1n << 12n) - 1n; // 12 bits differ
  assert.equal(shouldSend({ ...base, hash: big, now: 1000 + 59999 }), false);
  assert.equal(shouldSend({ ...base, hash: big, now: 1000 + 60000 }), true);
  assert.equal(shouldSend({ ...base, hash: (1n << 11n) - 1n, now: 1000 + 60000 }), false);
});

test('chatty mode sends right after a sent turn, same scene or not, and retries soon after a conversation', () => {
  const chatty = { ...settings, chattyMode: true };
  const base = { hash: 0n, lastSentHash: 0n, lastSentAt: 1000, now: 1001, settings: chatty };
  assert.equal(shouldSend({ ...base, last: 'sent' }), true);
  assert.equal(shouldSend({ ...base, last: 'busy' }), true);
  assert.equal(shouldSend({ ...base, hash: 5n, lastSentHash: null, lastSentAt: -Infinity, last: null }), true);
});

test('chatty mode waits one cooldown after a turn that failed for another reason, then skips the change check', () => {
  const chatty = { ...settings, chattyMode: true };
  const base = { hash: 0n, lastSentHash: 0n, lastSentAt: 1000, last: 'failed', settings: chatty };
  assert.equal(shouldSend({ ...base, now: 1000 + 59999 }), false);
  assert.equal(shouldSend({ ...base, now: 1000 + 60000 }), true);
});

test('the loop samples every sampleMs; chatty mode goes on at once after a sent turn', () => {
  const s = { sampleMs: 3000, chattyMode: false };
  assert.equal(nextTickMs('sent', s), 3000);
  assert.equal(nextTickMs('sent', { ...s, chattyMode: true }), 0);
  assert.equal(nextTickMs('blocked', { ...s, chattyMode: true }), 3000);
  assert.equal(nextTickMs(undefined, { ...s, chattyMode: true }), 3000);
});
