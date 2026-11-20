import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskTable, ACCEPTED_MAX_AGE_MS } from '../../src/agentd/tasks.mjs';

const mk = () => { let n = 0, t = 1000; return new TaskTable({ newId: () => `t${++n}`, now: () => t, setNow: v => (t = v) }); };

test('begin returns a task; second begin on same device is busy', () => {
  const tt = mk();
  const a = tt.begin('dev1', 'm1');
  assert.equal(a.taskId, 't1');
  assert.equal(tt.begin('dev1', 'm2'), null);
  assert.equal(tt.begin('dev2', 'm3').taskId, 't2');
});

test('finish returns and removes the task; unknown id is undefined', () => {
  const tt = mk();
  tt.begin('dev1', 'm1');
  assert.equal(tt.finish('t1').deviceId, 'dev1');
  assert.equal(tt.finish('t1'), undefined);
  assert.ok(tt.begin('dev1', 'm2'), 'device free again');
});

test('oldest returns earliest pending task', () => {
  const tt = mk();
  tt.begin('dev1', 'm1');
  tt.begin('dev2', 'm2');
  assert.equal(tt.oldest().taskId, 't1');
  tt.finish('t1');
  assert.equal(tt.oldest().taskId, 't2');
  tt.finish('t2');
  assert.equal(tt.oldest(), undefined);
});

test('sweep drops tasks older than maxAge (clt01 agent.Send times out at 10 min)', () => {
  let t = 0;
  const tt = new TaskTable({ newId: () => 'x', now: () => t });
  tt.begin('dev1', 'm1');
  t = 10 * 60 * 1000 + 1;
  assert.deepEqual(tt.sweep(10 * 60 * 1000).map(x => x.taskId), ['x']);
  assert.equal(tt.pending().length, 0);
});

test('dropDevice removes that device task only', () => {
  const tt = mk();
  tt.begin('dev1', 'm1');
  tt.begin('dev2', 'm2');
  tt.dropDevice('dev1');
  assert.deepEqual(tt.pending().map(x => x.deviceId), ['dev2']);
});

test('accept frees the device for a new task; accepting twice is a no-op', () => {
  const tt = mk();
  tt.begin('dev1', 'm1');
  assert.equal(tt.accept('t1').state, 'accepted');
  assert.equal(tt.accept('t1'), null);
  assert.equal(tt.accept('nope'), null);
  assert.equal(tt.begin('dev1', 'm2').taskId, 't2', 'an accepted task does not hold the device');
  assert.equal(tt.begin('dev1', 'm3'), null, 'a waiting one still does');
});

test('sweep leaves accepted tasks; expiredAccepted lists those past their own max age', () => {
  let t = 0;
  let n = 0;
  const tt = new TaskTable({ newId: () => `t${++n}`, now: () => t });
  tt.begin('dev1', 'm1');
  tt.accept('t1');
  tt.begin('dev2', 'm2');
  t = 10 * 60 * 1000 + 1;
  assert.deepEqual(tt.sweep().map(x => x.taskId), ['t2']);
  assert.deepEqual(tt.expiredAccepted(), []);
  t = ACCEPTED_MAX_AGE_MS + 1;
  assert.deepEqual(tt.expiredAccepted().map(x => x.taskId), ['t1']);
  assert.ok(tt.get('t1'), 'listed, not removed');
});

test('a task record carries its holder, Codex thread and pending cancel; they change only through the table', () => {
  const ended = [];
  const tasks = new TaskTable({ onEnd: t => ended.push(t) });
  const a = tasks.begin('d1', 'm1');
  tasks.accept(a.taskId);
  const b = tasks.begin('d1', 'm2');
  tasks.hold(a.taskId, 's1', 'push');
  tasks.hold(b.taskId, 's2', 'poll');
  assert.deepEqual(tasks.heldBy('s1').map(t => t.taskId), [a.taskId]);
  assert.deepEqual(tasks.release(a.taskId), { sessionId: 's1', via: 'push' });
  assert.deepEqual(tasks.heldBy('s1'), []);
  assert.equal(tasks.release(a.taskId), null, 'nobody holds it any more');
  assert.equal(tasks.hold('gone', 's1', 'poll'), null);

  tasks.bindThread(b.taskId, 'th');
  assert.deepEqual([tasks.get(b.taskId).threadId, tasks.get(b.taskId).turnId], ['th', undefined]);
  tasks.bindThread(b.taskId, 'th', 'turn-1');
  assert.equal(tasks.get(b.taskId).turnId, 'turn-1');
  tasks.setCancelRequested(b.taskId, true);
  assert.equal(tasks.get(b.taskId).cancelRequested, true);

  tasks.finish(b.taskId);
  assert.deepEqual(ended.map(t => t.holder), [{ sessionId: 's2', via: 'poll' }], 'whoever ends it still sees its holder');
});
