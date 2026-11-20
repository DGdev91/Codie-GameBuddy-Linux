// The client SDK against an in-process codie-agentd and a fake clt01.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HostError, ToolClient } from '../../sdk/index.mjs';
import { startAgentd } from '../../src/agentd/daemon/agentd-core.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { startFakeDevice } from './helpers/fake-device.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const noMdns = { close: async () => {}, discover: async () => [] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const TURNS = '/v1/api/data/user/chat/turns';

test('ToolClient runs chat turns and API calls once approved', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-host-'));
  const device = await startFakeDevice({ credential });
  new Store(home).upsertPairing({
    deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port,
    userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
  });
  const a = await startAgentd({ home, clt01: {}, log: () => {}, exit: () => {}, mdns: noMdns });
  const sdk = new ToolClient({ name: 'game-buddy', scope: { pair: true, api: [TURNS, '/v1/api/data/user/character'] }, home });
  t.after(async () => {
    await sdk.close();
    await a.shutdown();
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  await assert.rejects(sdk.chatTurn({ image: JPEG }), e => e instanceof HostError && e.code === 'APPROVAL_PENDING');
  await fetch(`http://127.0.0.1:${a.ipcPort}/clients/approve`, {
    method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'game-buddy' }),
  });

  const turn = await sdk.chatTurn({ image: JPEG, text: 'cheer me on', waitMs: 5000 });
  assert.deepEqual([turn.state, turn.assistant_text], ['completed', 'Nice jump!']);
  assert.deepEqual(device.turns[0].request.output, { speech: 'device' });
  assert.equal('interrupt' in device.turns[0].request, false);
  await sdk.chatTurn({ image: JPEG, interrupt: false, waitMs: 5000 });
  assert.equal(device.turns[1].request.interrupt, false);
  assert.equal('retention' in device.turns[1].request, false);
  await sdk.chatTurn({ image: JPEG, retention: 'none', waitMs: 5000 });
  assert.equal(device.turns[2].request.retention, 'none');
  assert.equal('tools' in device.turns[2].request, false);
  await sdk.chatTurn({ image: JPEG, tools: 'none', waitMs: 5000 });
  assert.equal(device.turns[3].request.tools, 'none');
  assert.deepEqual(await sdk.api('GET', '/v1/api/data/user/character'), { name: 'Codie' });
  const { found, paired } = await sdk.devices();
  assert.deepEqual([found, paired.map(d => [d.deviceId, d.name])], [[], [['DEV1', 'Codie']]]);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(check, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail('condition not reached');
}

const ECHO = [{
  name: 'echo_text', version: 'v1', description: 'Echo text.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  result_schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
  risk: 'read', idempotent: true, confirmation_required: false,
}];

async function pairedHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-host-'));
  const device = await startFakeDevice({ credential });
  new Store(home).upsertPairing({
    deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port,
    userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
  });
  const lines = [];
  const start = () => startAgentd({ home, clt01: {}, log: l => lines.push(l), exit: () => {}, mdns: noMdns });
  t.after(async () => {
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, start, lines };
}

const admin = (a, method, route, body) => fetch(`http://127.0.0.1:${a.ipcPort}${route}`, {
  method, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(r => r.json());

// The daemon may lose a pending client (restart, reap after sleep): serve()
// must register again on its own instead of polling the dead id forever.
test('ToolClient registers again when the daemon loses it while pending, then publishes once approved', async t => {
  const { home, start } = await pairedHome(t);
  let a = await start();
  const sdk = new ToolClient({ name: 'echo-tool', scope: { tools: true }, home });
  sdk.setTools(ECHO);
  const ac = new AbortController();
  const served = sdk.serve({}, { signal: ac.signal }).then(() => 'resolved', e => e);
  t.after(async () => {
    ac.abort();
    await served;
    await sdk.close();
    await a.shutdown();
  });

  await until(() => sdk.status === 'pending');
  const firstId = sdk.id;
  await a.shutdown();
  a = await start();
  await until(async () => (await admin(a, 'GET', '/clients')).clients.length === 1);
  assert.notEqual(sdk.id, firstId);
  assert.equal(sdk.status, 'pending');

  await admin(a, 'POST', '/clients/approve', { name: 'echo-tool' });
  await until(async () => (await admin(a, 'GET', '/clients')).clients[0].tools.length === 1, 15_000);
  assert.equal(sdk.status, 'approved');
  assert.deepEqual((await admin(a, 'GET', '/clients')).clients[0].tools, ['echo_text']);
  ac.abort();
  assert.equal(await served, 'resolved');
});

// connect() and the first call racing at startup share one registration, so
// the client never keeps the token of a registration the daemon replaced.
test('ToolClient registers once when connect and a call race', async t => {
  const { home, start, lines } = await pairedHome(t);
  const a = await start();
  const sdk = new ToolClient({ name: 'game-buddy', scope: { api: [TURNS] }, home });
  t.after(async () => {
    await sdk.close();
    await a.shutdown();
  });

  const [, turn] = await Promise.allSettled([sdk.connect(), sdk.chatTurn({ image: JPEG })]);
  assert.equal(turn.reason.code, 'APPROVAL_PENDING');
  assert.equal(lines.filter(l => l.includes('game-buddy registered')).length, 1);
  await assert.rejects(sdk.chatTurn({ image: JPEG }), e => e.code === 'APPROVAL_PENDING');
});

test('publishTools waits for approval, then updates and withdraws a serving client\'s catalog', async t => {
  const { home, start } = await pairedHome(t);
  const a = await start();
  const sdk = new ToolClient({ name: 'echo-tool', scope: { tools: true }, home });
  const ac = new AbortController();
  const served = sdk.serve({}, { signal: ac.signal });
  t.after(async () => {
    ac.abort();
    await served;
    await sdk.close();
    await a.shutdown();
  });
  await until(() => sdk.status === 'pending');
  await sdk.publishTools(ECHO); // kept for serve(): not approved yet
  const published = async () => (await admin(a, 'GET', '/clients')).clients[0].tools;
  assert.deepEqual(await published(), []);

  await admin(a, 'POST', '/clients/approve', { name: 'echo-tool' });
  await until(async () => (await published()).length === 1, 15_000);
  await sdk.publishTools([{ ...ECHO[0], name: 'echo_again' }]);
  assert.deepEqual(await published(), ['echo_again']);
  await sdk.publishTools([]);
  assert.deepEqual(await published(), []);
});
