import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TaskTable } from '../../src/agentd/tasks.mjs';
import { NO_REPLY, START_FAILED, START_UNTRUSTED, SEND_UNKNOWN, CANCEL_UNCONFIRMED } from '../../src/agentd/texts.mjs';
import { Dispatcher, taskPrompt } from '../../src/agentd/daemon/dispatch.mjs';
import { childEnv } from '../../src/agentd/daemon/child-env.mjs';
import { ClaudeBackground, REPLY_TOOL } from '../../src/agentd/daemon/claude-background.mjs';
import { CodexQueue, lastCodexMessage } from '../../src/agentd/daemon/codex-queue.mjs';
import { codexProxy, codexRpc } from '../../src/agentd/daemon/codex-rpc.mjs';

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await sleep(5); } };

function mk({ codexThread = 'th1', codexStatus = ['active', 'idle'], claudeStatus = ['busy', 'idle'], settings = {},
  codexSession = true, cwd = '/proj', codexSendFails = false, claudeStartFails = false, claudeStartError = null, codexLast = '' } = {}) {
  const tasks = new TaskTable();
  const errors = [];
  const results = [];
  const link = { sendError: (t, m) => { if (tasks.finish(t)) errors.push([t, m]); return true; },
    sendResult: (t, m) => { if (tasks.finish(t)) results.push([t, m]); return true; } };
  const calls = [];
  const seq = arr => { let i = 0; return () => arr[Math.min(i++, arr.length - 1)]; };
  const cs = seq(codexStatus);
  const ls = seq(claudeStatus);
  const codex = {
    pickThread: async () => codexThread,
    send: async (th, text) => { calls.push(['codex.send', th, text]); if (codexSendFails) throw Object.assign(new Error('CLI missing'), { code: 'ENOENT' }); },
    status: async () => cs(),
    lastReply: async () => codexLast,
  };
  const claude = {
    start: async (dir, text) => { calls.push(['claude.start', dir, text]); if (claudeStartError) throw claudeStartError; if (claudeStartFails) throw new Error('untrusted'); return { sessionId: 'sid1', agentId: `a${calls.length}` }; },
    status: async () => ls(),
    stop: async sid => { calls.push(['claude.stop', sid]); },
  };
  const d = new Dispatcher({ tasks, link, codex, claude, settings: () => settings, hasCodexSession: () => codexSession,
    claudeCwd: () => cwd, spoken: t => `[${t}]`, pollMs: 5, graceMs: 20, startGraceMs: 30, stopWaitMs: 50, cancelWaitMs: 200, cancelPollMs: 5 });
  const task = (text = 'check memory') => { const t = tasks.begin(`d${Math.random()}`, 'm'); tasks.accept(t.taskId); return { taskId: t.taskId, deviceId: t.deviceId, deviceName: 'Living room', text }; };
  return { d, tasks, errors, results, calls, task };
}

test('taskPrompt carries the task id and how to answer, user words first', () => {
  const p = taskPrompt({ taskId: 't1', deviceId: 'd1', deviceName: 'Living room', text: 'check memory' });
  assert.ok(!p.startsWith('['), 'not a bracketed header');
  assert.match(p, /task_id="t1"/);
  assert.match(p, /Living room/);
  assert.match(p, /check memory/);
  assert.match(p, /codie_reply/);
});

test('childEnv drops the parent session markers and adds the usual CLI dirs to PATH', () => {
  const env = childEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '9', CODEX_THREAD_ID: 'x',
    CLAUDE_PROJECT_DIR: '/a', CLAUDE_PLUGIN_ROOT: '/p', CODEX_SANDBOX_NETWORK_DISABLED: '1', HOME: '/h' }, '/h');
  assert.equal(env.HOME, '/h');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
  if (process.platform !== 'win32') assert.deepEqual(env.PATH.split(':'), ['/bin', '/h/.local/bin', '/h/.claude/local', '/opt/homebrew/bin', '/usr/local/bin']);
});

