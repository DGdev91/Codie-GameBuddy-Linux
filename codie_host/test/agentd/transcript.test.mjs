import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSlug, transcriptDir, snapshotTranscripts, waitForTask, lastAssistantText } from '../../src/agentd/transcript.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-tr-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const line = id => JSON.stringify({ type: 'queue-operation', content: `<channel source="codie" task_id="${id}">hi</channel>` }) + '\n';

test('slug and dir follow Claude Code layout', () => {
  assert.equal(projectSlug('/Users/me/Devs/codie-host'), '-Users-me-Devs-codie-host');
  assert.equal(projectSlug('/a/b.c_d'), '-a-b-c-d');
  assert.equal(transcriptDir({ configDir: '/h/.claude', projectDir: '/x/y' }), path.join('/h/.claude', 'projects', '-x-y'));
  assert.equal(transcriptDir({ configDir: '/h', projectDir: '' }), null);
});

test('snapshotTranscripts lists only *.jsonl sizes; a missing dir is empty', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.jsonl'), 'abc');
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  assert.deepEqual([...snapshotTranscripts(d)], [['a.jsonl', 3]]);
  assert.equal(snapshotTranscripts(path.join(d, 'nope')).size, 0);
});

test('waitForTask sees the line in the session transcript, appended after the snapshot', async () => {
  const d = tmp();
  const f = path.join(d, 's1.jsonl');
  fs.writeFileSync(f, line('old'));
  const since = snapshotTranscripts(d);
  setTimeout(() => fs.appendFileSync(f, line('abc')), 60);
  assert.equal(await waitForTask(d, 'abc', { since, timeoutMs: 1000, intervalMs: 20 }), true);
});

test('after /clear: the line lands in a transcript created after the snapshot', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'before-clear.jsonl'), line('old'));
  const since = snapshotTranscripts(d);
  setTimeout(() => fs.writeFileSync(path.join(d, 'after-clear.jsonl'), line('abc')), 60);
  assert.equal(await waitForTask(d, 'abc', { since, timeoutMs: 1000, intervalMs: 20 }), true);
});

test('the line is found even when more than 64KB is appended after it', async () => {
  const d = tmp();
  const f = path.join(d, 's1.jsonl');
  fs.writeFileSync(f, '');
  const since = snapshotTranscripts(d);
  setTimeout(() => fs.appendFileSync(f, line('abc') + JSON.stringify({ big: 'x'.repeat(200 * 1024) }) + '\n'), 60);
  assert.equal(await waitForTask(d, 'abc', { since, timeoutMs: 1000, intervalMs: 20 }), true);
});

test('a line split across two polls is still found', async () => {
  const d = tmp();
  const f = path.join(d, 's1.jsonl');
  fs.writeFileSync(f, '');
  const since = snapshotTranscripts(d);
  const l = line('abc');
  const cut = l.indexOf('abc') + 1;
  setTimeout(() => fs.appendFileSync(f, l.slice(0, cut)), 30);
  setTimeout(() => fs.appendFileSync(f, l.slice(cut)), 200);
  assert.equal(await waitForTask(d, 'abc', { since, timeoutMs: 1000, intervalMs: 20 }), true);
});

test('waitForTask times out when the id never shows up', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 't.jsonl'), line('other'));
  assert.equal(await waitForTask(d, 'abc', { timeoutMs: 150, intervalMs: 20 }), false);
});

test('lastAssistantText: the final assistant text, skipping tool calls, sidechains and other entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-last-'));
  const file = path.join(dir, 's.jsonl');
  const line = j => JSON.stringify(j) + '\n';
  fs.writeFileSync(file,
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look first.' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Shall I continue?' }] } })
    + line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Words from a subagent.' }] } })
    + line({ type: 'system', subtype: 'stop_hook_summary' })
    + 'not json\n');
  assert.equal(lastAssistantText(file), 'Shall I continue?');
  assert.equal(lastAssistantText(path.join(dir, 'missing.jsonl')), '');
  assert.equal(lastAssistantText(undefined), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('progressedSince: a tool result, typed prompt or new Codex turn after the mark counts; replies do not', async () => {
  const { transcriptMark, progressedSince } = await import('../../src/agentd/transcript.mjs');
  const rec = o => JSON.stringify(o) + '\n';
  const at = start => { const f = path.join(tmp(), 's.jsonl'); fs.writeFileSync(f, start); return f; };
  const cases = [
    [rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done?' }] } }), false],
    [rec({ type: 'attachment', attachment: { type: 'hook_success' } }) + rec({ type: 'system', subtype: 'stop_hook_summary' }), false],
    [rec({ type: 'user', isSidechain: true, message: { content: 'sub' } }), false],
    [rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } }), true],
    [rec({ type: 'user', message: { content: 'next please' } }), true],
    [rec({ type: 'event_msg', payload: { type: 'task_complete' } }) + rec({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }), false],
    [rec({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1' } }), true],
    [rec({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1' } }), true],
    [rec({ type: 'event_msg', payload: { type: 'task_started' } }), true],
    [rec({ type: 'event_msg', payload: { type: 'turn_aborted' } }), true],
  ];
  for (const [appended, expected] of cases) {
    const f = at(rec({ type: 'user', message: { content: 'old prompt' } }));
    const mark = transcriptMark(f);
    assert.equal(progressedSince(mark), false);
    fs.appendFileSync(f, appended);
    assert.equal(progressedSince(mark), expected, appended);
  }
  assert.equal(transcriptMark(undefined), null);
  assert.equal(transcriptMark(path.join(tmp(), 'missing.jsonl')), null);
  assert.equal(progressedSince(null), false);
});

test('progressedSince: a rewritten (shorter) transcript counts as progress', async () => {
  const { transcriptMark, progressedSince } = await import('../../src/agentd/transcript.mjs');
  const f = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(f, 'x'.repeat(100));
  const mark = transcriptMark(f);
  fs.writeFileSync(f, 'y');
  assert.equal(progressedSince(mark), true);
});
