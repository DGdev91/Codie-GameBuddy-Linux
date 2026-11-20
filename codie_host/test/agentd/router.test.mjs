import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskTable } from '../../src/agentd/tasks.mjs';
import { NOT_AVAILABLE, NOT_PICKED_UP, SESSION_CLOSED, INTERRUPTED, ACCEPTED } from '../../src/agentd/texts.mjs';
import { Router, LISTEN_GRACE_MS } from '../../src/agentd/daemon/router.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function mk(over = {}) {
  const tasks = new TaskTable();
  const errors = [];
  const results = [];
  const accepts = [];
  const link = { sendError: (t, m) => { if (tasks.finish(t)) errors.push([t, m]); return true; },
    sendResult: (t, m) => { if (!tasks.finish(t)) return false; results.push([t, m]); return true; },
    accept: (t, m) => { if (!tasks.accept(t)) return false; accepts.push([t, m]); return true; } };
  let clock = 1_000_000;
  const router = new Router({ link, tasks, now: () => clock, pickupMs: 30, deliveryMs: 30, ...over });
  const msg = (dev = 'd1', text = 'list files') => { const t = tasks.begin(dev, `m-${dev}`); const e = { taskId: t.taskId, deviceId: dev, deviceName: 'Living room', text }; router.onDeviceMessage(e); return e; };
  return { router, tasks, errors, results, accepts, msg, advance: ms => { clock += ms; } };
}

test('nobody to take it → refused before a task exists, and errored if it slips through', () => {
  const { router, msg, errors } = mk();
  assert.equal(router.refuse(), NOT_AVAILABLE);
  const e = msg();
  assert.deepEqual(errors, [[e.taskId, NOT_AVAILABLE]]);
});

test('a channel session gets the task as an event; confirmation claims it', async () => {
  const { router, msg, tasks } = mk();
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  assert.equal(router.refuse(), null);
  const e = msg();
  const [ev] = await router.nextEvents(s.id, 1000);
  assert.deepEqual({ type: ev.type, taskId: ev.taskId, text: ev.text }, { type: 'task', taskId: e.taskId, text: 'list files' });
  router.confirmDelivery(s.id, e.taskId, true);
  await sleep(150);
  assert.ok(tasks.get(e.taskId), 'not rerouted after confirmation');
  assert.equal(router.listening(), false, 'a pushed task is not listening');
  assert.equal(router.refuse(), null, 'the channel session takes new tasks');
});