test('an open Codex thread is preferred; the task is queued into it', async () => {
  const { d, calls, task, tasks } = mk({ codexStatus: ['active'] });
  await d.refresh();
  assert.equal(d.backend(), 'codex');
  const e = task();
  assert.equal(d.take(e), true);
  await until(() => calls.length);
  assert.equal(calls[0][0], 'codex.send');
  assert.equal(calls[0][1], 'th1');
  assert.match(calls[0][2], new RegExp(`task_id="${e.taskId}"`));
  tasks.finish(e.taskId); // the session answered (codie_reply)
});

test('no Codex thread → a background Claude session, stopped when the task ends', async () => {
  const { d, calls, task, tasks, errors } = mk({ codexThread: null, claudeStatus: ['busy'] });
  await d.refresh();
  assert.equal(d.backend(), 'claude');
  const e = task();
  d.take(e);
  await until(() => calls.length);
  assert.deepEqual(calls[0].slice(0, 2), ['claude.start', '/proj']);
  tasks.finish(e.taskId); // replied
  await until(() => calls.some(c => c[0] === 'claude.stop'));
  assert.deepEqual(errors, []);
});

test('Codex without a registered Codex session is not used', async () => {
  const { d } = mk({ codexSession: false });
  await d.refresh();
  assert.equal(d.backend(), 'claude');
});

test('settings turn each backend off', async () => {
  const { d } = mk({ settings: { codexQueue: false, claudeBackground: false } });
  await d.refresh();
  assert.equal(d.backend(), null);
  assert.equal(d.available(), false);
  assert.equal(d.take({ taskId: 'x' }), false);
});

test('no Claude project directory → no Claude backend', async () => {
  const { d } = mk({ codexThread: null, cwd: null });
  await d.refresh();
  assert.equal(d.backend(), null);
});

test('a session that goes idle without answering ends the task with NO_REPLY', async () => {
  const { d, task, errors, calls } = mk({ codexThread: null, claudeStatus: ['busy', 'idle'] });
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => errors.length);
  assert.deepEqual(errors, [[e.taskId, NO_REPLY]]);
  await until(() => calls.some(c => c[0] === 'claude.stop'));
});

test('idle right after the start is not "done" until the start grace passes', async () => {
  const { d, task, errors } = mk({ codexThread: null, claudeStatus: ['idle'] });
  await d.refresh();
  const e = task();
  const t0 = Date.now();
  d.take(e);
  await until(() => errors.length);
  assert.ok(Date.now() - t0 >= 30, 'waited out the start grace');
  assert.deepEqual(errors, [[e.taskId, NO_REPLY]]);
});

test('Codex idle without codie_reply: its last message answers', async () => {
  const { d, task, results, errors } = mk({ codexStatus: ['active', 'idle'], codexLast: 'half the memory is left' });
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => results.length || errors.length);
  assert.deepEqual(results, [[e.taskId, '[half the memory is left]']]);
});

test('a "No response requested." last message is not spoken', async () => {
  const { d, task, errors } = mk({ codexStatus: ['active', 'idle'], codexLast: 'No response requested.' });
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => errors.length);
  assert.deepEqual(errors, [[e.taskId, NO_REPLY]]);
});

test('Codex queueing fails → falls back to a background Claude session', async () => {
  const { d, task, calls, tasks } = mk({ codexSendFails: true, claudeStatus: ['busy'] });
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => calls.some(c => c[0] === 'claude.start'));
  tasks.finish(e.taskId);
});

test('a send that failed after all but reached the thread is watched as delivered, never replayed', async () => {
  const { d, task, results, calls } = mk({ codexLast: 'Plenty of memory.' });
  d.codex.send = async () => { throw new Error('accepted but acknowledgement was lost'); };
  d.codex.locate = async (th, id) => { calls.push(['codex.locate', th, id]); return 'queued'; };
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => results.length);
  assert.deepEqual(results, [[e.taskId, '[Plenty of memory.]']]);
  assert.ok(calls.some(c => c[0] === 'codex.locate' && c[2] === e.taskId));
  assert.ok(!calls.some(c => c[0] === 'claude.start'));
});

