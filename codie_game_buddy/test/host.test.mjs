import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError, TURN_WAIT_MAX_MS } from 'codie-host';
import { CLIENT_NAME, SCOPE, classify, createHost } from '../src/main/host.mjs';

const tick = () => new Promise(r => setTimeout(r, 15));

function fakeClient(over = {}) {
  return {
    status: 'approved',
    calls: [],
    async connect() {},
    serve() { return new Promise(() => {}); },
    async devices() { return { found: [], paired: [{ deviceId: 'D1', name: 'Codie', online: false }] }; },
    async chatTurn(req) { this.calls.push(req); return { turn_id: 't', state: 'completed', assistant_text: 'hi', error: null }; },
    async pairConfirm() { return { ok: true, toolsReady: true, message: 'Paired.' }; },
    async close() {},
    ...over,
  };
}

test('the client asks for exactly the phase 2 and 3 scope', () => {
  assert.equal(CLIENT_NAME, 'game-buddy');
  assert.deepEqual(SCOPE, { tools: true, pair: true, api: ['/v1/api/data/user/chat/turns', '/v1/api/data/user/conversation/context', '/v1/api/data/user/system'] });
});

test('errors are classified for the tray', () => {
  const he = (status, code) => new HostError(status, code, code);
  assert.equal(classify(he(409, 'DEVICE_BLOCKED')), 'blocked');
  assert.equal(classify(he(409, 'AMBIENT_MODE_BLOCKED')), 'blocked');
  assert.equal(classify(he(403, 'APPROVAL_PENDING')), 'pending');
  assert.equal(classify(he(409, 'NOT_PAIRED')), 'not-paired');
  assert.equal(classify(he(409, 'REPAIR_REQUIRED')), 'not-paired');
  assert.equal(classify(he(503, 'DEVICE_OFFLINE')), 'offline');
  assert.equal(classify(he(400, 'INVALID_ARGUMENT')), 'error');
  assert.equal(classify(new TypeError('fetch failed')), 'offline');
});

test('an approved client with a paired device is ready', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const states = [];
  const host = createHost({ client: fakeClient(), onState: s => states.push(s), watchMs: 5 });
  await host.start(ac.signal);
  assert.equal(host.state, 'ready');
  assert.deepEqual(states, ['ready']);
});

test('a pending client becomes ready once approved; no device means not-paired', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const client = fakeClient({ status: 'pending', async devices() { return { found: [], paired: [] }; } });
  const host = createHost({ client, watchMs: 5 });
  await host.start(ac.signal);
  assert.equal(host.state, 'pending');
  client.status = 'approved';
  await tick();
  assert.equal(host.state, 'not-paired');
});

test('chat turns report their outcome and move the state', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  let fail = null;
  const client = fakeClient({ async chatTurn(req) { if (fail) throw fail; return { state: 'completed', req }; } });
  const host = createHost({ client, watchMs: 1000 });
  await host.start(ac.signal);

  const ok = await host.chatTurn({ image: Buffer.from([1]), text: 'look', speech: 'device' });
  assert.equal(ok.ok, true);

  fail = new HostError(409, 'DEVICE_BLOCKED', 'busy');
  assert.deepEqual([(await host.chatTurn({})).kind, host.state], ['blocked', 'ready']);
  fail = new HostError(409, 'NOT_PAIRED', 'no device');
  assert.deepEqual([(await host.chatTurn({})).kind, host.state], ['not-paired', 'not-paired']);
  fail = new TypeError('fetch failed');
  assert.deepEqual([(await host.chatTurn({})).kind, host.state], ['offline', 'offline']);
  fail = null;
  await host.chatTurn({});
  assert.equal(host.state, 'ready');
});

test('a turn-derived offline stays offline across watcher ticks', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  let fail = null;
  const client = fakeClient({ async chatTurn() { if (fail) throw fail; return { state: 'completed' }; } });
  const host = createHost({ client, watchMs: 5 });
  await host.start(ac.signal);
  assert.equal(host.state, 'ready');
  fail = new TypeError('fetch failed');
  assert.equal((await host.chatTurn({})).kind, 'offline');
  await tick();
  await tick();
  assert.equal(host.state, 'offline'); // devices() still reports a pairing
});

test('a confirmed pairing makes the state ready', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const host = createHost({ client: fakeClient({ async devices() { return { found: [], paired: [] }; } }), watchMs: 1000 });
  await host.start(ac.signal);
  assert.equal(host.state, 'not-paired');
  assert.equal((await host.pairConfirm('D1', '123456')).toolsReady, true);
  assert.equal(host.state, 'ready');
});

test('a failed start is offline, then recovers once the client registers and is approved', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  let serves = 0;
  const client = fakeClient({
    status: null,
    async connect() { throw new TypeError('fetch failed'); },
    serve() {
      serves += 1;
      if (serves === 1) return Promise.reject(new TypeError('fetch failed'));
      client.status = 'pending';
      setTimeout(() => { client.status = 'approved'; }, 20);
      return new Promise(() => {});
    },
  });
  const host = createHost({ client, watchMs: 5, serveRetryMs: 5 });
  await host.start(ac.signal);
  assert.equal(host.state, 'offline');
  await tick();
  assert.equal(serves, 2); // the rejected serve() was retried
  await tick();
  await tick();
  assert.equal(host.state, 'ready');
});

