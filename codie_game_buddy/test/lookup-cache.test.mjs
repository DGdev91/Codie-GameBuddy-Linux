import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLookupCache, FAILED_RETRY_MS, MISS_RETRY_MS } from '../src/main/lookup-cache.mjs';

const INFO = { source: '萌娘百科', title: '黑神话：悟空', text: '取材于《西游记》。' };
const keyOf = ({ name, locale }) => `${locale}:${name.toLowerCase()}`;

function setup(t, lookup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { clock: 1_000, lookups: [], logs: [] };
  const file = path.join(dir, 'game-info.json');
  const make = () => createLookupCache({
    file, keyOf, label: 'game info', now: () => state.clock, log: line => state.logs.push(line),
    lookup: async args => { state.lookups.push(args); return lookup(args); },
  });
  return { state, file, make };
}

test('the first get starts a lookup and returns nothing; later gets return the cached value', async t => {
  const { state, make } = setup(t, async () => INFO);
  const cache = make();
  const args = { name: '黑神话：悟空', locale: 'zh-CN' };
  assert.equal(cache.get(args), null);
  assert.equal(cache.get(args), null); // one lookup in flight, not two
  await cache.idle();
  assert.deepEqual(state.lookups, [args]);
  assert.deepEqual(cache.get(args), INFO);
  assert.deepEqual(state.logs, ['game info: zh-CN:黑神话：悟空']);
});

test('the cache survives a restart and is kept per key', async t => {
  const { state, make } = setup(t, async () => INFO);
  const first = make();
  first.get({ name: '黑神话：悟空', locale: 'zh-CN' });
  await first.idle();
  const second = make();
  assert.equal(second.get({ name: '黑神话：悟空', locale: 'zh-CN' }).text, INFO.text);
  assert.equal(second.get({ name: '黑神话：悟空', locale: 'en' }), null);
  await second.idle();
  assert.equal(state.lookups.length, 2);
});

test('a key nothing was found for is looked up again only after MISS_RETRY_MS', async t => {
  const { state, make } = setup(t, async () => null);
  const cache = make();
  const args = { name: 'Unknown', locale: 'en' };
  cache.get(args);
  await cache.idle();
  assert.deepEqual(state.logs, ['game info: nothing for en:unknown']);
  state.clock += MISS_RETRY_MS - 1;
  cache.get(args);
  await cache.idle();
  assert.equal(state.lookups.length, 1);
  state.clock += 1;
  cache.get(args);
  await cache.idle();
  assert.equal(state.lookups.length, 2);
});

test('a failed lookup is tried again after FAILED_RETRY_MS, not a day later', async t => {
  const { state, make } = setup(t, async () => { throw new Error('HTTP 567'); });
  const cache = make();
  cache.get({ name: 'G', locale: 'en' });
  await cache.idle();
  assert.deepEqual(state.logs, ['game info: lookup failed for en:g (HTTP 567)']);
  state.clock += FAILED_RETRY_MS - 1;
  cache.get({ name: 'G', locale: 'en' });
  await cache.idle();
  assert.equal(state.lookups.length, 1);
  state.clock += 1;
  cache.get({ name: 'G', locale: 'en' });
  await cache.idle();
  assert.equal(state.lookups.length, 2);
});

test('an unreadable cache file is treated as empty', async t => {
  const { file, make } = setup(t, async () => INFO);
  fs.writeFileSync(file, '{ not json');
  assert.equal(make().get({ name: '黑神话：悟空', locale: 'zh-CN' }), null);
});

test('settled tells a finished lookup, found or not, from one not done yet', async t => {
  const { make } = setup(t, async ({ name }) => (name === 'found' ? INFO : null));
  const cache = make();
  const found = { name: 'found', locale: 'en' };
  const missing = { name: 'missing', locale: 'en' };
  assert.equal(cache.settled(found), false);
  cache.get(found);
  cache.get(missing);
  assert.equal(cache.settled(found), false); // still in flight
  await cache.idle();
  assert.equal(cache.settled(found), true);
  assert.equal(cache.settled(missing), true);
});
