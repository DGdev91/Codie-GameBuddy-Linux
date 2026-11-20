import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { toDiscovered, Mdns } from '../../src/agentd/mdns.mjs';
import { localBonjour, v4 } from './helpers/local-bonjour.mjs';

test('toDiscovered reads device_id/name/ipv4 TXT (string or Buffer) + SRV port', () => {
  const d = toDiscovered({ port: 8081, txt: { device_id: Buffer.from('d1'), name: 'Living room', ipv4: '10.0.0.5,192.168.1.2' } });
  assert.deepEqual(d, { deviceId: 'd1', name: 'Living room', host: '10.0.0.5', port: 8081 });
});

test('toDiscovered skips missing/placeholder device_id or ipv4', () => {
  assert.equal(toDiscovered({ port: 1, txt: { ipv4: '1.2.3.4' } }), null);
  assert.equal(toDiscovered({ port: 1, txt: { device_id: 'unknown0', ipv4: '1.2.3.4' } }), null);
  assert.equal(toDiscovered({ port: 1, txt: { device_id: 'd' } }), null);
});

test('close resolves at once and ends discovery', async () => {
  const m = new Mdns({ bonjour: localBonjour() });
  const t0 = Date.now();
  await m.close();
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(await m.discover(), []);
});

test('close is safe with nothing published and when called twice', async () => {
  const m = new Mdns({ bonjour: localBonjour() });
  await m.close();
  await m.close();
});

test('Mdns attaches an error listener to the multicast socket', () => {
  const m = new Mdns({ bonjour: localBonjour() });
  try {
    assert.ok(m.bonjour.server.mdns.listenerCount('error') > 0);
  } finally { m.close(); }
});

function discoveryFactory() {
  const clients = [];
  const factory = options => {
    const events = new EventEmitter();
    const client = { options, server: { mdns: events }, stopped: 0, destroyed: 0,
      find(_, onService) { client.emitService = onService; return { stop() { client.stopped++; } }; },
      destroy() { client.destroyed++; },
    };
    clients.push(client);
    return client;
  };
  return { clients, factory };
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform}: default discovery selects per-interface sockets on Windows and Linux`, async () => {
    const m = new Mdns({ platform });
    try {
      if (platform === 'darwin') assert.equal(m.discoveryBonjour, null);
      else assert.equal(typeof m.discoveryBonjour, 'function');
    } finally { await m.close(); }
  });
}

for (const platform of ['win32', 'linux']) {
  test(`${platform} discovery queries each usable IPv4 interface and merges duplicate devices`, async () => {
    const { clients, factory } = discoveryFactory();
    const m = new Mdns({ bonjour: localBonjour(), platform, discoveryBonjour: factory, interfaces: () => ({
      loop: [{ ...v4('127.0.0.1'), internal: true }],
      wsl: [v4('192.168.16.1')], wlan: [v4('10.10.32.229'), v4('10.10.32.229')],
      disconnected: [v4('169.254.2.3')], ipv6: [{ family: 'IPv6', address: '::1' }],
    }) });
    try {
      const result = m.discover(20);
      const bind = platform === 'linux' ? { bind: '0.0.0.0' } : {};
      assert.deepEqual(clients.map(c => c.options), [{ interface: '192.168.16.1', ...bind }, { interface: '10.10.32.229', ...bind }]);
      const svc = { port: 8081, txt: { device_id: 'device', ipv4: '10.10.32.130', name: 'Codie' } };
      clients.forEach(c => c.emitService(svc));
      assert.deepEqual(await result, [toDiscovered(svc)]);
      assert.ok(clients.every(c => c.stopped === 1 && c.destroyed === 1));
    } finally { await m.close(); }
  });
}

test('discovery refreshes interface addresses after network changes and close releases active scans', async () => {
  const { clients, factory } = discoveryFactory();
  let address = '10.0.0.1';
  const m = new Mdns({ bonjour: localBonjour(), discoveryBonjour: factory, interfaces: () => ({ wlan: [v4(address)] }) });
  await m.discover(1);
  address = '10.1.0.1';
  const pending = m.discover(60000);
  await m.close();
  assert.deepEqual(await pending, []);
  assert.deepEqual(clients.map(c => c.options.interface), ['10.0.0.1', '10.1.0.1']);
  assert.ok(clients.every(c => c.stopped === 1 && c.destroyed === 1));
  assert.deepEqual(await m.discover(), []);
});

test('an interface socket error releases that scan without losing devices from another interface', async () => {
  const { clients, factory } = discoveryFactory();
  const m = new Mdns({ bonjour: localBonjour(), discoveryBonjour: factory, interfaces: () => ({
    one: [v4('10.0.0.1')], two: [v4('10.1.0.1')],
  }) });
  try {
    const pending = m.discover(20);
    clients[0].server.mdns.emit('error', new Error('interface disappeared'));
    clients[1].emitService({ port: 8081, txt: { device_id: 'device', ipv4: '10.1.0.2' } });
    assert.equal((await pending).length, 1);
    assert.ok(clients.every(c => c.stopped === 1 && c.destroyed === 1));
  } finally { await m.close(); }
});
