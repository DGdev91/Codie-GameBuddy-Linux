import assert from 'node:assert/strict';
import test from 'node:test';
import { repeatedPhrases, wornPhrases } from '../src/main/worn.mjs';

test('wording two or more remarks share is found, the most used first', () => {
  const remarks = ['主人，你血条都快见底啦。', '那团火真漂亮，可你血条又掉了。', '主人，绕到它背后去呀。', '血条只剩一半了。'];
  assert.deepEqual(repeatedPhrases(remarks), [{ phrase: '血条', n: 3 }, { phrase: '主人', n: 2 }]);
  assert.deepEqual(wornPhrases(remarks), ['血条', '主人']);
});

test('of two phrases one inside the other, the more used stays, or the longer when used as often', () => {
  assert.deepEqual(wornPhrases(['绕着圆台转就好。', '先绕着圆台转。', '绕着它跑。']), ['绕着', '圆台转']);
  assert.deepEqual(wornPhrases(['绕着圆台转就好。', '先绕着圆台转。']), ['绕着圆台转']);
});

test('Latin words count from five letters, whatever their case; shorter ones and words said once do not', () => {
  assert.deepEqual(wornPhrases(['Master, nice dodge!', 'Easy now, master.', 'Nice one.', 'What a dodge.']), ['master', 'dodge']);
  assert.deepEqual(wornPhrases(['Go on.', 'Go now.']), []);
});

test('wording does not run across punctuation or from one script into another', () => {
  assert.deepEqual(wornPhrases(['加油，Master别怕。', '加油Master，别怕。']), ['master', '别怕', '加油']);
});

test('at most `max` phrases; none for no remarks or one', () => {
  assert.equal(wornPhrases(['甲乙。丙丁。戊己。', '甲乙，丙丁，戊己'], 2).length, 2);
  assert.deepEqual(wornPhrases([]), []);
  assert.deepEqual(wornPhrases(['只有一句。']), []);
});
