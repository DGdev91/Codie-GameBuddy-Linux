// agentd's signatures prove agentd to the device, not the device to agentd:
// a LAN host at (or announced for) a paired device's address must not be
// believed until it answers a fresh challenge with the credential.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startAgentd } from '../../src/agentd/daemon/agentd-core.mjs';
import { AGENTS_CLIENT } from '../../src/agentd/daemon/agents-host.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { integrationId } from '../../src/agentd/tools/integration-id.mjs';
import { startFakeDevice } from './helpers/fake-device.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const IID = integrationId('DEV1', AGENTS_CLIENT);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 5000) => {
  for (const end = Date.now() + ms; !(await cond()); await sleep(10)) if (Date.now() > end) throw new Error('timed out waiting');
};
const pairing = port => ({ deviceId: 'DEV1', name: 'Desk', host: '127.0.0.1', port,
  userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret });

// A port nothing listens on: the paired address of a device that went away.
const deadPort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

async function agentdWith(t, port, { discover = async () => [], logged = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-proof-'));
  const store = new Store(home);
  store.upsertPairing(pairing(port));
  const a = await startAgentd({ home, clt01: {}, log: (...m) => logged.push(m.join(' ')), exit: () => {}, mdns: { close: async () => {}, discover },
    hostRefreshOptions: { gapMs: 50, maxGapMs: 50, scanMs: 10 } });
  t.after(async () => { await a.shutdown(); fs.rmSync(home, { recursive: true, force: true }); });
  return { a, store };
}

test('an impostor at the paired address gets the socket but no task: its invoke is ignored', async t => {
  const impostor = await startFakeDevice({ credential, impostor: true });
  t.after(() => impostor.close());
  const logged = [];
  await agentdWith(t, impostor.port, { logged });
  // The impostor pushes an invoke on every socket agentd opens, right after its ready.
  const tries = setInterval(() => {
    if (!impostor.connected(IID)) return;
    impostor.invoke(IID, { invocation_id: 'evil-1', name: 'ask_agent', arguments: { prompt: 'rm -rf ~' }, timeout_ms: 20000 });
  }, 1);
  t.after(() => clearInterval(tries));
  await until(() => logged.some(l => /did not prove it holds our credential/.test(l)));
  await sleep(1500); // the retry opens another socket, refused the same way
  assert.deepEqual(impostor.results.filter(r => r.data?.invocation_id === 'evil-1'), [], 'no answer, no task');
  assert.equal(logged.filter(l => /did not prove/.test(l)).length >= 2, true, 'every socket is refused');
  assert.equal(logged.some(l => /agents: online/.test(l)), false, 'never online');
});

test('the real device, answering the challenge, gets its task taken', async t => {
  const device = await startFakeDevice({ credential });
  t.after(() => device.close());
  await agentdWith(t, device.port);
  await until(() => device.connected(IID));
  device.invoke(IID, { invocation_id: 'ok-1', name: 'ask_agent', arguments: { prompt: 'run tests' }, timeout_ms: 20000 });
  await until(() => device.results.find(r => r.data?.invocation_id === 'ok-1'));
});

test('a failed device moves to an address that proves the credential, never to one that does not', async t => {
  const impostor = await startFakeDevice({ credential, impostor: true });
  const device = await startFakeDevice({ credential });
  t.after(async () => { await impostor.close(); await device.close(); });
  let announced = impostor.port;
  const { store } = await agentdWith(t, await deadPort(), {
    discover: async () => [{ deviceId: 'DEV1', name: 'Desk', host: '127.0.0.1', port: announced }],
  });
  const paired = () => store.listPairings()[0].port;
  await sleep(400); // several refreshes see only the impostor
  assert.notEqual(paired(), impostor.port);
  assert.equal(impostor.connected(IID), false);
  announced = device.port;
  await until(() => paired() === device.port);
  await until(() => device.connected(IID));
});
