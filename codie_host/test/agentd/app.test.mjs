import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/agentd/store.mjs';
import { TaskTable } from '../../src/agentd/tasks.mjs';
import { REMIND_DEDUP_MS, TURN_END_DEDUP_MS, PERMISSION_TTL_MS, PERMISSION_DELAY_MS } from '../../src/agentd/reminders.mjs';
import { channelNotification, INSTRUCTIONS } from '../../src/agentd/session-tools.mjs';
import { INTERRUPTED } from '../../src/agentd/texts.mjs';
import { App, unquote } from '../../src/agentd/app.mjs';
import { sentences } from '../../src/agentd/locales.mjs';

const REMINDER = sentences('en').reminder('Claude Code');
const appendRecord = (file, record) => fs.appendFileSync(file, `${JSON.stringify(record)}\n`);

test('native Codex stop answers only its bound turn, independent of Windows PID matching', () => {
  const { app, tasks, sent } = mkApp();
  const a = tasks.begin('a', 'm'); const b = tasks.begin('b', 'm');
  Object.assign(a, { threadId: 'thread-a', turnId: 'turn-a' });
  Object.assign(b, { threadId: 'thread-b', turnId: 'turn-a' });
  const ctx = { host: 'Codex', session: { host: 'codex', threadId: 'thread-a' } };
  app.onStopHook({ turn_id: 'other', last_assistant_message: 'Other answer' }, ctx);
  assert.deepEqual(sent, []);
  app.onStopHook({ turn_id: 'turn-a', last_assistant_message: 'Done with A.' }, ctx);
  assert.deepEqual(sent, [[a.taskId, 'Done with A.']]);
  assert.ok(tasks.get(b.taskId));
});

