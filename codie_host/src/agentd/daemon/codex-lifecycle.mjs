import fs from 'node:fs';
import { INTERRUPTED } from '../texts.mjs';

export const taskMarker = id => `Codie voice task task_id="${id}"`;

const codexSession = threadId => ({ id: `codex:${threadId}`, threadId, host: 'codex' });

// Read only a bounded tail. A missing start/anchor means unknown, never success.
export function codexTaskState(file, taskId) {
  let source;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const bytes = Buffer.alloc(Math.min(size, 8 << 20));
      fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
      source = bytes.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  let turn = null;
  let found = null;
  for (const line of source.split('\n')) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload;
    if (j.type === 'event_msg' && p?.type === 'task_started') {
      turn = { turnId: p.turn_id, status: 'inProgress', reply: '' };
    }
    if (!turn) continue;
    const userText = j.type === 'event_msg' && p?.type === 'user_message' ? p.message
      : j.type === 'response_item' && p?.type === 'message' && p.role === 'user'
        ? (p.content ?? []).map(c => c.text ?? '').join('\n') : '';
    if (!found && typeof userText === 'string' && userText.includes(taskMarker(taskId))) found = turn;
    if (found !== turn || j.type !== 'event_msg') continue;
    if (p.turn_id && turn.turnId && p.turn_id !== turn.turnId) continue;
    if (p.type === 'task_complete') {
      turn.status = 'completed';
      turn.reply = typeof p.last_agent_message === 'string' ? p.last_agent_message.trim() : '';
    } else if (p.type === 'turn_aborted') {
      turn.status = 'interrupted';
      turn.reply = '';
    }
  }
  return found;
}

// Hook identities are authoritative; daemon process ancestry is not a thread id.
// A hook's session_id is the Codex thread id and its turn_id the rollout's
// turn id (checked against codex-cli 0.165). Any hook registers its thread;
// the registry is kept in `store` so an agentd restart does not forget the
// threads already open. A thread whose SessionEnd was missed stays listed,
// but CodexQueue only picks threads the app-server still has loaded.
export class CodexLifecycle {
  constructor({ tasks, link, app, store = null, now = Date.now }) {
    Object.assign(this, { tasks, link, app, store, now });
    this.threads = new Map((store?.codexThreads() ?? []).map(id => [id, codexSession(id)]));
  }

  openThreads() { return [...this.threads.keys()]; }

  #save() { this.store?.saveCodexThreads(this.openThreads()); }

  handle(route, body) {
    if (!['session-start', 'session-end', 'prompt', 'poll-result', 'stop', 'ask', 'permission', 'interrupt'].includes(route)) return {};
    const id = body?.session_id;
    if (typeof id !== 'string' || !id) return {};
    if (route === 'session-end') {
      if (this.threads.delete(id)) this.#save();
      return {};
    }
    let session = this.threads.get(id);
    if (!session) {
      session = codexSession(id);
      this.threads.set(id, session);
      this.#save();
    }
    session.lastActive = this.now();
    const ctx = this.app.ctxFor(session);
    // Bind queued requests from their actual prompt, and polls from their result.
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    let polled = [];
    if (route === 'poll-result' && /(?:^|__)codie_poll$/.test(body.tool_name ?? '')) {
      let response = body.tool_response;
      if (typeof response === 'string') { try { response = JSON.parse(response); } catch { response = null; } }
      try { polled = JSON.parse(response?.content?.[0]?.text ?? '[]'); } catch { /* unknown host response */ }
    }
    for (const t of this.tasks.pending()) {
      if (prompt.includes(taskMarker(t.taskId)) || (Array.isArray(polled) && polled.some(p => p?.taskId === t.taskId))) {
        // Never move a task already bound to another thread.
        if (t.threadId && t.threadId !== id || t.turnId && t.turnId !== body.turn_id) continue;
        this.tasks.bindThread(t.taskId, id, body.turn_id);
      }
    }
    if (route === 'interrupt') {
      for (const t of this.tasks.pending()) {
        if (t.threadId === id && t.turnId && t.turnId === body.turn_id) this.link.sendResult(t.taskId, INTERRUPTED, { asIs: true });
      }
    } else if (route === 'stop') this.app.onStopHook(body, ctx);
    else if (route === 'ask') this.app.onAskHook(body, ctx);
    else if (route === 'permission') this.app.onPermissionHook(body, ctx);
    return {};
  }
}
