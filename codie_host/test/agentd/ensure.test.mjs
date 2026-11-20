// ensureAgentd against real detached processes (test/fixtures/fake-agentd.mjs).
// Every pid seen in agentd.json is killed at the end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgentd, spawnDetached, agentdEnv, NEWER_PLUGIN, FLOOR_WINDOW_MS } from '../../src/agentd/daemon/ensure.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-agentd.mjs', import.meta.url));
const homes = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-ensure-')); homes.push(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const pids = new Set();
const track = r => { pids.add(r.pid); return r; };
// Each fixture runs in its home: Windows won't remove a live process's cwd,
// and frees it a moment after the process is gone (hence the retries).
after(async () => {
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  await Promise.all([...pids].map(pid => waitDead(pid)));
  await Promise.all(homes.map(d => fs.promises.rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});
const counting = () => {
  const spawn = (p, h) => { spawn.count++; return spawnDetached(p, h); };
  spawn.count = 0;
  return spawn;
};

// Runs `fn` with extra env vars that the spawned fixture inherits.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

async function waitDead(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(50);
  return !alive(pid);
}

test('spawns agentd when none runs, then reuses it', async () => {
  const home = tmp();
  const a = track(await withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 1 })));
  assert.ok(a.port > 0);
  assert.ok(a.token);
  assert.equal(a.version, 1);
  assert.ok(alive(a.pid));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'agentd.json'), 'utf8')).cwd, fs.realpathSync(home), 'runs in its home, not the session\'s cwd');
  const b = track(await ensureAgentd({ home, agentdPath: FAKE, version: 1 }));
  assert.equal(b.pid, a.pid);
  assert.equal(b.port, a.port);
  assert.equal(fs.existsSync(path.join(home, 'agentd.lock')), false);
});

test('two concurrent calls start exactly one agentd', async () => {
  const home = tmp();
  const spawn = counting();
  const [a, b] = await withEnv({ FAKE_VERSION: '1', FAKE_DELAY_MS: '300' }, () => Promise.all([
    ensureAgentd({ home, agentdPath: FAKE, version: 1, spawn }),
    ensureAgentd({ home, agentdPath: FAKE, version: 1, spawn }),
  ]));
  track(a); track(b);
  assert.equal(spawn.count, 1);
  assert.equal(a.pid, b.pid);
});

test('two sessions upgrading the same old agentd start one new one', async () => {
  const home = tmp();
  const old = track(await withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 1 })));
  const spawn = counting();
  const [a, b] = await withEnv({ FAKE_VERSION: '2', FAKE_DELAY_MS: '300' }, () => Promise.all([
    ensureAgentd({ home, agentdPath: FAKE, version: 2, spawn }),
    ensureAgentd({ home, agentdPath: FAKE, version: 2, spawn }),
  ]));
  track(a); track(b);
  assert.equal(spawn.count, 1);
  assert.equal(a.pid, b.pid);
  assert.equal(a.version, 2);
  assert.ok(await waitDead(old.pid));
});

test('an older agentd is shut down and replaced', async () => {
  const home = tmp();
  const old = track(await withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 1 })));
  const neu = track(await withEnv({ FAKE_VERSION: '2' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 2 })));
  assert.notEqual(neu.pid, old.pid);
  assert.equal(neu.version, 2);
  assert.ok(await waitDead(old.pid));
  assert.ok(alive(neu.pid));
});

test('upgrading raises the min-version floor; within its window an older caller reuses the newer agentd, never respawns its own', async () => {
  const home = tmp();
  const floor = path.join(home, 'agentd.min-version');
  const v1 = track(await withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 1 })));
  assert.equal(fs.existsSync(floor), false, 'a plain spawn sets no floor');
  const v2 = track(await withEnv({ FAKE_VERSION: '2' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 2 })));
  assert.equal(JSON.parse(fs.readFileSync(floor, 'utf8')), 2);
  assert.ok(await waitDead(v1.pid));

  const spawn = counting();
  const again = await withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 1, spawn }));
  assert.equal(again.pid, v2.pid, 'the old caller uses the running newer agentd');
  assert.equal(spawn.count, 0);

  // The newer agentd went away: the old caller still must not start v1.
  process.kill(v2.pid, 'SIGKILL');
  assert.ok(await waitDead(v2.pid));
  await assert.rejects(withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 1, spawn, timeoutMs: 500 })),
    { message: NEWER_PLUGIN });
  assert.equal(spawn.count, 0);
  assert.equal(fs.existsSync(path.join(home, 'agentd.lock')), false);

  // Once the window has passed the floor is ignored: a downgrade still works.
  const past = new Date(Date.now() - FLOOR_WINDOW_MS - 1000);
  fs.utimesSync(floor, past, past);
  const v1again = track(await withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 1, spawn })));
  assert.equal(spawn.count, 1);
  assert.equal(v1again.version, 1);
});

