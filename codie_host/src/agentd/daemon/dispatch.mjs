import { INTERRUPTED, DEVICE_TRUST, NO_REPLY, START_FAILED, SEND_UNKNOWN, CANCEL_UNCONFIRMED, START_UNTRUSTED } from '../texts.mjs';

// Hands a device task to a host without anyone listening:
// - Codex: queued into the most recently used open thread of the shared Codex
//   app-server daemon (`codex queue`); the user sees it run in that window.
// - Claude Code: run in a fresh background session (`claude --bg`), stopped
//   when done. Today's earlier device exchanges in that project go into the
//   prompt, so the conversation carries over. (Resuming one session instead
//   loses the plugin: `claude --bg --resume` starts the turn before its MCP
//   servers reconnect, so codie_reply is missing.)
// Either way the session answers with codie_reply. Without one, a Claude turn
// is answered by the Stop hook (the prompt carries the task_id tag); a Codex
// turn by its last message, read from the thread's rollout. A session that
// goes idle with neither ends the task with NO_REPLY.

// A cancel is confirmed within the device's cancel_task deadline (20 s).
export const CANCEL_WAIT_MS = 15_000;
// A send that failed is looked for in the thread this many times before it
// counts as never delivered (the queue entry may land late).
const LOCATE_TRIES = 3;
export const POLL_MS = 3000;
// After the session goes idle, how long a reply may still take to arrive.
export const REPLY_GRACE_MS = 15_000;
// A just-started job may not show as busy yet; idle before this isn't "done".
export const START_GRACE_MS = 20_000;
// After the task ends, how long a still-busy background session may finish its turn.
export const STOP_WAIT_MS = 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// What the session is asked to do: the user's words first (a bracketed
// header reads like a system notice, which a model may decline to answer),
// then how to answer. `task_id="…"` is the tag the Stop hook and the
// interrupt watch look for.
export function taskPrompt({ taskId, deviceId, deviceName, text }, history = []) {
  const earlier = history.length
    ? ['', '(For reference, my earlier conversation with you through the device today:', ...history.map(h => `- Me: ${h.q}\n  You: ${h.a}`), ')']
    : [];
  return [
    `I (the user) said to you through the Codie voice device "${deviceName || deviceId}":`,
    String(text ?? ''),
    ...earlier,
    '',
    `Do it as you would a request I typed in the terminal. When done (or unable to do it), call codie_reply once to tell me the result (Codie voice task task_id="${taskId}"): `
      + 'summary is a spoken-style summary, 1-3 short sentences, under 200 characters, no code, no file paths, no markdown (the device reads it aloud), in the language I used.',
    DEVICE_TRUST,
  ].join('\n');
}

// Picks a backend for each task and watches it until the task ends.
export class Dispatcher {
  constructor({ tasks, link, codex, claude, log = () => {}, settings = () => ({}),
    hasCodexSession = () => false, claudeCwd = () => null, spoken = t => t,
    routingState = new Map(), pollMs = POLL_MS, graceMs = REPLY_GRACE_MS, startGraceMs = START_GRACE_MS, stopWaitMs = STOP_WAIT_MS,
    cancelWaitMs = CANCEL_WAIT_MS, cancelPollMs = 500, now = Date.now }) {
    Object.assign(this, { tasks, link, codex, claude, log, settings, hasCodexSession, claudeCwd, spoken,
      routingState, pollMs, graceMs, startGraceMs, stopWaitMs, cancelWaitMs, cancelPollMs, now });
    this.codexThread = null; // cached by refresh(): routing decides synchronously
    this.jobs = 0;
    this.refreshSeq = 0;
    this.codexJobs = new Map();
  }

  #codexOn() { return this.settings().codexQueue !== false && !!this.codex; }
  #claudeOn() { return this.settings().claudeBackground !== false && !!this.claude; }

