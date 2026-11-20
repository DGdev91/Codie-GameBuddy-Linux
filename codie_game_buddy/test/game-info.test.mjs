import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupGameInfo, lookupTerm, pickBackground, BACKGROUND_MAX, TERM_MAX } from '../src/main/game-info.mjs';

const ARTICLE = [
  '《黑神话：悟空》是游戏科学开发的动作角色扮演游戏。',
  '',
  '== 游戏介绍 ==',
  '故事取材于《西游记》。你将扮演一位天命人，踏上西游之路。',
  '=== 雄奇壮丽 ===',
  '欢迎来到东方魔幻世界。',
  '',
  '== 游戏系统 ==',
  '棍法与变化。',
  '',
  '== 游戏结局 ==',
  '结局剧透。',
].join('\n');

test('the background is the intro plus the first background section, without headings or the ending', () => {
  const text = pickBackground(ARTICLE);
  assert.match(text, /^《黑神话：悟空》是游戏科学开发/);
  assert.match(text, /天命人/);
  assert.match(text, /东方魔幻世界/);
  assert.doesNotMatch(text, /==|棍法|结局剧透/);
});

test('an English article takes its Plot or Setting section', () => {
  const text = pickBackground('Elden Ring is an action role-playing game.\n\n== Gameplay ==\nRolls.\n\n== Plot ==\nThe Elden Ring was shattered.\n');
  assert.equal(text, 'Elden Ring is an action role-playing game. The Elden Ring was shattered.');
});

test('a long background is cut to BACKGROUND_MAX characters', () => {
  const text = pickBackground(`A game. ${'x'.repeat(2000)}`);
  assert.ok([...text].length <= BACKGROUND_MAX);
  assert.match(text, /…$/);
});

// A fake MediaWiki: opensearch suggests the titles with an extract, query
// returns an extract, the templates a page uses or the links on a template.
function wiki(pages, calls = [], { templates = {}, links = {} } = {}) {
  return async url => {
    calls.push(url);
    const u = new URL(url);
    const p = u.searchParams;
    const json = body => ({ ok: true, json: async () => body });
    const title = p.get('titles');
    if (p.get('action') === 'opensearch') {
      const titles = Object.keys(pages[u.origin] ?? {});
      return json([p.get('search'), titles, titles.map(() => ''), titles.map(() => '')]);
    }
    const asTitles = list => list.map(t => ({ ns: 0, title: t }));
    if (p.get('prop') === 'templates') return json({ query: { pages: [{ title, templates: asTitles(templates[title] ?? []) }] } });
    if (p.get('prop') === 'links') return json({ query: { pages: [{ title, links: asTitles(links[title] ?? []) }] } });
    const extract = pages[u.origin]?.[title];
    return json({ query: { pages: [extract ? { title, extract } : { title, missing: true }] } });
  };
}

test('Chinese looks up Moegirlpedia first and keeps the source name', async () => {
  const calls = [];
  const fetch = wiki({ 'https://zh.moegirl.org.cn': { '黑神话：悟空': ARTICLE } }, calls);
  const info = await lookupGameInfo({ name: '黑神话：悟空', locale: 'zh-CN', fetch });
  assert.equal(info.source, '萌娘百科');
  assert.equal(info.title, '黑神话：悟空');
  assert.match(info.text, /天命人/);
  assert.ok(calls.every(c => c.startsWith('https://zh.moegirl.org.cn/')));
});

test('a page that is not about a game is skipped, and the next source is tried', async () => {
  const fetch = wiki({
    'https://zh.moegirl.org.cn': { 原神: '原神是一个词。' },
    'https://zh.wikipedia.org': { 原神: '《原神》是米哈游开发的开放世界游戏。' },
  });
  const info = await lookupGameInfo({ name: '原神', locale: 'zh-CN', fetch });
  assert.equal(info.source, '维基百科');
  assert.match(info.text, /开放世界游戏/);
});

test('English uses Wikipedia; nothing found or a network error gives null', async () => {
  const fetch = wiki({ 'https://en.wikipedia.org': { 'Elden Ring': 'Elden Ring is an action role-playing game.' } });
  assert.equal((await lookupGameInfo({ name: 'Elden Ring', locale: 'en', fetch })).source, 'Wikipedia');
  assert.equal(await lookupGameInfo({ name: 'Nothing', locale: 'en', fetch: wiki({}) }), null);
  assert.equal(await lookupGameInfo({ name: 'Elden Ring', locale: 'en', fetch: async () => { throw new Error('offline'); } }), null);
});

const SERIES = {
  templates: { 影之刃零: ['Template:Cite web', 'Template:中国电子游戏作品', 'Template:影之刃系列', 'Template:影之刃系列top'] },
  links: {
    'Template:影之刃系列': ['影之刃零', '影之刃系列', '万邪王', '魂(影之刃系列)', '京城(影之刃系列)', '上官斩', '狱'],
    'Template:影之刃系列top': ['上官斩'],
    'Template:中国电子游戏作品': ['原神', '黑神话：悟空'],
  },
};

test('a game background carries the glossary of its own navbox: names with their page, not the game or the series', async () => {
  const fetch = wiki({ 'https://zh.moegirl.org.cn': { 影之刃零: '《影之刃零》是灵游坊开发的武侠动作游戏。' } }, [], SERIES);
  const info = await lookupGameInfo({ name: '影之刃零', locale: 'zh-CN', fetch });
  assert.deepEqual(info.terms, [['万邪王', '万邪王'], ['京城', '京城(影之刃系列)'], ['上官斩', '上官斩']]);
});

test('a failed glossary keeps the background, with no terms', async () => {
  const pages = { 'https://zh.moegirl.org.cn': { 影之刃零: '《影之刃零》是武侠动作游戏。' } };
  const base = wiki(pages);
  const fetch = async url => (new URL(url).searchParams.get('prop') === 'templates' ? { ok: false, status: 503 } : base(url));
  const info = await lookupGameInfo({ name: '影之刃零', locale: 'zh-CN', fetch });
  assert.match(info.text, /武侠动作游戏/);
  assert.deepEqual(info.terms, []);
});

test('a term is described by its intro and profile section, at most TERM_MAX characters', async () => {
  const fetch = wiki({ 'https://zh.moegirl.org.cn': {
    万邪王: '万邪王是《影之刃》系列的角色。\n\n== 简介 ==\n盘踞在黑林树顶的黑林之主。\n\n== 能力 ==\n吸取精神。',
  } });
  assert.deepEqual(await lookupTerm({ source: '萌娘百科', title: '万邪王', fetch }), { text: '万邪王是《影之刃》系列的角色。 盘踞在黑林树顶的黑林之主。' });
  assert.equal(await lookupTerm({ source: '萌娘百科', title: '玉儿', fetch }), null);
  const long = wiki({ 'https://zh.moegirl.org.cn': { 长: `长。${'字'.repeat(1000)}` } });
  assert.ok([...(await lookupTerm({ source: '萌娘百科', title: '长', fetch: long })).text].length <= TERM_MAX);
});
