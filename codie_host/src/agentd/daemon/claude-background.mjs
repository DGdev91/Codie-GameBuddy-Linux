import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../store.mjs';
import { runFile } from './child-env.mjs';

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// The tool a background Claude session must reach without a permission prompt.
export const REPLY_TOOL = 'mcp__plugin_codie_codie__codie_reply';

const MAX_TAIL = 8 << 20;
function readTail(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, MAX_TAIL);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len);
      return b.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

const localDay = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
export const HISTORY_MAX = 8;

// Claude Code: one fresh background session per task, in the project
// directory. Today's device exchanges per directory are kept in
// background.json as { claude: { [cwd]: { day, history: [{q, a}] } } }.
export class ClaudeBackground {
  constructor({ home, run = runFile, claude = 'claude', now = Date.now, projectsDir = path.join(os.homedir(), '.claude', 'projects') } = {}) {
    Object.assign(this, { run, claude, now, projectsDir });
    this.statePath = path.join(home, 'background.json');
  }

  // Today's exchanges in `cwd`, oldest first.
  history(cwd) {
    const h = readJson(this.statePath)?.claude?.[cwd];
    return h?.day === localDay(this.now()) && Array.isArray(h.history) ? h.history : [];
  }

  remember(cwd, q, a) {
    if (!q || !a) return;
    const state = readJson(this.statePath) ?? {};
    const history = [...this.history(cwd), { q, a }].slice(-HISTORY_MAX);
    writeJsonAtomic(this.statePath, { ...state, claude: { ...state.claude, [cwd]: { day: localDay(this.now()), history } } });
  }

  // { sessionId, agentId }. `claude --bg` ignores --session-id and names the
  // session itself ("backgrounded · <short id>").
  async start(cwd, text) {
    const args = ['--bg', '--allowedTools', REPLY_TOOL, '--', text];
    const { stdout, stderr } = await this.run(this.claude, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = `${stdout}\n${stderr}`;
    const agentId = /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(out)?.[1];
    if (!agentId) throw new Error(`claude --bg printed no session id: ${out.trim().slice(-200)}`);
    const sessionId = (await this.#entries()).find(a => a.id === agentId)?.sessionId;
    if (!sessionId) throw new Error(`background session ${agentId} not listed by claude agents`);
    return { sessionId, agentId };
  }

  // What the session answered for `taskId`: its codie_reply summary, else its
  // last text (what the Stop hook would have sent), else ''.
  answer(cwd, sessionId, taskId) {
    const text = readTail(path.join(this.projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`));
    let summary = '';
    let last = '';
    for (const line of text.split('\n')) {
      if (!line.includes('"assistant"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      for (const c of j?.type === 'assistant' && Array.isArray(j.message?.content) ? j.message.content : []) {
        if (c?.type === 'tool_use' && String(c.name).endsWith('codie_reply') && c.input?.task_id === taskId) summary = String(c.input.summary ?? '');
        else if (c?.type === 'text' && c.text?.trim()) last = c.text.trim();
      }
    }
    return (summary || last).trim();
  }

  async #entries() {
    const { stdout } = await this.run(this.claude, ['agents', '--json', '--all']);
    const list = JSON.parse(stdout);
    return Array.isArray(list) ? list.filter(a => a && a.kind !== 'interactive') : [];
  }

  // 'busy' / 'idle', or null once that run has ended.
  async status(agentId) {
    const e = (await this.#entries()).find(a => a.id === agentId);
    if (!e || ['stopped', 'failed', 'done', 'exited', 'completed'].includes(e.state) && !e.status) return null;
    return e.status === 'busy' ? 'busy' : 'idle';
  }

  async stop(agentId) {
    await this.run(this.claude, ['stop', agentId]);
  }
}
