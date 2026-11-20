// host.mjs with the real SDK against an in-process codie-agentd and the fake
// clt01 of the sibling codie_host repo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolClient } from 'codie-host';
import { Store, startAgentd, startFakeDevice } from 'codie-host/testing';
import { CLIENT_NAME, SCOPE, createHost } from '../src/main/host.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const noMdns = { sync: async () => {}, close: async () => {}, discover: async () => [] };

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail('condition not reached');
}

test('once approved and paired, a chat turn reaches the device', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'game-buddy-host-'));
  const device = await startFakeDevice({ credential });
  new Store(home).upsertPairing({
    deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port, bridgeId: 'b1', serviceSecret: 's1',
    userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
  });
  const agentd = await startAgentd({ home, port: 0, legacyDirs: [], handoffDirs: [], clt01: {}, log: () => {}, exit: () => {}, mdns: noMdns });
  const ac = new AbortController();
  const host = createHost({ client: new ToolClient({ name: CLIENT_NAME, scope: SCOPE, home }), watchMs: 20 });
  t.after(async () => {
    ac.abort();
    await host.close();
    await agentd.shutdown();
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  await host.start(ac.signal);
  assert.equal(host.state, 'pending');
  await fetch(`http://127.0.0.1:${agentd.ipcPort}/clients/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agentd.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: CLIENT_NAME }),
  });
  await until(() => host.state === 'ready');
  assert.deepEqual(await host.devices(), [{ deviceId: 'DEV1', name: 'Codie', host: '', paired: true, found: false, online: true }]);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const r = await host.chatTurn({ image: jpeg, text: 'cheer me on', speech: 'device' });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.turn.state, 'completed');
  assert.deepEqual(device.turns[0].request.output, { speech: 'device' });
  assert.ok(device.turns[0].image.equals(jpeg));
});