test('a failed or cancelled turn is an error with its reason that leaves the state alone', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  let outcome = 'failed';
  const error = { code: 'CONVERSATION_FAILED', message: 'boom' };
  const client = fakeClient({ async chatTurn() { return { state: outcome, error }; } });
  const host = createHost({ client, watchMs: 1000 });
  await host.start(ac.signal);
  for (const state of ['failed', 'cancelled']) {
    outcome = state;
    const r = await host.chatTurn({});
    assert.deepEqual([r.ok, r.kind, r.turn.state, r.error, host.state], [false, 'error', state, error, 'ready']);
  }
});

test('chat turns wait until the turn is heard; one still going after the longest wait is taken as heard', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const client = fakeClient({ async chatTurn(req) { this.calls.push(req); return { turn_id: 'api-turn-1', state: 'playing', error: null }; } });
  const host = createHost({ client, watchMs: 1000 });
  await host.start(ac.signal);
  const r = await host.chatTurn({ image: Buffer.from([1]), text: 'look' });
  assert.equal(client.calls.at(-1).waitMs, TURN_WAIT_MAX_MS);
  assert.deepEqual([r.ok, r.turn.state], [true, 'playing']);
});

test('close stops the watcher', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  let calls = 0;
  const client = fakeClient({ status: 'pending', async devices() { calls += 1; return { found: [], paired: [{ deviceId: 'D1' }] }; } });
  const host = createHost({ client, watchMs: 5 });
  await host.start(ac.signal);
  client.status = 'approved';
  await tick();
  assert.equal(calls, 1); // the watcher is alive before close
  await host.close();
  client.status = 'pending';
  await tick();
  client.status = 'approved';
  await tick();
  assert.equal(calls, 1);
});

test('a turn the device refused as busy or blocked is blocked, not an error', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  let code = 'DEVICE_BUSY';
  const client = fakeClient({ async chatTurn() { return { state: 'failed', error: { code } }; } });
  const host = createHost({ client, watchMs: 1000 });
  await host.start(ac.signal);
  for (code of ['DEVICE_BUSY', 'DEVICE_BLOCKED', 'AMBIENT_MODE_BLOCKED']) {
    assert.equal((await host.chatTurn({})).kind, 'blocked', code);
  }
  assert.equal(classify(new HostError(409, 'DEVICE_BUSY', 'busy')), 'blocked');
});

test('chat turns pass interrupt, retention and tools through to codie-host', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const client = fakeClient();
  const host = createHost({ client, watchMs: 1000 });
  await host.start(ac.signal);
  await host.chatTurn({ image: Buffer.from([1]), text: 'look' });
  assert.equal(client.calls.at(-1).retention, 'full');
  assert.equal(client.calls.at(-1).tools, 'all');
  await host.chatTurn({ image: Buffer.from([1]), text: 'look', interrupt: false, retention: 'none', tools: 'none' });
  assert.equal(client.calls.at(-1).interrupt, false);
  assert.equal(client.calls.at(-1).retention, 'none');
  assert.equal(client.calls.at(-1).tools, 'none');
});

test('devices come merged from codie-host', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const client = fakeClient({ async devices() {
    return { found: [{ deviceId: 'D2', name: 'Desk', host: '10.0.0.2', online: true }], paired: [{ deviceId: 'D1', name: 'Codie', online: false }] };
  } });
  const host = createHost({ client, watchMs: 1000 });
  await host.start(ac.signal);
  assert.deepEqual(await host.devices(), [
    { deviceId: 'D2', name: 'Desk', host: '10.0.0.2', paired: false, found: true, online: true },
    { deviceId: 'D1', name: 'Codie', host: '', paired: true, found: false, online: false },
  ]);
});

test('a conversation context goes to the device as base64 with its text and lifetime, and is cleared by a DELETE', async () => {
  const calls = [];
  const host = createHost({ client: fakeClient({ async api(...args) { calls.push(args); } }) });
  assert.deepEqual(await host.setContext({ image: Buffer.from('abc'), text: 'playing', ttlMs: 20000 }), { ok: true });
  assert.deepEqual(await host.clearContext(), { ok: true });
  assert.deepEqual(calls, [
    ['PUT', '/v1/api/data/user/conversation/context', { image_base64: 'YWJj', text: 'playing', ttl_ms: 20000 }],
    ['DELETE', '/v1/api/data/user/conversation/context'],
  ]);
});

test('a device without the conversation context route fails the push without changing the state', async () => {
  const host = createHost({ client: fakeClient({ async api() { throw new HostError(404, 'NOT_FOUND', 'no such route'); } }) });
  const before = host.state;
  const r = await host.setContext({ image: Buffer.from('abc'), text: 'playing', ttlMs: 20000 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'error');
  assert.equal(host.state, before);
});