test('a failed send the thread never got falls back like any queueing failure', async () => {
  const { d, task, calls, tasks } = mk({ claudeStatus: ['busy'] });
  d.codex.send = async () => { throw new Error('daemon refused'); };
  d.codex.locate = async () => null;
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => calls.some(c => c[0] === 'claude.start'));
  tasks.finish(e.taskId);
});

test('a failed send that cannot be checked ends with SEND_UNKNOWN, never replayed in Claude', async () => {
  const { d, task, errors, calls } = mk();
  d.codex.send = async () => { throw new Error('accepted but acknowledgement was lost'); };
  d.codex.locate = async () => { throw new Error('app-server gone'); };
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => errors.length);
  assert.deepEqual(errors, [[e.taskId, SEND_UNKNOWN]]);
  assert.ok(!calls.some(c => c[0] === 'claude.start'));
});

test('cancellation waits for an in-flight queue send, then stops the exact task', async () => {
  const { d, task, tasks } = mk({ codexStatus: ['busy'] });
  let sent;
  const ready = new Promise(resolve => { sent = resolve; });
  d.codex.send = () => ready;
  const cancelled = [];
  d.codex.cancel = async (...args) => { cancelled.push(args); return 'removed'; };
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => d.codexJobs.has(e.taskId));
  const stopping = d.cancel(e);
  assert.deepEqual(cancelled, []);
  sent();
  await stopping;
  assert.deepEqual(cancelled, [['th1', e.taskId, undefined]]);
  tasks.finish(e.taskId);
});

test('an interrupted turn counts as cancelled only once it is seen to stop', async () => {
  const { d, tasks } = mk();
  const states = ['inProgress', 'inProgress', 'interrupted'];
  d.codex.cancel = async () => 'interrupted';
  d.codex.taskState = async () => ({ status: states.shift() ?? 'interrupted' });
  const t = tasks.begin('dev', 'm');
  await d.cancel({ taskId: t.taskId, threadId: 'th1', turnId: 'turn-1' });
  assert.deepEqual(states, []);
});

test('a turn that keeps running after the interrupt is reported as not cancelled', async () => {
  const { d, tasks } = mk();
  d.codex.cancel = async () => 'interrupted';
  d.codex.taskState = async () => ({ status: 'inProgress' });
  const t = tasks.begin('dev', 'm');
  await assert.rejects(d.cancel({ taskId: t.taskId, threadId: 'th1', turnId: 'turn-1' }), new RegExp(CANCEL_UNCONFIRMED.slice(0, 30)));
});

test('a task found nowhere in the thread is reported as not cancelled after a few looks', async () => {
  const { d, tasks } = mk();
  let looks = 0;
  d.codex.cancel = async () => { looks++; return 'unknown'; };
  const t = tasks.begin('dev', 'm');
  await assert.rejects(d.cancel({ taskId: t.taskId, threadId: 'th1', turnId: 'turn-1' }), new RegExp(CANCEL_UNCONFIRMED.slice(0, 30)));
  assert.ok(looks > 1 && looks < 10, `looked ${looks} times`);
});

test('a task with no Codex thread is not Codex\'s to cancel', async () => {
  const { d, tasks } = mk();
  d.codex.cancel = async () => assert.fail('must not touch Codex');
  const t = tasks.begin('dev', 'm');
  await d.cancel({ taskId: t.taskId });
});

test('a backend that fails to start ends the task with START_FAILED', async () => {
  const { d, task, errors } = mk({ codexSendFails: true, cwd: null });
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => errors.length);
  assert.deepEqual(errors, [[e.taskId, START_FAILED]]);
});

test('a background Claude session refused for an untrusted directory says so', async () => {
  const err = Object.assign(new Error('Command failed: claude --bg'), {
    stderr: 'Workspace not trusted. Run `claude` in /proj once and accept the trust prompt, then retry.\n' });
  const { d, task, errors } = mk({ codexThread: null, claudeStartError: err });
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => errors.length);
  assert.deepEqual(errors, [[e.taskId, START_UNTRUSTED]]);
  assert.match(START_UNTRUSTED, /trust/);
});