test('Codex permission hook speaks without a Notification event, after the same delay and only if still unanswered', () => {
  const { app, announced, opts } = mkApp();
  const rollout = transcriptEndingWith('Building.');
  app.onPermissionHook({ tool_name: 'Bash', tool_input: { description: 'Build the app' }, transcript_path: rollout }, { host: 'Codex', session: { host: 'codex' } });
  assert.equal(announced.length, 1);
  assert.match(announced[0], /Codex.*Build the app/);
  assert.equal(opts[0].delayMs, PERMISSION_DELAY_MS);
  assert.equal(opts[0].stale(), false);
  appendRecord(rollout, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1' } });
  assert.equal(opts[0].stale(), true, 'approved meanwhile: the queued reminder is dropped');
});

test('a reminder dropped as stale no longer blocks the next one through the dedup window', () => {
  let now = 1_000_000;
  const { app, announced, opts } = mkApp({ now: () => now });
  const tp = transcriptEndingWith('Working.');
  app.onPermissionHook({ tool_name: 'Bash', tool_input: { description: 'Run tests' } }, {});
  app.onNotificationHook({ notification_type: 'permission_prompt', transcript_path: tp }, {});
  assert.equal(announced.length, 1);
  appendRecord(tp, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
  assert.equal(opts[0].stale(), true);
  opts[0].onDropped();
  now += 5_000;
  app.onNotificationHook({ notification_type: 'permission_prompt', transcript_path: tp }, {});
  assert.equal(announced.length, 2, 'the dropped one was never heard: this one is spoken');
});

test('a turn-end reminder is dropped when the user typed again before it was spoken', () => {
  const { app, opts } = mkApp();
  const tp = transcriptEndingWith('Shall I commit?');
  app.onStopHook({ transcript_path: tp, last_assistant_message: 'Shall I commit?' }, {});
  assert.equal(opts[0].stale(), false);
  appendRecord(tp, { type: 'user', message: { content: 'yes' } });
  assert.equal(opts[0].stale(), true);
});

test('StopFailure answers the device task its turn was working on, at once and with the reason', () => {
  const { app, tasks, sent } = mkApp();
  const task = tasks.begin('d1', 'run tests');
  const tp = transcript(L.channel(task.taskId) + L.assistant('On it.'));
  app.onStopFailureHook({ transcript_path: tp, error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' }, { host: 'Claude Code' });
  assert.deepEqual(sent, [[task.taskId, 'Claude Code on the computer stopped: it reached its usage limit. Please try again later.']]);
});

test('StopFailure of a turn the user typed answers no device task and says nothing', () => {
  const { app, tasks, sent, announced } = mkApp();
  tasks.begin('d1', 'run tests');
  app.onStopFailureHook({ transcript_path: transcript(L.typed('hello')), error: 'overloaded' }, {});
  assert.deepEqual([sent, announced], [[], []]);
});

test('Codex question fallback reads both synchronous and asynchronous option shapes', () => {
  for (const input of [{ question: 'Choose a mode?', options: [{ label: 'Fast (Recommended)' }, { label: 'Full' }] },
    { title: 'Choose a mode?', options: ['Fast (Recommended)', 'Full'] }]) {
    const { app, verbatim } = mkApp();
    app.onAskHook({ tool_input: { questions: [input] } }, { host: 'Codex', session: { host: 'codex' } });
    assert.match(verbatim[0], /Choose a mode\?.*1\. Fast \(Recommended\).*2\. Full/);
  }
});
const storeDirs = [];
// A transcript whose last assistant message is `text` (Notification hook payloads carry its path).
function transcriptEndingWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-tr-'));
  storeDirs.push(dir);
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  return file;
}
after(() => { for (const d of storeDirs) fs.rmSync(d, { recursive: true, force: true }); });
function mkApp(over = {}) {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-'));
  storeDirs.push(storeDir);
  const store = new Store(storeDir);
  const tasks = new TaskTable();
  const sent = [];
  const announced = [];
  const verbatim = []; // announce calls with { verbatim: true }
  const opts = []; // every announce call's options
  const link = { onlineDevices: () => [], sendResult: (t, s) => { const ok = !!tasks.finish(t); if (ok) sent.push([t, s]); return ok; },
    announce: (t, o) => { (o?.verbatim ? verbatim : announced).push(t); opts.push(o); return 1; } };
  const app = new App({ store, tasks, link,
    discover: async () => [{ deviceId: 'd1', name: 'Living room', host: '10.0.0.2', port: 8081 }],
    systemLocale: 'en-US',
    ...over,
    clt01: {
      pairRequest: async () => ({ challengeId: 'c1' }),
      pairConfirm: async () => ({ deviceId: 'd1', name: 'Living room', localSecret: 'L' }),
      pairCancel: async () => {},
      deviceAuth: async (h, p, secret) => ({ secret, userId: 'u1' }),
      issueClientCredential: async () => ({ id: 'cred-1', secret: 'client-secret' }),
      ...over.clt01,
    } });
  return { app, store, tasks, sent, announced, verbatim, opts };
}

test('channelNotification carries the task text and meta', () => {
  const n = channelNotification({ taskId: 't1', deviceId: 'd1', deviceName: 'Living room', text: 'run tests' });
  assert.equal(n.method, 'notifications/claude/channel');
  assert.equal(n.params.content, 'run tests');
  assert.deepEqual(n.params.meta, { device: 'Living room', device_id: 'd1', task_id: 't1' });
});

test('codie_reply sends result; unknown task reports error', async () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  const ok = await app.callTool('codie_reply', { task_id: 't1', summary: 'All tests passed' });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(sent, [['t1', 'All tests passed']]);
  const bad = await app.callTool('codie_reply', { task_id: 't1', summary: 'x' });
  assert.equal(bad.isError, true);
});

test('list devices marks paired/online', async () => {
  const { app, store } = mkApp();
  store.upsertPairing({ deviceId: 'd1', name: 'Living room' });
  const r = await app.callTool('codie_list_devices', {});
  assert.match(r.content[0].text, /1\. Living room\s+10\.0\.0\.2\s+paired · offline/);
});

test('pair begin + confirm persists record', async () => {
  const { app, store } = mkApp();
  await app.callTool('codie_list_devices', {});
  const b = await app.callTool('codie_pair_begin', { device_id: 'd1' });
  assert.match(b.content[0].text, /6-digit/);
  const r = await app.callTool('codie_pair_confirm', { device_id: 'd1', code: '123456' });
  assert.equal(r.content[0].text, 'Paired "Living room".');
  assert.deepEqual(store.listPairings(), [{ deviceId: 'd1', name: 'Living room', host: '10.0.0.2', port: 8081,
    userId: 'u1', credentialId: 'cred-1', credentialSecret: 'client-secret' }]);
});

test('pair confirm keys the record by the scanned deviceId even when clt01 returns empty deviceId', async () => {
  const { app, store } = mkApp({ clt01: {
    pairRequest: async () => ({ challengeId: 'c1' }),
    pairConfirm: async () => ({ deviceId: '', name: '', localSecret: 'L' }),
    pairCancel: async () => {},
  } });
  await app.callTool('codie_list_devices', {});
  await app.callTool('codie_pair_begin', { device_id: 'd1' });
  const r = await app.callTool('codie_pair_confirm', { device_id: 'd1', code: '123456' });
  assert.equal(r.isError, undefined);
  const [rec] = store.listPairings();
  assert.equal(rec.deviceId, 'd1');
  assert.equal(rec.name, 'Living room');
});

test('pair tool errors include clt01 err.code when present', async () => {
  const codeErr = (msg, code) => Object.assign(new Error(msg), { code });
  const { app, store } = mkApp({ clt01: {
    pairRequest: async () => ({ challengeId: 'c1' }),
    pairConfirm: async () => { throw codeErr('wrong code', 'PAIR_CODE_INVALID'); },
    pairCancel: async () => {},
  } });
  await app.callTool('codie_list_devices', {});
  await app.callTool('codie_pair_begin', { device_id: 'd1' });
  const r = await app.callTool('codie_pair_confirm', { device_id: 'd1', code: '000000' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'Failed: wrong code (PAIR_CODE_INVALID)');
  assert.deepEqual(store.listPairings(), []);

  const { app: app2 } = mkApp({ clt01: {
    pairRequest: async () => { throw codeErr('too many attempts', 'PAIR_LOCKED'); },
    pairConfirm: async () => ({}),
    pairCancel: async () => {},
  } });
  await app2.callTool('codie_list_devices', {});
  const b = await app2.callTool('codie_pair_begin', { device_id: 'd1' });
  assert.equal(b.content[0].text, 'Failed: too many attempts (PAIR_LOCKED)');

  // No code → plain message.
  const { app: app3 } = mkApp({ clt01: {
    pairRequest: async () => { throw new Error('HTTP 500'); },
    pairConfirm: async () => ({}),
    pairCancel: async () => {},
  } });
  await app3.callTool('codie_list_devices', {});
  const c = await app3.callTool('codie_pair_begin', { device_id: 'd1' });
  assert.equal(c.content[0].text, 'Failed: HTTP 500');
});

const trDirs = [];
after(() => { for (const d of trDirs) fs.rmSync(d, { recursive: true, force: true }); });
function transcript(content) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-tr-'));
  trDirs.push(d);
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, content);
  return f;
}
// Transcript lines shaped like Claude Code's (2.1.30x).
const L = {
  channel: id => JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'channel', server: 'plugin:codie:codie' },
    message: { role: 'user', content: `<channel source="plugin:codie:codie" device="Living room" task_id="${id}">\nrun tests\n</channel>` } }) + '\n',
  typed: text => JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } }) + '\n',
  toolResult: text => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: text }] } }) + '\n',
  skillMeta: text => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
  assistant: text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n',
  interrupt: (text = '[Request interrupted by user]') => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
  junk: n => JSON.stringify({ type: 'attachment', attachment: { type: 'mcp_instructions_delta', data: 'x'.repeat(n) } }) + '\n',
  codex: (type, extra = {}) => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type, ...extra } }) + '\n',
  // Background work, shaped like the real 2.1.304 lines: a run_in_background
  // Bash launch, a background Agent launch, the completion notice as queued,
  // as the user line opening a follow-up turn, or absorbed mid-turn.
  bgBash: (tu, bg = 'bgtzwuejk') => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ tool_use_id: tu, type: 'tool_result',
    content: `Command running in background with ID: ${bg}. Output is being written to: /tmp/x/tasks/${bg}.output.`, is_error: false }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: bg } }) + '\n',
  bgAgent: tu => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: tu, type: 'tool_result',
    content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a42744bcdb3a4acae' }] }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a42744bcdb3a4acae' } }) + '\n',
  notice: (tu, status = 'completed') => `<task-notification>\n<task-id>bgtzwuejk</task-id>\n<tool-use-id>${tu}</tool-use-id>\n`
    + `<output-file>/tmp/x/tasks/bgtzwuejk.output</output-file>\n<status>${status}</status>\n<summary>Background command "Wait" ${status}</summary>\n</task-notification>`,
  queued: tu => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: L.notice(tu) }) + '\n',
  noticeTurn: (tu, status) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: L.notice(tu, status) },
    origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification' }) + '\n',
  absorbed: (tu, status) => JSON.stringify({ isSidechain: false, attachment: { type: 'queued_command', prompt: L.notice(tu, status),
    commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } }, type: 'attachment' }) + '\n',
  // A plugin monitor's output line opening a turn (2.1.306), as the Codie inbox prints a task.
  inbox: id => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: '<task-notification>\n<task-id>b382eeu89</task-id>\n'
    + '<summary>Monitor event: "Tasks sent to this computer from Codie voice devices"</summary>\n'
    + `<event>[Codie voice task task_id="${id}" device="Living room"] run tests</event>\n`
    + 'If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn\'t need one.\n</task-notification>' },
    origin: { kind: 'task-notification', producer: 'session-task' }, turnOrigin: 'task_notification' }) + '\n',
  requestDump: text => JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
};

