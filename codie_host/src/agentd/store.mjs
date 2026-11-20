import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { codieHome } from './daemon/home.mjs';

// pairing.json: [{deviceId, name, host, port, userId, credentialId, credentialSecret}]
// deviceId is clt01's id (from _codie-config._tcp TXT); the credential fields
// are the clt01 client credential everything on the device signs with. The
// device master secret is never stored.
export class Store {
  constructor(dir = codieHome()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best-effort (pre-existing dir, Windows) */ }
    this.pairingPath = path.join(dir, 'pairing.json');
    this.statusPath = path.join(dir, 'status.json');
    this.settingsPath = path.join(dir, 'settings.json');
    this.clientsPath = path.join(dir, 'clients.json');
  }

  listPairings() {
    const v = readJson(this.pairingPath);
    return Array.isArray(v) ? v : [];
  }

  // A replaced record keeps its place: order decides nothing on its own
  // (toolDevice falls back to the first credentialed pairing).
  upsertPairing(record) {
    this.#backupCorrupt();
    const list = this.listPairings();
    const at = list.findIndex(r => r.deviceId === record.deviceId);
    const next = at < 0 ? [...list, record]
      : list.flatMap((r, i) => (r.deviceId !== record.deviceId ? [r] : i === at ? [record] : []));
    writeJsonAtomic(this.pairingPath, next);
  }

  removePairing(deviceId) {
    const list = this.listPairings();
    const next = list.filter(r => r.deviceId !== deviceId);
    if (next.length === list.length) return false;
    this.#backupCorrupt();
    writeJsonAtomic(this.pairingPath, next);
    return true;
  }


  // A pairing.json that exists but won't parse reads as [] — move it aside
  // before a write would overwrite it, so pairings aren't silently lost.
  #backupCorrupt() {
    let raw;
    try { raw = fs.readFileSync(this.pairingPath, 'utf8'); } catch { return; }
    try { JSON.parse(raw); return; } catch { /* corrupt */ }
    fs.renameSync(this.pairingPath, `${this.pairingPath}.corrupt-${Date.now()}`);
  }

  // settings.json: user preferences shared by every session ({remindMode, remindDetail, voiceLanguage}).
  readSettings() {
    return readSettings(this.dir);
  }

  lastCodexThread(deviceId) { return readJson(path.join(this.dir, 'routing.json'))?.[deviceId] ?? null; }

  rememberCodexThread(deviceId, threadId) {
    const file = path.join(this.dir, 'routing.json');
    writeJsonAtomic(file, { ...(readJson(file) ?? {}), [deviceId]: threadId });
  }

  // codex-threads.json: the Codex threads whose hooks reported them open
  // (SessionEnd removes one), kept across agentd restarts.
  codexThreads() {
    const v = readJson(path.join(this.dir, 'codex-threads.json'));
    return Array.isArray(v) ? v.filter(id => typeof id === 'string' && id) : [];
  }

  saveCodexThreads(ids) { writeJsonAtomic(path.join(this.dir, 'codex-threads.json'), ids); }

  // clients.json: { <name>: { scope, approvedAt } } — the tool clients the
  // user approved (`codie clients approve`) and the scope they asked for.
  approvedClients() {
    const v = readJson(this.clientsPath);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  approveClient(name, scope, now = Date.now()) {
    writeJsonAtomic(this.clientsPath, { ...this.approvedClients(), [name]: { scope, approvedAt: now } });
  }

  revokeClient(name) {
    const { [name]: gone, ...rest } = this.approvedClients();
    if (!gone) return false;
    writeJsonAtomic(this.clientsPath, rest);
    return true;
  }

  updateSettings(patch) { writeJsonAtomic(this.settingsPath, { ...this.readSettings(), ...patch }); }

  writeStatus(status) { writeJsonAtomic(this.statusPath, status); }
  readStatus() { return readStatus(this.dir); }
}

// Read-only views for programs that only look (a session's MCP server, the
// status line): no data dir is created.
export function readSettings(dir = codieHome()) {
  const v = readJson(path.join(dir, 'settings.json'));
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function readStatus(dir = codieHome()) {
  return readJson(path.join(dir, 'status.json'));
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Write-then-rename, owner-only (0600): readers never see a partial file.
export function writeJsonAtomic(p, value) {
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}
