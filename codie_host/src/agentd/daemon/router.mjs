import { randomUUID } from 'node:crypto';
import { belongsToSession, pidAlive } from '../ancestry.mjs';
import { MAX_WAIT_SECONDS } from '../session-tools.mjs';
import { ACCEPTED, NOT_AVAILABLE, NOT_PICKED_UP, SESSION_CLOSED, INTERRUPTED } from '../texts.mjs';

// Routes each device task to one place, in order: a session that takes pushes
// — a Claude Code session's plugin monitor (inbox.mjs), or one started with
// the channel flag — (pushed, then confirmed from its transcript), else a
// listening session (codie_poll),
// else background dispatch (an open Codex thread, else a background Claude
// session — dispatch.mjs), else an immediate error to the device. A
// destination that fails is added to `tried` and the task routes again.
//
// Asynchronous: the moment a taker holds a task — a channel session confirmed
// the push, it was queued for listening sessions, or background execution
// took it — the device's call is answered with ACCEPTED and the device is
// free. A push that is never confirmed is rerouted first, so the device hears
// a synchronous error only if every route fails before any accept. The final
// answer, or any later failure (NOT_PICKED_UP, SESSION_CLOSED, INTERRUPTED…),
// is announced to that device (AgentsHost).

// A device message is accepted while someone listens: a poll is waiting, one
// returned within this window (the listen loop is between calls), or a task
// is still being worked on. Otherwise it is refused at once: accepting it
// would only announce a failure later.
export const LISTEN_GRACE_MS = 90_000;
// How often a queued task checks it still has a listener. While any session
// listens (a waiting poll, its grace window, or a poll-claimed task it is
// still working on — it polls again after replying) the task stays queued;
// once none does, it is routed on (usually to a NOT_PICKED_UP announce).
export const PICKUP_TIMEOUT_MS = 45_000;
// A pushed task the session doesn't confirm in this window is undelivered.
export const DELIVERY_TIMEOUT_MS = 8_000;
export const SESSION_TTL_MS = 60_000;

// How describe() names each session host.
export const HOST_LABELS = { claude: 'Claude Code', codex: 'Codex' };

const unref = t => { t.unref?.(); return t; };

export class Router {
  // `canBackground` answers refuse() before a task exists; `background(event)`
  // takes one.
  constructor({ link, tasks, background = () => false, canBackground = () => false, now = Date.now,
    pickupMs = PICKUP_TIMEOUT_MS, deliveryMs = DELIVERY_TIMEOUT_MS, onChange = () => {} }) {
    Object.assign(this, { link, tasks, background, canBackground, now, pickupMs, deliveryMs, onChange });
    this.sessions = new Map(); // id -> session
    this.inbox = new Map(); // taskId -> {event, tried, timer}, until polled
    this.pendingDelivery = new Map(); // taskId -> {sessionId, event, tried, timer}
  }

  // `mcpPid` is the session's MCP server process, `sessionPid` its host
  // (Claude Code / Codex); reap() drops the session once either is gone.
  // An `inbox` session is the plugin monitor of a Claude Code session (same
  // sessionPid as its MCP server): pushed to like a channel session, with no
  // channel flag or listening needed.
  register({ host, channel = false, inbox = false, sessionPid, mcpPid = null, cwd = null }) {
    const t = this.now();
    const s = { id: randomUUID(), host, channel, inbox, sessionPid, mcpPid, cwd, lastSeen: t, lastActive: t };
    // Internal state kept off the enumerable shape callers see.
    Object.defineProperties(s, {
      pollWaiters: { value: new Set() }, // wake callbacks of its in-flight long polls
      lastPollAt: { value: -Infinity, writable: true }, // its own listen window
      stopped: { value: false, writable: true }, // listen explicitly stopped; cleared by its next poll
      queue: { value: [] }, // events for nextEvents
      waiter: { value: null, writable: true }, // resolve fn of a pending nextEvents
    });
    this.sessions.set(s.id, s);
    this.onChange();
    return s;
  }

  get(id) { return this.sessions.get(id); }

  get size() { return this.sessions.size; }

  touch(id) {
    const s = this.sessions.get(id);
    if (s) s.lastSeen = this.now();
    return s;
  }

  active(id) {
    const s = this.touch(id);
    if (s) s.lastActive = s.lastSeen;
    return s;
  }

  unregister(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    for (const t of this.tasks.heldBy(id)) this.link.sendError(t.taskId, SESSION_CLOSED);
    for (const [taskId, p] of [...this.pendingDelivery]) {
      if (p.sessionId !== id) continue;
      this.#clearPending(taskId);
      this.#route(p.event, new Set([...p.tried, id, 'background'])); // as in confirmDelivery
    }
    this.#wakeSession(s);
    for (const wake of [...s.pollWaiters]) wake(); // a dead session stops listening now
    this.onChange();
    return true;
  }