test('tasks do not wait for each other: a stuck session never blocks the next task', async () => {
  const { d, task, tasks, calls } = mk({ codexThread: null, claudeStatus: ['busy'] });
  await d.refresh();
  const a = task('one');
  const b = task('two');
  d.take(a);
  d.take(b);
  await until(() => calls.filter(c => c[0] === 'claude.start').length === 2);
  tasks.finish(a.taskId);
  tasks.finish(b.taskId);
});

test('a finished task waits for its session to go idle before stopping it', async () => {
  const { d, task, tasks, calls } = mk({ codexThread: null, claudeStatus: ['busy', 'busy', 'busy', 'busy', 'idle'] });
  await d.refresh();
  const e = task();
  d.take(e);
  await until(() => calls.length);
  tasks.finish(e.taskId); // replied, still finishing its turn
  await until(() => calls.some(c => c[0] === 'claude.stop'));
  assert.equal(calls.find(c => c[0] === 'claude.stop')[1], 'a1', 'stopped by the run\'s agent id');
});

test('CodexQueue picks the most recently used thread that takes input', async () => {
  const threads = {
    a: { id: 'a', cwd: '/p', recencyAt: 10, canAcceptDirectInput: true, threadSource: 'user' },
    b: { id: 'b', cwd: '/p', recencyAt: 30, canAcceptDirectInput: false, threadSource: 'user' },
    c: { id: 'c', cwd: '/p', recencyAt: 20, canAcceptDirectInput: true, threadSource: 'user' },
    s: { id: 's', cwd: '/p', recencyAt: 40, canAcceptDirectInput: true, threadSource: 'subagent' },
    x: { id: 'x', cwd: '/closed', recencyAt: 50, canAcceptDirectInput: true, threadSource: 'user' }, // loaded; open only when a hook says so
  };
  const rpc = async calls => calls.map(c => {
    if (c.method === 'thread/loaded/list') return { data: [...Object.keys(threads), 'gone'] };
    if (c.params.threadId === 'gone') throw new Error('thread not loaded'); // unloaded meanwhile: skipped
    return { thread: threads[c.params.threadId] };
  });
  const open = () => ['a', 'b', 'c', 's', 'gone'];
  assert.equal(await new CodexQueue({ rpc, knownThreads: open }).pickThread(), 'c', 'only threads a hook reported open');
  assert.equal(await new CodexQueue({ rpc, knownThreads: () => [...open(), 'x'] }).pickThread(), 'x');
  assert.equal(await new CodexQueue({ rpc, knownThreads: () => [] }).pickThread(), null, 'no open thread: none');
  assert.equal(await new CodexQueue({ rpc }).pickThread(), null, 'nothing reports open threads: none');
  assert.equal(await new CodexQueue({ rpc: async () => [{ data: [] }], knownThreads: open }).pickThread(), null);
});

test('CodexQueue prefers idle threads, then recency; busy threads are a fallback', async () => {
  const threads = {
    idleOld: { id: 'idleOld', cwd: '/p', status: { type: 'idle' }, updatedAt: 10 },
    idleNew: { id: 'idleNew', cwd: '/p', status: { type: 'idle' }, recencyAt: 20 },
    busyOld: { id: 'busyOld', cwd: '/p', status: { type: 'active' }, recencyAt: 30 },
    busyNew: { id: 'busyNew', cwd: '/p', status: { type: 'active' }, updatedAt: 40 },
    unloaded: { id: 'unloaded', cwd: '/p', status: { type: 'notLoaded' }, recencyAt: 100 },
  };
  const rpc = async calls => calls.map(c => c.method === 'thread/loaded/list'
    ? { data: Object.keys(threads) } : { thread: threads[c.params.threadId] });
  const q = new CodexQueue({ rpc, knownThreads: () => ['idleOld', 'idleNew', 'busyOld', 'busyNew', 'unloaded'] });
  assert.equal(await q.pickThread(), 'idleNew');
  delete threads.idleNew;
  assert.equal(await q.pickThread(), 'idleOld');
  delete threads.idleOld;
  assert.equal(await q.pickThread(), 'busyNew');
  delete threads.busyNew;
  assert.equal(await q.pickThread(), 'busyOld');
  delete threads.busyOld;
  assert.equal(await q.pickThread(), null);
});