test('stop hook: a turn started by a channel task → spoken summary', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  app.onStopHook({ pids: [7, 42], transcript_path: transcript(L.channel('t1') + L.assistant('OK') + L.toolResult('ok')),
    last_assistant_message: '## Done\nchanged `a.js`' });
  assert.deepEqual(sent, [['t1', 'Done changed a.js']]);
});

test('stop hook: no pending task → nothing', () => {
  const { app, sent } = mkApp();
  app.onStopHook({ pids: [42], transcript_path: transcript(L.channel('t1')), last_assistant_message: 'x' });
  assert.deepEqual(sent, []);
});

test('stop hook: a turn started by a typed prompt → nothing, even when it mentions the task', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  // The task's own turn ran earlier; this turn the user typed something.
  app.onStopHook({ pids: [42], transcript_path: transcript(L.channel('t1') + L.assistant('working') + L.typed('also look at t1') + L.toolResult('t1')),
    last_assistant_message: 'x' });
  assert.deepEqual(sent, []);
  assert.ok(tasks.get('t1'));
});

test('stop hook: answers the pending task whose push started the turn', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('tA', { taskId: 'tA', deviceId: 'd1', startedAt: 0 });
  tasks.tasks.set('tB', { taskId: 'tB', deviceId: 'd2', startedAt: 1 });
  app.onStopHook({ pids: [42], transcript_path: transcript(L.channel('tA') + L.assistant('a') + L.channel('tB') + L.assistant('b')), last_assistant_message: 'ok' });
  assert.deepEqual(sent, [['tB', 'ok']]);
  assert.ok(tasks.get('tA'));
});

test('stop hook: the task is found past >256KB of attachment lines after it', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  const tp = transcript(L.channel('t1') + L.junk(700 * 1024) + L.skillMeta('Base directory for this skill: x')
    + L.toolResult('y'.repeat(300 * 1024)) + L.junk(400 * 1024) + L.assistant('done'));
  app.onStopHook({ pids: [42], transcript_path: tp, last_assistant_message: 'Finished' });
  assert.deepEqual(sent, [['t1', 'Finished']]);
});

test('stop hook: a turn start beyond the scan limit answers nothing', async () => {
  const { currentTurnTask } = await import('../../src/agentd/transcript.mjs');
  const tp = transcript(L.channel('t1') + L.junk(64 * 1024) + L.assistant('done'));
  assert.equal(currentTurnTask(tp, ['t1']), 't1');
  assert.equal(currentTurnTask(tp, ['t1'], 32 * 1024), null);
});

test('background work: launched and not ended → the turn defers the task', async () => {
  const { currentTurnTask } = await import('../../src/agentd/transcript.mjs');
  // 843c1e87: launch, interim text, Stop. The notice may already be queued.
  const head = L.channel('t1') + L.bgBash('tu1') + L.assistant('60s timer running in background.');
  assert.equal(currentTurnTask(transcript(head), ['t1']), null);
  assert.equal(currentTurnTask(transcript(head + L.queued('tu1')), ['t1']), null);
  assert.equal(currentTurnTask(transcript(L.channel('t1') + L.bgAgent('tu2') + L.assistant('agent on it')), ['t1']), null);
  // Another launch's notice (or a request dump repeating this one's) ends nothing.
  assert.equal(currentTurnTask(transcript(head + L.noticeTurn('tuX') + L.assistant('x')), ['t1']), null);
  assert.equal(currentTurnTask(transcript(head + L.requestDump(L.notice('tu1')) + L.assistant('x')), ['t1']), null);
});

test('background work: the notification turn continues the task\'s chain', async () => {
  const { currentTurnTask } = await import('../../src/agentd/transcript.mjs');
  const head = L.channel('t1') + L.bgBash('tu1') + L.assistant('timer running');
  for (const status of ['completed', 'failed', 'killed']) {
    assert.equal(currentTurnTask(transcript(head + L.queued('tu1') + L.noticeTurn('tu1', status)
      + L.toolResult('15:11:15') + L.assistant('It is 3:11 PM.')), ['t1']), 't1', status);
  }
  // Absorbed into the device turn itself (no follow-up turn).
  assert.equal(currentTurnTask(transcript(head + L.absorbed('tu1', 'completed') + L.assistant('3:11')), ['t1']), 't1');
  // Two launches: the first notice turn still waits for the second.
  const two = L.channel('t1') + L.bgBash('tu1') + L.bgAgent('tu2') + L.assistant('both running') + L.noticeTurn('tu1') + L.assistant('one done');
  assert.equal(currentTurnTask(transcript(two), ['t1']), null);
  assert.equal(currentTurnTask(transcript(two + L.noticeTurn('tu2') + L.assistant('all done')), ['t1']), 't1');
  // A launch in the follow-up turn defers again.
  assert.equal(currentTurnTask(transcript(head + L.noticeTurn('tu1') + L.bgBash('tu3', 'b2') + L.assistant('again')), ['t1']), null);
  // Large attachment lines in between don't matter.
  assert.equal(currentTurnTask(transcript(head + L.junk(700 * 1024) + L.requestDump('y'.repeat(300 * 1024))
    + L.noticeTurn('tu1') + L.junk(400 * 1024) + L.assistant('done')), ['t1']), 't1');
});

