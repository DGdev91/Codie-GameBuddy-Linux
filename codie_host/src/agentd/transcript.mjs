import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const projectSlug = dir => String(dir).replace(/[^A-Za-z0-9]/g, '-');

// The directory holding this project's session transcripts. Not one file:
// `/clear` starts a new transcript (new session id) while the MCP server, and
// the CLAUDE_CODE_SESSION_ID it was started with, stay the same.
export function transcriptDir({ configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
  if (!projectDir) return null;
  return path.join(configDir, 'projects', projectSlug(projectDir));
}

// Size of every `*.jsonl` in `dir` (missing dir: none).
export function snapshotTranscripts(dir) {
  const sizes = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return sizes; }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    try { sizes.set(n, fs.statSync(path.join(dir, n)).size); } catch { /* raced a delete */ }
  }
  return sizes;
}

// Bytes [from, to) of a file, or empty when unreadable.
export function readBytes(file, from, to) {
  if (to <= from) return Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(to - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n);
  } catch { return Buffer.alloc(0); } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Last 256 KB is plenty for the final reply of a turn.
const LAST_REPLY_SCAN_BYTES = 256 * 1024;

// The text of the last main-thread assistant message in a transcript, or ''
// (missing file, no text yet). Tool calls and subagent messages are skipped.
export function lastAssistantText(file, maxBytes = LAST_REPLY_SCAN_BYTES) {
  if (!file) return '';
  let size;
  try { size = fs.statSync(file).size; } catch { return ''; }
  const lines = readBytes(file, Math.max(0, size - maxBytes), size).toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let j;
    try { j = JSON.parse(lines[i]); } catch { continue; }
    if (j?.type !== 'assistant' || j.isSidechain) continue;
    const c = j.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('') : '';
    if (text.trim()) return text.trim();
  }
  return '';
}

// True once any transcript in `dir` records the channel push for `taskId`
// (Claude Code enqueues it within milliseconds), false after `timeoutMs`.
// Only what was written after `since` (a snapshotTranscripts taken before the
// push) is read: bytes appended to files it lists, all of files it doesn't.
export async function waitForTask(dir, taskId, opts) {
  return (await waitForTaskFile(dir, taskId, opts)) !== null;
}

