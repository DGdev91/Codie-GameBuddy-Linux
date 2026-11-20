import os from 'node:os';
import { Bonjour } from 'bonjour-service';

// clt01 control plane: `_codie-config._tcp`, TXT device_id / name / ipv4 (csv).
// IP comes from TXT, not A-records (.local resolution is flaky on Windows) —
// same rule as Bridge's codie_discovery_service.dart.
export function toDiscovered(svc) {
  const txt = svc.txt || {};
  const s = k => (txt[k] == null ? '' : txt[k].toString());
  const deviceId = s('device_id');
  if (!deviceId || deviceId === 'unknown0') return null;
  const host = s('ipv4').split(',').map(x => x.trim()).find(x => /^\d+\.\d+\.\d+\.\d+$/.test(x));
  if (!host) return null;
  return { deviceId, name: s('name'), host, port: svc.port };
}

const ip4 = s => (/^\d+\.\d+\.\d+\.\d+$/.test(s ?? '') ? s.split('.').reduce((n, o) => ((n << 8) | +o) >>> 0, 0) : null);

// Finds clt01 devices on the LAN (`_codie-config._tcp`).
export class Mdns {
  constructor({ interfaces = () => os.networkInterfaces(), bonjour, platform = process.platform, discoveryBonjour } = {}) {
    const log = err => console.error('[codie] mdns', err?.message ?? err);
    this.bonjour = bonjour ?? new Bonjour({}, log);
    this.bonjour.server?.mdns?.on?.('error', log);
    this.interfaces = interfaces;
    this.platform = platform;
    // Windows and Linux (including mirrored WSL) can route multicast over
    // a virtual adapter. Query each IPv4 interface explicitly, using
    // fresh sockets so a network change cannot leave discovery on old ones.
    this.discoveryBonjour = discoveryBonjour ?? (!bonjour && (platform === 'win32' || platform === 'linux') ? ((options, onError) => new Bonjour(options, onError)) : null);
    this.scans = new Set();
  }

  // Resolves after `ms` with every distinct device seen.
  discover(ms = 3000) {
    if (this.closed) return Promise.resolve([]);
    if (this.discoveryBonjour) {
      const addresses = [...new Set(Object.values(this.interfaces() ?? {}).flat().filter(a =>
        !a.internal && (a.family === 'IPv4' || a.family === 4) && ip4(a.address) != null && !a.address.startsWith('169.254.')
      ).map(a => a.address))];
      if (addresses.length) {
        return Promise.all(addresses.map(address => this.#discover(ms, address))).then(groups =>
          [...new Map(groups.flat().map(d => [d.deviceId, d])).values()]);
      }
    }
    return this.#discover(ms);
  }

  #discover(ms, address) {
    return new Promise(resolve => {
      const found = new Map();
      let browser, client, timer, finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.scans.delete(finish);
        browser?.stop();
        if (address) client?.destroy();
        resolve([...found.values()]);
      };
      this.scans.add(finish);
      const onError = err => {
        console.error('[codie] mDNS discovery failed', address ?? '', err?.message ?? err);
        finish();
      };
      try {
        // On Linux, binding to the interface's unicast address excludes
        // multicast replies. Keep the selected multicast interface, but
        // receive on the wildcard address.
        client = address ? this.discoveryBonjour({ interface: address, ...(this.platform === 'linux' ? { bind: '0.0.0.0' } : {}) }, onError) : this.bonjour;
        if (address) client.server?.mdns?.on?.('error', onError);
        browser = client.find({ type: 'codie-config' }, svc => {
          const d = toDiscovered(svc);
          if (d) found.set(d.deviceId, d);
        });
        timer = setTimeout(finish, ms);
      } catch (err) { onError(err); }
    });
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      for (const finish of this.scans) finish();
      this.bonjour.destroy();
    }
    return Promise.resolve();
  }
}