test('background work: a typed prompt breaks the chain', async () => {
  const { currentTurnTask } = await import('../../src/agentd/transcript.mjs');
  const head = L.channel('t1') + L.bgBash('tu1') + L.assistant('timer running');
  assert.equal(currentTurnTask(transcript(head + L.typed('stop') + L.assistant('stopped')), ['t1']), null);
  assert.equal(currentTurnTask(transcript(head + L.typed('stop') + L.noticeTurn('tu1', 'killed') + L.assistant('x')), ['t1']), null);
  assert.equal(currentTurnTask(transcript(head + L.interrupt() + L.noticeTurn('tu1') + L.assistant('x')), ['t1']), null);
  // A notice turn after a typed turn belongs to the typed turn's chain.
  assert.equal(currentTurnTask(transcript(L.typed('run it') + L.bgBash('tu1') + L.noticeTurn('tu1') + L.assistant('x')), ['t1']), null);
});

test('stop hook: device task with a background wait → only the follow-up turn answers', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  const head = L.channel('t1') + L.bgBash('tu1') + L.assistant('60s timer running in background.');
  app.onStopHook({ transcript_path: transcript(head), last_assistant_message: '60s timer running in background.' });
  assert.deepEqual(sent, []);
  assert.ok(tasks.get('t1'));
  app.onStopHook({ transcript_path: transcript(head + L.noticeTurn('tu1') + L.assistant('It is now 3:11 pm.')),
    last_assistant_message: 'It is now 3:11 pm.' });
  assert.deepEqual(sent, [['t1', 'It is now 3:11 pm.']]);
});

test('stop hook: an interrupt marker line is a turn start, not a task', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  for (const form of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
    app.onStopHook({ pids: [42], transcript_path: transcript(L.channel('t1') + L.assistant('a') + L.interrupt(form) + L.assistant('b')),
      last_assistant_message: 'x' });
  }
  assert.deepEqual(sent, []);
});

test('stop hook: a Codex rollout answers a task the turn polled; an earlier turn\'s task is not answered', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  const poll = id => L.codex('item_completed', { item: { tool: 'codie_poll', result: { content: [{ type: 'text', text: `[{"taskId":"${id}"}]` }] } } });
  app.onStopHook({ transcript_path: transcript(L.codex('task_started') + poll('t1') + L.codex('task_started') + L.codex('agent_message')),
    last_assistant_message: 'x' });
  assert.deepEqual(sent, []);
  app.onStopHook({ transcript_path: transcript(L.codex('task_started') + poll('t1') + L.codex('agent_message')), last_assistant_message: 'Done' });
  assert.deepEqual(sent, [['t1', 'Done']]);
});

test('stop hook: compact-summary / transcript-only user lines are not a turn start', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  const compact = JSON.stringify({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued…' } }) + '\n';
  const visibleOnly = JSON.stringify({ type: 'user', isVisibleInTranscriptOnly: true, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }) + '\n';
  app.onStopHook({ transcript_path: transcript(L.channel('t1') + L.assistant('a') + compact + visibleOnly + L.assistant('b')), last_assistant_message: 'Done' });
  assert.deepEqual(sent, [['t1', 'Done']]);
});

test('stop hook: a Codex turn aborted after its task_started answers nothing', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  const poll = L.codex('item_completed', { item: { result: { content: [{ type: 'text', text: '[{"taskId":"t1"}]' }] } } });
  app.onStopHook({ transcript_path: transcript(L.codex('task_started') + poll + L.codex('turn_aborted', { reason: 'interrupted' })), last_assistant_message: 'Halfway done' });
  assert.deepEqual(sent, []);
});

test("stop hook: a Codex session answers only tasks it claimed (all pending on win32)", () => {
  const poll = L.codex('item_completed', { item: { result: { content: [{ type: 'text', text: '[{"taskId":"t1"}]' }] } } });
  const tp = transcript(L.codex('task_started') + poll);
  for (const [platform, claimed, want] of [['darwin', [], 0], ['darwin', ['t1'], 1], ['win32', [], 1]]) {
    const { app, tasks, sent } = mkApp({ platform });
    tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
    for (const id of claimed) tasks.hold(id, 's1', 'poll');
    app.onStopHook({ transcript_path: tp, last_assistant_message: 'x' }, { session: { host: 'codex', id: 's1' } });
    assert.equal(sent.length, want, `${platform} ${claimed}`);
  }
});

test('codie_status shows short task ids only', async () => {
  const { app, store, tasks } = mkApp();
  store.upsertPairing({ deviceId: 'd1', name: 'Living room', host: 'h', port: 1 });
  tasks.tasks.set('331ba06f-ad33-4919-bf7c-33ee7fb902a4', { taskId: '331ba06f-ad33-4919-bf7c-33ee7fb902a4', deviceId: 'd1', startedAt: 0 });
  const t = (await app.callTool('codie_status', {})).content[0].text;
  assert.match(t, /In progress: 331ba06f…/);
  assert.ok(!t.includes('331ba06f-ad33'));
});

test('codie_reply drops one surrounding pair of quotes; the soft-stop instruction has none around the sentence', async () => {
  assert.equal(unquote(`「${INTERRUPTED}」`), INTERRUPTED);
  assert.equal(unquote(`“OK”`), 'OK');
  assert.equal(unquote(' "OK" '), 'OK');
  assert.equal(unquote('「「OK」」'), '「OK」');
  assert.equal(unquote('he said “OK”.'), 'he said “OK”.');
  assert.equal(unquote('"'), '"');
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  await app.callTool('codie_reply', { task_id: 't1', summary: `「${INTERRUPTED}」` });
  assert.deepEqual(sent, [['t1', INTERRUPTED]]);
  assert.ok(INSTRUCTIONS.includes(INTERRUPTED) && !INSTRUCTIONS.includes(`「${INTERRUPTED}」`));
});

