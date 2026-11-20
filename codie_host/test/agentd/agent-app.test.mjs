import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/agentd/store.mjs';
import { TaskTable } from '../../src/agentd/tasks.mjs';
import { Router } from '../../src/agentd/daemon/router.mjs';
import { AgentApp, HOSTS } from '../../src/agentd/daemon/agent-app.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-'));
  dirs.push(dir);
  const store = new Store(dir);
  const tasks = new TaskTable();
  const errors = [];
  const announced = [];
  const link = { onlineDevices: () => [], sendResult: t => !!tasks.finish(t),
    sendError: (t, m) => { if (tasks.finish(t)) errors.push([t, m]); return true; },
    accept: t => !!tasks.accept(t),
    announce: t => { announced.push(t); return 1; } };
  const router = new Router({ link, tasks, pickupMs: 1000, deliveryMs: 1000 });
  const app = new AgentApp({ router, store, tasks, link, notify: () => {}, sessionPid: null,
    discover: async () => [], clt01: {}, systemLocale: 'en-US' });
  const msg = (dev = 'd1') => { const t = tasks.begin(dev, `m-${dev}`); const e = { taskId: t.taskId, deviceId: dev, deviceName: 'Living room', text: 'list files' }; router.onDeviceMessage(e); return e; };
  return { app, router, tasks, errors, announced, msg };
}

test('codie_poll hands out tasks through the router', async () => {
  const { app, router, msg } = mk();
  const s = router.register({ host: 'codex' });
  await app.callTool('codie_poll', { wait_seconds: 0 }, { session: s });
  const e = msg();
  const r = await app.callTool('codie_poll', { wait_seconds: 1 }, { session: s });
  const [got] = JSON.parse(r.content[0].text);
  assert.equal(got.taskId, e.taskId);
});

test('codie_listen_stop says how many queued tasks were handed back', async () => {
  const { app, router, msg, errors } = mk();
  const s = router.register({ host: 'codex' });
  await app.callTool('codie_poll', {}, { session: s });
  const e = msg();
  const r = await app.callTool('codie_listen_stop', {}, { session: s });
  assert.match(r.content[0].text, /1 unclaimed task handed back/);
  assert.equal(errors[0][0], e.taskId);
  const again = await app.callTool('codie_listen_stop', {}, { session: s });
  assert.equal(again.content[0].text, 'Stopped listening.');
});

test('codie_poll / codie_listen_stop without a session return an error result', async () => {
  const { app } = mk();
  for (const name of ['codie_poll', 'codie_listen_stop']) {
    const r = await app.callTool(name, {});
    assert.equal(r.isError, true, name);
  }
});

test('codie_turn_complete reminds with the calling host wording', async () => {
  const { app, router, announced } = mk();
  const s = router.register({ host: 'codex' });
  await app.callTool('codie_turn_complete', { message: 'Shall I keep editing?' }, { session: s });
  assert.deepEqual(announced, ['Codex on the computer needs you to take a look.']);
});

test('codie_status adds listening and session lines; Codex gets its pair hint', async () => {
  const { app, router } = mk();
  const s = router.register({ host: 'codex' });
  const r = await app.callTool('codie_status', {}, { session: s });
  const t = r.content[0].text;
  assert.match(t, /"pair Codie"/);
  assert.match(t, /^Listening: no session is listening$/m);
  assert.match(t, /^Connected sessions: Codex ×1$/m);
});

test('Router.describe groups sessions by host, flagging groups with a channel session', () => {
  const { router } = mk();
  assert.equal(router.describe(), 'none');
  router.register({ host: 'claude', channel: true });
  router.register({ host: 'codex' });
  router.register({ host: 'codex' });
  assert.equal(router.describe(), 'Claude Code ×1 (channel), Codex ×2');
  router.register({ host: 'claude' });
  assert.equal(router.describe(), 'Claude Code ×2 (channel), Codex ×2');
});
