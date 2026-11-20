// Paired device addresses follow the device (spec §3: scan + paired address,
// reconnect on IP change).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../../src/agentd/store.mjs';
import { createHostRefresh, updatePairedHosts } from '../../src/agentd/daemon/host-refresh.mjs';
import { DeviceError } from '../../src/agentd/tools/device-client.mjs';

// What answers at the new address proved it holds the pairing's credential.
const proven = async () => true;

function tempStore(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-hosts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home);
  store.upsertPairing({ deviceId: 'DEV1', name: 'Desk', host: '10.10.32.60', port: 8081, credentialId: 'c1' });
  store.upsertPairing({ deviceId: 'DEV2', name: 'Kitchen', host: '10.10.32.70', port: 8081 });
  return store;
}

test('a scan moves a paired device to its new address and leaves the rest alone', t => {
  const store = tempStore(t);
  const changed = updatePairedHosts(store, [
    { deviceId: 'DEV1', name: 'Renamed', host: '10.10.32.56', port: 8082 },
    { deviceId: 'DEV2', name: 'Kitchen', host: '10.10.32.70', port: 8081 },
    { deviceId: 'OTHER', name: 'Not paired', host: '10.10.32.99', port: 8081 },
  ]);
  assert.deepEqual(changed, ['DEV1']);
  const byId = Object.fromEntries(store.listPairings().map(r => [r.deviceId, r]));
  assert.deepEqual(byId.DEV1, { deviceId: 'DEV1', name: 'Desk', host: '10.10.32.56', port: 8082, credentialId: 'c1' });
  assert.equal(byId.DEV2.host, '10.10.32.70');
  assert.equal(byId.OTHER, undefined);
  assert.deepEqual(updatePairedHosts(store, [{ deviceId: 'DEV1', host: '10.10.32.56', port: 8082 }]), []);
});

// The address of a paired device changes only after it failed there (an
// mDNS answer alone proves nothing: any LAN host can send one).
test('a refresh moves only devices that failed, from one scan', async t => {
  const store = tempStore(t);
  const scans = [];
  let changes = 0;
  const hosts = createHostRefresh({ verify: proven,
    store, onChanged: () => { changes++; },
    discover: async ms => {
      scans.push(ms);
      return [{ deviceId: 'DEV1', host: '10.10.32.56', port: 8081 }, { deviceId: 'DEV2', host: '10.10.32.71', port: 8081 }];
    },
  });
  assert.deepEqual(await hosts.refresh(), [], 'nothing failed: no scan');
  assert.deepEqual(scans, []);
  assert.deepEqual(await hosts.unreachable('DEV1'), ['DEV1']);
  assert.deepEqual(scans, [3000]);
  assert.equal(changes, 1);
  const byId = Object.fromEntries(store.listPairings().map(r => [r.deviceId, r]));
  assert.equal(byId.DEV1.host, '10.10.32.56');
  assert.equal(byId.DEV2.host, '10.10.32.70', 'a healthy device keeps its address');
});

test('a device that answered again is no longer moved', async t => {
  const store = tempStore(t);
  let clock = 1_000_000;
  let found = [];
  const hosts = createHostRefresh({ store, verify: proven, now: () => clock, onChanged: () => {}, discover: async () => found });
  await hosts.unreachable('DEV1');
  hosts.reachable('DEV1');
  clock += 60_000;
  found = [{ deviceId: 'DEV1', host: '10.10.32.56', port: 8081 }];
  assert.deepEqual(await hosts.refresh(), []);
  assert.equal(store.listPairings().find(r => r.deviceId === 'DEV1').host, '10.10.32.60');
});