test('below the min-version floor: throws without spawning; at or above it spawns normally', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'agentd.min-version'), '3');
  const spawn = counting();
  await assert.rejects(ensureAgentd({ home, agentdPath: FAKE, version: 2, spawn, timeoutMs: 500 }), { message: NEWER_PLUGIN });
  assert.equal(spawn.count, 0);
  const a = track(await withEnv({ FAKE_VERSION: '3' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 3, spawn })));
  assert.equal(spawn.count, 1);
  assert.equal(a.version, 3);
});

test('an expired floor is ignored, and a later upgrade rewrites it', async () => {
  const home = tmp();
  const floor = path.join(home, 'agentd.min-version');
  fs.writeFileSync(floor, '3');
  const past = new Date(Date.now() - FLOOR_WINDOW_MS - 1000);
  fs.utimesSync(floor, past, past);
  const spawn = counting();
  const a = track(await withEnv({ FAKE_VERSION: '2' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 2, spawn })));
  assert.equal(spawn.count, 1);
  assert.equal(a.version, 2);
  // v2 → v2.5 upgrade: the expired 3 counts as 0, so the new floor is written.
  track(await withEnv({ FAKE_VERSION: '2.5' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 2.5, spawn })));
  assert.equal(JSON.parse(fs.readFileSync(floor, 'utf8')), 2.5);
});

test('a stale lock does not block the call', async () => {
  // Dead pid in the lock.
  const home = tmp();
  fs.writeFileSync(path.join(home, 'agentd.lock'), '999999');
  assert.equal(alive(999999), false);
  const a = track(await withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home, agentdPath: FAKE, version: 1, timeoutMs: 3000 })));
  assert.ok(alive(a.pid));
  assert.equal(fs.existsSync(path.join(home, 'agentd.lock')), false);

  // Live pid, but older than 10s.
  const home2 = tmp();
  const lock2 = path.join(home2, 'agentd.lock');
  fs.writeFileSync(lock2, String(process.pid));
  const old = (Date.now() - 20_000) / 1000;
  fs.utimesSync(lock2, old, old);
  const b = track(await withEnv({ FAKE_VERSION: '1' }, () => ensureAgentd({ home: home2, agentdPath: FAKE, version: 1, timeoutMs: 3000 })));
  assert.ok(alive(b.pid));
});

test('a fresh empty lock makes the caller wait, not spawn', async () => {
  const home = tmp();
  const lock = path.join(home, 'agentd.lock');
  fs.writeFileSync(lock, '');
  const spawn = counting();
  await assert.rejects(
    ensureAgentd({ home, agentdPath: FAKE, version: 1, spawn, timeoutMs: 500 }),
    { message: `The Codie background service failed to start; see ${path.join(home, 'agentd.log')}` },
  );
  assert.equal(spawn.count, 0);
  assert.ok(fs.existsSync(lock)); // not ours to remove
  fs.unlinkSync(lock);
});

test('an agentd that crashes on import fails fast and logs why', async () => {
  const home = tmp();
  const crash = path.join(tmp(), 'crash.mjs');
  fs.writeFileSync(crash, "throw new Error('boom on import');\n");
  const log = path.join(home, 'agentd.log');
  const started = Date.now();
  await assert.rejects(
    ensureAgentd({ home, agentdPath: crash, version: 1, timeoutMs: 5000 }),
    e => e.message.startsWith(`The Codie background service failed to start; see ${log}`) && e.message.includes('(exit code 1)'),
  );
  assert.ok(Date.now() - started < 2000);
  assert.equal(fs.existsSync(path.join(home, 'agentd.lock')), false);
  assert.match(fs.readFileSync(log, 'utf8'), /boom on import/);
});

test('agentdEnv drops Claude Code session vars and sets CODIE_HOME', () => {
  const env = agentdEnv('/x/home', {
    PATH: '/bin', FAKE_VERSION: '2', CODIE_HOME: '/old',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_PID: '7',
    CLAUDE_CONFIG_DIR: '/c',
  });
  assert.deepEqual(env, { PATH: '/bin', FAKE_VERSION: '2', CODIE_HOME: '/x/home', CLAUDE_CONFIG_DIR: '/c' });
});
