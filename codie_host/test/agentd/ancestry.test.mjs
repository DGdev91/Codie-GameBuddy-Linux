import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ancestorPids, hookPids, belongsToSession, pidAlive, isLiveStatus } from '../../src/agentd/ancestry.mjs';

test('ancestorPids starts at own parent and includes pid 1 or stops early', { skip: process.platform === 'win32' && 'no ps on Windows' }, () => {
  const chain = ancestorPids();
  assert.equal(chain[0], process.ppid);
  assert.ok(chain.length >= 1);
});

test('ancestorPids on Windows walks nothing', { skip: process.platform !== 'win32' }, () => {
  assert.deepEqual(ancestorPids(), []);
});

test('hookPids: the ancestor chain plus CLAUDE_PID, once', () => {
  assert.deepEqual(hookPids({ env: { CLAUDE_PID: '20' }, chain: [10, 20, 1] }), [10, 20, 1]);
  assert.deepEqual(hookPids({ env: { CLAUDE_PID: '20' }, chain: [] }), [20], 'Windows: no chain, CLAUDE_PID alone');
  assert.deepEqual(hookPids({ env: {}, chain: [10] }), [10]);
  assert.deepEqual(hookPids({ env: { CLAUDE_PID: 'x' }, chain: [] }), []);
});

test('belongsToSession', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(belongsToSession([10, 20, 1], 20, { platform }), true, platform);
    assert.equal(belongsToSession([10, 30, 1], 20, { platform }), false, platform);
  }
  assert.equal(belongsToSession(null, 20, { platform: 'linux' }), false);
  assert.equal(belongsToSession([], 20, { platform: 'linux' }), false);
  assert.equal(belongsToSession(undefined, 20, { platform: 'win32' }), true, 'Windows, no pid known → accept');
  assert.equal(belongsToSession([], 20, { platform: 'win32' }), true, 'Windows, no pid known → accept');
});

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('pidAlive: self alive, exited child dead, bad input dead', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
  assert.equal(pidAlive(undefined), false);
  assert.equal(pidAlive(0), false);
});

test('pidAlive: EPERM means alive', () => {
  const kill = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
  assert.equal(pidAlive(123, { kill }), true);
});

test('isLiveStatus needs active mode and a live sessionPid', () => {
  assert.equal(isLiveStatus({ mode: 'active', sessionPid: process.pid }), true);
  assert.equal(isLiveStatus({ mode: 'active', sessionPid: deadPid() }), false);
  assert.equal(isLiveStatus({ mode: 'active' }), false);
  assert.equal(isLiveStatus({ mode: 'stopped', sessionPid: process.pid }), false);
  assert.equal(isLiveStatus(null), false);
});

test('pidCwd reads the cwd from lsof on macOS, /proc on Linux, nothing on Windows', async () => {
  const { pidCwd } = await import('../../src/agentd/ancestry.mjs');
  const run = async args => { assert.deepEqual(args.slice(0, 3), ['-a', '-p', '42']); return 'p42\nfcwd\nn/Users/me/proj\n'; };
  assert.equal(await pidCwd(42, { platform: 'darwin', run }), '/Users/me/proj');
  assert.equal(await pidCwd(42, { platform: 'linux', readlink: async p => (p === '/proc/42/cwd' ? '/home/me/proj' : null) }), '/home/me/proj');
  assert.equal(await pidCwd(42, { platform: 'win32' }), null);
  assert.equal(await pidCwd(null, { platform: 'darwin', run }), null);
  assert.equal(await pidCwd(42, { platform: 'darwin', run: async () => { throw new Error('gone'); } }), null);
});
