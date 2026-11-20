import dgram from 'node:dgram';
import { Bonjour } from 'bonjour-service';

// Real bonjour-service registry, but every packet goes to this loopback sink,
// never 224.0.0.251. Instances leaked onto the LAN wedge Android 12 NSD: a
// resolve of an instance that vanishes mid-resolve never calls back, and
// a serial resolve queue on the device then ignores every later peer.
export const received = [];
const sink = dgram.createSocket('udp4');
sink.on('message', m => received.push(m));
await new Promise(ok => sink.bind(0, '127.0.0.1', ok));
sink.unref();
export const localBonjour = () => new Bonjour(
  { ip: '127.0.0.1', port: sink.address().port, interface: '127.0.0.1', bind: false, multicast: false }, () => {});

export const v4 = (address, netmask, extra = {}) => ({ address, netmask, family: 'IPv4', mac: '11:22:33:44:55:66', internal: false, ...extra });
export const IFACES = {
  lo0: [v4('127.0.0.1', '255.0.0.0', { internal: true, mac: '00:00:00:00:00:00' })],
  docker0: [v4('172.17.0.1', '255.255.0.0')],
  utun3: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false }],
  bridge100: [v4('192.168.64.1', '255.255.255.0')],
  en0: [{ address: 'fe80::abcd', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '11:22:33:44:55:66', internal: false }, v4('192.168.1.10', '255.255.255.0')],
};