test('stop hook: missing / unreadable / unrecognised transcript → nothing, no throw', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  app.onStopHook({ pids: [42], last_assistant_message: 'x' });
  app.onStopHook({ pids: [42], transcript_path: '/nonexistent/codie/t.jsonl', last_assistant_message: 'x' });
  app.onStopHook({ pids: [42], transcript_path: transcript('t1 not json\n{"task_id":"t1"}\n'), last_assistant_message: 'x' });
  app.onStopHook({ pids: [42], transcript_path: transcript(''), last_assistant_message: 'x' });
  app.onStopHook({ pids: [42], transcript_path: 42, last_assistant_message: 'x' });
  assert.deepEqual(sent, []);
});

test('codie_reply to an offline device says the summary was not delivered', async () => {
  const { app } = mkApp({ link: { onlineDevices: () => [], sendResult: () => 'offline' } });
  const r = await app.callTool('codie_reply', { task_id: 't1', summary: 'x' });
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, 'The device is offline; the summary was not delivered.');
});

test('codie_reply for a waiting task whose device is offline says it was not delivered (not queued)', async () => {
  const { app } = mkApp({ link: { onlineDevices: () => [], sendResult: () => 'undelivered' } });
  const r = await app.callTool('codie_reply', { task_id: 't1', summary: 'x' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /not delivered/);
  assert.doesNotMatch(r.content[0].text, /queued/);
});

test('codie_notify tells a failed send apart from a quiet skip', async () => {
  const { app } = mkApp({ link: { onlineDevices: () => [{ deviceId: 'd1' }], isQuiet: () => false, announce: () => 0 } });
  assert.match((await app.callTool('codie_notify', {})).content[0].text, /Failed to send/);
});

test('codie_reply announces INTERRUPTED as-is and any other summary with the done prefix', async () => {
  const calls = [];
  const { app } = mkApp({ link: { onlineDevices: () => [], sendResult: (t, s, o) => { calls.push([s, o]); return true; } } });
  await app.callTool('codie_reply', { task_id: 't1', summary: `「${INTERRUPTED}」` });
  await app.callTool('codie_reply', { task_id: 't2', summary: 'Done' });
  assert.deepEqual(calls, [[INTERRUPTED, { asIs: true }], ['Done', { asIs: false }]]);
});

test('codie_status tells the user to pair again when the device refused this computer', async () => {
  const { app, store } = mkApp({ repairRequired: id => id === 'd1' });
  store.upsertPairing({ deviceId: 'd1', name: 'Living room' });
  store.upsertPairing({ deviceId: 'd2', name: 'Desk' });
  assert.deepEqual(app.statusSnapshot().devices.map(d => d.repairRequired), [true, undefined]);
  const r = await app.callTool('codie_status', {});
  assert.match(r.content[0].text, /^🔴 Living room no longer accepts this computer: pair it again with \/codie:pair \(device_id=d1\)\n⚪ Desk offline/);
});

test('codie_status lists device_id for each pairing', async () => {
  const { app, store } = mkApp();
  store.upsertPairing({ deviceId: 'd1', name: 'Living room' });
  const r = await app.callTool('codie_status', {});
  assert.equal(r.content[0].text, '⚪ Living room offline (device_id=d1)\nRemind mode: remind only when a turn ends with a question (question)\n'
    + 'Detail: full (reads the agent message aloud)\nVoice language: English (United States), en-US (follows the system)');
});

test('codie_notify announces the fixed reminder', async () => {
  const { app, announced } = mkApp();
  const r = await app.callTool('codie_notify', {});
  assert.equal(r.isError, undefined);
  assert.deepEqual(announced, [REMINDER]);
});

test('codie_notify with no device online says so', async () => {
  const { app } = mkApp({ link: { onlineDevices: () => [], announce: () => 0 } });
  const r = await app.callTool('codie_notify', {});
  assert.match(r.content[0].text, /No Codie device is online/);
});

test('Notification hook reminds on permission/idle prompts only', () => {
  let t = 1_000_000;
  const { app, announced } = mkApp({ now: () => t });
  app.onNotificationHook({ pids: [42], notification_type: 'auth_success' });
  assert.deepEqual(announced, []);
  app.onNotificationHook({ pids: [42], notification_type: 'permission_prompt' });
  assert.deepEqual(announced, [REMINDER]);
  t += REMIND_DEDUP_MS + 1;
  app.onNotificationHook({ pids: [42], notification_type: 'idle_prompt', transcript_path: transcriptEndingWith('Shall I continue?') });
  t += REMIND_DEDUP_MS + 1;
  app.onNotificationHook({ pids: [42] });
  assert.equal(announced.length, 3);
});

// idle_prompt fires ~60s after EVERY turn the user leaves unanswered, so on its
// own it would remind after each turn and erase the difference between the
// remind modes: in the default mode only a turn that ended on a question counts.
test('idle_prompt follows the remind mode: by default only after a question', async () => {
  let t = 1_000_000;
  const { app, announced } = mkApp({ now: () => t });
  app.onNotificationHook({ notification_type: 'idle_prompt', transcript_path: transcriptEndingWith('Fixed it, all tests pass.') });
  app.onNotificationHook({ notification_type: 'idle_prompt' }); // no transcript to judge by
  assert.deepEqual(announced, [], 'a statement is not a question');
  app.onNotificationHook({ notification_type: 'idle_prompt', transcript_path: transcriptEndingWith('Shall I commit now?') });
  assert.deepEqual(announced, [REMINDER]);
  await app.callTool('codie_remind_mode', { mode: 'every_turn' });
  t += REMIND_DEDUP_MS + 1;
  app.onNotificationHook({ notification_type: 'idle_prompt', transcript_path: transcriptEndingWith('Fixed it, all tests pass.') });
  assert.equal(announced.length, 2, 'every_turn reminds whatever the turn ended on');
  // A permission prompt always needs the user, in either mode.
  await app.callTool('codie_remind_mode', { mode: 'question' });
  t += REMIND_DEDUP_MS + 1;
  app.onNotificationHook({ notification_type: 'permission_prompt', transcript_path: transcriptEndingWith('Let me run the tests first.') });
  assert.equal(announced.length, 3);
});

test('Notification hook is dropped right after a reminder spoke', async () => {
  let t = 1_000_000;
  const { app, announced } = mkApp({ now: () => t });
  await app.callTool('codie_notify', {});
  const asked = transcriptEndingWith('Shall I continue?');
  t += 60_000;
  app.onNotificationHook({ pids: [42], notification_type: 'idle_prompt', transcript_path: asked });
  assert.equal(announced.length, 1);
  t += 60_000;
  app.onNotificationHook({ pids: [42], notification_type: 'idle_prompt', transcript_path: asked });
  assert.equal(announced.length, 2);
});

test('reminders ask the link to skip devices that just had a task answer announced', async () => {
  const quiet = [];
  const { app } = mkApp({ link: { onlineDevices: () => [{ deviceId: 'd1' }], isQuiet: () => true, announce: (txt, o) => { quiet.push(o.quietMs); return 0; } } });
  app.onNotificationHook({ notification_type: 'idle_prompt', transcript_path: transcriptEndingWith('Shall I continue?') });
  app.onStopHook({ last_assistant_message: 'Shall I continue?' });
  const r = await app.callTool('codie_notify', {});
  assert.deepEqual(quiet, [REMIND_DEDUP_MS, TURN_END_DEDUP_MS, TURN_END_DEDUP_MS]);
  assert.match(r.content[0].text, /just announced a task result/);
});

test('pair confirm without a client credential saves nothing and keeps the existing pairing', async () => {
  const notFound = Object.assign(new Error('not found'), { status: 404 });
  const { app, store } = mkApp({ clt01: { issueClientCredential: async () => { throw notFound; } } });
  store.upsertPairing({ deviceId: 'd1', name: 'Living room', host: '10.0.0.2', port: 8081, credentialId: 'old', credentialSecret: 'olds' });
  await app.callTool('codie_list_devices', {});
  await app.callTool('codie_pair_begin', { device_id: 'd1' });
  const r = await app.callTool('codie_pair_confirm', { device_id: 'd1', code: '123456' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /did not issue a client credential \(not found\)/);
  assert.equal(store.listPairings()[0].credentialSecret, 'olds');
});

test('turn end reminds only on a question by default', () => {
  const { app, announced } = mkApp();
  app.onStopHook({ pids: [42], last_assistant_message: 'All passed.' });
  assert.deepEqual(announced, []);
  app.onStopHook({ pids: [42], last_assistant_message: 'Commit?' });
  assert.deepEqual(announced, [REMINDER]);
});

test('every_turn mode reminds after any turn', async () => {
  let t = 1_000_000;
  const { app, announced } = mkApp({ now: () => t });
  assert.match((await app.callTool('codie_remind_mode', { mode: 'every_turn' })).content[0].text, /every turn/);
  app.onStopHook({ pids: [42], last_assistant_message: 'Done.' });
  t += TURN_END_DEDUP_MS + 1;
  app.onStopHook({ pids: [42], last_assistant_message: 'Also done.' });
  assert.equal(announced.length, 2);
});

test('turn end skips the reminder right after codie_notify', async () => {
  let t = 1_000_000;
  const { app, announced } = mkApp({ now: () => t });
  await app.callTool('codie_notify', {});
  t += 5_000;
  app.onStopHook({ pids: [42], last_assistant_message: 'Shall I continue?' });
  assert.equal(announced.length, 1);
});

test('a turn that answered a device task speaks the summary, no reminder', () => {
  const { app, tasks, sent, announced } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  const tp = transcript(L.channel('t1'));
  app.onStopHook({ pids: [42], transcript_path: tp, last_assistant_message: 'Shall I commit too?' });
  assert.equal(sent.length, 1);
  assert.deepEqual(announced, []);
});

test('codie_remind_mode: shows default, rejects unknown, persists in settings', async () => {
  const { app, store } = mkApp();
  assert.match((await app.callTool('codie_remind_mode', {})).content[0].text, /question/);
  assert.equal((await app.callTool('codie_remind_mode', { mode: 'always' })).isError, true);
  await app.callTool('codie_remind_mode', { mode: 'every_turn' });
  assert.equal(store.readSettings().remindMode, 'every_turn');
  store.upsertPairing({ deviceId: 'd1', name: 'Living room' });
  assert.match((await app.callTool('codie_status', {})).content[0].text, /Remind mode: remind at the end of every turn/);
});

test('per-call ctx words replies and reminders for that session', async () => {
  const { app, announced } = mkApp();
  const r = await app.callTool('codie_status', {}, { host: 'Codex', pairHint: '"pair Codie"' });
  assert.match(r.content[0].text, /"pair Codie"/);
  app.onStopHook({ last_assistant_message: 'Shall I continue?' }, { host: 'Codex' });
  assert.deepEqual(announced, ['Codex on the computer needs you to take a look.']);
});

test('stop hook: a turn started by the Codie inbox monitor → spoken summary', () => {
  const { app, tasks, sent } = mkApp();
  tasks.tasks.set('t1', { taskId: 't1', deviceId: 'd1', startedAt: 0 });
  app.onStopHook({ pids: [42], transcript_path: transcript(L.inbox('t1') + L.assistant('OK')), last_assistant_message: 'All tests passed' });
  assert.deepEqual(sent, [['t1', 'All tests passed']]);
});

test('an inbox task turn chains through background work like a channel push', async () => {
  const { currentTurnTask } = await import('../../src/agentd/transcript.mjs');
  const head = L.inbox('t1') + L.bgBash('tu1') + L.assistant('running');
  assert.equal(currentTurnTask(transcript(head), ['t1']), null, 'its background work has not ended');
  assert.equal(currentTurnTask(transcript(head + L.noticeTurn('tu1') + L.assistant('done')), ['t1']), 't1');
  // A typed prompt after it breaks the chain.
  assert.equal(currentTurnTask(transcript(L.inbox('t1') + L.assistant('a') + L.typed('something else')), ['t1']), null);
});

test('pair confirm stores a client credential issued with the master secret; the master secret is not stored', async () => {
  const issued = [];
  const { app, store } = mkApp({ clt01: {
    pairConfirm: async () => ({ deviceId: 'd1', name: 'Living room', localSecret: 'master' }),
    issueClientCredential: async (host, port, master, label) => { issued.push({ host, master, label }); return { id: 'cred-1', secret: 'client-secret' }; },
  } });
  await app.callTool('codie_list_devices', {});
  await app.callTool('codie_pair_begin', { device_id: 'd1' });
  await app.callTool('codie_pair_confirm', { device_id: 'd1', code: '123456' });
  assert.deepEqual(issued.map(i => [i.host, i.master.secret, i.master.userId]), [['10.0.0.2', 'master', 'u1']]);
  const r = store.listPairings()[0];
  assert.deepEqual([r.userId, r.credentialId, r.credentialSecret], ['u1', 'cred-1', 'client-secret']);
  assert.ok(!JSON.stringify(r).includes('master'));
});

test('unpair asks for the device cleanup with the removed record', async () => {
  const forgotten = [];
  const { app, store } = mkApp({ forgetDevice: async r => { forgotten.push(r.deviceId); } });
  store.upsertPairing({ deviceId: 'd1', name: 'x', host: 'h', port: 1, credentialId: 'c' });
  await app.callTool('codie_unpair', { device_id: 'd1' });
  assert.deepEqual(forgotten, ['d1']);
});

test('a pairing becomes the tools device; a failed one does not', async () => {
  const issuing = { pairConfirm: async () => ({ deviceId: 'd1', name: 'Living room', localSecret: 'master' }),
    issueClientCredential: async () => ({ id: 'cred-1', secret: 'client-secret' }) };
  const { app, store } = mkApp({ clt01: issuing });
  store.updateSettings({ toolsDevice: 'elsewhere' });
  await app.callTool('codie_list_devices', {});
  await app.callTool('codie_pair_begin', { device_id: 'd1' });
  await app.callTool('codie_pair_confirm', { device_id: 'd1', code: '123456' });
  assert.equal(store.readSettings().toolsDevice, 'd1');

  const notFound = Object.assign(new Error('not found'), { status: 404 });
  const old = mkApp({ clt01: { issueClientCredential: async () => { throw notFound; } } });
  old.store.updateSettings({ toolsDevice: 'elsewhere' });
  await old.app.callTool('codie_list_devices', {});
  await old.app.callTool('codie_pair_begin', { device_id: 'd1' });
  await old.app.callTool('codie_pair_confirm', { device_id: 'd1', code: '123456' });
  assert.equal(old.store.readSettings().toolsDevice, 'elsewhere');
});

// An mDNS answer is no proof of identity: only a device that failed at its
// paired address is moved (host-refresh.mjs), never by a scan.
test('a scan never moves a paired device', async () => {
  let changes = 0;
  const { app, store } = mkApp({ onPairingsChanged: () => { changes++; } });
  store.upsertPairing({ deviceId: 'd1', name: 'Living room', host: '10.0.0.9', port: 8081 });
  await app.callTool('codie_list_devices', {});
  assert.equal(store.listPairings()[0].host, '10.0.0.9');
  assert.equal(changes, 0);
});

test('reminders follow the voice language: the system locale by default, or the setting', async () => {
  const { app, announced } = mkApp({ systemLocale: 'zh-CN' });
  await app.callTool('codie_notify', {});
  assert.deepEqual(announced, [sentences('zh').reminder('Claude Code')]);
  const { app: app2, store, announced: said } = mkApp({ systemLocale: 'zh-CN' });
  store.updateSettings({ voiceLanguage: 'en' });
  await app2.callTool('codie_notify', {});
  assert.deepEqual(said, [REMINDER]);
});

test('codie_notify reads the agent\'s message verbatim in full detail, the fixed reminder in brief', async () => {
  let t = 1_000_000;
  const { app, store, announced, verbatim } = mkApp({ now: () => t });
  const r = await app.callTool('codie_notify', { message: '  Option A fixes the root cause; I recommend it.  ' });
  assert.match(r.content[0].text, /read your message/);
  assert.deepEqual(verbatim, ['Option A fixes the root cause; I recommend it.']);
  assert.deepEqual(announced, []);
  store.updateSettings({ remindDetail: 'brief' });
  t += TURN_END_DEDUP_MS + 1;
  const b = await app.callTool('codie_notify', { message: 'Pick A or B?' });
  assert.match(b.content[0].text, /brief/);
  assert.deepEqual(announced, [REMINDER]);
  assert.equal(verbatim.length, 1);
});

test('codie_notify with an empty message plays the fixed reminder', async () => {
  const { app, announced, verbatim } = mkApp();
  await app.callTool('codie_notify', { message: '   ' });
  assert.deepEqual([announced, verbatim], [[REMINDER], []]);
});

test('codie_remind_mode switches detail and voice language, and rejects bad values', async () => {
  const { app, store } = mkApp();
  assert.equal((await app.callTool('codie_remind_mode', { detail: 'loud' })).isError, true);
  const bad = await app.callTool('codie_remind_mode', { language: 'not a tag' });
  assert.equal(bad.isError, true);
  assert.deepEqual(store.readSettings(), {}, 'nothing is saved when any value is bad');
  const r = await app.callTool('codie_remind_mode', { detail: 'brief', language: 'zh-cn' });
  assert.deepEqual(store.readSettings(), { remindDetail: 'brief', voiceLanguage: 'zh-CN' });
  assert.match(r.content[0].text, /Detail: brief/);
  assert.match(r.content[0].text, /write codie_notify messages in Chinese \(China\), zh-CN/);
  assert.match(r.content[0].text, /Other open sessions/);
  const back = await app.callTool('codie_remind_mode', { language: 'system' });
  assert.equal(store.readSettings().voiceLanguage, 'system');
  assert.match(back.content[0].text, /English \(United States\), en-US \(follows the system\)/);
  const shown = await app.callTool('codie_remind_mode', {});
  assert.match(shown.content[0].text, /Remind mode: .*\(question\)/);
  assert.match(shown.content[0].text, /Detail: brief/);
  assert.doesNotMatch(shown.content[0].text, /Other open sessions/);
});

test('AskUserQuestion reminds unless the agent just spoke through codie_notify', async () => {
  let t = 1_000_000;
  const { app, announced, verbatim } = mkApp({ now: () => t });
  app.onAskHook({ tool_name: 'AskUserQuestion' });
  assert.deepEqual(announced, [REMINDER]);
  t += TURN_END_DEDUP_MS + 1;
  await app.callTool('codie_notify', { message: 'A or B? I recommend A.' });
  t += 1_000;
  app.onAskHook({ tool_name: 'AskUserQuestion' });
  assert.equal(announced.length, 1);
  assert.equal(verbatim.length, 1);
});

test('a permission prompt says what the agent wants approved, once', () => {
  let t = 1_000_000;
  const { app, announced } = mkApp({ now: () => t });
  const ctx = { session: { id: 's1' }, host: 'Claude Code' };
  app.onPermissionHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules' } }, ctx);
  app.onNotificationHook({ notification_type: 'permission_prompt' }, ctx);
  assert.deepEqual(announced, ['Claude Code on the computer needs your approval: Remove node_modules']);
  t += REMIND_DEDUP_MS + 1;
  app.onNotificationHook({ notification_type: 'permission_prompt' }, ctx);
  assert.deepEqual(announced.at(-1), REMINDER, 'used once');
});

test('a permission prompt names the tool when it has no description', () => {
  let t = 1_000_000;
  const { app, announced } = mkApp({ now: () => t });
  const ctx = { session: { id: 's1' }, host: 'Claude Code' };
  app.onPermissionHook({ tool_name: 'Edit', tool_input: { file_path: '/repo/src/app.mjs' } }, ctx);
  app.onNotificationHook({ notification_type: 'permission_prompt' }, ctx);
  t += REMIND_DEDUP_MS + 1;
  app.onPermissionHook({ tool_name: 'mcp__plugin_codie_codie__codie_unpair', tool_input: { device_id: 'd1' } }, ctx);
  app.onNotificationHook({ notification_type: 'permission_prompt' }, ctx);
  assert.deepEqual(announced, ['Claude Code on the computer needs your approval: Edit app.mjs',
    'Claude Code on the computer needs your approval: codie_unpair']);
});

test('a permission prompt falls back to the reminder: brief detail, another session, expired, or AskUserQuestion', () => {
  let t = 1_000_000;
  const { app, store, announced } = mkApp({ now: () => t });
  const s1 = { session: { id: 's1' }, host: 'Claude Code' };
  const s2 = { session: { id: 's2' }, host: 'Claude Code' };
  const bash = { tool_name: 'Bash', tool_input: { description: 'Remove node_modules' } };
  const prompt = ctx => { app.onNotificationHook({ notification_type: 'permission_prompt' }, ctx); t += REMIND_DEDUP_MS + 1; };
  app.onPermissionHook(bash, s1);
  prompt(s2);
  app.onPermissionHook(bash, s1);
  t += PERMISSION_TTL_MS + 1;
  prompt(s1);
  app.onPermissionHook({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, s1);
  prompt(s1);
  store.updateSettings({ remindDetail: 'brief' });
  app.onPermissionHook(bash, s1);
  prompt(s1);
  assert.deepEqual(announced, [REMINDER, REMINDER, REMINDER, REMINDER]);
});

test('a Codex permission prompt does not override a task answer the device has not spoken yet', () => {
  const quiet = [];
  const { app } = mkApp({ link: { onlineDevices: () => [{ deviceId: 'd1' }], isQuiet: () => true, announce: (t, o) => { quiet.push(o.quietMs); return 0; } } });
  app.onPermissionHook({ tool_name: 'Bash', tool_input: { description: 'Build the app' } }, { host: 'Codex', session: { host: 'codex' } });
  assert.deepEqual(quiet, [TURN_END_DEDUP_MS]);
});

test('pairing steps answer with codes; device codes pass through', async () => {
  const { app } = mkApp();
  assert.deepEqual(await app.pairing.begin('d1'), { ok: false, code: 'DEVICE_NOT_SCANNED' });
  await app.pairing.scan();
  assert.deepEqual(await app.pairing.confirm('d1', '123456'), { ok: false, code: 'NO_PAIRING_IN_PROGRESS' });
  assert.deepEqual(await app.pairing.begin('d1'), { ok: true, code: 'PAIR_STARTED', deviceName: 'Living room' });
  assert.deepEqual(await app.pairing.confirm('d1', '123456'), { ok: true, code: 'PAIRED', deviceName: 'Living room' });
  assert.deepEqual(await app.pairing.cancel('d1'), { ok: true, code: 'CANCELLED' });
});

test('a failed pairing step says why as a code, and saves nothing', async () => {
  const codeErr = (msg, code) => Object.assign(new Error(msg), { code });
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const cases = [
    [{ pairConfirm: async () => { throw codeErr('Invalid pairing code', 'INVALID_CODE'); } }, 'INVALID_CODE', undefined],
    [{ pairConfirm: async () => { throw codeErr('Pairing code expired', 'PAIRING_CODE_EXPIRED'); } }, 'PAIRING_CODE_EXPIRED', undefined],
    [{ pairConfirm: async () => { throw refused; } }, 'DEVICE_UNREACHABLE', undefined],
    [{ pairConfirm: async () => { throw new Error('HTTP 500'); } }, 'PAIR_FAILED', undefined],
    [{ deviceAuth: async () => { throw codeErr('bootstrap: device not signed in (no user_id)', 'DEVICE_NOT_SIGNED_IN'); } }, 'DEVICE_NOT_SIGNED_IN', 'credential'],
    [{ issueClientCredential: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } }, 'CREDENTIAL_NOT_ISSUED', 'credential'],
    [{ issueClientCredential: async () => { throw refused; } }, 'DEVICE_UNREACHABLE', 'credential'],
  ];
  for (const [clt01, code, stage] of cases) {
    const { app, store } = mkApp({ clt01 });
    await app.pairing.scan();
    await app.pairing.begin('d1');
    const o = await app.pairing.confirm('d1', '123456');
    assert.deepEqual([o.ok, o.code, o.stage], [false, code, stage], code);
    assert.equal(typeof o.reason, 'string');
    assert.deepEqual(store.listPairings(), []);
  }
  const { app } = mkApp({ clt01: { pairRequest: async () => { throw codeErr('slow down', 'PAIRING_REQUEST_RATE_LIMITED'); } } });
  await app.pairing.scan();
  assert.deepEqual(await app.pairing.begin('d1'), { ok: false, code: 'PAIRING_REQUEST_RATE_LIMITED', reason: 'slow down (PAIRING_REQUEST_RATE_LIMITED)' });
});
