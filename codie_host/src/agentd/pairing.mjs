import os from 'node:os';
import { isNetworkError } from './tools/device-client.mjs';

// Pairing outcomes as stable codes (govee_buddy spec §4.1): what happened, for
// a program to put in its own words. Device business codes (INVALID_CODE,
// PAIRING_CODE_EXPIRED, ...) pass through unchanged; these are agentd's own.
export const PAIR = Object.freeze({
  STARTED: 'PAIR_STARTED',
  PAIRED: 'PAIRED',
  CANCELLED: 'CANCELLED',
  NOT_SCANNED: 'DEVICE_NOT_SCANNED',
  NO_PAIRING: 'NO_PAIRING_IN_PROGRESS',
  UNREACHABLE: 'DEVICE_UNREACHABLE',
  CREDENTIAL_NOT_ISSUED: 'CREDENTIAL_NOT_ISSUED',
  NOT_SIGNED_IN: 'DEVICE_NOT_SIGNED_IN',
  FAILED: 'PAIR_FAILED',
});

// deviceAuth wraps a failed bootstrap: the network error is its cause.
const unreachable = e => isNetworkError(e) || isNetworkError(e?.cause);

// A failed pair/request or pair/confirm: the device's own code when it sent one.
export function failureCode(e) {
  if (unreachable(e)) return PAIR.UNREACHABLE;
  return typeof e?.code === 'string' && e.code ? e.code : PAIR.FAILED;
}

// A failed client credential (bootstrap, then the credential route) after
// pair/confirm succeeded.
export function credentialFailureCode(e) {
  if (unreachable(e)) return PAIR.UNREACHABLE;
  return e?.code === PAIR.NOT_SIGNED_IN ? PAIR.NOT_SIGNED_IN : PAIR.CREDENTIAL_NOT_ISSUED;
}

// clt01 errors carry its business code (wrong PIN vs lockout read the same
// otherwise). DOMException's legacy numeric `code` (e.g. 23 on timeout) is noise.
export function errorReason(e) {
  const code = e instanceof DOMException ? undefined : e?.code;
  const suffix = code === undefined || code === null || code === '' ? '' : ` (${code})`;
  return `${e?.message ?? e}${suffix}`;
}

const failed = e => ({ ok: false, code: failureCode(e), reason: errorReason(e) });

// Scanning the LAN and pairing a device. Steps answer outcomes
// { ok, code, deviceName?, reason?, stage? }: device failures come back as
// codes, not exceptions. `reason` is the English failure, for logs and the
// agent wording (`text`).
export class Pairing {
  constructor({ store, link, discover, clt01, onPairingsChanged = () => {}, pairHint }) {
    Object.assign(this, { store, link, discover, clt01, onPairingsChanged, pairHint });
    this.lastScan = new Map(); // deviceId -> discovered
    this.challenges = new Map(); // deviceId -> challengeId
  }

  // Scans the LAN and remembers the result (begin/confirm look devices up in
  // it): [{ deviceId, name, host, paired, online }].
  // Paired devices keep their address: an mDNS answer is no proof of
  // identity (only a failing device is moved, daemon/host-refresh.mjs).
  async scan(ms = 3000) {
    const found = await this.discover(ms);
    this.lastScan = new Map(found.map(d => [d.deviceId, d]));
    const paired = new Set(this.store.listPairings().map(r => r.deviceId));
    const online = new Set(this.link.onlineDevices().map(d => d.deviceId));
    return found.map(d => ({ deviceId: d.deviceId, name: d.name || '', host: d.host, paired: paired.has(d.deviceId), online: online.has(d.deviceId) }));
  }

  // A clt01 client credential, issued with the master secret pair/confirm
  // returned: { userId, credentialId, credentialSecret }, or { error, code }
  // when the call fails. Everything agentd does on the device signs with it.
  async #clientCredential(d, localSecret) {
    try {
      const master = await this.clt01.deviceAuth(d.host, d.port, localSecret);
      const c = await this.clt01.issueClientCredential(d.host, d.port, master, `codie-agentd ${os.hostname()}`);
      return { userId: master.userId, credentialId: c.id, credentialSecret: c.secret };
    } catch (e) {
      return { error: errorReason(e), code: credentialFailureCode(e) };
    }
  }

  async begin(deviceId) {
    const d = this.lastScan.get(deviceId);
    if (!d) return { ok: false, code: PAIR.NOT_SCANNED };
    try {
      const { challengeId } = await this.clt01.pairRequest(d.host, d.port);
      this.challenges.set(d.deviceId, challengeId);
    } catch (e) {
      return failed(e);
    }
    return { ok: true, code: PAIR.STARTED, deviceName: d.name || d.deviceId };
  }

  async confirm(deviceId, code) {
    const d = this.lastScan.get(deviceId);
    const challengeId = this.challenges.get(deviceId);
    if (!d || !challengeId) return { ok: false, code: PAIR.NO_PAIRING };
    let r;
    try {
      r = await this.clt01.pairConfirm(d.host, d.port, challengeId, String(code).trim());
    } catch (e) {
      return failed(e);
    }
    this.challenges.delete(d.deviceId);
    // Key by the mDNS-scanned id: clt01's r.deviceId may be ''. Without a
    // client credential the pairing could do nothing, so none is saved.
    const credential = await this.#clientCredential(d, r.localSecret);
    if (credential.error) return { ok: false, code: credential.code, reason: credential.error, stage: 'credential' };
    this.store.upsertPairing({ deviceId: d.deviceId, name: r.name || d.name, host: d.host, port: d.port, ...credential });
    // The device just paired is the one tools go to (toolDevice).
    this.store.updateSettings({ toolsDevice: d.deviceId });
    this.onPairingsChanged();
    return { ok: true, code: PAIR.PAIRED, deviceName: r.name || d.name || d.deviceId };
  }

  async cancel(deviceId) {
    const d = this.lastScan.get(deviceId);
    const challengeId = this.challenges.get(deviceId);
    if (d && challengeId) await this.clt01.pairCancel(d.host, d.port, challengeId);
    this.challenges.delete(deviceId);
    return { ok: true, code: PAIR.CANCELLED };
  }

  // An outcome in words for an agent; programs word the code themselves.
  text(o, pairHint = this.pairHint) {
    switch (o.code) {
      case PAIR.NOT_SCANNED: return 'Scan with codie_list_devices first, then pick a device by device_id.';
      case PAIR.STARTED: return `Pairing requested. Read the 6-digit code on the screen of "${o.deviceName}" and tell me.`;
      case PAIR.NO_PAIRING: return 'No pairing in progress; call codie_pair_begin first.';
      case PAIR.PAIRED: return `Paired "${o.deviceName}".`;
      case PAIR.CANCELLED: return 'Pairing cancelled.';
      default:
        return o.stage === 'credential'
          ? `The device did not issue a client credential (${o.reason}); nothing saved (the existing pairing is unchanged). Update the Codie firmware, then retry ${pairHint}.`
          : `Failed: ${o.reason}`;
    }
  }
}
