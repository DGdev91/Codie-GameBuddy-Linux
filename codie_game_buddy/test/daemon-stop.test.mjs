import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stopDaemon } from '../src/main/daemon-stop.mjs';

const tmpHome = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-buddy-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A stand-in agentd: answers /shutdown and removes agentd.json after `exitMs`.
async function fakeAgentd(t, home, { exitMs = 50 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.end('{}');
    setTimeout(() => fs.rmSync(path.join(home, 'agentd.json'), { force: true }), exitMs);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  fs.writeFileSync(path.join(home, 'agentd.json'), JSON.stringify({ port: server.address().port, token: 'tk', pid: 1, version: 36 }));
  return seen;
}

test('nothing to stop when no codie-agentd runs', async t => {
  assert.equal(await stopDaemon({ home: tmpHome(t) }), false);
});

test('asks codie-agentd to shut down with its token and waits until it is gone', async t => {
  const home = tmpHome(t);
  const seen = await fakeAgentd(t, home);
  assert.equal(await stopDaemon({ home }), true);
  assert.deepEqual(seen, ['POST /shutdown Bearer tk']);
  assert.equal(fs.existsSync(path.join(home, 'agentd.json')), false);
});

test('one that does not exit in time is reported', async t => {
  const home = tmpHome(t);
  await fakeAgentd(t, home, { exitMs: 10_000 });
  await assert.rejects(stopDaemon({ home, timeoutMs: 200 }), /still running/);
});
