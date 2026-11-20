import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/agentd/store.mjs';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-')); });

const rec = (over = {}) => ({
  deviceId: 'dev1', name: 'Living room', host: '10.0.0.2', port: 8081,
  credentialId: 'c1', credentialSecret: 's1', ...over,
});

test('empty store lists nothing', () => {
  assert.deepEqual(new Store(dir).listPairings(), []);
});

test('upsert persists and replaces by deviceId', () => {
  const s = new Store(dir);
  s.upsertPairing(rec());
  s.upsertPairing(rec({ name: 'Living room 2', credentialSecret: 's2' }));
  const again = new Store(dir).listPairings();
  assert.equal(again.length, 1);
  assert.equal(again[0].name, 'Living room 2');
  assert.equal(again[0].credentialSecret, 's2');
});

test('a replaced pairing keeps its place: the order of pairings never changes on an update', () => {
  const s = new Store(dir);
  s.upsertPairing(rec());
  s.upsertPairing(rec({ deviceId: 'dev2' }));
  s.upsertPairing(rec({ host: '10.0.0.99' }));
  assert.deepEqual(s.listPairings().map(r => [r.deviceId, r.host]), [['dev1', '10.0.0.99'], ['dev2', '10.0.0.2']]);
  s.upsertPairing(rec({ deviceId: 'dev3' }));
  assert.deepEqual(s.listPairings().map(r => r.deviceId), ['dev1', 'dev2', 'dev3']);
});

test('removePairing deletes one record', () => {
  const s = new Store(dir);
  s.upsertPairing(rec());
  assert.equal(s.removePairing('dev1'), true);
  assert.equal(s.removePairing('dev1'), false);
  assert.deepEqual(s.listPairings(), []);
});

test('corrupt pairing.json reads as empty instead of throwing', () => {
  fs.writeFileSync(path.join(dir, 'pairing.json'), '{oops');
  assert.deepEqual(new Store(dir).listPairings(), []);
});

test('writeStatus / readStatus round-trip, no temp files left', () => {
  const s = new Store(dir);
  s.writeStatus({ online: 1, paired: 2 });
  assert.deepEqual(s.readStatus(), { online: 1, paired: 2 });
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp')), []);
});

test('write over corrupt pairing.json backs it up first', () => {
  fs.writeFileSync(path.join(dir, 'pairing.json'), '{oops');
  const s = new Store(dir);
  s.upsertPairing(rec());
  const backups = fs.readdirSync(dir).filter(f => f.startsWith('pairing.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{oops');
  assert.equal(s.listPairings().length, 1);
});

test('data dir is private (0700)', { skip: process.platform === 'win32' }, () => {
  const sub = path.join(dir, 'home');
  new Store(sub);
  assert.equal(fs.statSync(sub).mode & 0o777, 0o700);
});

test('failed write leaves no temp file', () => {
  const s = new Store(dir);
  fs.mkdirSync(path.join(dir, 'status.json', 'x'), { recursive: true }); // rename target is a dir → fails
  assert.throws(() => s.writeStatus({ ok: 1 }));
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp')), []);
});


test('previous Codex sessions persist separately for each device', () => {
  const s = new Store(dir);
  assert.equal(s.lastCodexThread('d1'), null);
  s.rememberCodexThread('d1', 'thread-a');
  s.rememberCodexThread('d2', 'thread-b');
  const again = new Store(dir);
  assert.equal(again.lastCodexThread('d1'), 'thread-a');
  assert.equal(again.lastCodexThread('d2'), 'thread-b');
});
