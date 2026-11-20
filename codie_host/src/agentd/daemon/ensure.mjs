import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTD_VERSION } from './version.mjs';
import { writeJsonAtomic } from '../store.mjs';

const POLL_MS = 100;
const STATUS_TIMEOUT_MS = 1000;
const SHUTDOWN_WAIT_MS = 3000;
const STALE_LOCK_MS = 10_000;

// While a newer session replaces an older agentd (its /shutdown, then its
// spawn), an older session must not start its own older agentd in the gap:
// the two would keep replacing each other. The upgrader writes the floor
// first; it is honored only for FLOOR_WINDOW_MS after that write (file
// mtime), which covers the gap. After that it is ignored, so a downgraded
// plugin (or one older session left behind) can still start agentd.
export const NEWER_PLUGIN = 'A newer Codie plugin is starting the background service; try again shortly. If this keeps happening, update this plugin.';
export const FLOOR_FILE = 'agentd.min-version';
export const FLOOR_WINDOW_MS = 30_000;

// The floor in force, or 0 once its window has passed.
function readFloor(home, windowMs) {
  const file = path.join(home, FLOOR_FILE);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > windowMs) return 0;
    return Number(JSON.parse(fs.readFileSync(file, 'utf8'))) || 0;
  } catch { return 0; }
}

// Raises the floor in force (an expired one counts as 0), restarting its window.
function raiseFloor(home, version, windowMs) {
  if (version > readFloor(home, windowMs)) writeJsonAtomic(path.join(home, FLOOR_FILE), version);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// agentd belongs to no session: drop the Claude Code session vars it would
// otherwise inherit (CLAUDE_CODE_CHILD_SESSION stops the transcripts of the
// `claude` it later spawns from being saved).
// Under Electron (game_buddy), process.execPath is the Electron binary:
// ELECTRON_RUN_AS_NODE makes it run the daemon as plain Node.
export function agentdEnv(home, env = process.env, versions = process.versions) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k === 'CLAUDE_PID') continue;
    out[k] = v;
  }
  out.CODIE_HOME = home;
  if (versions.electron) out.ELECTRON_RUN_AS_NODE = '1';
  return out;
}

// stdout/stderr go to <home>/agentd.log, so a crash before agentd.mjs sets
// up its own logging still leaves a trace. A failed spawn is recorded on
// `child.spawnError` instead of crashing the session.
export function spawnDetached(agentdPath, home) {
  const fd = fs.openSync(path.join(home, 'agentd.log'), 'a', 0o600);
  try {
    const child = spawnChild(process.execPath, [agentdPath], {
      // cwd: home, not the session's project dir (which agentd would pin, and
      // which may later be deleted or unmounted).
      detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: agentdEnv(home), cwd: home,
    });
    child.on('error', e => { child.spawnError = e; });
    child.unref();
    return child;
  } finally {
    fs.closeSync(fd);
  }
}

// The agentd described by agentd.json, if its pid lives and GET /status
// answers for that same pid.
async function probe(home) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(home, 'agentd.json'), 'utf8')); } catch { return null; }
  if (!info?.port || !info.token || !isAlive(info.pid)) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/status`, {
      headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const s = await r.json();
    if (s.pid !== info.pid) return null;
    return { port: info.port, token: info.token, pid: info.pid, version: Number(s.version) };
  } catch {
    return null;
  }
}

async function shutdownAndWait({ port, token, pid }) {
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch { /* it may be exiting already */ }
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while (isAlive(pid) && Date.now() < deadline) await sleep(50);
}

// A lock is stale when older than 10s or when its pid is gone. An empty file
// (a lock still being written) or one whose pid was reused goes stale only by
// age. Two sessions may both judge the same lock stale and both spawn; that
// race is accepted: the agentd that agentd.json no longer names leaves on its
// own (agentd-core's liveness check), as does an older one a missed /shutdown
// left running.
function isStaleLock(lock) {
  let st, text;
  try { st = fs.statSync(lock); text = fs.readFileSync(lock, 'utf8').trim(); } catch { return false; }
  if (Date.now() - st.mtimeMs > STALE_LOCK_MS) return true;
  return text !== '' && !isAlive(Number(text));
}

function tryLock(lock) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      // EPERM/EBUSY: Windows, while another process deletes or holds the file.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
    }
    if (!isStaleLock(lock)) return false;
    try { fs.unlinkSync(lock); } catch { /* someone else cleared it */ }
  }
  return false;
}

function releaseLock(lock) {
  try {
    if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lock);
  } catch { /* already gone */ }
}

// Returns a running agentd of at least `version`: reuses the live one, asks an
// older one to shut down, or spawns a new one. One session spawns at a time
// (agentd.lock); the others just wait for agentd.json to appear. `timeoutMs`
// covers only the wait for a spawned agentd, not the shutdown of an old one.
export async function ensureAgentd({
  home, agentdPath, version = AGENTD_VERSION, spawn = spawnDetached, timeoutMs = 5000, floorWindowMs = FLOOR_WINDOW_MS,
}) {
  const good = a => a && a.version >= version;
  const current = await probe(home);
  if (good(current)) return current; // a running newer agentd is fine to use
  if (version < readFloor(home, floorWindowMs)) throw new Error(NEWER_PLUGIN);

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (current) {
    raiseFloor(home, version, floorWindowMs); // before /shutdown, so the old version's sessions won't respawn it
    await shutdownAndWait(current);
  }
  const lock = path.join(home, 'agentd.lock');
  const failure = detail => new Error(`The Codie background service failed to start; see ${path.join(home, 'agentd.log')}${detail}`);
  const deadline = Date.now() + timeoutMs;
  let locked = false;
  let exited = null;
  try {
    while (Date.now() < deadline) {
      if (!locked && tryLock(lock)) {
        locked = true;
        const got = await probe(home); // another session may have finished meanwhile
        if (good(got)) return got;
        if (version < readFloor(home, floorWindowMs)) throw new Error(NEWER_PLUGIN); // a newer session upgraded meanwhile
        const child = spawn(agentdPath, home);
        child?.once?.('exit', (code, signal) => { exited ??= { code, signal }; });
        child?.once?.('error', e => { exited ??= { error: e }; });
      }
      await sleep(POLL_MS);
      const got = await probe(home);
      if (good(got)) return got;
      if (exited) {
        // It may have lost the race to an agentd that serves now.
        const last = await probe(home);
        if (good(last)) return last;
        const why = exited.error ? exited.error.code ?? exited.error.message : exited.code ?? exited.signal;
        throw failure(` (exit code ${why})`);
      }
    }
  } finally {
    if (locked) releaseLock(lock);
  }
  throw failure('');
}
