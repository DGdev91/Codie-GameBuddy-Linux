import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSpokenSummary } from '../../src/agentd/summary.mjs';

test('strips fenced code blocks and inline code', () => {
  const s = toSpokenSummary('Fixed it.\n```js\nconst a = 1;\n```\nRan `npm test`, it passes.');
  assert.equal(s, 'Fixed it. Ran npm test, it passes.');
});

test('strips markdown headers, bullets, bold, links', () => {
  assert.equal(toSpokenSummary('## Result\n- **Tests** all green\n- see [docs](http://x)'), 'Result Tests all green see docs');
});

test('truncates to max chars with ellipsis', () => {
  const s = toSpokenSummary('😀'.repeat(300), 200);
  assert.equal([...s].length, 200);
  assert.ok(s.endsWith('…'));
});

test('empty / missing input yields fallback sentence', () => {
  assert.equal(toSpokenSummary(''), 'The task has finished.');
  assert.equal(toSpokenSummary(undefined), 'The task has finished.');
  assert.equal(toSpokenSummary('```\nonly code\n```'), 'The task has finished.');
});

test('endsWithQuestion: final sentence ends with ? or ？', async () => {
  const { endsWithQuestion } = await import('../../src/agentd/summary.mjs');
  assert.equal(endsWithQuestion('Fixed it, commit now？'), true);
  assert.equal(endsWithQuestion('Push now?'), true);
  assert.equal(endsWithQuestion('Which one？）\n'), true);
  assert.equal(endsWithQuestion('**Shall I continue？**'), true);
  assert.equal(endsWithQuestion('Do you want A or B？\n```\ncode\n```'), true);
  assert.equal(endsWithQuestion('Why？ The port was taken。 Fixed now。'), false);
  assert.equal(endsWithQuestion('All passed。'), false);
  assert.equal(endsWithQuestion(''), false);
  assert.equal(endsWithQuestion(undefined), false);
});
