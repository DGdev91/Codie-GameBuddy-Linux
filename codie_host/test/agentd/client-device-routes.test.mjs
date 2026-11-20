// Client device routes through codie-agentd (spec §6.4 as client routes):
// the real loopback IPC and a fake clt01.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startAgentd } from '../../src/agentd/daemon/agentd-core.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { startFakeDevice } from './helpers/fake-device.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const noMdns = { close: async () => {}, discover: async () => [] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const TURNS = '/v1/api/data/user/chat/turns';

async function setup(t, { paired = true, clt01 = {}, discover = async () => [], log = () => {}, deny = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-host-'));
  const device = await startFakeDevice({ credential });
  if (deny) device.setDeny(...deny);
  if (paired) {
    new Store(home).upsertPairing({
      deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port,
      userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
    });
  }
  const a = await startAgentd({ home, clt01, log, exit: () => {},
    mdns: { ...noMdns, discover } });
  const ipc = async (method, route, body, token = a.token) => {
    const res = await fetch(`http://127.0.0.1:${a.ipcPort}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const client = async (name, scope, { approve = true } = {}) => {
    const reg = (await ipc('POST', '/clients', { name, scope })).body;
    if (approve) await ipc('POST', '/clients/approve', { name });
    return { call: (method, sub, body) => ipc(method, `/clients/${reg.id}${sub}`, body, reg.token) };
  };
  t.after(async () => {
    await a.shutdown();
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { device, client, ipc, store: new Store(home) };
}

test('device API pass-through stays within the scope', async t => {
  const { client } = await setup(t);
  const c = await client('reader', { api: ['/v1/api/data/user/character'] });
  const ok = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { data: { name: 'Codie' } });
  const outside = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/memo' });
  assert.deepEqual([outside.status, outside.body.code], [403, 'SCOPE_DENIED']);
  const admin = await c.call('POST', '/api', { method: 'POST', path: '/v1/api/admin/install/service' });
  assert.deepEqual([admin.status, admin.body.code], [403, 'SCOPE_DENIED']);
  const bad = await c.call('POST', '/api', { method: 'TRACE', path: '/v1/api/data/user/character' });
  assert.deepEqual([bad.status, bad.body.code], [400, 'INVALID_ARGUMENT']);
});

test('paths that normalize differently are refused', async t => {
  const { client } = await setup(t);
  const c = await client('sneaky', { api: ['/v1/api/data/user/character'] });
  const encoded = await c.call('POST', '/api', { method: 'POST', path: '/v1/api/data/user/character/%2e%2e/%2e%2e/%2e%2e/admin/install/service' });
  assert.deepEqual([encoded.status, encoded.body.code], [400, 'INVALID_ARGUMENT']);
  const mixed = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character/.%2e/x' });
  assert.deepEqual([mixed.status, mixed.body.code], [400, 'INVALID_ARGUMENT']);
  const plain = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character?x=1' });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  const dotsInQuery = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character?q=a..b' });
  assert.equal(dotsInQuery.status, 200, JSON.stringify(dotsInQuery.body));
});

test('percent-encoded paths are refused', async t => {
  const { client } = await setup(t);
  const c = await client('sneaky', { api: ['/v1/api/data/user/character'] });
  for (const p of [
    '/v1/api/data/user/character/%2e%2e%2f%2e%2e%2f%2e%2e%2fadmin/install/service',
    '/v1/api/data/user/character%2f%2e%2e%2ftool-integrations/x',
  ]) {
    const r = await c.call('POST', '/api', { method: 'POST', path: p });
    assert.deepEqual([r.status, r.body.code, r.body.error ?? r.body.message], [400, 'INVALID_ARGUMENT', 'path must not contain percent-encoding'], p);
  }
});

test('only credential failures ask for a repair; other device 401s pass through', async t => {
  const { client, device } = await setup(t);
  const c = await client('reader', { api: ['/v1/api/data/user/character'] });
  device.setDeny(401, 'REQUEST_EXPIRED');
  const expired = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.deepEqual([expired.status, expired.body.code], [502, 'REQUEST_EXPIRED']);
  device.setDeny(401, 'LOCAL_SESSION_EXPIRED');
  const session = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.deepEqual([session.status, session.body.code], [409, 'REPAIR_REQUIRED']);
  device.setDeny(null);
  const back = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.equal(back.status, 200);
});

test('a device that dropped every pairing (e.g. a reset) shows up in status as needing a new pairing', async t => {
  const { ipc } = await setup(t, { deny: [401, 'LOCAL_SESSION_EXPIRED'] });
  const deadline = Date.now() + 5000;
  let device;
  while (Date.now() < deadline && !device?.repairRequired) {
    device = (await ipc('GET', '/status')).body.devices.find(d => d.deviceId === 'DEV1');
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(device?.repairRequired, true, 'agentd\'s own device link was refused');
});

test('a device that refused the credential is shown as needing a new pairing until a call goes through', async t => {
  const { client, device, ipc } = await setup(t);
  const c = await client('reader', { api: ['/v1/api/data/user/character'], pair: true });
  const repair = async () => (await ipc('GET', '/status')).body.devices.find(d => d.deviceId === 'DEV1').repairRequired;
  device.setDeny(401, 'REQUEST_EXPIRED');
  await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.equal(await repair(), undefined, 'only a refused credential asks for a new pairing');
  device.setDeny(401, 'LOCAL_SESSION_EXPIRED');
  await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.equal(await repair(), true);
  assert.equal((await c.call('GET', '/devices')).body.paired.find(d => d.deviceId === 'DEV1').repairRequired, true);
  device.setDeny(null);
  await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.equal(await repair(), undefined);
});

test('a pending client reaches nothing', async t => {
  const { client } = await setup(t);
  const c = await client('waiting', { api: ['/v1/api/data/user/character'] }, { approve: false });
  const r = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.deepEqual([r.status, r.body.code], [403, 'APPROVAL_PENDING']);
});

test('a chat turn posts the image on the active slot and returns the answer', async t => {
  const { client, device } = await setup(t);
  const c = await client('buddy', { api: [TURNS] });
  const r = await c.call('POST', '/chat-turns', { image: JPEG.toString('base64'), text: 'how do I pass this?', speech: 'none' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { turn_id: 'turn-1', state: 'completed', assistant_text: 'Nice jump!', error: null });
  const [turn] = device.turns;
  assert.equal(turn.request.slot, 2);
  assert.deepEqual(turn.request.output, { speech: 'none' });
  assert.equal(turn.imageType, 'image/jpeg');
  assert.ok(turn.image.equals(JPEG));
});

test('chat turn failures carry stable codes', async t => {
  const { client, device } = await setup(t);
  const c = await client('buddy', { api: [TURNS] });
  device.setChat({ block: 'DEVICE_BLOCKED' });
  const blocked = await c.call('POST', '/chat-turns', { image: JPEG.toString('base64') });
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'DEVICE_BLOCKED']);
  const big = Buffer.concat([JPEG, Buffer.alloc(1 << 20)]);
  const tooBig = await c.call('POST', '/chat-turns', { image: big.toString('base64') });
  assert.deepEqual([tooBig.status, tooBig.body.code], [413, 'IMAGE_TOO_LARGE']);
  const noScope = await client('other', {});
  const denied = await noScope.call('POST', '/chat-turns', { image: JPEG.toString('base64') });
  assert.deepEqual([denied.status, denied.body.code], [403, 'SCOPE_DENIED']);
});

test('without a paired device the routes say so', async t => {
  const { client } = await setup(t, { paired: false });
  const c = await client('buddy', { api: [TURNS] });
  const r = await c.call('POST', '/chat-turns', { image: JPEG.toString('base64') });
  assert.deepEqual([r.status, r.body.code], [409, 'NOT_PAIRED']);
});

const pairingClt01 = {
  pairRequest: async () => ({ challengeId: 'c1' }),
  pairConfirm: async (h, p, challengeId, code) => {
    if (code !== '123456') throw Object.assign(new Error('wrong code'), { code: 'PAIRING_CODE_INVALID' });
    return { deviceId: 'NEW1', name: 'Desk Codie', localSecret: 'master' };
  },
  pairCancel: async () => {},
  deviceAuth: async (h, p, secret) => ({ secret, userId: 'user-9' }),
  issueClientCredential: async () => ({ id: 'cred-new', secret: 'new-secret' }),
};

test('a client with the pair permission scans and pairs a device', async t => {
  const { client, store } = await setup(t, {
    paired: false, clt01: pairingClt01,
    discover: async () => [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', port: 8081 }],
  });
  const c = await client('buddy', { pair: true });
  const scan = await c.call('GET', '/devices');
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  assert.deepEqual(scan.body.found, [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', paired: false, online: false }]);
  assert.deepEqual(scan.body.paired, []);

  const begin = await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  assert.equal(begin.body.ok, true, begin.body.message);
  assert.deepEqual([begin.body.code, begin.body.deviceName], ['PAIR_STARTED', 'Desk Codie']);
  const wrong = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '000000' });
  assert.deepEqual([wrong.body.ok, wrong.body.toolsReady], [false, false]);
  assert.equal(wrong.body.code, 'PAIRING_CODE_INVALID');

  await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  const done = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '123456' });
  assert.equal(done.status, 200);
  assert.equal(done.body.toolsReady, true, done.body.message);
  assert.equal(done.body.code, 'PAIRED');
  assert.equal(store.listPairings().find(r => r.deviceId === 'NEW1').credentialId, 'cred-new');
  const cancel = await c.call('POST', '/pair/cancel', { device_id: 'NEW1' });
  assert.deepEqual([cancel.body.ok, cancel.body.code], [true, 'CANCELLED']);
});

test('a newly paired second device becomes the tools device, so toolsReady is true', async t => {
  const logged = [];
  const { client, store } = await setup(t, {
    clt01: pairingClt01, log: (...a) => logged.push(a.join(' ')),
    discover: async () => [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', port: 8081 }],
  });
  const c = await client('buddy', { pair: true });
  await c.call('GET', '/devices');
  const begin = await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  assert.equal(begin.body.ok, true, begin.body.message);
  const done = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '123456' });
  assert.equal(done.body.ok, true, done.body.message);
  assert.equal(done.body.toolsReady, true);
  assert.equal(store.listPairings().find(r => r.deviceId === 'NEW1').credentialId, 'cred-new');
  assert.equal(store.readSettings().toolsDevice, 'NEW1');
  assert.ok(logged.some(l => /buddy paired NEW1; tools now go to it \(was DEV1\)/.test(l)), logged.join('\n'));
});

test('a device that issues no client credential is not paired, and approves nothing', async t => {
  const notFound = Object.assign(new Error('not found'), { status: 404 });
  const { client, ipc, store } = await setup(t, {
    clt01: { ...pairingClt01, issueClientCredential: async () => { throw notFound; } },
    discover: async () => [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', port: 8081 }],
  });
  const c = await client('buddy', { pair: true }, { approve: false });
  await c.call('GET', '/devices');
  await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  const done = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '123456' });
  assert.deepEqual([done.body.ok, done.body.toolsReady], [false, false], done.body.message);
  assert.equal(done.body.code, 'CREDENTIAL_NOT_ISSUED');
  assert.match(done.body.message, /did not issue a client credential/);
  assert.equal(store.listPairings().find(r => r.deviceId === 'NEW1'), undefined);
  assert.equal(store.readSettings().toolsDevice, 'DEV1');
  assert.equal((await ipc('GET', '/clients')).body.clients.find(x => x.name === 'buddy').status, 'pending');
});

test('pairing says what went wrong as a code a program can word', async t => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const { client } = await setup(t, {
    paired: false, clt01: { ...pairingClt01, pairRequest: async () => { throw refused; } },
    discover: async () => [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', port: 8081 }],
  });
  const c = await client('buddy', { pair: true });
  const unscanned = await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  assert.deepEqual([unscanned.status, unscanned.body.ok, unscanned.body.code], [200, false, 'DEVICE_NOT_SCANNED']);
  await c.call('GET', '/devices');
  const nothing = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '123456' });
  assert.deepEqual([nothing.body.ok, nothing.body.code, nothing.body.toolsReady], [false, 'NO_PAIRING_IN_PROGRESS', false]);
  const down = await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  assert.deepEqual([down.body.ok, down.body.code], [false, 'DEVICE_UNREACHABLE']);
  assert.match(down.body.message, /^Failed: fetch failed/);
});

// Typing the code from the device screen is the user's consent, so a pending
// client that asked for pairing may pair, and a successful pairing approves
// the scope it asked for.
test('a pending client with the pair permission is approved by pairing', async t => {
  const logged = [];
  const { client, ipc, store } = await setup(t, {
    paired: false, clt01: pairingClt01, log: (...a) => logged.push(a.join(' ')),
    discover: async () => [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', port: 8081 }],
  });
  const scope = { pair: true, tools: true, api: [TURNS] };
  const c = await client('buddy', scope, { approve: false });
  const status = async () => (await ipc('GET', '/clients')).body.clients.find(x => x.name === 'buddy').status;

  const early = await c.call('POST', '/chat-turns', { image: JPEG.toString('base64'), text: 'hi', speech: 'none' });
  assert.deepEqual([early.status, early.body.code], [403, 'APPROVAL_PENDING']);
  assert.equal((await c.call('GET', '/devices')).status, 200);
  await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  const wrong = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '000000' });
  assert.equal(wrong.body.ok, false);
  assert.equal(await status(), 'pending');

  await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  const done = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '123456' });
  assert.equal(done.body.ok, true, done.body.message);
  assert.equal(await status(), 'approved');
  assert.deepEqual(store.approvedClients().buddy.scope, { tools: true, pair: true, api: [TURNS] });
  assert.ok(logged.some(l => /buddy approved by pairing NEW1/.test(l)), logged.join('\n'));
});

test('a pending client without the pair permission cannot pair its way in', async t => {
  const { client } = await setup(t, { clt01: pairingClt01 });
  const c = await client('plain', { tools: true }, { approve: false });
  const denied = await c.call('GET', '/devices');
  assert.deepEqual([denied.status, denied.body.code], [403, 'SCOPE_DENIED']);
});

// A loopback port nothing listens on (fetch refuses some low ports outright).
async function closedPort() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

test('a device call that cannot reach the device fails at once and has the address refreshed', async t => {
  let port = 0;
  let scans = 0;
  const { client, store } = await setup(t, { discover: async () => { scans++; return [{ deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port }]; } });
  const record = store.listPairings()[0];
  port = record.port;
  store.upsertPairing({ ...record, port: await closedPort() });
  const c = await client('reader', { api: ['/v1/api/data/user/character'] });
  const lost = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.deepEqual([lost.status, lost.body.code], [503, 'DEVICE_OFFLINE']);
  const deadline = Date.now() + 5000;
  while (store.listPairings()[0].port !== port && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(store.listPairings()[0].port, port);
  assert.equal(scans, 1);
  assert.equal(store.listPairings().length, 1);
  const back = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
});

test('a device that refuses the credential has its address refreshed; other device errors do not', async t => {
  let scans = 0;
  const { client, device } = await setup(t, { discover: async () => { scans++; return []; } });
  const c = await client('reader', { api: ['/v1/api/data/user/character'] });
  device.setDeny(409, 'DEVICE_BLOCKED');
  const busy = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.deepEqual([busy.status, busy.body.code], [409, 'DEVICE_BLOCKED']);
  device.setDeny(401, 'REQUEST_EXPIRED');
  await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(scans, 0);
  device.setDeny(401, 'LOCAL_SECRET_MISMATCH'); // e.g. another Codie took this address
  const foreign = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.deepEqual([foreign.status, foreign.body.code], [409, 'REPAIR_REQUIRED']);
  const deadline = Date.now() + 3000;
  while (!scans && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(scans, 1);
});

test('a scan never moves a healthy paired device; once it fails there, the refresh does', async t => {
  let found = [];
  const { client, device, store } = await setup(t, { discover: async () => found });
  const other = await startFakeDevice({ credential });
  t.after(() => other.close());
  found = [{ deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: other.port }];
  const paired = store.listPairings()[0].port;
  const scanner = await client('buddy', { pair: true, api: ['/v1/api/data/user/character'] });
  assert.equal((await scanner.call('GET', '/devices')).status, 200);
  assert.equal(store.listPairings()[0].port, paired, 'an mDNS answer alone moves nothing');
  assert.equal((await scanner.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' })).status, 200);

  await device.close();
  const lost = await scanner.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.equal(lost.status, 503);
  const deadline = Date.now() + 5000;
  while (store.listPairings()[0].port === paired && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(store.listPairings()[0].port, other.port);
  assert.equal((await scanner.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' })).status, 200);
});

test('pairing needs the pair permission and a well-formed request', async t => {
  const { client } = await setup(t, { clt01: pairingClt01 });
  const plain = await client('plain', { tools: true });
  const denied = await plain.call('GET', '/devices');
  assert.deepEqual([denied.status, denied.body.code], [403, 'SCOPE_DENIED']);
  const c = await client('buddy', { pair: true });
  const noId = await c.call('POST', '/pair/begin', {});
  assert.deepEqual([noId.status, noId.body.code], [400, 'INVALID_ARGUMENT']);
  const badCode = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '12ab' });
  assert.deepEqual([badCode.status, badCode.body.code], [400, 'INVALID_ARGUMENT']);
});
