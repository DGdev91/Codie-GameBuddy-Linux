import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DeviceError } from '../../src/agentd/tools/device-client.mjs';
import { ToolLink } from '../../src/agentd/tools/tool-link.mjs';
import { deviceProof, proofContextWs } from '../../src/agentd/tools/sign.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

class FakeSocket extends EventEmitter {
  static all = [];
  constructor(url) { super(); this.url = new URL(url); this.terminated = false; FakeSocket.all.push(this); }
  terminate() { this.terminated = true; this.emit('close'); }
  close() { this.emit('close'); }
}

const device = {
  host: '127.0.0.1', port: 1, credential: { id: 'c', secret: 's' },
  request: async method => (method === 'GET' ? { revision: 1 } : { revision: 1 }),
};

// The device's ready, answering the socket's challenge with `secret`.
const ready = (ws, secret = device.credential.secret, revision = 1) => ws.emit('message', JSON.stringify({
  type: 'ready', data: { revision, proof: deviceProof({ secret }, proofContextWs('i'), ws.url.searchParams.get('challenge')) },
}));

function link(silenceMs) {
  FakeSocket.all = [];
  return new ToolLink({ device, integrationId: 'i', name: 'agents', tools: [], onInvoke: () => {}, WebSocketImpl: FakeSocket, silenceMs });
}

// The device pings every 20s; a device that rebooted sends nothing and no
// FIN either, so only silence tells the link it is gone.
test('a silent device socket is dropped and the link reconnects', async t => {
  const l = link(60);
  t.after(() => l.stop());
  l.start();
  await sleep(10);
  const first = FakeSocket.all[0];
  ready(first);
  assert.equal(l.online, true);
  await sleep(120);
  assert.equal(first.terminated, true);
  assert.equal(l.online, false);
  await sleep(1100); // the first retry waits 1s
  assert.ok(FakeSocket.all.length >= 2, 'reconnected after the silence');
});

test('pings keep a quiet device socket alive', async t => {
  const l = link(60);
  t.after(() => l.stop());
  l.start();
  await sleep(10);
  const first = FakeSocket.all[0];
  ready(first);
  for (let i = 0; i < 4; i++) { await sleep(30); first.emit('ping'); }
  assert.equal(first.terminated, false);
  assert.equal(l.online, true);
});

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

// The daemon looks for a moved device (host refresh) on network failures
// only: a device that answers with an error is where it was.
test('a publish or socket that cannot reach the device reports it unreachable', async t => {
  FakeSocket.all = [];
  const unreachable = [];
  let fail = refused();
  const flaky = { ...device, request: async () => { if (fail) throw fail; return { revision: 1 }; } };
  const l = new ToolLink({ device: flaky, integrationId: 'i', name: 'echo', tools: [], onInvoke: () => {}, WebSocketImpl: FakeSocket,
    onUnreachable: e => unreachable.push(e) });
  t.after(() => l.stop());
  l.start();
  await sleep(10);
  assert.equal(unreachable.length, 1);

  fail = new DeviceError(500, 'INTERNAL');
  await sleep(1100);
  assert.equal(unreachable.length, 1, 'a device error is not a network failure');

  fail = null;
  await sleep(2100);
  const ws = FakeSocket.all.at(-1);
  assert.ok(ws, 'connected once the device answers');
  ws.emit('error', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
  assert.equal(unreachable.length, 2);
});

test('a device that refuses the credential is unreachable too; one that answers is reachable', async t => {
  FakeSocket.all = [];
  const seen = [];
  let fail = new DeviceError(401, 'LOCAL_SECRET_MISMATCH');
  const other = { ...device, request: async () => { if (fail) throw fail; return { revision: 1 }; } };
  const l = new ToolLink({ device: other, integrationId: 'i', name: 'echo', tools: [], onInvoke: () => {}, WebSocketImpl: FakeSocket,
    onUnreachable: () => seen.push('unreachable'), onReachable: () => seen.push('reachable') });
  t.after(() => l.stop());
  l.start();
  await sleep(10);
  assert.deepEqual(seen, ['unreachable']);
  fail = new DeviceError(409, 'INTEGRATION_REVISION_CONFLICT');
  await sleep(1100);
  assert.deepEqual(seen, ['unreachable'], 'a business error says nothing about the address');
  fail = null;
  await sleep(2100);
  assert.deepEqual(seen, ['unreachable', 'reachable']);
});

test('a link stopped while updating its catalog sends no PUT and reports no error', async t => {
  FakeSocket.all = [];
  const calls = [];
  let answerGet;
  const slow = { ...device, request: async method => {
    calls.push(method);
    if (method === 'GET' && calls.length > 2) await new Promise(r => { answerGet = r; });
    return { revision: 1 };
  } };
  const l = new ToolLink({ device: slow, integrationId: 'i', name: 'echo', tools: [], onInvoke: () => {}, WebSocketImpl: FakeSocket });
  t.after(() => l.stop());
  l.start();
  await sleep(10);
  assert.deepEqual(calls, ['GET', 'PUT']);
  const update = l.updateTools([]);
  await sleep(10);
  l.stop();
  answerGet();
  await update;
  assert.deepEqual(calls, ['GET', 'PUT', 'GET']);
});

// Signatures are one-way: anything at the device's address can accept
// agentd's calls, so the socket counts only once the device answered a fresh
// challenge with the credential's secret.
test('a socket whose ready does not prove the credential stays offline and is dropped', async t => {
  FakeSocket.all = [];
  const calls = [];
  const unreachable = [];
  const l = new ToolLink({ device, integrationId: 'i', name: 'agents', tools: [], onInvoke: c => calls.push(c), WebSocketImpl: FakeSocket,
    onUnreachable: e => unreachable.push(e.code) });
  t.after(() => l.stop());
  l.start();
  await sleep(10);
  const first = FakeSocket.all[0];
  assert.match(first.url.searchParams.get('challenge'), /^[0-9a-f]{32}$/);
  first.emit('message', JSON.stringify({ type: 'invoke', data: { invocation_id: 'early', name: 'ask_agent' } }));
  ready(first, 'not-the-secret');
  first.emit('message', JSON.stringify({ type: 'invoke', data: { invocation_id: 'x', name: 'ask_agent' } }));
  assert.equal(l.online, false);
  assert.equal(first.terminated, true);
  assert.deepEqual(unreachable, ['DEVICE_PROOF_MISMATCH']);
  assert.deepEqual(calls, [], 'no invoke before or after a failed proof');

  await sleep(1100);
  const second = FakeSocket.all.at(-1);
  assert.notEqual(second, first);
  assert.notEqual(second.url.searchParams.get('challenge'), first.url.searchParams.get('challenge'), 'a fresh challenge per socket');
  ready(second);
  assert.equal(l.online, true);
  second.emit('message', JSON.stringify({ type: 'invoke', data: { invocation_id: 'ok', name: 'ask_agent' } }));
  assert.deepEqual(calls.map(c => c.invocation_id), ['ok']);
});