test('refreshes are a minute apart, back off to ten minutes while nothing moves, and share a run', async t => {
  const store = tempStore(t);
  let clock = 1_000_000;
  let scans = 0;
  let release;
  const hosts = createHostRefresh({ verify: proven,
    store, now: () => clock, onChanged: () => {},
    discover: () => { scans++; return new Promise(r => { release = r; }); },
  });
  const first = hosts.unreachable('DEV1');
  assert.equal(hosts.unreachable('DEV1'), first);
  release([]);
  assert.deepEqual(await first, []);
  assert.equal(scans, 1);

  // Nothing moved: the gap doubles from 60 s, up to 10 min.
  const runAt = async ms => { clock += ms; const p = hosts.unreachable('DEV1'); release?.([]); await p; return scans; };
  assert.equal(await runAt(60_000), 1, 'gap is now 120 s');
  assert.equal(await runAt(60_000), 2);
  assert.equal(await runAt(239_000), 2, 'gap is now 240 s');
  assert.equal(await runAt(1_000), 3);
  assert.equal(await runAt(480_000), 4, 'gap is now 480 s');
  assert.equal(await runAt(600_000), 5, 'capped at 600 s');
  assert.equal(await runAt(599_000), 5);
  assert.equal(await runAt(1_000), 6);

  // The device answered: back to a minute.
  hosts.reachable('DEV1');
  await hosts.unreachable('DEV1');
  assert.equal(await runAt(60_000), 7);
});

test('a move resets the gap to a minute', async t => {
  const store = tempStore(t);
  let clock = 1_000_000;
  let found = [];
  const hosts = createHostRefresh({ store, verify: proven, now: () => clock, onChanged: () => {}, discover: async () => found });
  await hosts.unreachable('DEV1');
  clock += 60_000;
  await hosts.unreachable('DEV1'); // skipped: the gap is 120 s
  clock += 60_000;
  found = [{ deviceId: 'DEV1', host: '10.10.32.56', port: 8081 }];
  assert.deepEqual(await hosts.unreachable('DEV1'), ['DEV1']);
  found = [{ deviceId: 'DEV1', host: '10.10.32.57', port: 8081 }];
  clock += 60_000;
  assert.deepEqual(await hosts.unreachable('DEV1'), ['DEV1']);
});

test('a failed scan changes nothing', async t => {
  const store = tempStore(t);
  const logged = [];
  const hosts = createHostRefresh({ store, verify: proven, onChanged: () => assert.fail('no change'), log: (...a) => logged.push(a.join(' ')),
    discover: async () => { throw new Error('no multicast'); } });
  assert.deepEqual(await hosts.unreachable('DEV1'), []);
  assert.match(logged.join('\n'), /no multicast/);
});

// An mDNS answer naming a paired device that failed may still come from any
// LAN host: the pairing moves only to an address that proves the credential.
test('a device is not moved to an address that cannot prove its credential', async t => {
  const store = tempStore(t);
  const asked = [];
  const logged = [];
  const hosts = createHostRefresh({
    store, onChanged: () => assert.fail('no change'), log: (...a) => logged.push(a.join(' ')),
    discover: async () => [{ deviceId: 'DEV1', host: '10.10.32.66', port: 8081 }],
    verify: async (record, d) => { asked.push([record.deviceId, record.host, d.host]); return false; },
  });
  assert.deepEqual(await hosts.unreachable('DEV1'), []);
  assert.deepEqual(asked, [['DEV1', '10.10.32.60', '10.10.32.66']]);
  assert.equal(store.listPairings().find(r => r.deviceId === 'DEV1').host, '10.10.32.60');
  assert.match(logged.join(' '), /not moved/);
});

// A refused credential (the device dropped its pairings) asks the user to
// pair again; a new pairing, or any call that goes through, ends that.
test('a refused credential marks the pairing until a call goes through or it is paired again', async t => {
  const store = tempStore(t);
  const hosts = createHostRefresh({ store, discover: async () => [], verify: proven, onChanged: () => {} });
  const expired = () => new DeviceError(401, 'LOCAL_SESSION_EXPIRED', 'expired');
  await hosts.unreachable('DEV1', new TypeError('fetch failed'));
  assert.equal(hosts.refused('DEV1'), false, 'a network failure is not a refusal');
  await hosts.unreachable('DEV1', new DeviceError(401, 'REQUEST_EXPIRED', 'clock'));
  assert.equal(hosts.refused('DEV1'), false, 'other 401s are not a refusal');
  await hosts.unreachable('DEV1', expired());
  assert.equal(hosts.refused('DEV1'), true);
  assert.equal(hosts.refused('DEV2'), false);
  hosts.reachable('DEV1');
  assert.equal(hosts.refused('DEV1'), false);

  await hosts.unreachable('DEV1', expired());
  store.upsertPairing({ ...store.listPairings().find(r => r.deviceId === 'DEV1'), credentialId: 'c2' });
  assert.equal(hosts.refused('DEV1'), false, 'the new pairing has not been refused');
});
