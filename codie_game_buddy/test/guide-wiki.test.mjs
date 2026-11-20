import assert from 'node:assert/strict';
import test from 'node:test';
import { guideTerms, lookupGuideWiki, RETRY_WAITS_MS, searchNames, wikiApiCandidates } from '../src/main/guide-wiki.mjs';

const PORTAL = 'https://wiki.biligame.com/wiki/api.php';
const BW = slug => `https://wiki.biligame.com/${slug}/api.php`;

// A fake set of MediaWiki APIs, by api.php URL. A URL with no handler answers
// a web page, as a closed BWIKI or an unknown Fandom subdomain does.
function apis(handlers, calls = []) {
  return async url => {
    calls.push(url);
    const u = new URL(url);
    const handler = handlers[`${u.origin}${u.pathname}`];
    if (!handler) return { ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    const body = handler(Object.fromEntries(u.searchParams));
    return { ok: true, json: async () => body };
  };
}

const siteinfo = (sitename, mainpage = 'Main Page') => ({ query: { general: { sitename, mainpage } } });
const allpages = titles => ({ query: { allpages: titles.map(title => ({ ns: 0, title })) } });

// The BWIKI portal: a page per sub-wiki, holding its game's name and domain.
const portalEntry = (title, game, domain, index) => ({
  title, index, revisions: [{ slots: { main: { content: `{{游戏WIKI详情页\n|游戏名=${game}\n|WIKI域名=${domain}\n|上线状态=已上线\n}}` } } }],
});
const portal = entries => params => (params.generator === 'prefixsearch' ? { query: { pages: entries } } : {});

// A wiki that answers siteinfo and allpages.
const wikiOf = (sitename, titles, mainpage) => params => {
  if (params.meta === 'siteinfo') return siteinfo(sitename, mainpage);
  if (params.list === 'allpages') return allpages(titles);
  return {};
};

const noSleep = async () => {};

test('Chinese finds the BWIKI whose game name matches exactly, by the background title', async () => {
  const calls = [];
  const fetch = apis({
    [PORTAL]: portal([portalEntry('杀戮尖塔2WIKI', '杀戮尖塔2', 'slaythespire2', 1), portalEntry('杀戮尖塔WIKI', '杀戮尖塔', 'slaythespire', 2)]),
    [BW('slaythespire')]: wikiOf('杀戮尖塔WIKI_BWIKI_哔哩哔哩', ['鸟居', '燃烧之血'], '首页'),
  }, calls);
  const r = await lookupGuideWiki({ name: 'Slay the Spire', title: '杀戮尖塔', locale: 'zh-CN', fetch, sleep: noSleep });
  assert.deepEqual(r, { source: '杀戮尖塔WIKI', api: BW('slaythespire'), terms: [['鸟居', '鸟居'], ['燃烧之血', '燃烧之血']] });
  assert.ok(!calls.some(u => u.includes('slaythespire2')));
});

test('a BWIKI that has closed (its API answers a web page) is no guide', async () => {
  const fetch = apis({ [PORTAL]: portal([portalEntry('星际争霸2WIKI', '星际争霸2', 'sc2', 1)]) });
  assert.equal(await lookupGuideWiki({ name: '星际争霸2', title: '星际争霸2', locale: 'zh-CN', fetch, sleep: noSleep }), null);
});

test('the portal is also searched by the name without a trailing number or subtitle', async () => {
  const searched = [];
  const fetch = apis({
    [PORTAL]: params => {
      searched.push(params.gpssearch);
      return params.gpssearch === '黑神话' ? { query: { pages: [portalEntry('黑神话：悟空WIKI', '黑神话：悟空', 'wukong', 1)] } } : {};
    },
    [BW('wukong')]: wikiOf('黑神话：悟空WIKI_BWIKI_哔哩哔哩', ['虎先锋']),
  });
  const r = await lookupGuideWiki({ name: '黑神话：悟空', title: null, locale: 'zh-CN', fetch, sleep: noSleep });
  assert.equal(r.api, BW('wukong'));
  assert.deepEqual(searched, ['黑神话：悟空', '黑神话']);
});

test('English guesses a Fandom, then a wiki.gg, then the name without its numeral', async () => {
  const calls = [];
  const fetch = apis({
    'https://starcraft.wiki.gg/api.php': wikiOf('StarCraft Wiki', ['Zergling', 'Baneling']),
  }, calls);
  const r = await lookupGuideWiki({ name: 'StarCraft II', title: 'StarCraft II', locale: 'en', fetch, sleep: noSleep });
  assert.deepEqual(r, { source: 'StarCraft Wiki', api: 'https://starcraft.wiki.gg/api.php', terms: [['Zergling', 'Zergling'], ['Baneling', 'Baneling']] });
  const hosts = calls.map(u => new URL(u).host);
  assert.deepEqual(hosts.slice(0, 4), ['starcraftii.fandom.com', 'starcraftii.wiki.gg', 'starcraft.fandom.com', 'starcraft.wiki.gg']);
});

test('a game is also searched without its number, numeral or subtitle', () => {
  assert.deepEqual(searchNames(['StarCraft II', 'starcraft2.exe title']), ['StarCraft II', 'StarCraft', 'starcraft2.exe title']);
  assert.deepEqual(searchNames(['星际争霸2']), ['星际争霸2', '星际争霸']);
  assert.deepEqual(searchNames(['Hawaii', null]), ['Hawaii']);
  assert.deepEqual(searchNames(['Black Myth: Wukong']), ['Black Myth: Wukong', 'Black Myth']);
});

test("a guessed wiki whose name is not the game's is skipped", async () => {
  const fetch = apis({ 'https://control.fandom.com/api.php': wikiOf('Mind Control Wiki', ['Jesse']) });
  assert.equal(await lookupGuideWiki({ name: 'Control', title: 'Control', locale: 'en', fetch, sleep: noSleep }), null);
});

test("the user's wiki address wins over the search, in any language", async () => {
  const calls = [];
  const fetch = apis({ [BW('eldenring')]: wikiOf('艾尔登法环WIKI_BWIKI_哔哩哔哩', ['玛尔基特']) }, calls);
  const r = await lookupGuideWiki({ name: 'ELDEN RING', title: 'Elden Ring', locale: 'en', url: 'https://wiki.biligame.com/eldenring/%E9%A6%96%E9%A1%B5', fetch, sleep: noSleep });
  assert.deepEqual(r, { source: '艾尔登法环WIKI', api: BW('eldenring'), terms: [['玛尔基特', '玛尔基特']] });
  assert.ok(!calls.some(u => u.includes('fandom') || u.includes(PORTAL)));
});

test('a wiki address gives its api.php candidates; anything but https gives none', () => {
  assert.deepEqual(wikiApiCandidates('https://wiki.biligame.com/eldenring/%E9%A6%96%E9%A1%B5'), [BW('eldenring'), 'https://wiki.biligame.com/api.php', 'https://wiki.biligame.com/w/api.php']);
  assert.deepEqual(wikiApiCandidates('https://eldenring.fandom.com/wiki/Margit'), ['https://eldenring.fandom.com/api.php', 'https://eldenring.fandom.com/w/api.php']);
  assert.deepEqual(wikiApiCandidates('https://eldenring.fandom.com/zh/wiki/Margit'), ['https://eldenring.fandom.com/zh/api.php', 'https://eldenring.fandom.com/api.php', 'https://eldenring.fandom.com/w/api.php']);
  assert.deepEqual(wikiApiCandidates('https://example.org/w/api.php'), ['https://example.org/w/api.php']);
  assert.deepEqual(wikiApiCandidates('http://eldenring.fandom.com/'), []);
  assert.deepEqual(wikiApiCandidates('not a url'), []);
});

test('no wiki found gives null; a wiki without usable titles still names its source', async () => {
  assert.equal(await lookupGuideWiki({ name: 'Nothing', title: null, locale: 'en', fetch: apis({}), sleep: noSleep }), null);
  const fetch = apis({ 'https://nothing.fandom.com/api.php': wikiOf('Nothing Wiki', ['Nothing']) });
  assert.deepEqual(await lookupGuideWiki({ name: 'Nothing', title: null, locale: 'en', fetch, sleep: noSleep }), { source: 'Nothing Wiki', api: 'https://nothing.fandom.com/api.php', terms: [] });
});

test('a wiki that rate-limits the titles (BWIKI HTTP 567) is asked again after a wait, then given up on', async () => {
  let answers = [567, 514, 200];
  const fetch = async () => {
    const status = answers.shift() ?? 567;
    return status === 200
      ? { ok: true, status, json: async () => allpages(['玛尔基特']) }
      : { ok: false, status, json: async () => ({}) };
  };
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  assert.deepEqual(await guideTerms({ api: BW('eldenring'), game: '艾尔登法环', mainpage: '首页', fetch, sleep }), [['玛尔基特', '玛尔基特']]);
  assert.deepEqual(waits, RETRY_WAITS_MS.slice(0, 2));
  answers = [];
  waits.length = 0;
  await assert.rejects(guideTerms({ api: BW('eldenring'), game: '艾尔登法环', mainpage: '首页', fetch, sleep }), /HTTP 567/);
  assert.deepEqual(waits, RETRY_WAITS_MS);
});

test('a page that is not found is not asked again', async () => {
  let asked = 0;
  const fetch = async () => { asked++; return { ok: false, status: 404, json: async () => ({}) }; };
  await assert.rejects(guideTerms({ api: BW('x'), game: 'x', mainpage: '', fetch, sleep: noSleep }), /HTTP 404/);
  assert.equal(asked, 1);
});

test('the titles are read page by page, and only names that can match safely are kept', async () => {
  const pages = [
    ['玛尔基特', '首页', '剑', 'Data:Map/point/1', '虎先锋/数据', '艾尔登法环', '葛瑞克（Boss）'],
    ['Margit, the Fell Omen', 'Map', 'Elden Ring Wiki'],
  ];
  const asked = [];
  const fetch = apis({
    'https://x.fandom.com/api.php': params => {
      asked.push(params.apcontinue ?? null);
      const i = params.apcontinue ? 1 : 0;
      return { ...allpages(pages[i]), ...(i === 0 ? { continue: { apcontinue: 'M', continue: '-||' } } : {}) };
    },
  });
  const waits = [];
  const terms = await guideTerms({ api: 'https://x.fandom.com/api.php', game: '艾尔登法环', mainpage: '首页', fetch, sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(terms, [['玛尔基特', '玛尔基特'], ['葛瑞克', '葛瑞克（Boss）'], ['Margit, the Fell Omen', 'Margit, the Fell Omen'], ['Elden Ring Wiki', 'Elden Ring Wiki']]);
  assert.deepEqual(asked, [null, 'M']);
  assert.deepEqual(waits, []); // spacing is the fetch's job (host-throttle.mjs); waits are for refusals
});

test('titles that stop inside a tree of subpages go on after the tree', async () => {
  const asked = [];
  const fetch = apis({
    'https://x.fandom.com/api.php': params => {
      asked.push([params.apcontinue ?? null, params.apfrom ?? null]);
      return params.apfrom
        ? allpages(['温迪'])
        : { ...allpages(['Boss攻略合集', 'Data:Map/point/1', 'Data:Map/point/2']), continue: { apcontinue: 'Data:Map/point/3', continue: '-||' } };
    },
  });
  const terms = await guideTerms({ api: 'https://x.fandom.com/api.php', game: '原神', mainpage: '首页', fetch, sleep: noSleep });
  assert.deepEqual(terms.map(t => t[0]), ['Boss攻略合集', '温迪']);
  assert.deepEqual(asked, [[null, null], [null, 'Data:Map0']]);
});

test('a wiki address that refuses the request is a failed lookup, not a game without a wiki', async () => {
  const fetch = async () => ({ ok: false, status: 567, json: async () => ({}) });
  await assert.rejects(lookupGuideWiki({ name: '原神', locale: 'zh-CN', url: 'https://wiki.biligame.com/ys', fetch, sleep: noSleep }), /HTTP 567/);
});
