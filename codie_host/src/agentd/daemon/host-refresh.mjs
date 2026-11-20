import { isCredentialRejected } from '../tools/device-client.mjs';

// A device keeps its id when DHCP gives it a new address; the computer
// reaches it at the address of its pairing (spec §3: scan + paired address,
// reconnect on IP change), so a pairing that stopped working follows a scan.
export const HOST_SCAN_MS = 3000;
export const HOST_REFRESH_GAP_MS = 60_000;
export const HOST_REFRESH_MAX_GAP_MS = 600_000;

// Points every paired device in `found` (scan results) at the host/port it
// was seen at. Returns the ids of the pairings that changed.
export function updatePairedHosts(store, found) {
  const seen = new Map((found ?? []).map(d => [d.deviceId, d]));
  const changed = [];
  for (const record of store.listPairings()) {
    const d = seen.get(record.deviceId);
    if (!d?.host || (d.host === record.host && d.port === record.port)) continue;
    store.upsertPairing({ ...record, host: d.host, port: d.port });
    changed.push(record.deviceId);
  }
  return changed;
}

// Moving a paired device on an mDNS answer alone would let any LAN host
// redirect it (TXT device_id proves nothing), so only devices whose paired
// address failed (`unreachable(deviceId)`: nothing answers there, or something
// that refuses our credential) are moved, and only by the scan their failure
// asks for. `reachable(deviceId)` (a call went through) clears the mark.
// `refresh()` runs one scan when a device is marked, at most once per gap: a
// minute, doubling to ten while scans move nothing, back to a minute on a move
// or once a marked device answers. Requests during a run share it. Each
// resolves with the moved device ids ([] when skipped or the scan failed).
// Even then the answer may come from any LAN host, so a device moves only to
// an address where `verify(record, found)` confirms that what answers there
// holds the pairing's credential.
// `refused(deviceId)`: the failure was the device refusing the pairing's
// credential (it was reset or updated and dropped its pairings), so the user
// has to pair again. A call that goes through, or a new credential, ends it.
export function createHostRefresh({ store, discover, verify, onChanged, now = Date.now, gapMs = HOST_REFRESH_GAP_MS, maxGapMs = HOST_REFRESH_MAX_GAP_MS,
  scanMs = HOST_SCAN_MS, log = () => {} }) {
  const failed = new Set();
  const refusedCredentials = new Map(); // deviceId -> the credential id the device refused
  const credentialOf = deviceId => store.listPairings().find(r => r.deviceId === deviceId)?.credentialId;
  let running = null;
  let lastRun = -Infinity;
  let gap = gapMs;
  const run = async () => {
    try {
      const candidates = (await discover(scanMs)).filter(d => failed.has(d.deviceId));
      const paired = new Map(store.listPairings().map(r => [r.deviceId, r]));
      const found = [];
      for (const d of candidates) {
        const record = paired.get(d.deviceId);
        if (!record || (d.host === record.host && d.port === record.port)) continue;
        if (await verify(record, d)) found.push(d);
        else log(`[hosts] ${d.deviceId} answered from ${d.host}:${d.port} without proving it holds our credential; not moved`);
      }
      const changed = updatePairedHosts(store, found);
      gap = changed.length ? gapMs : Math.min(gap * 2, maxGapMs);
      if (changed.length) {
        log(`[hosts] new address for ${changed.join(', ')}`);
        onChanged();
      }
      return changed;
    } catch (e) {
      log('[hosts] refresh failed', e?.message ?? e);
      return [];
    } finally {
      running = null;
    }
  };
  function refresh() {
    if (running) return running;
    if (!failed.size || now() - lastRun < gap) return Promise.resolve([]);
    lastRun = now();
    running = run();
    return running;
  }
  return {
    refresh,
    unreachable(deviceId, error) {
      failed.add(deviceId);
      if (isCredentialRejected(error)) refusedCredentials.set(deviceId, credentialOf(deviceId));
      return refresh();
    },
    reachable(deviceId) {
      refusedCredentials.delete(deviceId);
      if (failed.delete(deviceId)) gap = gapMs;
    },
    refused(deviceId) {
      return refusedCredentials.has(deviceId) && refusedCredentials.get(deviceId) === credentialOf(deviceId);
    },
  };
}
