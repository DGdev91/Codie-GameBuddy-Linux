// Background on a game for the commentary prompt: the intro and the first
// background section of its wiki article, plus the glossary of names (people,
// places, events) that screen-terms.mjs looks for on screen. Chinese tries
// Moegirlpedia first (reachable from mainland China, unlike Wikipedia), then
// Wikipedia.
const SOURCES = {
  'zh-CN': [
    { name: '萌娘百科', api: 'https://zh.moegirl.org.cn/api.php' },
    { name: '维基百科', api: 'https://zh.wikipedia.org/w/api.php' },
  ],
  en: [{ name: 'Wikipedia', api: 'https://en.wikipedia.org/w/api.php' }],
};
// Moegirlpedia refuses anonymous list=search; opensearch (title suggestions) works on both.
const MAX_TITLES = 3;
const TIMEOUT_MS = 8_000;
const HEADERS = { 'user-agent': 'codie-game-buddy/0.1' };

export const BACKGROUND_MAX = 600;
export const TERM_MAX = 200;
// Section titles that carry the world and story, or who a character is; the
// ending never does.
const BACKGROUND_SECTION = /背景|世界观|剧情|故事|设定|介绍|简介|setting|synopsis|premise|plot|story/i;
const SPOILER_SECTION = /结局|ending/i;
const ABOUT_A_GAME = /游戏|遊戲|\bgame\b/i;

const HEADING = /^(=+)\s*(.+?)\s*\1\s*$/;

// The intro plus the first top-level background section (its subsections
// included, their headings dropped), as one line of at most `max` characters.
export function pickBackground(extract, max = BACKGROUND_MAX) {
  const intro = [];
  let section = null;
  let current = intro;
  for (const line of extract.split('\n')) {
    const h = line.match(HEADING);
    if (!h) { current?.push(line); continue; }
    if (h[1].length > 2) continue; // a subsection stays in its section
    if (section) { current = null; continue; }
    const wanted = BACKGROUND_SECTION.test(h[2]) && !SPOILER_SECTION.test(h[2]);
    current = wanted ? (section = []) : null;
  }
  return cut([...intro, ...(section ?? [])].join(' ').replace(/\s+/g, ' ').trim(), max);
}

// `text` in at most `max` characters, an ellipsis marking a cut.
export function cut(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

// Letters and digits only, lower case: how names are compared with screen text.
export const normalize = text => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
// A shorter name matches too much screen text by chance.
const MIN_NAME = { cjk: 2, latin: 4 };
const MAX_NAVBOXES = 4;
const MAX_TERMS = 400;
const DISAMBIGUATION = /\s*[(（][^)）]*[)）]\s*$/;
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };

// [name, page] for a page title worth looking for on screen, or null: the
// disambiguation suffix dropped, and not a name too short to match safely or
// one that is part of the game's own name `game` (normalized) or holds it.
export function termOf(page, game) {
  const name = page.replace(DISAMBIGUATION, '');
  const n = normalize(name);
  const min = /[^\p{Script=Latin}\p{N}]/u.test(n) ? MIN_NAME.cjk : MIN_NAME.latin;
  if ([...n].length < min || n.includes(game) || game.includes(n)) return null;
  return [name, page];
}

export async function getJson(fetch, api, params) {
  const url = `${api}?${new URLSearchParams({ format: 'json', ...params })}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

async function extractOf(fetch, api, title) {
  const r = await getJson(fetch, api, {
    action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1',
    variant: 'zh-cn', formatversion: '2', titles: title,
  });
  const page = r?.query?.pages?.[0];
  return page?.extract ? { title: page.title ?? title, extract: page.extract } : null;
}

const titlesOf = async (fetch, api, params) =>
  ((await getJson(fetch, api, { action: 'query', formatversion: '2', ...params }))?.query?.pages?.[0]?.[params.prop] ?? []).map(t => t.title);

// [name, page title] pairs from the game's own navboxes: the templates the
// article uses whose name starts like the game's (Template:影之刃系列 for
// 影之刃零), not the generic ones (Template:中国电子游戏作品). The game, the
// series and names too short to match safely are left out.
async function glossaryOf(fetch, api, title) {
  const game = normalize(title);
  const templates = (await titlesOf(fetch, api, { prop: 'templates', tlnamespace: '10', tllimit: 'max', titles: title }))
    .filter(t => commonPrefix(normalize(t.replace(/^[^:]*:/, '')), game) >= Math.min(2, game.length))
    .slice(0, MAX_NAVBOXES);
  const skip = new Set(templates.map(t => normalize(t.replace(/^[^:]*:/, ''))));
  const terms = new Map();
  for (const template of templates) {
    for (const page of await titlesOf(fetch, api, { prop: 'links', plnamespace: '0', pllimit: 'max', titles: template })) {
      const term = termOf(page, game);
      if (!term || skip.has(normalize(term[0])) || terms.has(term[0])) continue;
      terms.set(...term);
    }
  }
  return [...terms].slice(0, MAX_TERMS);
}

async function fromSource(fetch, source, name) {
  const [, titles = []] = await getJson(fetch, source.api, { action: 'opensearch', search: name, limit: String(MAX_TITLES), namespace: '0' });
  for (const candidate of titles.slice(0, MAX_TITLES)) {
    const page = await extractOf(fetch, source.api, candidate);
    if (!page) continue;
    const text = pickBackground(page.extract);
    if (!ABOUT_A_GAME.test(text)) continue;
    // The background stands without the glossary.
    const terms = await glossaryOf(fetch, source.api, page.title).catch(() => []);
    return { source: source.name, title: page.title, text, terms };
  }
  return null;
}

// { source, title, text, terms } for the game, or null when no source has it
// or the network fails; the caller retries later.
export async function lookupGameInfo({ name, locale, fetch }) {
  for (const source of SOURCES[locale] ?? SOURCES.en) {
    try {
      const info = await fromSource(fetch, source, name);
      if (info) return info;
    } catch { /* try the next source */ }
  }
  return null;
}

// { text } describing a glossary term's page on `source` (who or what it is),
// or null when the page has no text.
export async function lookupTerm({ source, title, fetch }) {
  const api = Object.values(SOURCES).flat().find(s => s.name === source)?.api;
  if (!api) return null;
  const page = await extractOf(fetch, api, title);
  const text = page ? pickBackground(page.extract, TERM_MAX) : '';
  return text ? { text } : null;
}
