import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexLifecycle, codexTaskState, taskMarker } from '../../src/agentd/daemon/codex-lifecycle.mjs';
import { CodexQueue, lastCodexMessage } from '../../src/agentd/daemon/codex-queue.mjs';
import { TaskTable } from '../../src/agentd/tasks.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { INTERRUPTED } from '../../src/agentd/texts.mjs';

const ev = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
function rollout(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-lifecycle-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  return file;
}
const start = (turn, id) => [ev('task_started', { turn_id: turn }), ev('user_message', { message: taskMarker(id) })];

test('a completed task returns its own final result, never a later turn', t => {
  const file = rollout(t, [...start('a', 'task-a'), ev('task_complete', { turn_id: 'a', last_agent_message: 'Answer A' }),
    ...start('b', 'task-b'), ev('task_complete', { turn_id: 'b', last_agent_message: 'Answer B' })]);
  assert.equal(lastCodexMessage(file, 'task-a'), 'Answer A');
  assert.equal(lastCodexMessage(file, 'task-b'), 'Answer B');
});

test('partial, aborted, unrelated and truncated records cannot become success', t => {
  const file = rollout(t, [...start('a', 'task-a'), ev('agent_message', { message: 'Working' }),
    ev('task_complete', { turn_id: 'other', last_agent_message: 'Other result' }),
    ev('turn_aborted', { turn_id: 'a', reason: 'interrupted' }),
    ...start('b', 'other'), ev('task_complete', { last_agent_message: 'Finished' })]);
  assert.equal(lastCodexMessage(file, 'task-a'), '');
  assert.equal(codexTaskState(file, 'task-a').status, 'interrupted');
  const partial = rollout(t, [...start('c', 'task-c'), ev('agent_message', { message: 'Almost done' })]);
  assert.equal(lastCodexMessage(partial, 'task-c'), '');
  const truncated = rollout(t, [ev('user_message', { message: taskMarker('x') }), ev('task_complete', { last_agent_message: 'No start' })]);
  assert.equal(lastCodexMessage(truncated, 'x'), '');
});

test('assistant quotes and tool arguments cannot claim a queued task', t => {
  const file = rollout(t, [ev('task_started', { turn_id: 'a' }), ev('agent_message', { message: taskMarker('x') }),
    ev('task_complete', { last_agent_message: 'Wrong' })]);
  assert.equal(codexTaskState(file, 'x'), null);
});

test('native hook identity, poll binding and interrupt are scoped to one thread and turn', () => {
  const tasks = new TaskTable();
  const replies = [];
  const app = { ctxFor: session => ({ session }), onStopHook: () => {} };
  const life = new CodexLifecycle({ tasks, app, link: { sendResult: (id, message) => { replies.push([id, message]); tasks.finish(id); } } });
  const a = tasks.begin('a', 'm'); const b = tasks.begin('b', 'm');
  life.handle('prompt', { session_id: 'thread-a', turn_id: 'turn-a', prompt: taskMarker(a.taskId) });
  life.handle('poll-result', { session_id: 'thread-b', turn_id: 'turn-b', tool_name: 'mcp__codie__codie_poll',
    tool_response: { content: [{ type: 'text', text: JSON.stringify([{ taskId: b.taskId }]) }] } });
  assert.equal(b.threadId, 'thread-b');
  life.handle('interrupt', { session_id: 'thread-a', turn_id: 'turn-b' });
  assert.deepEqual(replies, []);
  life.handle('interrupt', { session_id: 'thread-a', turn_id: 'turn-a' });
  assert.deepEqual(replies, [[a.taskId, INTERRUPTED]]);
  assert.ok(tasks.get(b.taskId));
  life.handle('session-end', { session_id: 'thread-a' });
  assert.deepEqual(life.openThreads(), ['thread-b']);
});