  expire() {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const s of [...this.sessions.values()]) if (s.lastSeen < cutoff) this.unregister(s.id);
  }

  // Unregisters sessions whose MCP server or host process has exited, so a
  // killed session frees its tasks without waiting out SESSION_TTL_MS.
  // A pid the session didn't report is not checked.
  reap(alive = pidAlive) {
    for (const s of [...this.sessions.values()]) {
      const gone = [s.mcpPid, s.sessionPid].some(pid => Number.isInteger(pid) && pid > 0 && !alive(pid));
      if (gone) this.unregister(s.id);
    }
  }

  // The user interrupted session `sessionId` (it saw the marker in its own
  // record after it took `taskIds`): each of those it still claims (by push
  // or poll) and that is still pending ends with INTERRUPTED, and its listen
  // window closes. Returns how many tasks it released, or null for an unknown
  // session. Idempotent.
  interrupt(sessionId, taskIds = []) {
    const s = this.touch(sessionId);
    if (!s) return null;
    let n = 0;
    for (const taskId of new Set(taskIds.map(String))) {
      if (this.tasks.get(taskId)?.holder?.sessionId !== s.id) continue;
      this.tasks.release(taskId); // it gets no `done` for a task it gave up itself
      if (this.link.sendResult(taskId, INTERRUPTED, { asIs: true })) n++;
    }
    this.listenStop(sessionId);
    this.onChange();
    return n;
  }

  // Ties go to the earliest registered. A Windows hook without pids matches
  // every session, so this degrades to the most recently active one.
  sessionForPids(pids, host) {
    let best;
    for (const s of this.sessions.values()) {
      if (host && s.host !== host) continue;
      if (belongsToSession(pids, s.sessionPid) && (!best || s.lastActive > best.lastActive)) best = s;
    }
    return best;
  }

  // The registrations of one Claude Code session: its MCP server and its
  // inbox, paired by sessionPid. Nothing else pairs: Codex threads may share
  // one app-server process. A session that reported no sessionPid stands alone.
  #siblings(s) {
    if (!Number.isInteger(s.sessionPid)) return [s];
    return [...this.sessions.values()].filter(o => o === s
      || (o.host === s.host && o.sessionPid === s.sessionPid && o.inbox !== s.inbox));
  }

  // The ids of the tasks session `id` holds (took and has not answered).
  held(id) { return this.tasks.heldBy(id).map(t => t.taskId); }

  // Whether `s`'s Claude Code session runs the plugin monitor (its inbox).
  hasInbox(s) {
    return !!s && this.#siblings(s).some(o => o.inbox && o.channel);
  }

  // When the user last used `s`'s host session, through any of its registrations.
  #activity(s) {
    return Math.max(...this.#siblings(s).map(o => o.lastActive));
  }

  // Host sessions by app, e.g. `Claude Code ×1 (auto-receive), Codex ×2`; a group
  // is marked when a session in it takes pushes: by its plugin monitor
  // (auto-receive) or by a channel. `none` when there are none.
  describe() {
    const groups = new Map(); // label -> {n, inbox, channel}
    for (const s of this.sessions.values()) {
      const label = HOST_LABELS[s.host] ?? String(s.host);
      const g = groups.get(label) ?? { n: 0, inbox: false, channel: false };
      if (!s.inbox || this.#siblings(s).length === 1) g.n++; // an inbox counts with its MCP server
      g.inbox ||= s.inbox && s.channel;
      g.channel ||= s.channel && !s.inbox;
      groups.set(label, g);
    }
    if (!groups.size) return 'none';
    const mark = g => (g.inbox ? ' (auto-receive)' : g.channel ? ' (channel)' : '');
    return [...groups].map(([label, g]) => `${label} ×${g.n}${mark(g)}`).join(', ');
  }

  hasHost(host) {
    for (const s of this.sessions.values()) if (s.host === host) return true;
    return false;
  }

  hasPushReceiver() { return [...this.sessions.values()].some(s => s.channel); }

  // The project directory of the most recently active `host` session, or null.
  latestCwd(host) {
    let best;
    for (const s of this.sessions.values()) {
      if (s.host === host && s.cwd && (!best || s.lastActive > best.lastActive)) best = s;
    }
    return best?.cwd ?? null;
  }

  listening() {
    let busy = false;
    for (const s of this.sessions.values()) if (this.#sessionListening(s)) busy = true;
    return busy;
  }

  // Waiting in a poll, inside its own grace window, or owing a reply to a
  // task it polled. A pushed task it owes doesn't count: a channel session
  // demoted since is not listening, and new tasks queued for it would only
  // wait out PICKUP_TIMEOUT_MS before NOT_PICKED_UP.
  #sessionListening(s) {
    if (s.pollWaiters.size > 0 || this.now() - s.lastPollAt < LISTEN_GRACE_MS) return true;
    // It polls again after replying, unless it stopped.
    return !s.stopped && this.tasks.heldBy(s.id).some(t => t.holder.via === 'poll');
  }

  // AgentsHost asks before turning a message into a task.
  refuse() {
    if ([...this.sessions.values()].some(s => s.channel) || this.listening()
      || this.canBackground()) return null;
    return NOT_AVAILABLE;
  }

  onDeviceMessage(event) {
    this.#route(event, new Set());
  }

  onDeviceCancel(event) {
    const { taskId } = event;
    const holders = new Set();
    const p = this.pendingDelivery.get(taskId);
    if (p) holders.add(p.sessionId);
    this.#clearPending(taskId);
    this.#dequeue(taskId);
    // Its holder must release its local watcher, a poll client too. Released
    // here, it gets this cancel and no `done` when the task then ends.
    const holder = this.tasks.release(taskId);
    if (holder) holders.add(holder.sessionId);
    for (const id of holders) {
      const s = this.sessions.get(id);
      if (s) this.#push(s, { type: 'cancel', ...event }); // device fields word the notice
    }
  }

  // Channel sessions' long poll: queued events at once, else the first to
  // arrive within `waitMs`; [] on timeout, abort or unregister.
  nextEvents(sessionId, waitMs, signal) {
    const s = this.touch(sessionId);
    if (!s || signal?.aborted) return Promise.resolve([]);
    if (s.queue.length) return Promise.resolve(this.#drainSession(s));
    this.#wakeSession(s); // a newer call replaces the old one
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        if (s.waiter === done) s.waiter = null;
        resolve(this.sessions.get(s.id) && !signal?.aborted ? this.#drainSession(s) : []);
      };
      // Not unref'd: the caller awaits this, and it ends within waitMs anyway.
      const timer = setTimeout(done, waitMs);
      signal?.addEventListener('abort', done);
      s.waiter = done;
    });
  }

  // True when the session now holds the task.
  confirmDelivery(sessionId, taskId, ok) {
    const p = this.pendingDelivery.get(taskId);
    if (!p || p.sessionId !== sessionId) return false; // late, or not this session's
    this.#clearPending(taskId);
    // Ended before confirmation (reply, cancel, expiry): nothing to claim or
    // reroute, and no evidence the session is deaf.
    if (!this.tasks.get(taskId)) return false;
    const s = this.sessions.get(sessionId);
    if (ok) {
      if (!s) return false;
      this.tasks.hold(taskId, sessionId, 'push');
      this.link.accept(taskId, ACCEPTED); // no-op if a route before accepted it
      return true;
    }
    if (s) {
      // Its unread copy must not be handed out after the reroute.
      const i = s.queue.findIndex(e => e.type === 'task' && e.taskId === taskId);
      if (i >= 0) s.queue.splice(i, 1);
    }
    if (s?.channel) {
      s.channel = false; // pushes don't reach it; stop routing there
      this.onChange();
    }
    // Not to background dispatch: an unconfirmed push may still be running
    // in that session, and a second run would repeat its side effects.
    this.#route(p.event, new Set([...p.tried, sessionId, 'background']));
    return false;
  }

  // A task left the TaskTable (any way: a reply, Stop hook, sweep, error,
  // unpair): the session still holding it gets a `done` event, so it stops
  // watching for an interrupt on its behalf.
  onTaskEnded(task) {
    const s = this.sessions.get(task.holder?.sessionId);
    if (s) this.#push(s, { type: 'done', taskId: task.taskId });
  }

  // The wait runs on the real clock; the listen window on the injected now().
  async poll(sessionId, waitSeconds, signal) {
    const wait = Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS);
    const deadline = Date.now() + wait * 1000;
    // A call cancelled before it ran must not take tasks it can't return.
    if (signal?.aborted) return [];
    const s = this.touch(sessionId);
    if (!s) return [];
    s.lastPollAt = this.now();
    s.stopped = false;
    let events = this.#drainInbox(s);
    while (!events.length && Date.now() < deadline && !signal?.aborted) {
      await this.#waitForMessage(s, deadline - Date.now(), signal);
      // An aborted call's result is discarded, so leave the tasks queued.
      if (signal?.aborted || !this.sessions.has(sessionId)) break;
      events = this.#drainInbox(s);
    }
    if (this.sessions.has(sessionId)) s.lastPollAt = this.now();
    return events;
  }

  // Closes only the caller's window; queued tasks stay while another session
  // listens. The caller's own claims stay too: it still owes those replies,
  // but they no longer count as listening (until it polls again).
  listenStop(sessionId) {
    const s = this.touch(sessionId);
    if (s) { s.lastPollAt = -Infinity; s.stopped = true; }
    for (const o of this.sessions.values()) if (o.id !== sessionId && this.#sessionListening(o)) return 0;
    const queued = [...this.inbox.values()];
    for (const q of queued) {
      this.#dequeue(q.event.taskId);
      this.#route(q.event, new Set([...q.tried, 'listen']));
    }
    return queued.length;
  }

  #route(event, tried) {
    const { taskId } = event;
    if (!this.tasks.get(taskId)) return; // cancelled, replied or swept

    // A pinned Codex request must never be picked up by an unrelated listener.
    if (event.routing) {
      if (this.background(event)) this.link.accept(taskId, ACCEPTED);
      else this.link.sendError(taskId, 'No connected Codex session is available. Open the target session and try again.');
      return;
    }

    let target;
    for (const s of this.sessions.values()) {
      if (s.channel && !tried.has(s.id) && (!target || this.#activity(s) > this.#activity(target))) target = s;
    }
    if (target) {
      const timer = unref(setTimeout(() => this.confirmDelivery(target.id, taskId, false), this.deliveryMs));
      this.pendingDelivery.set(taskId, { sessionId: target.id, event, tried, timer });
      this.#push(target, { type: 'task', ...event });
      return; // accepted once the session confirms delivery
    }

    if (!tried.has('listen') && this.listening()) {
      this.inbox.set(taskId, { event, tried, timer: this.#pickupTimer(event, tried) });
      this.link.accept(taskId, ACCEPTED);
      for (const s of this.sessions.values()) for (const wake of [...s.pollWaiters]) wake();
      return;
    }

    if (!tried.has('background') && this.background(event)) {
      this.link.accept(taskId, ACCEPTED);
      return;
    }

    this.link.sendError(taskId, tried.has('listen') ? NOT_PICKED_UP : NOT_AVAILABLE);
  }

  // Re-arms while someone still listens: the device isn't waiting, so a
  // listener busy with an earlier task is no reason to fail this one. A task
  // that ended meanwhile (reply, cancel, accepted-task max age) just leaves.
  #pickupTimer(event, tried) {
    const { taskId } = event;
    return unref(setTimeout(() => {
      const q = this.inbox.get(taskId);
      if (!q) return;
      if (!this.tasks.get(taskId)) { this.#dequeue(taskId); return; }
      if (this.listening()) { q.timer = this.#pickupTimer(event, tried); return; }
      this.#dequeue(taskId);
      this.#route(event, new Set([...tried, 'listen']));
    }, this.pickupMs));
  }

  #push(s, ev) {
    s.queue.push(ev);
    this.#wakeSession(s);
  }

  #wakeSession(s) {
    const w = s.waiter;
    s.waiter = null;
    w?.();
  }

  // A task event is handed out only while its delivery to this session is
  // pending: not after it ended or was rerouted. Cancels pass through.
  #drainSession(s) {
    return s.queue.splice(0).filter(e => e.type !== 'task' || this.pendingDelivery.get(e.taskId)?.sessionId === s.id);
  }

  #clearPending(taskId) {
    const p = this.pendingDelivery.get(taskId);
    if (p) clearTimeout(p.timer);
    return this.pendingDelivery.delete(taskId);
  }

  #dequeue(taskId) {
    const q = this.inbox.get(taskId);
    if (q) clearTimeout(q.timer);
    return this.inbox.delete(taskId);
  }

  // Hands every live queued task to `s`; dead ones are dropped.
  #drainInbox(s) {
    const events = [];
    for (const { event } of [...this.inbox.values()]) {
      this.#dequeue(event.taskId);
      if (!this.tasks.get(event.taskId)) continue;
      this.tasks.hold(event.taskId, s.id, 'poll');
      events.push(event);
    }
    return events;
  }

  // Resolves on a new message, after `ms`, or when `signal` aborts.
  #waitForMessage(s, ms, signal) {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); s.pollWaiters.delete(done); resolve(); };
      // Not unref'd: the caller awaits this, and it ends within ms anyway.
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done);
      s.pollWaiters.add(done);
    });
  }
}
