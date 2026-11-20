import path from 'node:path';
import { runFile } from './child-env.mjs';
import { codexTaskState, taskMarker } from './codex-lifecycle.mjs';
import { codexRpc } from './codex-rpc.mjs';

// A directory as compared between a spoken target and a thread: Windows
// paths are case-insensitive and either may end in a separator.
const dirKey = (dir, platform) => (platform === 'win32' ? path.win32.normalize(dir).replace(/\\+$/, '').toLowerCase() : dir);

// Codex: open threads of the shared daemon.
export class CodexQueue {
  constructor({ rpc = codexRpc, run = runFile, codex = 'codex', platform = process.platform, knownThreads = () => [] } = {}) {
    Object.assign(this, { rpc, run, codex, platform, knownThreads });
  }

  // Prefer an idle thread, then the most recently used open thread that takes
  // direct input, or null. Open means `knownThreads()` names it (Codex's
  // SessionStart/SessionEnd hooks, codex-lifecycle.mjs): the daemon keeps a
  // thread loaded after its window closes, so a loaded thread alone means
  // nothing. A thread unloaded between the list and its read is just skipped.
  async pickThread({ routing, previousThread } = {}) {
    const known = new Set(this.knownThreads());
    if (!known.size) return null;
    const [loaded] = await this.rpc([{ method: 'thread/loaded/list' }]);
    const threads = [];
    for (const threadId of loaded?.data ?? []) {
      if (!known.has(threadId)) continue;
      try {
        const [r] = await this.rpc([{ method: 'thread/read', params: { threadId } }]);
        const t = r?.thread;
        if (!t || t.status?.type === 'notLoaded' || t.canAcceptDirectInput === false || t.ephemeral || (t.threadSource ?? 'user') !== 'user') continue;
        threads.push(t);
      } catch { /* gone meanwhile */ }
    }
    const recency = t => Math.max(t.recencyAt ?? 0, t.updatedAt ?? 0);
    threads.sort((a, b) => Number(b.status?.type === 'idle') - Number(a.status?.type === 'idle') || recency(b) - recency(a));
    if (routing?.mode === 'idle') {
      const idle = threads.find(t => t.status?.type === 'idle');
      if (!idle) throw new Error('No user Codex session is idle. Wait for a session to become idle or specify a session to queue the task.');
      return idle.id;
    }
    if (routing?.mode === 'continue') {
      if (!previousThread) throw new Error('This Codie has no previous Codex session. Specify a session or project first.');
      if (!threads.some(t => t.id === previousThread)) throw new Error('The previous Codex session is closed. Open it or specify another session.');
      return previousThread;
    }
    if (routing?.mode === 'session') {
      const target = routing.target.trim();
      const key = target.toLowerCase();
      const matches = threads.filter(t => t.id === target || t.name?.toLowerCase() === key
        || (t.cwd && (dirKey(t.cwd, this.platform) === dirKey(target, this.platform)
          || (this.platform === 'win32' ? path.win32 : path).basename(t.cwd).toLowerCase() === key)));
      if (matches.length === 1) return matches[0].id;
      const candidates = (matches.length ? matches : threads).map(t => `${t.name || 'Unnamed session'} (${t.id}, ${t.cwd})`).join('; ');
      throw new Error(`${matches.length ? 'Multiple sessions match. Specify one session' : 'No matching session was found. Choose an open session'}: ${candidates || 'No sessions are available'}.`);
    }
    return threads[0]?.id ?? null;
  }

  async #read(threadId) {
    const [r] = await this.rpc([{ method: 'thread/read', params: { threadId } }]);
    return r?.thread ?? null;
  }

  // 'busy' while a turn runs, 'idle' otherwise, null once it is not loaded.
  async status(threadId) {
    const t = await this.#read(threadId);
    const type = t?.status?.type;
    if (!t || type === 'notLoaded') return null;
    return type === 'active' ? 'busy' : 'idle';
  }

  async send(threadId, text) {
    await this.run(this.codex, ['queue', '--thread', threadId, '--message', text], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, windowsHide: true });
  }

  // The last thing the thread said after the message carrying `taskId`
  // (its rollout's task_complete / agent_message), or ''.
  async lastReply(threadId, taskId) {
    const t = await this.#read(threadId);
    return t?.path ? lastCodexMessage(t.path, taskId) : '';
  }

  async taskState(threadId, taskId) {
    const t = await this.#read(threadId);
    return t?.path ? codexTaskState(t.path, taskId) : null;
  }

  // The id of the thread's queued submission carrying `taskId`, or null.
  async #queued(threadId, taskId) {
    let cursor;
    do {
      const [page] = await this.rpc([{ method: 'thread/queue/list', params: { threadId, ...(cursor ? { cursor } : {}) } }]);
      const entry = (page?.data ?? []).find(e => (e.input ?? []).some(i => i.type === 'text' && i.text?.includes(taskMarker(taskId))));
      if (entry) return entry.id;
      cursor = page?.nextCursor;
    } while (cursor);
    return null;
  }

  // Where a task sent to the thread is: 'queued', 'started' (its turn is in
  // the rollout), or null (the thread never got it).
  async locate(threadId, taskId) {
    if (await this.#queued(threadId, taskId)) return 'queued';
    return (await this.taskState(threadId, taskId)) ? 'started' : null;
  }

  // 'removed' from the queue, 'interrupted' (the RPC was accepted; the
  // caller confirms the turn stopped), 'finished' already, or 'unknown'.
  async cancel(threadId, taskId, turnId) {
    // Deleting a queue entry races with its turn starting; check the turn after.
    const queued = await this.#queued(threadId, taskId);
    if (queued) {
      const [r] = await this.rpc([{ method: 'thread/queue/delete', params: { threadId, queuedSubmissionId: queued } }]);
      if (r?.deleted) return 'removed';
    }
    const state = await this.taskState(threadId, taskId);
    const activeTurn = state?.status === 'inProgress' ? state.turnId : !state ? turnId : null;
    if (activeTurn) {
      await this.rpc([{ method: 'turn/interrupt', params: { threadId, turnId: activeTurn } }]);
      return 'interrupted';
    }
    return state ? 'finished' : 'unknown';
  }
}

export function lastCodexMessage(file, taskId) {
  const state = codexTaskState(file, taskId);
  return state?.status === 'completed' ? state.reply : '';
}
