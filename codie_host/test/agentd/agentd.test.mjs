// startAgentd end to end, in process: a fake clt01 device whose agents
// integration (ask_agent) hands tasks over, sessions over the real loopback
// IPC, and no real mDNS.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NOT_AVAILABLE, INTERRUPTED, SESSION_CLOSED, ACCEPTED, ACCEPTED_TIMEOUT, CALL_ONCE } from '../../src/agentd/texts.mjs';
import { startAgentd } from '../../src/agentd/daemon/agentd-core.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { HOSTS } from '../../src/agentd/daemon/agent-app.mjs';
import { resolveVoiceLanguage, sentences } from '../../src/agentd/locales.mjs';
import { AGENTS_CLIENT, ANNOUNCE_MAX } from '../../src/agentd/daemon/agents-host.mjs';
import { AGENTD_VERSION } from '../../src/agentd/daemon/version.mjs';
import { integrationId } from '../../src/agentd/tools/integration-id.mjs';
import { startFakeDevice } from './helpers/fake-device.mjs';

// agentd runs in this process: its voice language is this machine's.
const said = sentences(resolveVoiceLanguage());
const dirs = [];
const tmp = prefix => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 3000) => {
  for (const end = Date.now() + ms; !(await cond()); await sleep(5)) if (Date.now() > end) throw new Error('timed out waiting');
};
const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const noMdns = { close: async () => {}, discover: async () => [] };
const pairing = (deviceId, name, port) => ({ deviceId, name, host: '127.0.0.1', port,
  userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret });

// A started agentd with one paired fake device (DEV1).
async function start(opts = {}) {
  const home = tmp('codie-agentd-');
  const device = await startFakeDevice({ credential });
  new Store(home).upsertPairing(pairing('DEV1', 'Living room', device.port));
  const exits = [];
  const a = await startAgentd({
    home, clt01: {}, log: () => {}, exit: () => exits.push(Date.now()), mdns: noMdns,
    ...opts,
  });
  const call = async (method, p, body, token = a.token) => {
    const r = await fetch(`http://127.0.0.1:${a.ipcPort}${p}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  const register = async (host, channel, sessionPid = process.pid) =>
    (await call('POST', '/sessions', { host, channel, sessionPid })).json.sessionId;
  const tool = async (id, name, args) => (await call('POST', `/sessions/${id}/tools/${name}`, { args })).json;
  const close = async () => { await a.shutdown(); await device.close(); };
  return { a, home, exits, call, register, tool, device, close };
}

// The device's model calls ask_agent; resolves to the data of its answer.
let invocations = 0;
function ask(device, prompt, deviceId = 'DEV1') {
  const invocationId = `inv-${++invocations}`;
  device.invoke(integrationId(deviceId, AGENTS_CLIENT), { invocation_id: invocationId, name: 'ask_agent', arguments: { prompt }, timeout_ms: 20000 });
  return (async () => {
    let found;
    await until(() => (found = device.results.find(r => r.data?.invocation_id === invocationId)));
    return found.data.data;
  })();
}
const spoken = async device => { await until(() => device.spoken.length); return device.spoken.shift(); };

// Runs `fn` with a started agentd whose device is connected; always tears down.
async function withAgentd(opts, fn) {
  const t = await start(opts);
  try {
    await until(() => t.device.connected(integrationId('DEV1', AGENTS_CLIENT)));
    await fn(t);
  } finally {
    await t.close();
  }
}

// A Codex-style session that polled one device task (accepted).
async function pollOne({ a, device, register, tool }, prompt = 'run tests') {
  const id = await register('codex', false);
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  const answer = await ask(device, prompt);
  assert.equal(answer.status, 'accepted');
  await polled;
  return { id, taskId: answer.task_id };
}

test('no sessions: ask_agent is rejected with NOT_AVAILABLE', () => withAgentd({}, async ({ device }) => {
  assert.deepEqual(await ask(device, 'look at the directory'), { status: 'rejected', message: NOT_AVAILABLE });
}));

test('no channel or listener: a background Claude session in the session\'s project takes the task', () => {
  const started = [];
  const claudeBackground = {
    start: async (cwd, text) => { started.push({ cwd, text }); return 'sid'; },
    status: async () => 'busy',
    stop: async () => {},
  };
  return withAgentd({ claudeBackground }, async ({ device, call, tool }) => {
    const id = (await call('POST', '/sessions', { host: 'claude', channel: false, sessionPid: process.pid, cwd: '/proj' })).json.sessionId;
    const answer = await ask(device, 'check memory');
    assert.deepEqual([answer.status, answer.message], ['accepted', `${ACCEPTED} ${CALL_ONCE}`]);
    await until(() => started.length);
    assert.equal(started[0].cwd, '/proj');
    assert.match(started[0].text, new RegExp(`task_id="${answer.task_id}"`));
    await tool(id, 'codie_reply', { task_id: answer.task_id, summary: 'Half is used.' });
    assert.equal(await spoken(device), 'Half is used.');
  });
});

test('a relative cwd is ignored: no background Claude session without a project', () => withAgentd({
  claudeBackground: { start: async () => { throw new Error('must not start'); }, status: async () => null, stop: async () => {} },
}, async ({ device, call }) => {
  await call('POST', '/sessions', { host: 'claude', channel: false, sessionPid: process.pid, cwd: 'proj' });
  assert.equal((await ask(device, 'check memory')).message, NOT_AVAILABLE);
}));

test('Codex-style session: codie_poll takes the task, codie_reply reaches the device', () => withAgentd({}, async ({ a, device, register, tool }) => {
  const id = await register('codex', false);
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  // Accepted at once (queued for the listener): the device's call returns.
  const answer = await ask(device, 'look at the directory');
  assert.equal(answer.status, 'accepted');
  const [task] = JSON.parse((await polled).content[0].text);
  assert.equal(task.taskId, answer.task_id);
  assert.equal(task.text, 'look at the directory');
  assert.match((await tool(id, 'codie_status', {})).content[0].text, /In progress: /, 'an accepted task is still in progress');
  const r = await tool(id, 'codie_reply', { task_id: task.taskId, summary: 'There are three files.' });
  assert.equal(r.isError, undefined);
  assert.equal(await spoken(device), 'There are three files.');
  assert.deepEqual(a.app.tasks.pending(), []);
}));

test('Claude-style channel session: events → delivered → codie_reply', () => withAgentd({}, async ({ a, device, call, register, tool }) => {
  const id = await register('claude', true);
  const events = call('POST', `/sessions/${id}/events`, { waitMs: 5000 });
  await until(() => a.router.get(id).waiter);
  const answered = ask(device, 'run the tests');
  const { status, json } = await events;
  assert.equal(status, 200);
  assert.equal(json.events.length, 1);
  const [event] = json.events;
  assert.deepEqual([event.type, event.text], ['task', 'run the tests']);
  await sleep(50);
  assert.equal(device.results.length, 0, 'not accepted before delivery is confirmed');
  assert.equal((await call('POST', `/sessions/${id}/delivered`, { taskId: event.taskId, ok: true })).status, 200);
  const answer = await answered;
  assert.deepEqual([answer.status, answer.task_id], ['accepted', event.taskId], 'accepted once the session confirms the push');
  const r = await tool(id, 'codie_reply', { task_id: event.taskId, summary: 'All tests pass.' });
  assert.equal(r.isError, undefined);
  assert.equal(await spoken(device), 'All tests pass.');
  assert.equal(device.results.length, 1, 'no second answer to the call');
}));

test('channel session reports undelivered: the task moves to a listening session', () => withAgentd({}, async ({ a, device, call, register, tool }) => {
  const ch = await register('claude', true, 1111);
  const listener = await register('codex', false, 2222);
  const polled = tool(listener, 'codie_poll', { wait_seconds: 5 });
  const events = call('POST', `/sessions/${ch}/events`, { waitMs: 5000 });
  await until(() => a.router.listening() && a.router.get(ch).waiter);
  ask(device, 'look at the logs');
  const taskId = (await events).json.events[0].taskId;
  await call('POST', `/sessions/${ch}/delivered`, { taskId, ok: false });
  const [task] = JSON.parse((await polled).content[0].text);
  assert.equal(task.taskId, taskId);
}));

test('hooks/stop: a question at turn end announces with the matching session\'s host wording', () => withAgentd({}, async ({ device, call, register }) => {
  await register('codex', false, process.pid);
  assert.deepEqual((await call('POST', '/hooks/stop', { pids: [99999, process.pid], last_assistant_message: 'Shall I continue?' })).json, {});
  assert.equal(await spoken(device), said.reminder(HOSTS.codex.host));
  assert.deepEqual((await call('POST', '/hooks/stop', { pids: [1, 2], last_assistant_message: 'OK?' })).json, {});
  assert.equal((await call('POST', '/hooks/bogus', {})).status, 404);
}));

test('hooks/ask reminds when the agent did not speak first; hooks/permission is only remembered', () => withAgentd({}, async ({ device, call, register }) => {
  await register('claude', false, process.pid);
  await call('POST', '/hooks/ask', { pids: [process.pid], tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
  assert.equal(await spoken(device), said.reminder(HOSTS.claude.host));
  await sleep(10);
  assert.deepEqual((await call('POST', '/hooks/permission', { pids: [process.pid], tool_name: 'Bash',
    tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules' } })).json, {});
  assert.deepEqual(device.spoken, [], 'the permission is only remembered');
}));

test('hooks/stop makes its session the most recently active: the next channel push goes there', () => withAgentd({}, async ({ a, device, call, register }) => {
  const first = await register('claude', true, process.pid);
  await sleep(5);
  const second = await register('claude', true, process.ppid);
  await sleep(5);
  await call('POST', '/hooks/stop', { pids: [process.pid], last_assistant_message: 'Done.' });
  ask(device, 'look at the logs').catch(() => {}); // stays unanswered: nobody confirms the push
  await until(() => a.router.pendingDelivery.size);
  assert.equal([...a.router.pendingDelivery.values()][0].sessionId, first);
  assert.notEqual(first, second);
}));

test('POST /sessions/:id/interrupted: the device hears INTERRUPTED for the polled task; idempotent; unknown → ok:false', () =>
  withAgentd({}, async t => {
    const { id, taskId } = await pollOne(t);
    const { call } = t;
    assert.deepEqual((await call('POST', `/sessions/${id}/interrupted`, {})).json, { ok: true, released: 0 }, 'no ids: nothing');
    assert.deepEqual((await call('POST', `/sessions/${id}/interrupted`, { taskIds: ['other', taskId] })).json, { ok: true, released: 1 });
    assert.equal(await spoken(t.device), INTERRUPTED);
    assert.deepEqual((await call('POST', `/sessions/${id}/interrupted`, { taskIds: [taskId] })).json, { ok: true, released: 0 });
    assert.deepEqual((await call('POST', '/sessions/nope/interrupted', { taskIds: [taskId] })).json, { ok: false });
    // The device is free: a new instruction is taken at once.
    const again = await pollOne(t, 'do something else');
    assert.notEqual(again.taskId, taskId);
  }));

test('a session whose MCP server process exited is dropped within the liveness interval', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', r));
  await withAgentd({ livenessMs: 50 }, async ({ a, device, call, tool }) => {
    const id = (await call('POST', '/sessions', { host: 'codex', channel: false, sessionPid: process.pid, mcpPid: child.pid })).json.sessionId;
    const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
    await until(() => a.router.listening());
    assert.equal((await ask(device, 'run tests')).status, 'accepted');
    await polled;
    await exited;
    assert.equal(await spoken(device), SESSION_CLOSED);
    assert.equal(a.router.get(id), undefined);
  });
});

test('POST /sessions: a pid that is not running is not stored (logged), so the session is not reaped', async () => {
  const logs = [];
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(r => child.on('exit', r));
  await withAgentd({ livenessMs: 20, log: (...a) => logs.push(a.join(' ')) }, async ({ a, call }) => {
    const id = (await call('POST', '/sessions', { host: 'codex', channel: false, sessionPid: child.pid, mcpPid: process.pid })).json.sessionId;
    assert.equal(a.router.get(id).sessionPid, null);
    assert.equal(a.router.get(id).mcpPid, process.pid);
    assert.ok(logs.some(l => l.includes(`sessionPid (${child.pid})`)), logs.join('\n'));
    await sleep(100);
    assert.ok(a.router.get(id), 'still registered');
  });
});

test('IPC: wrong token → 401; unknown session → 404; bad host → 400', () => withAgentd({}, async ({ call }) => {
  assert.equal((await call('GET', '/status', undefined, 'nope')).status, 401);
  assert.equal((await call('POST', '/sessions/missing/events', { waitMs: 10 })).status, 404);
  assert.equal((await call('POST', '/sessions', { host: 'vim', channel: false, sessionPid: 1 })).status, 400);
  assert.deepEqual(await call('POST', '/sessions/missing/close', {}), { status: 200, json: { ok: false } });
  const s = (await call('GET', '/status')).json;
  assert.equal(s.version, AGENTD_VERSION);
  assert.equal(s.devicePort, undefined);
  assert.equal(s.sessions, 0);
  assert.equal(s.online, 1);
}));

test('idle: no sessions for idleExitMs → shutdown, exit, agentd.json removed', async () => {
  const t = await start({ idleExitMs: 300, upkeepMs: 50 });
  try {
    const file = path.join(t.home, 'agentd.json');
    assert.ok(fs.existsSync(file));
    await until(() => t.exits.length, 5000);
    assert.equal(t.exits.length, 1);
    assert.equal(fs.existsSync(file), false);
    assert.equal(t.a.store.readStatus().mode, 'stopped');
  } finally {
    await t.close();
  }
  assert.equal(t.exits.length, 1, 'shutdown runs once');
});

// A process that stays alive until the test kills it: stands in for another agentd.
function otherProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return child.pid;
}

// Two agentds on one device kick each other's tool integration off every
// second: one that agentd.json no longer names, while that one lives, has
// been replaced and leaves, without touching the newer one's files.
test('an agentd replaced in agentd.json by another live agentd exits', async t => {
  const logs = [];
  const r = await start({ livenessMs: 20, log: (...a) => logs.push(a.join(' ')) });
  try {
    const other = otherProcess(t);
    const file = path.join(r.home, 'agentd.json');
    const newer = { port: 1, token: 'newer', pid: other, version: AGENTD_VERSION + 1 };
    fs.writeFileSync(file, JSON.stringify(newer));
    const status = path.join(r.home, 'status.json');
    fs.writeFileSync(status, JSON.stringify({ mode: 'active', sessionPid: other }));
    await until(() => r.exits.length, 5000);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), newer);
    assert.deepEqual(JSON.parse(fs.readFileSync(status, 'utf8')), { mode: 'active', sessionPid: other });
    assert.ok(logs.some(l => l.includes(`agentd.json names pid ${other}`)), logs.join('\n'));
  } finally {
    await r.close();
  }
});

test('an agentd.json naming a dead process does not stop agentd', async () => {
  const r = await start({ livenessMs: 20 });
  try {
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise(res => gone.once('exit', res));
    fs.writeFileSync(path.join(r.home, 'agentd.json'), JSON.stringify({ port: 1, token: 'x', pid: gone.pid, version: AGENTD_VERSION }));
    await sleep(300);
    assert.equal(r.exits.length, 0);
  } finally {
    await r.close();
  }
});

test('a session keeps it alive past idleExitMs', async () => {
  const t = await start({ idleExitMs: 300, upkeepMs: 20 });
  try {
    await t.register('codex', false);
    await sleep(700);
    assert.equal(t.exits.length, 0);
  } finally {
    await t.close();
  }
});

test('agentd.json is 0600 with port, token, pid, version', async () => {
  const t = await start();
  try {
    const file = path.join(t.home, 'agentd.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(j, { port: t.a.ipcPort, token: t.a.token, pid: process.pid, version: AGENTD_VERSION });
    assert.equal(t.a.store.readStatus().sessionPid, process.pid);
  } finally {
    await t.close();
  }
});

test('shutdown still exits when a step throws, and refuses new sessions meanwhile', async () => {
  const mdns = { discover: async () => [], close: () => new Promise(() => {}) }; // never finishes: capped
  const t = await start({ mdns });
  t.a.store.writeStatus = () => { throw new Error('disk full'); };
  try {
    const done = t.a.shutdown();
    assert.equal((await t.call('POST', '/sessions', { host: 'codex', channel: false, sessionPid: 1 })).status, 503);
    await done;
    assert.equal(t.exits.length, 1);
  } finally {
    await t.device.close();
  }
});

test('the final answer is spoken on the originating device only', () => withAgentd({}, async t => {
  const d2 = await startFakeDevice({ credential });
  try {
    t.a.store.upsertPairing(pairing('DEV2', 'Bedroom', d2.port));
    t.a.app.onPairingsChanged();
    await until(() => d2.connected(integrationId('DEV2', AGENTS_CLIENT)));
    const { id, taskId } = await pollOne(t);
    await t.tool(id, 'codie_reply', { task_id: taskId, summary: 'Done.' });
    assert.equal(await spoken(t.device), 'Done.');
    await sleep(50);
    assert.deepEqual(d2.spoken, [], 'the other device hears nothing');
  } finally {
    await d2.close();
  }
}));

test('the device is free once accepted: a second instruction is taken while the first is open', () => withAgentd({}, async t => {
  const first = await pollOne(t, 'first thing');
  const second = await pollOne(t, 'second thing');
  assert.notEqual(first.taskId, second.taskId);
  assert.equal(t.a.app.tasks.pending().length, 2);
}));

test('an answer for an offline device is not delivered, and says so', () => withAgentd({}, async t => {
  const { id, taskId } = await pollOne(t);
  await t.device.close();
  await until(() => !t.a.app.link.onlineDevices().length);
  const r = await t.tool(id, 'codie_reply', { task_id: taskId, summary: 'Finished.' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /not delivered/);
}));

test('an accepted task past its max age is announced as timed out and ended', () => withAgentd({ upkeepMs: 30 }, async t => {
  const { taskId } = await pollOne(t);
  t.a.app.tasks.get(taskId).acceptedAt = 0; // long ago
  assert.equal(await spoken(t.device), ACCEPTED_TIMEOUT);
  assert.equal(t.a.app.tasks.get(taskId), undefined);
}));

test('no reminder right after a task answer: it would replace the answer on the device', () => withAgentd({}, async t => {
  const { id, taskId } = await pollOne(t);
  await t.tool(id, 'codie_reply', { task_id: taskId, summary: 'Done.' });
  assert.equal(await spoken(t.device), 'Done.');
  await t.call('POST', '/hooks/stop', { pids: [process.pid], last_assistant_message: 'Anything else?' });
  await t.call('POST', '/hooks/notification', { pids: [process.pid], notification_type: 'idle_prompt' });
  assert.match((await t.tool(id, 'codie_notify', {})).content[0].text, /just announced a task result/);
  await sleep(50);
  assert.deepEqual(t.device.spoken, []);
}));

test('a 300-char codie_reply summary reaches the device clamped to what clt01 accepts', () => withAgentd({}, async t => {
  const { id, taskId } = await pollOne(t);
  const r = await t.tool(id, 'codie_reply', { task_id: taskId, summary: 'é'.repeat(300) });
  assert.equal(r.isError, undefined);
  const text = await spoken(t.device);
  assert.equal([...text].length, ANNOUNCE_MAX);
  assert.ok(text.endsWith('…'));
}));

test('Codex hooks register their thread by session_id, no pid chain; SessionEnd forgets it', () => withAgentd({}, async ({ home, call }) => {
  assert.deepEqual((await call('POST', '/hooks/session-start', { host: 'codex', session_id: 'thread-1', source: 'startup' })).json, {});
  await call('POST', '/hooks/prompt', { host: 'codex', session_id: 'thread-1', turn_id: 'turn-1', prompt: 'hello' });
  await call('POST', '/hooks/stop', { host: 'codex', session_id: 'thread-2', turn_id: 'turn-2', last_assistant_message: 'ok' });
  assert.deepEqual(new Store(home).codexThreads().sort(), ['thread-1', 'thread-2']);
  await call('POST', '/hooks/session-end', { host: 'codex', session_id: 'thread-2', reason: 'other' });
  assert.deepEqual(new Store(home).codexThreads(), ['thread-1']);
}));