// As waitForTask, but says where: `{ name, offset }` — the transcript file
// (in `dir`) that recorded the push and the byte offset of the start of the
// line that holds it (so a watcher can resume there without re-reading) —
// or null.
export async function waitForTaskFile(dir, taskId, { since = new Map(), timeoutMs = 3000, intervalMs = 100 } = {}) {
  const needle = Buffer.from(`task_id=\\"${taskId}\\"`); // JSON-escaped inside the line
  const deadline = Date.now() + timeoutMs;
  const read = new Map(since); // file -> bytes already scanned
  const carry = new Map(); // file -> tail of the last chunk, for a needle split across reads
  for (;;) {
    for (const [name, size] of snapshotTranscripts(dir)) {
      const from = read.get(name) ?? 0;
      if (size <= from) continue;
      const tail = carry.get(name) ?? Buffer.alloc(0);
      const chunk = Buffer.concat([tail, readBytes(path.join(dir, name), from, size)]);
      const at = chunk.indexOf(needle);
      if (at >= 0) {
        const nl = chunk.lastIndexOf(0x0a, at);
        // A line that began before this chunk started at or before `from`
        // (the snapshot / previous read): resume there.
        const offset = nl >= 0 ? from - tail.length + nl + 1 : Math.max(0, (since.get(name) ?? 0));
        return { name, offset: Math.min(offset, from - tail.length + at) };
      }
      read.set(name, from + chunk.length - tail.length);
      carry.set(name, chunk.subarray(Math.max(0, chunk.length - needle.length)));
    }
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// Max bytes read backwards from a transcript's end to find the current turn.
// Claude Code writes huge attachment / api-request lines mid-turn (680KB
// between a task and its Stop, seen on a real device), so a fixed tail misses it.
export const TURN_SCAN_BYTES = 8 * 1024 * 1024;
const SCAN_CHUNK = 256 * 1024;

// Complete lines of `file`, last first, within the last `maxBytes`.
function* linesBackwards(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const floor = Math.max(0, size - maxBytes);
    let pos = size;
    let rest = Buffer.alloc(0); // bytes after the last newline seen (a line's tail)
    while (pos > floor) {
      const len = Math.min(SCAN_CHUNK, pos - floor);
      pos -= len;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      let buf = Buffer.concat([chunk, rest]);
      let nl;
      while ((nl = buf.lastIndexOf(0x0a)) >= 0) {
        const line = buf.subarray(nl + 1);
        if (line.length) yield line.toString('utf8');
        buf = buf.subarray(0, nl);
      }
      rest = buf;
    }
    if (pos === 0 && rest.length) yield rest.toString('utf8'); // the file's first line
  } catch { /* missing / unreadable: no lines */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// A Claude Code transcript line that starts a turn: a top-level user prompt
// (typed, a slash command, a channel push…), not a tool result, a mid-turn
// meta line (skill text, image source) or a subagent's line.
export function claudeTurnStart(j) {
  if (j?.type !== 'user' || j.isSidechain) return false;
  if (j.isMeta && j.origin?.kind !== 'channel') return false;
  if (j.isCompactSummary || j.isVisibleInTranscriptOnly) return false; // written by /compact etc., not a prompt
  const c = j.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && !c.some(p => p?.type === 'tool_result') && c.some(p => p?.type === 'text');
}

// A Codex rollout line that starts a turn.
const codexTurnStart = j => j?.type === 'event_msg' && j.payload?.type === 'task_started';
const codexAborted = j => j?.type === 'event_msg' && j.payload?.type === 'turn_aborted';

// Background work in a Claude Code transcript. A launch is the tool_result of
// a `run_in_background` Bash (toolUseResult.backgroundTaskId) or a background
// Agent (toolUseResult.status "async_launched"). Its end is a
// `<task-notification>` naming the launch's tool_use_id with a final status
// (completed / failed / killed) that the model saw: either as the user line
// that starts a follow-up turn (origin.kind "task-notification") or absorbed
// mid-turn as a `queued_command` attachment. A notification only queued
// (queue-operation enqueue) has not reached the model yet: its turn is coming.
export const isLaunch = j => {
  const r = j?.toolUseResult;
  return !!r && typeof r === 'object' && (!!r.backgroundTaskId || r.status === 'async_launched');
};
export const launchIds = j => (Array.isArray(j.message?.content) ? j.message.content : [])
  .filter(p => p?.type === 'tool_result' && p.tool_use_id).map(p => p.tool_use_id);
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
// tool_use_ids of the background launches that `text`'s notifications end.
function endedIds(text) {
  const ids = [];
  if (typeof text !== 'string') return ids;
  for (const [, body] of text.matchAll(NOTIFICATION)) {
    const id = body.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1];
    const status = body.match(/<status>([^<]+)<\/status>/)?.[1];
    if (id && status && status !== 'running' && status !== 'pending') ids.push(id);
  }
  return ids;
}
export const notificationText = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '';
// How a device task line starts (inbox.mjs prints it through the plugin
// monitor; background dispatch prompts start the same way).
export const TASK_TAG = '[Codie voice task task_id=';
// `taskId`'s tag as it appears inside a JSON transcript line.
const taskTagIn = (line, taskId) => line.includes(`${TASK_TAG}\\"${taskId}\\"`);
// A user line that starts a turn to deliver background-completion notices
// (or a plugin monitor's output, such as a Codie inbox task).
export const isNotificationTurn = j => j?.type === 'user' && !j.isSidechain
  && (j.origin?.kind === 'task-notification' || j.turnOrigin === 'task_notification');
// Notifications absorbed into a running turn.
export const absorbedNotification = j => j?.type === 'attachment' && !j.isSidechain
  && j.attachment?.type === 'queued_command' && (j.attachment.origin?.kind === 'task-notification'
    || j.attachment.commandMode === 'task-notification') ? j.attachment.prompt : null;

// Which of `taskIds` the transcript's current turn is answering, or null. In
// a Claude Code transcript the turn must belong to the task's chain: started
// by the task's channel push, or by background-completion notifications
// following (transitively) such a turn — a typed prompt, or an interrupt
// marker, breaks the chain. While background work the chain launched has not
// reported its end, nothing is answered yet: the follow-up turn its
// notification starts will. A Codex rollout has no pushes: a task the turn
// took with codie_poll counts, unless the turn was aborted (its last text is
// partial). Other or unrecognised formats answer nothing.
export function currentTurnTask(file, taskIds, maxBytes = TURN_SCAN_BYTES) {
  if (typeof file !== 'string' || !file || !taskIds.length) return null;
  const seen = new Set(); // ids mentioned after the turn start (Codex)
  let aborted = false; // the Codex turn was aborted: its last text is partial
  const launched = new Set(); // Claude: background launches in the chain (tool_use_id)
  const ended = new Set(); // Claude: launches whose end the chain saw
  for (const line of linesBackwards(file, maxBytes)) {
    // Request dumps (some 100KB+) repeat other lines' text: never a record.
    if (line.startsWith('{"type":"api-request') || line.startsWith('{"type":"queue-operation"')) continue;
    const isUser = line.includes('"type":"user"');
    const isCodexStart = line.includes('"task_started"');
    if (line.includes('"turn_aborted"')) {
      try { if (codexAborted(JSON.parse(line))) aborted = true; } catch { /* not a record line */ }
    }
    if (line.includes('"queued_command"') && line.includes('<task-notification>')) {
      try { for (const id of endedIds(absorbedNotification(JSON.parse(line)))) ended.add(id); } catch { /* not a record line */ }
      continue;
    }
    if (!isUser && !isCodexStart) {
      for (const id of taskIds) if (line.includes(id)) seen.add(id);
      continue;
    }
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const inboxTask = isNotificationTurn(j) ? taskIds.find(id => taskTagIn(line, id)) : undefined;
    if (inboxTask) { // the Codie inbox monitor's task opened this turn
      for (const id of launched) if (!ended.has(id)) return null;
      return inboxTask;
    }
    if (isNotificationTurn(j)) { // continues the previous turn's chain
      for (const id of endedIds(notificationText(j.message?.content))) ended.add(id);
      continue;
    }
    if (j.type === 'user' && !j.isSidechain && isLaunch(j)) for (const id of launchIds(j)) launched.add(id);
    if (claudeTurnStart(j)) {
      const task = taskIds.find(id => line.includes(`task_id=\\"${id}\\"`)); // the push's tag, JSON-escaped
      if (!task) return null;
      for (const id of launched) if (!ended.has(id)) return null; // still running: answer when it ends
      return task;
    }
    if (codexTurnStart(j)) return aborted ? null : taskIds.find(id => seen.has(id)) ?? null;
    for (const id of taskIds) if (line.includes(id)) seen.add(id);
  }
  return null;
}

// A record that shows the session moved on after it began waiting on the
// user: an answered permission or question (a tool result), a typed prompt,
// a new or aborted turn. Replies the agent itself writes are not: they may
// land just after the hook that started the wait.
const CODEX_INPUT_ITEMS = new Set(['function_call_output', 'custom_tool_call_output']);
const CODEX_PROGRESS_EVENTS = new Set(['user_message', 'task_started', 'turn_aborted']);
function isUserProgress(j) {
  if (j?.type === 'user') return !j.isSidechain;
  const p = j?.payload;
  if (j?.type === 'response_item') return CODEX_INPUT_ITEMS.has(p?.type) || (p?.type === 'message' && p.role === 'user');
  if (j?.type === 'event_msg') return CODEX_PROGRESS_EVENTS.has(p?.type);
  return false;
}

// More than this appended since the mark counts as progress unread.
const PROGRESS_SCAN_BYTES = 4 << 20;

// Where a transcript ends now, to ask `progressedSince` later; null when
// there is no readable transcript.
export function transcriptMark(file) {
  if (typeof file !== 'string' || !file) return null;
  try { return { file, size: fs.statSync(file).size }; } catch { return null; }
}

// True when a Claude Code transcript or Codex rollout gained a record of the
// user's progress after `mark`. A null mark never has.
export function progressedSince(mark, maxBytes = PROGRESS_SCAN_BYTES) {
  if (!mark) return false;
  let size;
  try { size = fs.statSync(mark.file).size; } catch { return false; }
  if (size < mark.size) return true; // rewritten
  if (size - mark.size > maxBytes) return true;
  for (const line of readBytes(mark.file, mark.size, size).toString('utf8').split('\n')) {
    if (!line.includes('"user"') && !line.includes('"response_item"') && !line.includes('"event_msg"')) continue;
    try { if (isUserProgress(JSON.parse(line))) return true; } catch { /* partial line */ }
  }
  return false;
}