test('Dispatcher reselects the available thread before sending', async () => {
  const { d, task, tasks, calls } = mk();
  let selected = 'now-busy';
  d.codex.pickThread = async () => selected;
  await d.refresh();
  selected = 'now-idle';
  const e = task();
  d.take(e);
  await until(() => calls.some(c => c[0] === 'codex.send'));
  assert.equal(calls.find(c => c[0] === 'codex.send')[1], 'now-idle');
  tasks.finish(e.taskId);
});

test('CodexQueue on Windows matches a named directory case- and trailing-slash-insensitively', async () => {
  const rpc = async calls => calls.map(c => (c.method === 'thread/loaded/list' ? { data: ['a'] }
    : { thread: { id: 'a', cwd: 'D:\\Devs\\P', recencyAt: 1, canAcceptDirectInput: true, threadSource: 'user' } }));
  const q = new CodexQueue({ rpc, platform: 'win32', knownThreads: () => ['a'] });
  assert.equal(await q.pickThread({ routing: { mode: 'session', target: 'd:\\devs\\p\\' } }), 'a');
});

test('codexRpc on Windows speaks through the app-server proxy\'s byte stream', async () => {
  const seen = [];
  const d = await fakeDaemon(m => { seen.push(m.method); return { result: { echo: m.method } }; }, { tcp: true });
  try {
    const r = await codexRpc([{ method: 'thread/loaded/list' }], { platform: 'win32', proxy: () => net.connect(d.port, '127.0.0.1') });
    assert.deepEqual(seen, ['initialize', 'thread/loaded/list']);
    assert.deepEqual(r, [{ echo: 'thread/loaded/list' }]);
  } finally { d.close(); }
});

test('codexProxy: a codex that cannot start rejects the call', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: { write() {} }, stdout: new EventEmitter(), kill() {} });
  const p = codexRpc([{ method: 'x' }], { platform: 'win32', proxy: () => codexProxy({ spawn: () => child }) });
  child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(p, /ENOENT/);
});

test('CodexQueue.status maps active/idle/notLoaded', async () => {
  const st = type => new CodexQueue({ rpc: async () => [{ thread: { status: { type } } }] }).status('t');
  assert.equal(await st('active'), 'busy');
  assert.equal(await st('idle'), 'idle');
  assert.equal(await st('systemError'), 'idle');
  assert.equal(await st('notLoaded'), null);
});

test('lastCodexMessage takes only the completed answer of the task turn', () => {
  const f = path.join(tmp('codie-ro-'), 'r.jsonl');
  const L = o => JSON.stringify({ type: 'event_msg', ...o });
  fs.writeFileSync(f, [L({ payload: { type: 'task_started', turn_id: 'turn9' } }), L({ payload: { type: 'user_message', message: 'Codie voice task task_id="t9"' } }),
    L({ payload: { type: 'agent_message', message: 'middle' } }), L({ payload: { type: 'task_complete', last_agent_message: 'final answer' } })].join('\n'));
  assert.equal(lastCodexMessage(f, 't9'), 'final answer');
  assert.equal(lastCodexMessage(f, 'nope'), '');
});

test('CodexQueue.send runs codex queue for the thread', async () => {
  const runs = [];
  await new CodexQueue({ rpc: async () => [], run: async (cmd, args) => { runs.push([cmd, ...args]); return { stdout: '' }; } }).send('th', 'a task');
  assert.deepEqual(runs, [['codex', 'queue', '--thread', 'th', '--message', 'a task']]);
});