test('hook-registered threads exclude closed-but-loaded threads in the same directory', async () => {
  const threads = { closed: { id: 'closed', cwd: '/p', status: { type: 'idle' }, updatedAt: 9 },
    open: { id: 'open', cwd: '/p', status: { type: 'active' }, updatedAt: 1 } };
  const q = new CodexQueue({ knownThreads: () => ['open'],
    rpc: async ([c]) => c.method === 'thread/loaded/list' ? [{ data: ['closed', 'open'] }] : [{ thread: threads[c.params.threadId] }] });
  assert.equal(await q.pickThread(), 'open');
  q.knownThreads = () => [];
  assert.equal(await q.pickThread(), null);
});

test('cancellation deletes only the matching queued task, including later pages', async () => {
  const calls = [];
  const q = new CodexQueue({ rpc: async ([c]) => {
    calls.push(c);
    if (c.method === 'thread/queue/delete') return [{ deleted: true }];
    return c.params.cursor ? [{ data: [{ id: 'queued-a', input: [{ type: 'text', text: taskMarker('a') }] }], nextCursor: null }]
      : [{ data: [{ id: 'other', input: [{ type: 'text', text: taskMarker('b') }] }], nextCursor: 'page2' }];
  } });
  assert.equal(await q.cancel('thread', 'a'), 'removed');
  assert.deepEqual(calls.at(-1), { method: 'thread/queue/delete', params: { threadId: 'thread', queuedSubmissionId: 'queued-a' } });
});

test('a queue-start race interrupts the identified turn, never the current unrelated one', async t => {
  const file = rollout(t, [...start('turn-a', 'a')]);
  const calls = [];
  const q = new CodexQueue({ rpc: async ([c]) => {
    calls.push(c);
    if (c.method === 'thread/queue/list') return [{ data: [{ id: 'q', input: [{ type: 'text', text: taskMarker('a') }] }] }];
    if (c.method === 'thread/queue/delete') return [{ deleted: false }];
    if (c.method === 'thread/read') return [{ thread: { path: file } }];
    return [{}];
  } });
  assert.equal(await q.cancel('thread', 'a'), 'interrupted');
  assert.deepEqual(calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn-a' } });
  fs.appendFileSync(file, JSON.stringify(ev('task_complete', { turn_id: 'turn-a', last_agent_message: 'Done' })) + '\n');
  calls.length = 0;
  assert.equal(await q.cancel('thread', 'a'), 'finished');
  assert.ok(!calls.some(c => c.method === 'turn/interrupt'));
});

test('cancellation without a turn anchor does not interrupt another turn', async () => {
  const q = new CodexQueue({ rpc: async ([c]) => {
    assert.notEqual(c.method, 'turn/interrupt');
    return c.method === 'thread/queue/list' ? [{ data: [] }] : [{ thread: {} }];
  } });
  assert.equal(await q.cancel('thread', 'missing'), 'unknown');
});

test('registered threads survive an agentd restart; session-end forgets them', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-threads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const app = { ctxFor: session => ({ session }), onStopHook: () => {} };
  const mk = () => new CodexLifecycle({ tasks: new TaskTable(), app, link: {}, store });
  const life = mk();
  life.handle('prompt', { session_id: 'thread-a', turn_id: 't1', prompt: 'hello' });
  life.handle('stop', { session_id: 'thread-b', turn_id: 't2', last_assistant_message: 'ok' });
  assert.deepEqual(mk().openThreads().sort(), ['thread-a', 'thread-b']);
  life.handle('session-end', { session_id: 'thread-a' });
  assert.deepEqual(mk().openThreads(), ['thread-b']);
});

test('locate finds a task queued or started in the thread, and nothing else', async t => {
  const file = rollout(t, [...start('turn-a', 'started')]);
  const q = new CodexQueue({ rpc: async ([c]) => {
    if (c.method === 'thread/queue/list') return [{ data: [{ id: 'q', input: [{ type: 'text', text: taskMarker('queued') }] }] }];
    if (c.method === 'thread/read') return [{ thread: { path: file } }];
    return [{}];
  } });
  assert.equal(await q.locate('thread', 'queued'), 'queued');
  assert.equal(await q.locate('thread', 'started'), 'started');
  assert.equal(await q.locate('thread', 'missing'), null);
});
