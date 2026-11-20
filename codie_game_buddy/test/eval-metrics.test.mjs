import assert from 'node:assert/strict';
import test from 'node:test';
import { repetition, similarity } from '../scripts/eval-metrics.mjs';

test('similarity is 1 for the same words, 0 for none shared, punctuation and case aside', () => {
  assert.equal(similarity('Nice dodge!', 'nice dodge'), 1);
  assert.equal(similarity('加油', 'Go'), 0);
  assert.ok(similarity('这一刀真漂亮', '这一刀真险') > 0.4);
  assert.ok(similarity('这一刀真漂亮', '这一刀真险') < 1);
});

test('repetition counts remarks said again, shared openings and how close each is to an earlier one', () => {
  const m = repetition(['加油，别怕它！', '加油，稳住！', '这座城真安静。', '加油，别怕它！']);
  assert.equal(m.remarks, 4);
  assert.equal(m.duplicates, 1);
  assert.equal(m.sameOpening, 2); // the second and the fourth start like the first
  assert.equal(m.maxNearest, 1);
  assert.ok(m.meanNearest > 0 && m.meanNearest < 1);
});

test('remarks that share nothing score zero; none or one remark has nothing to compare', () => {
  assert.deepEqual(repetition(['加油！', 'Slow down.']), { remarks: 2, duplicates: 0, sameOpening: 0, meanNearest: 0, maxNearest: 0, meanLength: 5 });
  assert.deepEqual(repetition([]), { remarks: 0, duplicates: 0, sameOpening: 0, meanNearest: 0, maxNearest: 0, meanLength: 0 });
});
