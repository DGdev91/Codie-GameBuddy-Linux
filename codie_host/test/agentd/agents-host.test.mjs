// Voice tasks through tool hosting (spec §6.3): a paired device calls
// ask_agent / cancel_task on the `agents` integration; sessions take the task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CALL_ONCE, ACCEPTED } from '../../src/agentd/texts.mjs';
import { startAgentd } from '../../src/agentd/daemon/agentd-core.mjs';
import { AGENT_TOOLS, AGENTS_CLIENT, askRequest } from '../../src/agentd/daemon/agents-host.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { integrationId } from '../../src/agentd/tools/integration-id.mjs';
import { startFakeDevice } from './helpers/fake-device.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const IID = integrationId('DEV1', AGENTS_CLIENT);
const noMdns = { close: async () => {}, discover: async () => [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await check();
    if (v) return v;
    await sleep(20);
  }
  assert.fail('condition not reached');
}

async function setup(t, { discover = async () => [], codexQueue = null, dispatchOptions = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-agents-'));
  const device = await startFakeDevice({ credential });
  new Store(home).upsertPairing({
    deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port,
    userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
  });
  const a = await startAgentd({ home, clt01: {}, log: () => {}, exit: () => {}, mdns: { ...noMdns, discover }, codexQueue, dispatchOptions });
  const call = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${a.ipcPort}${route}`, {
      method, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const register = async host => (await call('POST', '/sessions', { host, channel: false, sessionPid: process.pid })).json.sessionId;
  const tool = async (id, name, args) => (await call('POST', `/sessions/${id}/tools/${name}`, { args })).json;
  // The device's answer to invocation `id`.
  const resultOf = id => until(() => device.results.find(r => r.data?.invocation_id === id)?.data);
  t.after(async () => {
    await a.shutdown();
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { a, device, call, register, tool, resultOf };
}

test('the agents catalog passes the clt01 rules; ask_agent arguments map to router routing', () => {
  assert.deepEqual(AGENT_TOOLS.map(t => t.name), ['ask_agent', 'cancel_task']);
  assert.deepEqual(askRequest({ prompt: ' check disk ' }), { text: 'check disk' });
  assert.deepEqual(askRequest({ prompt: 'go on', mode: 'continue' }), { text: 'go on', routing: { mode: 'continue' } });
  assert.deepEqual(askRequest({ prompt: 'x', mode: 'session', target: 'web' }), { text: 'x', routing: { mode: 'session', target: 'web' } });
  assert.match(askRequest({ prompt: 'x', mode: 'session' }).error, /session or project/);
  assert.match(askRequest({ prompt: 'x', target: 'web' }).error, /Only session routing/);
  assert.match(askRequest({ prompt: '  ' }).error, /empty/);
});

test('ask_agent: a listening session takes the task, codie_reply is spoken on the device', async t => {
  const { a, device, register, tool, resultOf } = await setup(t);
  await until(() => device.connected(IID));
  assert.deepEqual(device.integrations.get(IID).tools.map(x => x.name), ['ask_agent', 'cancel_task']);

  const id = await register('codex');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-1', name: 'ask_agent', arguments: { prompt: 'look at the directory' }, timeout_ms: 20000 });

  const answer = await resultOf('inv-1');
  assert.equal(answer.status, 'succeeded');
  assert.equal(answer.data.status, 'accepted');
  assert.equal(answer.data.message, `${ACCEPTED} ${CALL_ONCE}`);
  const [task] = JSON.parse((await polled).content[0].text);
  assert.equal(task.taskId, answer.data.task_id);
  assert.equal(task.text, 'look at the directory');

  const r = await tool(id, 'codie_reply', { task_id: task.taskId, summary: 'There are three files.' });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(await until(() => device.agentResults.length && device.agentResults), ['There are three files.']);
  assert.deepEqual(a.app.tasks.pending(), []);
});

test('ask_agent is declared async; the answer goes to agent/results, not tts/utterances', async t => {
  const { a, device, register, tool, resultOf } = await setup(t);
  await until(() => device.connected(IID));
  const ask = device.integrations.get(IID).tools.find(x => x.name === 'ask_agent');
  assert.deepEqual([ask.completion, ask.version], ['async', 'v7']);

  const id = await register('codex');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.setActiveState('Talking');
  device.invoke(IID, { invocation_id: 'inv-r', name: 'ask_agent', arguments: { prompt: 'disk space' }, timeout_ms: 20000 });
  assert.equal((await resultOf('inv-r')).data.status, 'accepted');
  const [task] = JSON.parse((await polled).content[0].text);
  await tool(id, 'codie_reply', { task_id: task.taskId, summary: 'Plenty left.' });

  assert.deepEqual(await until(() => device.agentResults.length && device.agentResults), ['Plenty left.'],
    'handed over at once: the device waits for idle itself');
  assert.deepEqual(device.utterances, []);
});

test('a reminder is no task result: it stays out of agent/results (and so out of the chat)', async t => {
  const { device, register, tool } = await setup(t);
  await until(() => device.connected(IID));
  const id = await register('codex');
  const r = await tool(id, 'codie_notify', {});
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal((await until(() => device.utterances.length && device.utterances)).length, 1);
  assert.deepEqual(device.agentResults, []);
});

test('codie_notify with a message is read verbatim through agent/results', async t => {
  const { device, register, tool } = await setup(t);
  await until(() => device.connected(IID));
  const id = await register('codex');
  const r = await tool(id, 'codie_notify', { message: 'A fixes the root cause, B is a workaround. I recommend A.' });
  assert.match(r.content[0].text, /read your message/, JSON.stringify(r));
  assert.deepEqual(await until(() => device.agentResults.length && device.agentResults), ['A fixes the root cause, B is a workaround. I recommend A.']);
  assert.deepEqual(device.utterances, []);
});

test('ask_agent with nobody to take it is rejected at once, with the reason', async t => {
  const { device, resultOf } = await setup(t);
  await until(() => device.connected(IID));
  device.invoke(IID, { invocation_id: 'inv-2', name: 'ask_agent', arguments: { prompt: 'hello' }, timeout_ms: 20000 });
  const answer = await resultOf('inv-2');
  assert.equal(answer.data.status, 'rejected');
  assert.ok(answer.data.message);
});

test('ask_agent with bad routing is rejected without a task', async t => {
  const { a, device, register, tool, resultOf } = await setup(t);
  await until(() => device.connected(IID));
  const id = await register('codex');
  tool(id, 'codie_poll', { wait_seconds: 2 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-3', name: 'ask_agent', arguments: { prompt: 'x', mode: 'session' }, timeout_ms: 20000 });
  assert.match((await resultOf('inv-3')).data.message, /session or project/);
  assert.deepEqual(a.app.tasks.pending(), []);
});

test('cancel_task ends the latest task and tells the session; an unknown one is not_found', async t => {
  const cancellations = [];
  const { a, device, call, register, tool, resultOf } = await setup(t, { codexQueue: {
    pickThread: async () => null, cancel: async (...args) => { cancellations.push(args); return 'interrupted'; },
    taskState: async () => ({ status: 'interrupted' }),
  } });
  await until(() => device.connected(IID));
  const id = await register('codex');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-4', name: 'ask_agent', arguments: { prompt: 'long job' }, timeout_ms: 20000 });
  const taskId = (await resultOf('inv-4')).data.task_id;
  await polled;
  await call('POST', '/hooks/poll-result', { host: 'codex', session_id: 'my-thread', turn_id: 'my-turn',
    tool_name: 'mcp__codie__codie_poll', tool_response: { content: [{ type: 'text', text: JSON.stringify([{ taskId }]) }] } });

  device.invoke(IID, { invocation_id: 'inv-5', name: 'cancel_task', arguments: {}, timeout_ms: 5000 });
  assert.deepEqual((await resultOf('inv-5')).data, { status: 'canceled', task_id: taskId });
  assert.deepEqual(cancellations, [['my-thread', taskId, 'my-turn']]);
  assert.deepEqual(a.app.tasks.pending(), []);
  device.invoke(IID, { invocation_id: 'inv-6', name: 'cancel_task', arguments: { task_id: taskId }, timeout_ms: 5000 });
  assert.deepEqual((await resultOf('inv-6')).data, { status: 'not_found' });
});

test('cancel_task fails, keeping the task, when the Codex turn is not seen to stop', async t => {
  const { a, device, call, register, tool, resultOf } = await setup(t, { codexQueue: {
    pickThread: async () => null, cancel: async () => 'interrupted', taskState: async () => ({ status: 'inProgress' }),
  }, dispatchOptions: { cancelWaitMs: 100, cancelPollMs: 10 } });
  await until(() => device.connected(IID));
  const id = await register('codex');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-7', name: 'ask_agent', arguments: { prompt: 'long job' }, timeout_ms: 20000 });
  const taskId = (await resultOf('inv-7')).data.task_id;
  await polled;
  await call('POST', '/hooks/poll-result', { host: 'codex', session_id: 'my-thread', turn_id: 'my-turn',
    tool_name: 'mcp__codie__codie_poll', tool_response: { content: [{ type: 'text', text: JSON.stringify([{ taskId }]) }] } });

  device.invoke(IID, { invocation_id: 'inv-8', name: 'cancel_task', arguments: {}, timeout_ms: 5000 });
  const r = await resultOf('inv-8');
  assert.equal(r.status, 'failed');
  assert.match(r.message, /Could not confirm/);
  assert.equal(a.app.tasks.get(taskId)?.cancelRequested, false, 'still running, and its answer will be spoken');
});

test('a second ask_agent in the same voice turn returns the first task instead of a new one', async t => {
  const { a, device, register, tool, resultOf } = await setup(t);
  await until(() => device.connected(IID));
  const id = await register('codex');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-a', name: 'ask_agent', arguments: { prompt: 'check disk' }, turn_id: 'turn-1', timeout_ms: 20000 });
  const first = (await resultOf('inv-a')).data;
  await polled;
  device.invoke(IID, { invocation_id: 'inv-b', name: 'ask_agent', arguments: { prompt: 'Check the free disk space' }, turn_id: 'turn-1', timeout_ms: 20000 });
  assert.deepEqual((await resultOf('inv-b')).data, first);
  assert.equal(a.app.tasks.pending().length, 1);
});

test('a reminder waits until the device is idle before it is spoken', async t => {
  const { a, device } = await setup(t);
  await until(() => device.connected(IID));
  device.setActiveState('Speaking');
  assert.equal(a.app.link.announce('Take a look.'), 1);
  await sleep(1500);
  assert.deepEqual(device.utterances, [], 'nothing spoken while the device talks');
  device.setActiveState('Idle');
  assert.deepEqual(await until(() => device.utterances.length && device.utterances), ['Take a look.']);
});

test('a device that moved to another port gets the agents link back after a host refresh', async t => {
  let found = [];
  const { a, device } = await setup(t, { discover: async () => found });
  await until(() => device.connected(IID));
  await device.close();
  const moved = await startFakeDevice({ credential });
  t.after(() => moved.close());
  found = [{ deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: moved.port }];
  await until(() => moved.connected(IID), 8000);
  assert.equal(a.store.listPairings().find(r => r.deviceId === 'DEV1').port, moved.port);
});

test('a task accepted before the device moved is answered on the new link', async t => {
  let found = [];
  const { a, device, register, tool, resultOf } = await setup(t, { discover: async () => found });
  await until(() => device.connected(IID));
  const id = await register('codex');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-m', name: 'ask_agent', arguments: { prompt: 'run the tests' }, timeout_ms: 20000 });
  assert.equal((await resultOf('inv-m')).data.status, 'accepted');
  const [task] = JSON.parse((await polled).content[0].text);

  await device.close();
  const moved = await startFakeDevice({ credential });
  t.after(() => moved.close());
  found = [{ deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: moved.port }];
  await until(() => moved.connected(IID), 8000);
  await until(() => a.app.link.onlineDevices().length);

  const r = await tool(id, 'codie_reply', { task_id: task.taskId, summary: 'All green.' });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(await until(() => moved.agentResults.length && moved.agentResults), ['All green.']);
});

test('a reminder still waiting for the device to go idle is dropped once it is stale', async t => {
  const { a, device } = await setup(t);
  await until(() => device.connected(IID));
  device.setActiveState('Talking');
  let stale = false;
  let dropped = 0;
  assert.equal(a.app.link.announce('Claude Code needs your approval: Run tests', { stale: () => stale, onDropped: () => dropped++ }), 1);
  await sleep(200);
  stale = true; // the user approved on the computer meanwhile
  device.setActiveState('Idle');
  await until(() => dropped === 1);
  a.app.link.announce('Claude Code on the computer needs you to take a look.');
  assert.deepEqual(await until(() => device.utterances.length && device.utterances), ['Claude Code on the computer needs you to take a look.'],
    'only the reminder that was still current is spoken');
});

test('credentials in a task answer are hidden before the device hears or records them', async t => {
  const { a, device, register, tool, resultOf } = await setup(t);
  await until(() => device.connected(IID));
  const id = await register('codex');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-s', name: 'ask_agent', arguments: { prompt: 'which key?' }, timeout_ms: 20000 });
  assert.equal((await resultOf('inv-s')).data.status, 'accepted');
  const [task] = JSON.parse((await polled).content[0].text);
  await tool(id, 'codie_reply', { task_id: task.taskId, summary: 'It uses OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234.' });
  assert.deepEqual(await until(() => device.agentResults.length && device.agentResults), ['It uses OPENAI_API_KEY=….']);
});

test('a device cancel reaches the session holding the task as a cancel, with no done after it', async t => {
  const { a, device, register, tool, resultOf } = await setup(t);
  await until(() => device.connected(IID));
  const id = await register('claude');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-h1', name: 'ask_agent', arguments: { prompt: 'long job' }, timeout_ms: 20000 });
  const taskId = (await resultOf('inv-h1')).data.task_id;
  await polled;
  assert.deepEqual(a.router.held(id), [taskId]);

  device.invoke(IID, { invocation_id: 'inv-h2', name: 'cancel_task', arguments: {}, timeout_ms: 5000 });
  assert.deepEqual((await resultOf('inv-h2')).data, { status: 'canceled', task_id: taskId });
  const events = [...await a.router.nextEvents(id, 200), ...await a.router.nextEvents(id, 200)];
  assert.deepEqual(events.map(e => [e.type, e.taskId]), [['cancel', taskId]]);
  assert.deepEqual(a.router.held(id), []);
});

test('a task answered by codie_reply sends its holder a done', async t => {
  const { a, device, register, tool, resultOf } = await setup(t);
  await until(() => device.connected(IID));
  const id = await register('claude');
  const polled = tool(id, 'codie_poll', { wait_seconds: 5 });
  await until(() => a.router.listening());
  device.invoke(IID, { invocation_id: 'inv-h3', name: 'ask_agent', arguments: { prompt: 'quick job' }, timeout_ms: 20000 });
  const taskId = (await resultOf('inv-h3')).data.task_id;
  await polled;
  await tool(id, 'codie_reply', { task_id: taskId, summary: 'Done.' });
  assert.deepEqual(await a.router.nextEvents(id, 200), [{ type: 'done', taskId }]);
});