test('ClaudeBackground starts a fresh session per task and keeps the id claude --bg prints', async () => {
  const runs = [];
  const run = async (cmd, args, opts) => {
    if (args[0] === 'agents') return { stdout: JSON.stringify([{ id: 'abcd1234', sessionId: 'abcd1234-full', kind: 'background', status: 'busy' }]) };
    runs.push({ args, cwd: opts?.cwd });
    return { stdout: 'Starting background service…\nbackgrounded · abcd1234 · some-name\n', stderr: '' };
  };
  const r = await new ClaudeBackground({ home: tmp('codie-bg-'), run }).start('/proj', 'one');
  assert.deepEqual(r, { sessionId: 'abcd1234-full', agentId: 'abcd1234' });
  assert.deepEqual(runs, [{ args: ['--bg', '--allowedTools', REPLY_TOOL, '--', 'one'], cwd: '/proj' }]);
});

test('ClaudeBackground remembers today\'s exchanges per project, the last few only', () => {
  let clock = new Date(2026, 9, 21, 9).getTime();
  const bg = new ClaudeBackground({ home: tmp('codie-bg-'), now: () => clock });
  for (let i = 1; i <= 10; i++) bg.remember('/proj', `q${i}`, `a${i}`);
  bg.remember('/proj', '', 'no question, not remembered');
  const h = bg.history('/proj');
  assert.equal(h.length, 8);
  assert.deepEqual(h.at(-1), { q: 'q10', a: 'a10' });
  assert.deepEqual(bg.history('/other'), []);
  clock += 24 * 3600_000;
  assert.deepEqual(bg.history('/proj'), [], 'a new day starts fresh');
});

test('ClaudeBackground.answer reads the codie_reply summary, else the last text', () => {
  const projects = tmp('codie-proj-');
  const dir = path.join(projects, '-proj');
  fs.mkdirSync(dir);
  const A = content => JSON.stringify({ type: 'assistant', message: { content } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [A([{ type: 'text', text: 'let me look first' }]),
    A([{ type: 'tool_use', name: REPLY_TOOL, input: { task_id: 't1', summary: 'half the memory is used' } }]), A([{ type: 'text', text: 'Replied to the device.' }])].join('\n'));
  fs.writeFileSync(path.join(dir, 's2.jsonl'), A([{ type: 'text', text: 'memory is fine' }]));
  const bg = new ClaudeBackground({ home: tmp('codie-bg-'), projectsDir: projects });
  assert.equal(bg.answer('/proj', 's1', 't1'), 'half the memory is used');
  assert.equal(bg.answer('/proj', 's2', 't2'), 'memory is fine');
  assert.equal(bg.answer('/proj', 'missing', 't'), '');
});

test('taskPrompt lists earlier exchanges when given', () => {
  const p = taskPrompt({ taskId: 't', deviceId: 'd', text: 'what was that number just now' }, [{ q: 'remember 47', a: 'got it' }]);
  assert.match(p, /- Me: remember 47\n  You: got it/);
  assert.ok(p.indexOf('what was that number just now') < p.indexOf('remember 47'), 'the new request first');
});

test('a background Claude task is remembered for the next prompt', async () => {
  const { d, task, tasks, calls } = mk({ codexThread: null, claudeStatus: ['busy', 'idle'] });
  const remembered = [];
  d.claude.history = () => [{ q: 'old question', a: 'old answer' }];
  d.claude.answer = () => 'new answer';
  d.claude.remember = (cwd, q, a) => remembered.push([cwd, q, a]);
  await d.refresh();
  const e = task('new question');
  d.take(e);
  await until(() => calls.length);
  assert.match(calls[0][2], /old question/);
  tasks.finish(e.taskId);
  await until(() => remembered.length);
  assert.deepEqual(remembered, [['/proj', 'new question', 'new answer']]);
});

test('ClaudeBackground fails when claude --bg prints no session id', async () => {
  const bg = new ClaudeBackground({ home: tmp('codie-bg-'), run: async (cmd, args) => ({ stdout: args[0] === 'agents' ? '[]' : 'Workspace not trusted.', stderr: '' }) });
  await assert.rejects(bg.start('/proj', 'x'), /no session id/);
});

test('ClaudeBackground reads a run\'s status by its agent id and stops it', async () => {
  const runs = [];
  const list = [{ id: 'old', sessionId: 'sid', kind: 'background', state: 'stopped' }, { id: 'abc', sessionId: 'sid', kind: 'background', status: 'busy' },
    { id: 'i', sessionId: 'sid', kind: 'interactive', status: 'idle' }];
  const run = async (cmd, args) => { runs.push(args); return { stdout: JSON.stringify(list) }; };
  const bg = new ClaudeBackground({ home: tmp('codie-bg-'), run });
  assert.equal(await bg.status('abc'), 'busy');
  assert.equal(await bg.status('old'), null, 'an earlier run of the same session has ended');
  assert.equal(await bg.status('gone'), null);
  await bg.stop('abc');
  assert.deepEqual(runs.at(-1), ['stop', 'abc']);
});

// A minimal WebSocket JSON-RPC server on a unix socket, like Codex's daemon.
// Listens on a unix socket, or with `tcp` on 127.0.0.1 (Windows has no
// unix sockets for node; the proxy transport is a plain byte stream anyway).
const testSocket = () => process.platform === 'win32' ? `\\\\.\\pipe\\codie-test-${crypto.randomUUID()}` : path.join(tmp('codie-cx-'), 's');
function fakeDaemon(handle, { tcp = false } = {}) {
  const sock = tcp ? 0 : testSocket();
  const server = net.createServer(c => {
    let buf = Buffer.alloc(0);
    let up = false;
    const send = obj => {
      const p = Buffer.from(JSON.stringify(obj));
      const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
      c.write(Buffer.concat([head, p]));
    };
    c.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(buf.toString())[1];
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        c.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buf = buf.subarray(i + 4);
        up = true;
      }
      while (buf.length >= 6) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
        buf = buf.subarray(off + 4 + len);
        const m = JSON.parse(data.toString());
        if (m.id === undefined) continue;
        send({ method: 'thread/status/changed', params: {} }); // a notification first: must be ignored
        send({ id: m.id, ...handle(m) });
      }
    });
  });
  return new Promise(r => server.listen(sock, () => r({ sock, port: server.address()?.port, close: () => server.close() })));
}

