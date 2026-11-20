import { randomUUID } from 'node:crypto';

export const TASK_MAX_AGE_MS = 10 * 60 * 1000; // clt01 agent.Send defaultTimeout
// An accepted task no longer holds the device's call (it already got the
// accept result), so clt01's timeout doesn't bound it; this does.
export const ACCEPTED_MAX_AGE_MS = 60 * 60 * 1000;

// Device tasks keyed by taskId; insertion order = arrival order, which
// oldest() relies on. A task starts waiting (the device's ask_agent call is
// open, one per device) and becomes `accepted` once a session takes it: the
// device got its result and is free, and the final answer is announced later.
// Everything known about a task lives on its record and changes only here:
// its state, who holds it, the Codex thread running it, a pending cancel.
export class TaskTable {
  // `onEnd(task)` runs whenever a task leaves the table (finish, sweep,
  // dropDevice).
  constructor({ newId = randomUUID, now = Date.now, onEnd = () => {} } = {}) {
    this.newId = newId;
    this.now = now;
    this.onEnd = onEnd;
    this.tasks = new Map();
  }

  // Null while the device already has a task it is still waiting on;
  // accepted tasks don't hold the device.
  begin(deviceId, messageId) {
    for (const t of this.tasks.values()) if (t.deviceId === deviceId && t.state !== 'accepted') return null;
    const task = { taskId: this.newId(), deviceId, messageId, state: 'waiting', startedAt: this.now() };
    this.tasks.set(task.taskId, task);
    return task;
  }

  get(taskId) { return this.tasks.get(taskId); }

  // Marks a waiting task accepted; the task, or null when it is unknown or
  // was already accepted.
  accept(taskId) {
    const t = this.tasks.get(taskId);
    if (!t || t.state === 'accepted') return null;
    t.state = 'accepted';
    t.acceptedAt = this.now();
    return t;
  }

  // Who works on the task: session `sessionId` took it, pushed to it
  // ('push') or claimed by its codie_poll ('poll'). One holder at a time.
  hold(taskId, sessionId, via) {
    const t = this.tasks.get(taskId);
    if (t) t.holder = { sessionId, via };
    return t ?? null;
  }

  // The holder lets go (interrupted, or the device cancelled); returns who held it.
  release(taskId) {
    const t = this.tasks.get(taskId);
    const holder = t?.holder ?? null;
    if (t) t.holder = null;
    return holder;
  }

  heldBy(sessionId) {
    return [...this.tasks.values()].filter(t => t.holder?.sessionId === sessionId);
  }

  // The Codex thread (and, once known, the turn) running the task.
  bindThread(taskId, threadId, turnId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    t.threadId = threadId;
    if (turnId !== undefined) t.turnId = turnId;
    return t;
  }

  // The device asked to cancel: answers that arrive meanwhile are dropped.
  // Cleared again when the cancel could not be carried out.
  setCancelRequested(taskId, on) {
    const t = this.tasks.get(taskId);
    if (t) t.cancelRequested = on;
  }

  finish(taskId) {
    const t = this.tasks.get(taskId);
    this.tasks.delete(taskId);
    if (t) this.onEnd(t);
    return t;
  }

  oldest() { return this.tasks.values().next().value; }
  pending() { return [...this.tasks.values()]; }

  dropDevice(deviceId) {
    for (const [id, t] of this.tasks) if (t.deviceId === deviceId) { this.tasks.delete(id); this.onEnd(t); }
  }

  // Drops waiting tasks older than maxAge (the device gave up on them).
  // Accepted tasks are left for expiredAccepted().
  sweep(maxAge = TASK_MAX_AGE_MS) {
    const cutoff = this.now() - maxAge;
    const dropped = [];
    for (const [id, t] of this.tasks) {
      if (t.state !== 'accepted' && t.startedAt < cutoff) { this.tasks.delete(id); dropped.push(t); this.onEnd(t); }
    }
    return dropped;
  }

  // Accepted tasks older than maxAge; the caller ends them (it tells the device).
  expiredAccepted(maxAge = ACCEPTED_MAX_AGE_MS) {
    const cutoff = this.now() - maxAge;
    return [...this.tasks.values()].filter(t => t.state === 'accepted' && t.acceptedAt < cutoff);
  }
}