  // Which backend would take a task now: 'codex', 'claude' or null.
  backend() {
    if (this.#codexOn() && this.hasCodexSession() && this.codexThread) return 'codex';
    if (this.#claudeOn() && this.claudeCwd()) return 'claude';
    return null;
  }

  available() { return this.backend() !== null; }

  // Stops a Codex task (one this dispatcher queued, or one a hook bound to a
  // thread); resolves once it is seen stopped, within cancelWaitMs, else
  // throws CANCEL_UNCONFIRMED. A task without a Codex thread is not Codex's.
  async cancel(event) {
    const job = this.codexJobs.get(event.taskId);
    const threadId = job?.threadId ?? event.threadId;
    if (!threadId) return;
    if (!this.codex?.cancel) throw new Error(CANCEL_UNCONFIRMED);
    const end = this.now() + this.cancelWaitMs;
    // A send already in flight must finish before we inspect its queue entry.
    if (job?.sending) await Promise.race([job.sending.catch(() => {}), sleep(this.cancelWaitMs)]);
    let result = 'unknown';
    for (let look = 0; look < LOCATE_TRIES && result === 'unknown' && this.now() < end; look++) {
      if (look) await sleep(this.cancelPollMs);
      result = await this.codex.cancel(threadId, event.taskId, event.turnId);
    }
    if (result === 'removed' || result === 'finished') return;
    if (result === 'interrupted') {
      while (this.now() < end) {
        if (await this.#stopped(threadId, event.taskId)) return;
        await sleep(this.cancelPollMs);
      }
    }
    this.log(`task ${event.taskId}: cancelling in Codex thread ${threadId} not confirmed (${result})`);
    throw new Error(CANCEL_UNCONFIRMED);
  }

  // The interrupted turn is over: its rollout says so, or, without a
  // rollout record, the thread is no longer busy.
  async #stopped(threadId, taskId) {
    try {
      const state = await this.codex.taskState?.(threadId, taskId);
      if (state) return state.status !== 'inProgress';
      return (await this.codex.status(threadId)) !== 'busy';
    } catch {
      return false;
    }
  }

  // After a failed send: 'queued'/'started' (the thread got it after all),
  // null (it never did), or undefined (it cannot be checked).
  async #locate(threadId, taskId) {
    try {
      for (let look = 0; look < LOCATE_TRIES; look++) {
        if (look) await sleep(this.pollMs);
        const where = await this.codex.locate(threadId, taskId);
        if (where) return where;
      }
      return null;
    } catch (e) {
      this.log(`task ${taskId}: checking Codex thread ${threadId} failed`, e?.message ?? e);
      return undefined;
    }
  }

  // Takes the task (the Router accepts it) or returns false.
  take(event) {
    const backend = event.routing ? (this.#codexOn() && this.hasCodexSession() ? 'codex' : null) : this.backend();
    if (!backend) return false;
    this.jobs++;
    this.#run(event, backend, this.claudeCwd())
      .catch(e => this.log('dispatch failed', e?.message ?? e))
      .finally(() => { this.jobs--; this.codexJobs.delete(event.taskId); });
    return true;
  }

  // Refreshes the open Codex thread; errors just mean none. A slow older
  // refresh never overwrites a newer one.
  async refresh() {
    const seq = ++this.refreshSeq;
    let thread = null;
    if (this.#codexOn() && this.hasCodexSession()) {
      try { thread = await this.codex.pickThread(); } catch { thread = null; }
    }
    if (seq === this.refreshSeq) this.codexThread = thread;
  }

  async #run(event, backend, cwd) {
    const { taskId } = event;
    const text = taskPrompt(event);
    let job;
    if (backend === 'codex') {
      let thread = null;
      let sending = false;
      try {
        // Re-read availability before sending; the periodic snapshot may be stale.
        thread = await this.codex.pickThread({ routing: event.routing, previousThread: this.routingState.get(event.deviceId) });
        if (!this.tasks.get(taskId)) return;
        if (!thread) throw new Error('no open Codex thread');
        this.tasks.bindThread(taskId, thread);
        const tracked = { threadId: thread, sending: null };
        this.codexJobs.set(taskId, tracked);
        sending = true;
        tracked.sending = this.codex.send(thread, text);
        await tracked.sending;
        job = this.#codexJob(event, thread);
      } catch (e) {
        this.log(`task ${taskId}: queueing into Codex failed`, e?.stderr || e?.message || e);
        // Only a spawn failure proves no input was sent; any other failure
        // may hide a delivery, so the thread is checked before anything is
        // replayed in a second host.
        const where = sending && !['ENOENT', 'EACCES'].includes(e?.code) ? await this.#locate(thread, taskId) : null;
        if (where === undefined) { this.link.sendError(taskId, SEND_UNKNOWN); return; }
        if (where) job = this.#codexJob(event, thread);
        else if (event.routing) { this.link.sendError(taskId, e.message); return; }
        else if (!(this.#claudeOn() && cwd)) { this.link.sendError(taskId, START_FAILED); return; }
        else backend = 'claude'; // fall back
      }
    }
    if (backend === 'claude' && !job) {
      let run;
      try {
        run = await this.claude.start(cwd, taskPrompt(event, this.claude.history?.(cwd) ?? []));
      } catch (e) {
        this.log(`task ${taskId}: starting a background Claude session failed`, e?.stderr || e?.message || e);
        this.link.sendError(taskId, /not trusted/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`) ? START_UNTRUSTED : START_FAILED);
        return;
      }
      this.log(`task ${taskId} running in background Claude session ${run.sessionId} (${run.agentId}, ${cwd})`);
      job = { status: () => this.claude.status(run.agentId), stop: () => this.claude.stop(run.agentId),
        // Remembered for the next task's prompt once the turn is over.
        done: () => this.claude.remember?.(cwd, String(event.text ?? ''), this.claude.answer?.(cwd, run.sessionId, taskId) ?? '') };
    }
    if (!this.tasks.get(taskId)) { await this.#finish(job); return; } // cancelled while starting
    await this.#watch(taskId, job);
    await this.#finish(job);
  }

  #codexJob(event, thread) {
    const { taskId } = event;
    try { this.routingState.set(event.deviceId, thread); } catch (e) { this.log('saving Codex routing state failed', e.message); }
    this.log(`task ${taskId} queued into Codex thread ${thread}`);
    return { status: () => this.codex.status(thread), lastReply: () => this.codex.lastReply(thread, taskId),
      taskState: this.codex.taskState ? () => this.codex.taskState(thread, taskId) : null };
  }

  // Lets the turn end before stopping (a reply may come before the last
  // writes), up to stopWaitMs.
  async #finish(job) {
    if (!job.stop) return;
    const end = this.now() + this.stopWaitMs;
    while (this.now() < end) {
      let s;
      try { s = await job.status(); } catch { s = 'idle'; }
      if (s !== 'busy') break;
      await sleep(this.pollMs);
    }
    try { job.done?.(); } catch (e) { this.log('remembering the exchange failed', e?.message ?? e); }
    await job.stop().catch(e => this.log('stopping background session failed', e?.message ?? e));
  }

  // Until the task ends. Idle (after it worked, or past the start grace) for
  // graceMs without an answer: the session's last message answers, else
  // NO_REPLY.
  async #watch(taskId, job) {
    const started = this.now();
    let worked = false;
    let idleSince = null;
    while (this.tasks.get(taskId)) {
      await sleep(this.pollMs);
      if (!this.tasks.get(taskId)) return;
      if (this.tasks.get(taskId).cancelRequested) continue;
      let s;
      try { s = await job.status(); } catch { continue; } // transient; ask again
      if (job.taskState) {
        let state;
        try { state = await job.taskState(); } catch { continue; }
        if (state?.status === 'interrupted') {
          this.link.sendResult(taskId, INTERRUPTED, { asIs: true });
          return;
        }
        if (state?.status === 'inProgress') { worked = true; idleSince = null; continue; }
        // A later unrelated turn must not postpone a completed task's reply.
        if (state?.status === 'completed') s = 'idle';
      }
      if (s === 'busy') { worked = true; idleSince = null; continue; }
      if (!worked && this.now() - started < this.startGraceMs) continue;
      idleSince ??= this.now();
      if (this.now() - idleSince < this.graceMs) continue;
      if (!this.tasks.get(taskId)) return;
      let reply = '';
      try { reply = (await job.lastReply?.()) ?? ''; } catch { /* none */ }
      if (reply && !IGNORED_REPLIES.test(reply)) this.link.sendResult(taskId, this.spoken(reply));
      else this.link.sendError(taskId, NO_REPLY);
      return;
    }
  }
}

// What a model says when it decided not to answer; never worth speaking.
const IGNORED_REPLIES = /^\s*No response requested\.?\s*$/i;
