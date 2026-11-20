// Tool hosting through codie-agentd (spec §6.2): clients over the real
// loopback IPC, a fake clt01 for the integrations and their WebSocket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startAgentd } from '../../src/agentd/daemon/agentd-core.mjs';
import { toolDevice } from '../../src/agentd/daemon/tool-hosting.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { integrationId } from '../../src/agentd/tools/integration-id.mjs';
import { startFakeDevice } from './helpers/fake-device.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noMdns = { close: async () => {}, discover: async () => [] };

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail('condition not reached');
}

const tools = [{
  name: 'echo_text', version: 'v1', description: 'Echo text.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  result_schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
  risk: 'read', idempotent: true, confirmation_required: false,
}];

async function setup(t, { discover = async () => [], extra = [], log = () => {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-host-'));
  const device = await startFakeDevice({ credential });
  const store = new Store(home);
  store.upsertPairing({
    deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port,
    userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
  });
  for (const r of extra) store.upsertPairing(r);
  const a = await startAgentd({ home, clt01: {}, log, exit: () => {}, mdns: { ...noMdns, discover } });
  const ipc = async (method, route, body, token = a.token) => {
    const res = await fetch(`http://127.0.0.1:${a.ipcPort}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  t.after(async () => {
    await a.shutdown();
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { ipc, device, store, agentd: a };
}

test('a client goes from pending to approved, publishes tools and answers a call', async t => {
  const { ipc, device } = await setup(t);
  const reg = await ipc('POST', '/clients', { name: 'echo-tool', scope: { tools: true } });
  assert.equal(reg.body.status, 'pending');
  const { id, token } = reg.body;

  const early = await ipc('PUT', `/clients/${id}/tools`, { tools }, token);
  assert.equal(early.status, 403);
  assert.equal(early.body.code, 'APPROVAL_PENDING');

  assert.equal((await ipc('POST', '/clients/approve', { name: 'echo-tool' })).status, 200);
  const put = await ipc('PUT', `/clients/${id}/tools`, { tools }, token);
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const iid = integrationId('DEV1', 'echo-tool');
  await until(() => device.connected(iid));
  assert.equal(device.integrations.get(iid).tools[0].timeout_ms, 5000);
  await until(async () => (await ipc('GET', `/clients/${id}`, undefined, token)).body.online);

  device.invoke(iid, { invocation_id: 'inv-1', name: 'echo_text', arguments: { text: 'hi' }, timeout_ms: 5000 });
  const polled = await ipc('POST', `/clients/${id}/calls`, { wait_ms: 2000 }, token);
  assert.deepEqual(polled.body.calls.map(c => [c.invocation_id, c.name, c.arguments.text]), [['inv-1', 'echo_text', 'hi']]);

  const answered = await ipc('POST', `/clients/${id}/calls/inv-1/result`, { status: 'succeeded', data: { text: 'hi' } }, token);
  assert.equal(answered.status, 200);
  await until(() => device.results.length === 1);
  assert.deepEqual(device.results[0], { type: 'result', data: { invocation_id: 'inv-1', status: 'succeeded', data: { text: 'hi' } } });
});

test('an approved scope is remembered; a wider one waits again', async t => {
  const { ipc, store } = await setup(t);
  store.approveClient('lights', { tools: true, api: [] });
  assert.equal((await ipc('POST', '/clients', { name: 'lights', scope: { tools: true } })).body.status, 'approved');
  const wider = await ipc('POST', '/clients', { name: 'lights', scope: { tools: true, api: ['/v1/api/data/user/character'] } });
  assert.equal(wider.body.status, 'pending');
});

test('no client may register under agentd\'s own integration name', async t => {
  const { ipc } = await setup(t);
  const r = await ipc('POST', '/clients', { name: 'agents', scope: { tools: true } });
  assert.deepEqual([r.status, r.body.code], [400, 'INVALID_ARGUMENT']);
});

test('tokens are per client and agentd routes refuse client tokens', async t => {
  const { ipc } = await setup(t);
  const a = (await ipc('POST', '/clients', { name: 'tool-a', scope: {} })).body;
  const b = (await ipc('POST', '/clients', { name: 'tool-b', scope: {} })).body;
  assert.equal((await ipc('GET', `/clients/${b.id}`, undefined, a.token)).status, 401);
  assert.equal((await ipc('GET', '/clients', undefined, a.token)).status, 401);
  assert.equal((await ipc('POST', '/clients/approve', { name: 'tool-a' }, a.token)).status, 401);
  assert.equal((await ipc('GET', `/clients/${a.id}`, undefined, a.token)).status, 200);
});

test('a failed result needs a code; a client without tool scope cannot host tools', async t => {
  const { ipc } = await setup(t);
  const plain = (await ipc('POST', '/clients', { name: 'plain', scope: {} })).body;
  await ipc('POST', '/clients/approve', { name: 'plain' });
  const denied = await ipc('PUT', `/clients/${plain.id}/tools`, { tools }, plain.token);
  assert.equal(denied.body.code, 'SCOPE_DENIED');
  const bad = await ipc('POST', `/clients/${plain.id}/calls/x/result`, { status: 'failed', data: {} }, plain.token);
  assert.equal(bad.status, 400);
});

test('the long poll returns empty after the wait', async t => {
  const { ipc } = await setup(t);
  const c = (await ipc('POST', '/clients', { name: 'idle', scope: {} })).body;
  const started = Date.now();
  const polled = await ipc('POST', `/clients/${c.id}/calls`, { wait_ms: 200 }, c.token);
  assert.deepEqual(polled.body.calls, []);
  assert.ok(Date.now() - started >= 180);
});

test('a client token cannot reach session routes; agentd counts clients as activity', async t => {
  const { ipc, agentd } = await setup(t);
  const c = (await ipc('POST', '/clients', { name: 'busy', scope: {} })).body;
  assert.equal((await ipc('POST', '/sessions', { host: 'claude' }, c.token)).status, 401);
  assert.equal((await ipc('GET', '/status', undefined, c.token)).status, 401);
  assert.deepEqual((await ipc('GET', '/status')).body.clients.map(x => x.name), ['busy']);
  assert.equal(agentd.hosting.registry.size, 1);
});

test('tool hosting without a credentialed pairing says NOT_PAIRED', async t => {
  const { ipc, store } = await setup(t);
  store.upsertPairing({ deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: 1 });
  const c = (await ipc('POST', '/clients', { name: 'lonely', scope: { tools: true } })).body;
  await ipc('POST', '/clients/approve', { name: 'lonely' });
  const put = await ipc('PUT', `/clients/${c.id}/tools`, { tools }, c.token);
  assert.equal(put.status, 409);
  assert.equal(put.body.code, 'NOT_PAIRED');
});

const pairing = (deviceId, port, cred) => ({
  deviceId, name: deviceId, host: '127.0.0.1', port,
  ...(cred ? { userId: cred.userId, credentialId: cred.id, credentialSecret: cred.secret } : {}),
});

// An approved client with tool scope whose catalog is published.
async function hostTools(ipc, name) {
  const c = (await ipc('POST', '/clients', { name, scope: { tools: true } })).body;
  await ipc('POST', '/clients/approve', { name });
  const put = await ipc('PUT', `/clients/${c.id}/tools`, { tools }, c.token);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return c;
}

test('toolDevice: the chosen device while it holds a credential, else the first credentialed pairing', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-host-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home);
  assert.equal(toolDevice(store), null);
  store.upsertPairing(pairing('OLD', 1));
  store.upsertPairing(pairing('DEV1', 1, credential));
  store.upsertPairing(pairing('DEV2', 2, credential));
  assert.equal(toolDevice(store).deviceId, 'DEV1');
  store.updateSettings({ toolsDevice: 'DEV2' });
  assert.equal(toolDevice(store).deviceId, 'DEV2');
  store.updateSettings({ toolsDevice: 'OLD' });
  assert.equal(toolDevice(store).deviceId, 'DEV1', 'a device without a credential is never chosen');
  store.updateSettings({ toolsDevice: 'GONE' });
  assert.equal(toolDevice(store).deviceId, 'DEV1');
});

test('the tools device can be read and set; an unpaired or uncredentialed device is refused', async t => {
  const { ipc, store } = await setup(t);
  assert.deepEqual((await ipc('GET', '/tools-device')).body, { toolsDevice: 'DEV1' });
  assert.equal((await ipc('GET', '/status')).body.toolsDevice, 'DEV1');
  store.upsertPairing(pairing('OLD', 1));
  store.upsertPairing(pairing('DEV2', 2, credential));

  const unknown = await ipc('POST', '/tools-device', { device_id: 'NOPE' });
  assert.deepEqual([unknown.status, unknown.body.code], [404, 'NOT_PAIRED']);
  assert.match(unknown.body.error, /NOPE is not paired/);
  const old = await ipc('POST', '/tools-device', { device_id: 'OLD' });
  assert.deepEqual([old.status, old.body.code], [409, 'REPAIR_REQUIRED']);
  assert.match(old.body.error, /no client credential/);
  assert.equal((await ipc('POST', '/tools-device', {})).status, 400);
  assert.equal(store.readSettings().toolsDevice, 'DEV1');

  const set = await ipc('POST', '/tools-device', { device_id: 'DEV2' });
  assert.deepEqual([set.status, set.body], [200, { toolsDevice: 'DEV2' }]);
  assert.equal(store.readSettings().toolsDevice, 'DEV2');
  assert.equal((await ipc('GET', '/status')).body.toolsDevice, 'DEV2');

  // The chosen device lost its credential: the fallback is used, and shown.
  const { credentialId, ...noCredential } = store.listPairings().find(r => r.deviceId === 'DEV2');
  store.upsertPairing(noCredential);
  assert.deepEqual((await ipc('GET', '/tools-device')).body, { toolsDevice: 'DEV1', chosen: 'DEV2' });
  const status = (await ipc('GET', '/status')).body;
  assert.deepEqual([status.toolsDevice, status.chosen], ['DEV1', 'DEV2']);
});

test('a new tools device takes the client links over; the old device loses the integration', async t => {
  const { ipc, device, store } = await setup(t);
  const cred2 = { id: 'cred-2', secret: 'second-secret', userId: 'user-2' };
  const second = await startFakeDevice({ credential: cred2 });
  t.after(() => second.close());
  store.upsertPairing(pairing('DEV2', second.port, cred2));
  const c = await hostTools(ipc, 'echo-tool');
  const first = integrationId('DEV1', 'echo-tool');
  await until(() => device.connected(first));

  assert.equal((await ipc('POST', '/tools-device', { device_id: 'DEV2' })).status, 200);
  const moved = integrationId('DEV2', 'echo-tool');
  await until(() => second.connected(moved));
  await until(() => !device.integrations.has(first) && !device.connected(first));
  await until(async () => (await ipc('GET', `/clients/${c.id}`, undefined, c.token)).body.online);

  second.invoke(moved, { invocation_id: 'inv-2', name: 'echo_text', arguments: { text: 'there' }, timeout_ms: 5000 });
  const polled = await ipc('POST', `/clients/${c.id}/calls`, { wait_ms: 2000 }, c.token);
  assert.deepEqual(polled.body.calls.map(x => x.invocation_id), ['inv-2']);
});

test('unpairing the tools device closes the client links', async t => {
  const { ipc, device, agentd } = await setup(t);
  await hostTools(ipc, 'echo-tool');
  const iid = integrationId('DEV1', 'echo-tool');
  await until(() => device.connected(iid));
  await agentd.app.callTool('codie_unpair', { device_id: 'DEV1' });
  await until(() => !device.connected(iid));
  assert.equal([...agentd.hosting.registry.clients.values()][0].link, null);
});

const cred2 = { id: 'cred-2', secret: 'second-secret', userId: 'user-2' };

test('agentd pins the tools device of an install without one; pairing edits never move it', async t => {
  const second = await startFakeDevice({ credential: cred2 });
  t.after(() => second.close());
  const { ipc, device, store, agentd } = await setup(t, { extra: [pairing('DEV2', second.port, cred2)] });
  assert.equal(store.readSettings().toolsDevice, 'DEV1');
  await hostTools(ipc, 'echo-tool');
  const iid = integrationId('DEV1', 'echo-tool');
  await until(() => device.connected(iid));

  // A write that once moved DEV1 behind DEV2 (refresh, agents on|off, androidId).
  const dev1 = store.listPairings().find(r => r.deviceId === 'DEV1');
  store.upsertPairing({ ...dev1, androidId: 'A1' });
  agentd.hosting.sync();
  assert.equal(toolDevice(store).deviceId, 'DEV1');
  await sleep(300);
  assert.ok(device.connected(iid));
  assert.ok(!second.integrations.has(integrationId('DEV2', 'echo-tool')));
});

test('a device that moved to another port gets its tool link back after a host refresh', async t => {
  let found = [];
  const second = await startFakeDevice({ credential: cred2 });
  t.after(() => second.close());
  const { ipc, device, store } = await setup(t, { discover: async () => found, extra: [pairing('DEV2', second.port, cred2)] });
  const c = await hostTools(ipc, 'echo-tool');
  const iid = integrationId('DEV1', 'echo-tool');
  await until(() => device.connected(iid));

  await device.close();
  const moved = await startFakeDevice({ credential });
  t.after(() => moved.close());
  found = [{ deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: moved.port }];

  await until(() => moved.connected(iid), 8000);
  assert.equal(store.listPairings().find(r => r.deviceId === 'DEV1').port, moved.port);
  assert.equal(store.listPairings().find(r => r.deviceId === 'DEV2').port, second.port);
  assert.ok(!second.integrations.has(integrationId('DEV2', 'echo-tool')), 'the tools stay on the device that moved');
  await until(async () => (await ipc('GET', `/clients/${c.id}`, undefined, c.token)).body.online);
});

const tools2 = [{ ...tools[0], version: 'v2', description: 'Echo text back.' }];

test('a catalog update in flight on the old device neither fails the client nor outlives the switch', async t => {
  const second = await startFakeDevice({ credential: cred2 });
  t.after(() => second.close());
  const { ipc, device } = await setup(t, { extra: [pairing('DEV2', second.port, cred2)] });
  const c = await hostTools(ipc, 'echo-tool');
  const first = integrationId('DEV1', 'echo-tool');
  await until(() => device.connected(first));

  device.setPutDelay(400);
  const update = ipc('PUT', `/clients/${c.id}/tools`, { tools: tools2 }, c.token);
  await sleep(150); // its PUT is now on its way to DEV1
  assert.equal((await ipc('POST', '/tools-device', { device_id: 'DEV2' })).status, 200);
  const put = await update;
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const moved = integrationId('DEV2', 'echo-tool');
  await until(() => second.connected(moved));
  assert.equal(second.integrations.get(moved).tools[0].version, 'v2');
  await sleep(600);
  assert.equal(device.integrations.has(first), false, 'deleted after the late PUT, not before it');
});

test('switching away and straight back keeps the integration on the device', async t => {
  const second = await startFakeDevice({ credential: cred2 });
  t.after(() => second.close());
  const { ipc, device } = await setup(t, { extra: [pairing('DEV2', second.port, cred2)] });
  await hostTools(ipc, 'echo-tool');
  const first = integrationId('DEV1', 'echo-tool');
  await until(() => device.connected(first));
  device.setPutDelay(200);
  await ipc('POST', '/tools-device', { device_id: 'DEV2' });
  await ipc('POST', '/tools-device', { device_id: 'DEV1' });
  await until(() => device.connected(first));
  await sleep(800);
  assert.ok(device.integrations.has(first));
  assert.ok(device.connected(first));
});

test('an empty catalog withdraws the tools until the next one', async t => {
  const { ipc, device } = await setup(t);
  const { id, token } = (await ipc('POST', '/clients', { name: 'echo-tool', scope: { tools: true } })).body;
  await ipc('POST', '/clients/approve', { name: 'echo-tool' });
  const iid = integrationId('DEV1', 'echo-tool');
  await ipc('PUT', `/clients/${id}/tools`, { tools }, token);
  await until(() => device.connected(iid));

  const empty = await ipc('PUT', `/clients/${id}/tools`, { tools: [] }, token);
  assert.deepEqual([empty.status, empty.body.tools], [200, []]);
  await until(() => !device.connected(iid));
  assert.equal((await ipc('GET', `/clients/${id}`, undefined, token)).body.online, false);

  await ipc('PUT', `/clients/${id}/tools`, { tools }, token);
  await until(() => device.connected(iid));
});