test('codexRpc initializes, then runs each call in order', async () => {
  const seen = [];
  const d = await fakeDaemon(m => { seen.push(m.method); return { result: m.method === 'initialize' ? {} : { echo: m.params } }; });
  try {
    const r = await codexRpc([{ method: 'thread/loaded/list' }, { method: 'thread/read', params: { threadId: 'x'.repeat(200) } }], { socket: d.sock });
    assert.deepEqual(seen, ['initialize', 'thread/loaded/list', 'thread/read']);
    assert.equal(r[1].echo.threadId.length, 200);
  } finally { d.close(); }
});

test('codexRpc rejects on a JSON-RPC error and without a daemon', async () => {
  const d = await fakeDaemon(m => (m.method === 'initialize' ? { result: {} } : { error: { message: 'nope' } }));
  try {
    await assert.rejects(codexRpc([{ method: 'x' }], { socket: d.sock }), /nope/);
  } finally { d.close(); }
  await assert.rejects(codexRpc([{ method: 'x' }], { socket: path.join(tmp('codie-cx-'), 'missing') }));
});


test('codexRpc skips a socket closed before upgrade', async () => {
  const sock = testSocket();
  const bad = net.createServer(c => c.destroy());
  await new Promise(r => bad.listen(sock, r));
  const good = await fakeDaemon(() => ({ result: { data: ['open-thread'] } }));
  try {
    const r = await codexRpc([{ method: 'thread/loaded/list' }], { platform: 'linux', sockets: () => [sock, good.sock] });
    assert.deepEqual(r, [{ data: ['open-thread'] }]);
  } finally { bad.close(); good.close(); }
});