test('a demoted channel session owing a pushed task does not count as listening', async () => {
  const { router, msg, errors } = mk({ deliveryMs: 10_000, pickupMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e1 = msg();
  await router.nextEvents(s.id, 100);
  router.confirmDelivery(s.id, e1.taskId, true); // claimed by push
  router.get(s.id).channel = false; // demoted since (e.g. a later push went unseen)
  assert.equal(router.listening(), false);
  assert.equal(router.refuse(), NOT_AVAILABLE);
  const e2 = msg('d2'); // another device: d1 still has e1 open
  assert.deepEqual(errors, [[e2.taskId, NOT_AVAILABLE]], 'turned away at once, not queued for a pickup that never comes');
  router.unregister(s.id);
  assert.deepEqual(errors[1], [e1.taskId, SESSION_CLOSED], 'its pushed task still errors when it closes');
});

test('undelivered push marks the session non-channel and falls through to listening', async () => {
  const { router, msg } = mk();
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const l = router.register({ host: 'codex', sessionPid: 2 });
  await router.poll(l.id, 0); // l is listening
  const e = msg();
  await router.nextEvents(s.id, 1000);
  router.confirmDelivery(s.id, e.taskId, false);
  assert.equal(router.get(s.id).channel, false);
  const got = await router.poll(l.id, 1);
  assert.equal(got[0].taskId, e.taskId);
});

test('no confirmation within deliveryMs counts as undelivered', async () => {
  const { router, msg, errors } = mk();
  router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e = msg();
  await sleep(150);
  assert.deepEqual(errors, [[e.taskId, NOT_AVAILABLE]]);
});

test('channel sessions are preferred over listening ones, most recently active first', async () => {
  const { router, msg, advance } = mk();
  const a = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  advance(10);
  const b = router.register({ host: 'claude', channel: true, sessionPid: 2 });
  const l = router.register({ host: 'codex', sessionPid: 3 });
  await router.poll(l.id, 0);
  advance(10); router.active(a.id);
  msg();
  assert.equal((await router.nextEvents(a.id, 100)).length, 1);
  assert.equal((await router.nextEvents(b.id, 20)).length, 0);
});

test('queued for listening but never polled → NOT_PICKED_UP once nobody listens', async () => {
  const { router, msg, errors, advance } = mk();
  const l = router.register({ host: 'codex', sessionPid: 3 });
  await router.poll(l.id, 0);
  const e = msg();
  await sleep(100);
  assert.deepEqual(errors, [], 'still inside its listen window: stays queued');
  advance(LISTEN_GRACE_MS);
  await sleep(100);
  assert.deepEqual(errors, [[e.taskId, NOT_PICKED_UP]]);
});

test('listenStop hands queued tasks on immediately and closes the window', async () => {
  const { router, msg, errors } = mk({ pickupMs: 10_000 });
  const l = router.register({ host: 'codex', sessionPid: 3 });
  await router.poll(l.id, 0);
  const e = msg();
  assert.equal(router.listenStop(l.id), 1);
  assert.deepEqual(errors, [[e.taskId, NOT_PICKED_UP]]);
  assert.equal(router.refuse(), NOT_AVAILABLE);
});

test('long poll wakes on a new task; an aborted poll takes nothing', async () => {
  const { router, msg } = mk({ pickupMs: 10_000 });
  const l = router.register({ host: 'codex', sessionPid: 3 });
  const ac = new AbortController(); ac.abort();
  assert.deepEqual(await router.poll(l.id, 5, ac.signal), []);
  const waiting = router.poll(l.id, 5);
  await sleep(10);
  const e = msg();
  assert.equal((await waiting)[0].taskId, e.taskId);
});

test('a listening grace window expires', () => {
  const { router, advance } = mk();
  const l = router.register({ host: 'codex', sessionPid: 3 });
  router.poll(l.id, 0);
  assert.equal(router.listening(), true);
  advance(LISTEN_GRACE_MS + 1);
  assert.equal(router.listening(), false);
});

test('device cancel reaches the channel session that holds the task', async () => {
  const { router, msg } = mk({ deliveryMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e = msg();
  await router.nextEvents(s.id, 100);
  router.confirmDelivery(s.id, e.taskId, true);
  router.onDeviceCancel({ taskId: e.taskId });
  assert.deepEqual((await router.nextEvents(s.id, 100)).map(x => x.type), ['cancel']);
});

test('closing a session errors the tasks it claimed', async () => {
  const { router, msg, errors } = mk({ deliveryMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e = msg();
  await router.nextEvents(s.id, 100);
  router.confirmDelivery(s.id, e.taskId, true);
  router.unregister(s.id);
  assert.deepEqual(errors, [[e.taskId, SESSION_CLOSED]]);
});

test('sessions that stop calling in expire', () => {
  const { router, advance } = mk();
  const s = router.register({ host: 'codex', sessionPid: 3 });
  advance(61_000);
  router.expire();
  assert.equal(router.get(s.id), undefined);
});

test('stop hooks map to the session whose pid is in the chain', () => {
  const { router } = mk();
  const a = router.register({ host: 'claude', sessionPid: 10 });
  router.register({ host: 'claude', sessionPid: 20 });
  assert.equal(router.sessionForPids([5, 10, 1]).id, a.id);
});

// win32 can't read the process chain, so any session matches there.
test('a pid chain outside every session maps to none', { skip: process.platform === 'win32' }, () => {
  const { router } = mk();
  router.register({ host: 'claude', sessionPid: 10 });
  router.register({ host: 'claude', sessionPid: 20 });
  assert.equal(router.sessionForPids([5, 6]), undefined);
});

test('a rerouted push is not handed to the demoted session later', async () => {
  const { router, msg } = mk({ pickupMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const l = router.register({ host: 'codex', sessionPid: 2 });
  await router.poll(l.id, 0);
  const e = msg();
  await sleep(150); // unread and unconfirmed → rerouted to the listener
  assert.equal((await router.poll(l.id, 0))[0].taskId, e.taskId);
  assert.deepEqual(await router.nextEvents(s.id, 20), []);
});

test('a task that ends before confirmation does not demote the session', async () => {
  const { router, msg, tasks } = mk();
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e = msg();
  tasks.finish(e.taskId); // replied or expired
  await sleep(150);
  assert.equal(router.get(s.id).channel, true);
  assert.deepEqual(await router.nextEvents(s.id, 20), []);
});

test('unregistering a session ends its in-flight poll and its listening', async () => {
  const { router, advance } = mk();
  const l = router.register({ host: 'codex', sessionPid: 3 });
  const p = router.poll(l.id, 5);
  router.unregister(l.id);
  advance(1); // still inside the grace window it had
  assert.equal(router.listening(), false);
  assert.deepEqual(await p, []);
});

test('canBackground lets refuse() accept with nobody listening', () => {
  const { router } = mk({ canBackground: () => true });
  assert.equal(router.refuse(), null);
});

test('device cancel reaches a push claimant even after it was demoted', async () => {
  const { router, msg } = mk({ deliveryMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e1 = msg('d1');
  await router.nextEvents(s.id, 100);
  router.confirmDelivery(s.id, e1.taskId, true);
  const e2 = msg('d2');
  await router.nextEvents(s.id, 100);
  router.confirmDelivery(s.id, e2.taskId, false); // demoted
  assert.equal(router.get(s.id).channel, false);
  router.onDeviceCancel({ taskId: e1.taskId });
  assert.deepEqual((await router.nextEvents(s.id, 100)).map(x => [x.type, x.taskId]), [['cancel', e1.taskId]]);
});

test("listenStop closes only the caller's window", async () => {
  const { router, msg, errors } = mk({ pickupMs: 10_000 });
  const a = router.register({ host: 'codex', sessionPid: 3 });
  const b = router.register({ host: 'codex', sessionPid: 4 });
  await router.poll(a.id, 0);
  await router.poll(b.id, 0);
  const e = msg();
  assert.equal(router.listenStop(a.id), 0, 'b still listens, so the task stays queued');
  assert.deepEqual(errors, []);
  assert.equal((await router.poll(b.id, 0))[0].taskId, e.taskId);
  const e2 = msg('d2');
  assert.equal(router.listenStop(b.id), 1);
  assert.deepEqual(errors, [[e2.taskId, NOT_PICKED_UP]]);
});

test('unregistering a session with a pending push reroutes to the next channel session', async () => {
  const { router, msg, advance } = mk({ deliveryMs: 10_000 });
  const a = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  advance(10);
  const b = router.register({ host: 'claude', channel: true, sessionPid: 2 });
  const e = msg();
  assert.equal((await router.nextEvents(b.id, 100))[0].taskId, e.taskId);
  router.unregister(b.id);
  assert.equal((await router.nextEvents(a.id, 100))[0].taskId, e.taskId);
});

test('a poll aborted mid-wait leaves the task queued', async () => {
  const { router, msg } = mk({ pickupMs: 10_000 });
  const l = router.register({ host: 'codex', sessionPid: 3 });
  const ac = new AbortController();
  const p = router.poll(l.id, 5, ac.signal);
  await sleep(10);
  ac.abort();
  const e = msg(); // lands before the aborted poll resumes
  assert.deepEqual(await p, []);
  assert.equal((await router.poll(l.id, 0))[0].taskId, e.taskId);
});

test('the last listener stopping hands queued tasks on even while it owes a reply', async () => {
  const { router, msg, errors, tasks } = mk({ pickupMs: 10_000 });
  const l = router.register({ host: 'codex', sessionPid: 3 });
  await router.poll(l.id, 0);
  const e1 = msg('d1');
  assert.equal((await router.poll(l.id, 0))[0].taskId, e1.taskId); // claimed, unfinished
  const e2 = msg('d2');
  assert.equal(router.listenStop(l.id), 1);
  assert.deepEqual(errors, [[e2.taskId, NOT_PICKED_UP]]);
  assert.ok(tasks.get(e1.taskId), 'its own claim stays');
  assert.equal(router.listening(), false, 'it owes the reply, but stopped listening: not listening on its behalf');
  assert.equal(router.refuse(), NOT_AVAILABLE, 'new messages are refused, not accepted for it');
  await router.poll(l.id, 0); // listening again
  assert.equal(router.refuse(), null);
});

test('interrupt answers every task the session claimed (push and poll) with INTERRUPTED; idempotent', async () => {
  const { router, msg, results, errors, tasks } = mk({ deliveryMs: 10_000, pickupMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const other = router.register({ host: 'codex', sessionPid: 2 });
  const pushed = msg('d1');
  await router.nextEvents(s.id, 100);
  router.confirmDelivery(s.id, pushed.taskId, true);
  router.get(s.id).channel = false; // so the next tasks queue for pollers
  const polled = router.poll(s.id, 1);
  const e2 = msg('d2');
  assert.equal((await polled)[0].taskId, e2.taskId);
  const theirs = router.poll(other.id, 1);
  const e3 = msg('d3');
  assert.equal((await theirs)[0].taskId, e3.taskId);

  assert.equal(router.interrupt(s.id, []), 0, 'no ids: nothing released');
  assert.equal(router.interrupt(s.id, [pushed.taskId, e2.taskId, e3.taskId]), 2, "only its own claims; e3 is the other session's");
  assert.deepEqual(results.sort(), [[pushed.taskId, INTERRUPTED], [e2.taskId, INTERRUPTED]].sort());
  assert.deepEqual(router.held(s.id), []);
  assert.ok(tasks.get(e3.taskId), "another session's task is untouched");
  assert.deepEqual(router.held(other.id), [e3.taskId]);
  assert.equal(router.interrupt(s.id, [pushed.taskId, e2.taskId]), 0, 'again: nothing left');
  assert.equal(results.length, 2);
  assert.deepEqual(errors, []);
  assert.equal(router.interrupt('nope'), null);
});

test('interrupt closes the session\'s listen window', async () => {
  const { router, msg, errors } = mk({ pickupMs: 10_000 });
  const s = router.register({ host: 'codex', sessionPid: 1 });
  await router.poll(s.id, 0);
  assert.equal(router.listening(), true);
  router.interrupt(s.id, []);
  assert.equal(router.listening(), false);
  const e = msg();
  assert.deepEqual(errors, [[e.taskId, NOT_AVAILABLE]], 'not queued for a listener that stopped');
});

test('reap unregisters sessions whose MCP server or host process is gone', () => {
  const { router, tasks, errors } = mk();
  const dead = new Set([666, 777]);
  const alive = pid => !dead.has(pid);
  const a = router.register({ host: 'codex', sessionPid: 1, mcpPid: 666 });
  const b = router.register({ host: 'codex', sessionPid: 777, mcpPid: 2 });
  const c = router.register({ host: 'codex', sessionPid: 1, mcpPid: 2 });
  const d = router.register({ host: 'codex', sessionPid: null }); // an old client: no pids to check
  const t = tasks.begin('d1', 'm1');
  tasks.hold(t.taskId, a.id, 'poll');
  router.reap(alive);
  assert.equal(router.get(a.id), undefined);
  assert.equal(router.get(b.id), undefined);
  assert.ok(router.get(c.id));
  assert.ok(router.get(d.id));
  assert.deepEqual(errors, [[t.taskId, SESSION_CLOSED]]);
});

test('a claimed task that ends any other way sends its session a done event', async () => {
  const { router, msg, tasks } = mk({ pickupMs: 10_000 });
  const s = router.register({ host: 'codex', sessionPid: 1 });
  const other = router.register({ host: 'codex', sessionPid: 2 });
  const polled = router.poll(s.id, 1);
  const e = msg();
  await polled;
  router.onTaskEnded(tasks.finish(e.taskId)); // e.g. the Stop hook answered it, or the sweep dropped it
  assert.deepEqual(await router.nextEvents(s.id, 10), [{ type: 'done', taskId: e.taskId }]);
  assert.deepEqual(router.held(s.id), []);
  assert.deepEqual(await router.nextEvents(other.id, 10), [], 'only the claimant hears');
});

test('confirmDelivery says whether the session now holds the task', async () => {
  const { router, msg, tasks } = mk({ deliveryMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e = msg();
  assert.equal(router.confirmDelivery(s.id, e.taskId, true), true);
  const e2 = msg('d2');
  tasks.finish(e2.taskId);
  assert.equal(router.confirmDelivery(s.id, e2.taskId, true), false, 'ended before confirmation');
  assert.equal(router.confirmDelivery(s.id, 'nope', true), false);
});

test('a pushed task is accepted when the session confirms delivery, not when it is sent', async () => {
  const { router, msg, accepts, tasks } = mk({ deliveryMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e = msg();
  await router.nextEvents(s.id, 100);
  assert.deepEqual(accepts, [], 'not yet: the push may go unseen');
  assert.equal(router.confirmDelivery(s.id, e.taskId, true), true);
  assert.deepEqual(accepts, [[e.taskId, ACCEPTED]]);
  assert.equal(tasks.get(e.taskId).state, 'accepted');
});

test('an unconfirmed push is accepted by the taker that finally holds it, once', async () => {
  const { router, msg, accepts } = mk({ pickupMs: 10_000 });
  const s = router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const l = router.register({ host: 'codex', sessionPid: 2 });
  await router.poll(l.id, 0);
  const e = msg();
  await router.nextEvents(s.id, 100);
  router.confirmDelivery(s.id, e.taskId, false); // rerouted to the listen queue
  assert.deepEqual(accepts, [[e.taskId, ACCEPTED]], 'accepted when queued');
  assert.equal((await router.poll(l.id, 1))[0].taskId, e.taskId);
  assert.equal(accepts.length, 1);
});

test('an unconfirmed push with no other route is a synchronous error, never accepted', async () => {
  const { router, msg, accepts, errors } = mk();
  router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e = msg();
  await sleep(100); // deliveryMs passes
  assert.deepEqual(accepts, []);
  assert.deepEqual(errors, [[e.taskId, NOT_AVAILABLE]]);
});

test('a queued task waits while the listener works on an earlier polled task, and fails once it stops listening', async () => {
  const { router, msg, errors, advance } = mk();
  const l = router.register({ host: 'codex', sessionPid: 2 });
  await router.poll(l.id, 0);
  const e1 = msg('d1');
  await router.poll(l.id, 0); // claims e1, works on it for a long while
  advance(LISTEN_GRACE_MS * 3); // its own grace window long gone
  const e2 = msg('d2');
  await sleep(150); // several pickup windows
  assert.deepEqual(errors, [], 'still listening: it owes e1 and will poll again');
  router.unregister(l.id);
  await sleep(100);
  assert.deepEqual(errors, [[e1.taskId, SESSION_CLOSED], [e2.taskId, NOT_PICKED_UP]]);
});

test('a queued task that ended meanwhile (e.g. its accepted max age) just leaves the queue', async () => {
  const { router, msg, errors, tasks, advance } = mk();
  const l = router.register({ host: 'codex', sessionPid: 2 });
  await router.poll(l.id, 0);
  const e = msg();
  tasks.finish(e.taskId);
  advance(LISTEN_GRACE_MS);
  await sleep(100);
  assert.deepEqual(errors, []);
  assert.equal(router.inbox.size, 0);
});

test('a task queued for listening sessions is accepted at once', async () => {
  const { router, msg, accepts } = mk({ pickupMs: 10_000 });
  const l = router.register({ host: 'codex', sessionPid: 2 });
  await router.poll(l.id, 0);
  const e = msg();
  assert.deepEqual(accepts, [[e.taskId, ACCEPTED]]);
});

test('a task nobody can take is not accepted: the device gets a synchronous error', () => {
  const { msg, accepts, errors } = mk();
  const e = msg();
  assert.deepEqual(accepts, []);
  assert.deepEqual(errors, [[e.taskId, NOT_AVAILABLE]]);
});

test('background execution that takes the task accepts it', () => {
  const { msg, accepts } = mk({ background: () => true });
  const e = msg();
  assert.deepEqual(accepts, [[e.taskId, ACCEPTED]]);
});

test('interrupt announces INTERRUPTED as-is (no done prefix)', async () => {
  const tasks = new TaskTable();
  const calls = [];
  const link = { accept: t => !!tasks.accept(t), sendError: t => !!tasks.finish(t),
    sendResult: (t, m, o) => { calls.push([m, o]); return !!tasks.finish(t); } };
  const router = new Router({ link, tasks, pickupMs: 10_000, deliveryMs: 10_000 });
  const l = router.register({ host: 'codex', sessionPid: 2 });
  await router.poll(l.id, 0);
  const t = tasks.begin('d1', 'm1');
  router.onDeviceMessage({ taskId: t.taskId, deviceId: 'd1', text: 'x' });
  await router.poll(l.id, 0);
  assert.equal(router.interrupt(l.id, [t.taskId]), 1);
  assert.deepEqual(calls, [[INTERRUPTED, { asIs: true }]]);
});

test('an unconfirmed channel push is not rerouted to background dispatch (it may still run there)', async () => {
  let taken = 0;
  const { router, msg, errors } = mk({ background: () => { taken++; return true; }, canBackground: () => true });
  router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const e = msg();
  await sleep(150); // deliveryMs passes without confirmation
  assert.equal(taken, 0);
  assert.deepEqual(errors, [[e.taskId, NOT_AVAILABLE]]);
  const e2 = msg('d2'); // the demoted session is no longer a target: background takes the next task
  assert.equal(taken, 1);
  assert.ok(e2);
});

test('an inbox session (plugin monitor) is pushed to like a channel session', async () => {
  const { router, msg, accepts } = mk();
  router.register({ host: 'claude', sessionPid: 7, mcpPid: 70 }); // the same Claude Code's MCP server
  const inbox = router.register({ host: 'claude', channel: true, inbox: true, sessionPid: 7, mcpPid: 71 });
  assert.equal(router.refuse(), null, 'no channel flag and no listening needed');
  const e = msg();
  const [ev] = await router.nextEvents(inbox.id, 1000);
  assert.equal(ev.taskId, e.taskId);
  router.confirmDelivery(inbox.id, e.taskId, true);
  assert.deepEqual(accepts, [[e.taskId, ACCEPTED]]);
});

test('push targets rank by their Claude Code session: activity on its MCP server counts for its inbox', async () => {
  const { router, msg, advance } = mk({ deliveryMs: 10_000 }); // no reroute on an unconfirmed push
  const mcpA = router.register({ host: 'claude', sessionPid: 1 });
  const inboxA = router.register({ host: 'claude', channel: true, inbox: true, sessionPid: 1 });
  advance(10);
  router.register({ host: 'claude', sessionPid: 2 });
  const inboxB = router.register({ host: 'claude', channel: true, inbox: true, sessionPid: 2 });
  advance(10);
  router.active(mcpA.id); // the user just used session A (a tool call or its Stop hook)
  msg();
  assert.equal((await router.nextEvents(inboxA.id, 100)).length, 1);
  assert.equal((await router.nextEvents(inboxB.id, 20)).length, 0);
});

test('describe counts one Claude Code per session, its inbox included, and marks auto-receive', () => {
  const { router } = mk();
  router.register({ host: 'claude', sessionPid: 1 });
  router.register({ host: 'claude', channel: true, inbox: true, sessionPid: 1 });
  router.register({ host: 'codex', sessionPid: 2 });
  assert.equal(router.describe(), 'Claude Code ×1 (auto-receive), Codex ×1');
});

test('describe merges only an inbox with its MCP server: other sessions sharing a host process count apart', () => {
  const { router } = mk();
  router.register({ host: 'codex', sessionPid: 5 }); // two Codex threads behind one app-server process
  router.register({ host: 'codex', sessionPid: 5 });
  router.register({ host: 'claude', channel: true, inbox: true, sessionPid: 9 }); // an inbox whose MCP server is not registered (yet)
  assert.equal(router.describe(), 'Codex ×2, Claude Code ×1 (auto-receive)'); // groups in registration order
});


test('explicit Codex routing bypasses unrelated channel and polling sessions', () => {
  const events = [];
  const { router, tasks, accepts } = mk({ background: e => { events.push(e); return true; } });
  router.register({ host: 'claude', channel: true, sessionPid: 1 });
  const t = tasks.begin('d1', 'm-target');
  const event = { taskId: t.taskId, deviceId: 'd1', text: 'continue', routing: { mode: 'continue' } };
  router.onDeviceMessage(event);
  assert.deepEqual(events, [event]);
  assert.deepEqual(accepts, [[t.taskId, ACCEPTED]]);
});
