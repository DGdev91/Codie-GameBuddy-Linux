import assert from 'node:assert/strict';
import test from 'node:test';
import { createScreenTerms, matchTerms, MAX_SHOWN } from '../src/main/screen-terms.mjs';

const TERMS = [['玉儿', '玉儿'], ['不能', '不能'], ['万邪王', '万邪王'], ['邵白雁', '邵白雁&邵玄雕'], ['白雁', '白雁'], ['京城', '京城(影之刃系列)'], ['Malenia', 'Malenia']];

test('names of three or more characters match anywhere, OCR spaces and punctuation ignored', () => {
  assert.deepEqual(matchTerms(['万 邪 王来了，我们不能退'], TERMS), [['万邪王', '万邪王']]);
  assert.deepEqual(matchTerms(['blade of MALENIA!'], TERMS), [['Malenia', 'Malenia']]);
});

test('a two-character name matches only on a line of its own, such as a speaker label', () => {
  assert.deepEqual(matchTerms(['玉儿', '说怪面伤的人实在太多'], TERMS), [['玉儿', '玉儿']]);
  assert.deepEqual(matchTerms(['～玉，儿'], TERMS), [['玉儿', '玉儿']]);
  assert.deepEqual(matchTerms(['一玉儿 0'], TERMS), [['玉儿', '玉儿']]); // OCR noise around it
  assert.deepEqual(matchTerms(['我们不能退'], TERMS), []);
});

test('a name inside a longer matched name does not count again; order is as on screen', () => {
  assert.deepEqual(matchTerms(['邵白雁出手', '京城'], TERMS), [['邵白雁', '邵白雁&邵玄雕'], ['京城', '京城(影之刃系列)']]);
  assert.deepEqual(matchTerms(['京城', '邵白雁'], TERMS), [['京城', '京城(影之刃系列)'], ['邵白雁', '邵白雁&邵玄雕']]);
});

test('no lines or no glossary match nothing', () => {
  assert.deepEqual(matchTerms([], TERMS), []);
  assert.deepEqual(matchTerms(['万邪王'], []), []);
});

function setup({ described = {} } = {}) {
  const state = { asked: [], logs: [] };
  const termInfo = { get: args => { state.asked.push(args); return described[args.title] ?? null; } };
  const screen = createScreenTerms({ termInfo, log: line => state.logs.push(line) });
  return { screen, state };
}

const INFO = { source: '萌娘百科', title: '影之刃零', terms: TERMS };

test('terms read on the frame come back with their descriptions; undescribed ones are dropped', () => {
  const { screen, state } = setup({ described: { 万邪王: { text: '黑林之主。' } } });
  assert.deepEqual(screen.describe(['玉儿', '万邪王来了'], INFO), [{ name: '万邪王', text: '黑林之主。' }]);
  assert.deepEqual(state.asked, [{ source: '萌娘百科', title: '玉儿' }, { source: '萌娘百科', title: '万邪王' }]);
  assert.deepEqual(state.logs, ['screen terms: 玉儿, 万邪王']);
});

test(`at most MAX_SHOWN described terms are returned`, () => {
  const names = ['甲甲甲', '乙乙乙', '丙丙丙', '丁丁丁', '戊戊戊'];
  const described = Object.fromEntries(names.map(n => [n, { text: `${n}。` }]));
  const { screen } = setup({ described });
  const r = screen.describe([names.join('，')], { ...INFO, terms: names.map(n => [n, n]) });
  assert.equal(r.length, MAX_SHOWN);
  assert.deepEqual(r.map(t => t.name), names.slice(0, MAX_SHOWN));
});

test('nothing matched logs nothing', () => {
  const { screen, state } = setup();
  assert.deepEqual(screen.describe(['HP 100'], INFO), []);
  assert.deepEqual(state.logs, []);
});