test('codexRpc does not try another daemon after an RPC error', async () => {
  let reachedOther = false;
  const first = await fakeDaemon(m => m.method === 'initialize' ? { result: {} } : { error: { message: 'denied' } });
  const other = await fakeDaemon(() => { reachedOther = true; return { result: {} }; });
  try {
    await assert.rejects(codexRpc([{ method: 'thread/read' }], { platform: 'linux', sockets: () => [first.sock, other.sock] }), /denied/);
    assert.equal(reachedOther, false);
  } finally { first.close(); other.close(); }
});


test('explicit session intent overrides idle preference and rejects ambiguity', async () => {
  const threads = {
    busy: { id: 'busy', name: 'Control task', cwd: '/p/control', status: { type: 'active' } },
    idle: { id: 'idle', name: 'Another task', cwd: '/p/other', status: { type: 'idle' } },
  };
  const rpc = async calls => calls.map(c => c.method === 'thread/loaded/list'
    ? { data: Object.keys(threads) } : { thread: threads[c.params.threadId] });
  const q = new CodexQueue({ rpc, knownThreads: () => Object.keys(threads) });
  const select = target => q.pickThread({ routing: { mode: 'session', target } });
  for (const target of ['busy', 'Control task', '/p/control', 'control']) assert.equal(await select(target), 'busy');
  threads.second = { ...threads.busy, id: 'second', name: 'Another Control task' };
  await assert.rejects(select('control'), /Multiple sessions match/);
  assert.equal(await select('busy'), 'busy');
  await assert.rejects(select('missing'), /No matching session/);
  assert.equal(await q.pickThread({ routing: { mode: 'continue' }, previousThread: 'busy' }), 'busy');
  await assert.rejects(q.pickThread({ routing: { mode: 'continue' } }), /no previous Codex session/);
  delete threads.busy;
  await assert.rejects(q.pickThread({ routing: { mode: 'continue' }, previousThread: 'busy' }), /session is closed/);
});

test('Dispatcher remembers the target per device only after successful queueing', async () => {
  const { d, tasks, task, calls } = mk({ codexStatus: ['busy'] });
  const selections = [];
  d.codex.pickThread = async options => { selections.push(options); return options?.routing ? options.previousThread : 'first'; };
  await d.refresh();
  const a = task();
  d.take(a);
  await until(() => calls.some(c => c[0] === 'codex.send'));
  tasks.finish(a.taskId);
  assert.equal(d.routingState.get(a.deviceId), 'first');
  const b = task(); b.deviceId = a.deviceId; b.routing = { mode: 'continue' };
  d.take(b);
  await until(() => calls.filter(c => c[0] === 'codex.send').length === 2);
  assert.equal(selections.at(-1).previousThread, 'first');
  assert.equal(d.routingState.get('another-device'), undefined);
  tasks.finish(b.taskId);
});

test('a missing explicit target never starts an unrelated Claude session', async () => {
  const { d, task, errors, calls } = mk();
  await d.refresh();
  d.codex.pickThread = async () => { throw new Error('Multiple sessions match. Specify one session.'); };
  const e = task(); e.routing = { mode: 'session', target: 'Control' };
  d.take(e);
  await until(() => errors.length);
  assert.match(errors[0][1], /Multiple sessions match/);
  assert.equal(calls.length, 0);
  assert.equal(d.routingState.get(e.deviceId), undefined);
});


test('explicit idle routing never queues into a busy session or selects a subagent', async () => {
  const threads = {
    busy: { id: 'busy', status: { type: 'active' }, threadSource: 'user' },
    subagent: { id: 'subagent', status: { type: 'idle' }, threadSource: 'subagent' },
  };
  const rpc = async calls => calls.map(c => c.method === 'thread/loaded/list'
    ? { data: Object.keys(threads) } : { thread: threads[c.params.threadId] });
  const q = new CodexQueue({ rpc, knownThreads: () => Object.keys(threads) });
  await assert.rejects(q.pickThread({ routing: { mode: 'idle' } }), /No user Codex session is idle/);
  threads.idle = { id: 'idle', status: { type: 'idle' }, threadSource: 'user' };
  assert.equal(await q.pickThread({ routing: { mode: 'idle' } }), 'idle');
});
