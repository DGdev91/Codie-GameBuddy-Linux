// The client connection (sdk/connection.mjs) against a fake ToolClient.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError, classify, createConnection, mergeDevices } from '../../sdk/index.mjs';

const tick = () => new Promise(r => setTimeout(r, 15));

function fakeClient(over = {}) {
  return {
    status: 'approved',
    published: [],
    served: [],
    async connect() {},
    setTools(tools) { this.tools = tools; },
    async publishTools(tools) { this.published.push(tools); },
    serve(handlers) { this.served.push(handlers); return new Promise(() => {}); },
    async devices() { return { found: [], paired: [{ deviceId: 'D1', name: 'Codie', online: false }] }; },
    async pairConfirm() { return { ok: true, code: 'PAIRED', toolsReady: true }; },
    async close() {},
    ...over,
  };
}

async function started(t, client, opts = {}) {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const states = [];
  const conn = createConnection({ client, onState: s => states.push(s), watchMs: 5, ...opts });
  await conn.start(ac.signal);
  return { conn, states };
}

test('errors are classified', () => {
  const he = (status, code) => new HostError(status, code, code);
  assert.equal(classify(he(409, 'DEVICE_BUSY')), 'blocked');
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
  const { conn, states } = await started(t, fakeClient());
  assert.equal(conn.state, 'ready');
  assert.deepEqual(states, ['ready']);
});

test('a pending client becomes ready once approved; no device means not-paired', async t => {
  const client = fakeClient({ status: 'pending', async devices() { return { found: [], paired: [] }; } });
  const { conn } = await started(t, client);
  assert.equal(conn.state, 'pending');
  client.status = 'approved';
  await tick();
  assert.equal(conn.state, 'not-paired');
});

test('the program\'s own call outcomes move the state; blocked and other errors do not', async t => {
  const { conn } = await started(t, fakeClient(), { watchMs: 1000 });
  assert.equal(conn.noteError(new HostError(409, 'DEVICE_BUSY', 'busy')), 'blocked');
  assert.equal(conn.noteError(new HostError(400, 'INVALID_ARGUMENT', 'x')), 'error');
  assert.equal(conn.state, 'ready');
  assert.equal(conn.noteError(new HostError(409, 'NOT_PAIRED', 'none')), 'not-paired');
  assert.equal(conn.state, 'not-paired');
  conn.noteReady();
  assert.equal(conn.state, 'ready');
});

test('an offline from a call stays offline across watcher ticks', async t => {
  const { conn } = await started(t, fakeClient());
  conn.noteError(new TypeError('fetch failed'));
  await tick();
  await tick();
  assert.equal(conn.state, 'offline'); // devices() still reports a pairing
});

test('a pairing the device refused is not ready', async t => {
  const client = fakeClient({ async devices() { return { found: [], paired: [{ deviceId: 'D1', name: 'Codie', online: false, repairRequired: true }] }; } });
  const { conn } = await started(t, client);
  assert.equal(conn.state, 'not-paired');
});

test('a confirmed pairing makes the state ready', async t => {
  const { conn } = await started(t, fakeClient({ async devices() { return { found: [], paired: [] }; } }), { watchMs: 1000 });
  assert.equal(conn.state, 'not-paired');
  assert.equal((await conn.pairConfirm('D1', '123456')).toolsReady, true);
  assert.equal(conn.state, 'ready');
});

test('a failed start is offline, then recovers once the client registers and is approved', async t => {
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
  const { conn } = await started(t, client, { serveRetryMs: 5 });
  assert.equal(conn.state, 'offline');
  await tick();
  assert.equal(serves, 2); // the rejected serve() was retried
  await tick();
  await tick();
  assert.equal(conn.state, 'ready');
});

test('close stops the watcher', async t => {
  let calls = 0;
  const client = fakeClient({ status: 'pending', async devices() { calls += 1; return { found: [], paired: [{ deviceId: 'D1' }] }; } });
  const { conn } = await started(t, client);
  client.status = 'approved';
  await tick();
  assert.equal(calls, 1); // the watcher is alive before close
  await conn.close();
  client.status = 'pending';
  await tick();
  client.status = 'approved';
  await tick();
  assert.equal(calls, 1);
});

test('serve() answers with the handlers; setTools publishes and returns a failure instead of throwing', async t => {
  const handlers = { light_status: async () => ({}) };
  const client = fakeClient();
  const { conn } = await started(t, client, { tools: [{ name: 'a' }], handlers, watchMs: 1000 });
  assert.deepEqual(client.tools, [{ name: 'a' }]);
  assert.equal(client.served[0], handlers);
  assert.equal(await conn.setTools([{ name: 'b' }]), null);
  assert.deepEqual(client.published, [[{ name: 'b' }]]);
  client.publishTools = async () => { throw new HostError(400, 'TOOL_CATALOG_INVALID', 'bad'); };
  assert.equal((await conn.setTools([])).code, 'TOOL_CATALOG_INVALID');
  assert.equal(conn.state, 'ready');
});

test('devices lists every device found, then the paired ones the scan missed', async t => {
  assert.deepEqual(mergeDevices({
    found: [
      { deviceId: 'A', name: 'Desk', host: '10.0.0.2', paired: true, online: true },
      { deviceId: 'B', name: '', host: '10.0.0.3', paired: false, online: false },
    ],
    paired: [{ deviceId: 'A', name: 'Desk', online: true }, { deviceId: 'C', name: 'Kitchen', online: false }],
  }), [
    { deviceId: 'A', name: 'Desk', host: '10.0.0.2', paired: true, found: true, online: true },
    { deviceId: 'B', name: 'B', host: '10.0.0.3', paired: false, found: true, online: false },
    { deviceId: 'C', name: 'Kitchen', host: '', paired: true, found: false, online: false },
  ]);
  const { conn } = await started(t, fakeClient(), { watchMs: 1000 });
  assert.deepEqual(await conn.devices(), [{ deviceId: 'D1', name: 'Codie', host: '', paired: true, found: false, online: false }]);
});
