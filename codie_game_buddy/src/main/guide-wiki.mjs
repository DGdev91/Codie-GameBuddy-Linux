import { getJson, normalize, termOf } from './game-info.mjs';

// The guide wiki of a game on the allow list (spec §4.1.4): the wiki address
// the user gave, else for Chinese the BWIKI the bilibili portal lists for the
// game, else for English a Fandom or wiki.gg guessed from the game's name.
// Its page titles are the guide glossary that screen text is matched against.

const PORTAL = 'https://wiki.biligame.com/wiki/api.php';
const BWIKI = domain => `https://wiki.biligame.com/${domain}/api.php`;
const GUESSED_HOSTS = [slug => `https://${slug}.fandom.com/api.php`, slug => `https://${slug}.wiki.gg/api.php`];
const PORTAL_RESULTS = '10';
// Titles come 500 a page to anonymous readers. BWIKI rate-limits bursts
// (HTTP 514, 567): the caller's fetch spaces requests per host
// (host-throttle.mjs), and a refused request is asked again after a wait.
const TITLES_PER_PAGE = '500';
const MAX_TITLE_PAGES = 60;
export const RETRY_WAITS_MS = Object.freeze([3_000, 10_000, 30_000]);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const refused = e => e?.status === 429 || e?.status >= 500;

async function getJsonPatiently(fetch, api, params, sleep) {
  for (let i = 0; ; i++) {
    try {
      return await getJson(fetch, api, params);
    } catch (e) {
      if (!refused(e) || i >= RETRY_WAITS_MS.length) throw e;
      await sleep(RETRY_WAITS_MS[i]);
    }
  }
}

// The names a game is searched by: as given, without a trailing number (or a
// Roman numeral after a space: StarCraft II, not Hawaii), and without a subtitle.
export const searchNames = names => [...new Set(names.filter(Boolean).flatMap(n => [
  n, n.replace(/(?:\s*\d+|\s+[IVX]+)$/i, ''), n.replace(/\s*[：:].*$/, ''),
]).map(n => n.trim()).filter(Boolean))];

// { sitename, mainpage } of the MediaWiki at `api`, or null when it is not one
// (a closed BWIKI or an unknown Fandom answers a web page). A site that
// refuses the request may be one: that is a failed lookup, not a miss.
async function siteOf(fetch, api) {
  try {
    const general = (await getJson(fetch, api, { action: 'query', meta: 'siteinfo', formatversion: '2' }))?.query?.general;
    return general?.sitename ? { sitename: general.sitename, mainpage: general.mainpage ?? '' } : null;
  } catch (e) {
    if (refused(e)) throw e;
    return null;
  }
}

// BWIKI site names carry the platform after the game ("艾尔登法环WIKI_BWIKI_哔哩哔哩").
const sourceName = sitename => sitename.split('_')[0];

// The portal has a page per sub-wiki whose content holds 游戏名= and WIKI域名=.
async function findBwiki(fetch, names, sleep) {
  const wanted = new Set(names.filter(Boolean).map(normalize));
  const tried = new Set();
  for (const q of searchNames(names)) {
    const r = await getJsonPatiently(fetch, PORTAL, {
      action: 'query', generator: 'prefixsearch', gpssearch: q, gpslimit: PORTAL_RESULTS,
      prop: 'revisions', rvprop: 'content', rvslots: 'main', formatversion: '2',
    }, sleep);
    const pages = [...(r?.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const page of pages) {
      const content = page.revisions?.[0]?.slots?.main?.content ?? '';
      const domain = content.match(/WIKI域名=([^\s|}]+)/)?.[1];
      const game = content.match(/游戏名=([^\n|}]+)/)?.[1]?.trim() ?? '';
      if (!domain || !wanted.has(normalize(game)) || tried.has(domain)) continue;
      tried.add(domain);
      const site = await siteOf(fetch, BWIKI(domain));
      if (site) return { source: page.title, api: BWIKI(domain), mainpage: site.mainpage };
    }
  }
  return null;
}

// A Fandom or wiki.gg named like the game: the site name must start with it,
// so "control" does not pick the Mind Control Wiki.
async function guessEnglishWiki(fetch, names) {
  const slugs = [...new Set(searchNames(names).map(n => normalize(n)).filter(Boolean))];
  for (const slug of slugs) {
    for (const host of GUESSED_HOSTS) {
      const site = await siteOf(fetch, host(slug));
      if (site && normalize(site.sitename).startsWith(slug)) return { source: sourceName(site.sitename), api: host(slug), mainpage: site.mainpage };
    }
  }
  return null;
}

// Where the api.php of a wiki page's address may be: the address itself when
// it is one, else under the first path segment (BWIKI's /eldenring/, a
// Fandom language's /zh/), at the root, or under /w/ (Wikipedia). https only.
export function wikiApiCandidates(address) {
  let url;
  try { url = new URL(address); } catch { return []; }
  if (url.protocol !== 'https:') return [];
  if (url.pathname.endsWith('/api.php')) return [`${url.origin}${url.pathname}`];
  const first = url.pathname.split('/').filter(Boolean)[0];
  const under = first && first !== 'wiki' && first !== 'w' ? [`${url.origin}/${first}/api.php`] : [];
  return [...new Set([...under, `${url.origin}/api.php`, `${url.origin}/w/api.php`])];
}

async function resolveWikiAddress(fetch, address) {
  for (const api of wikiApiCandidates(address)) {
    const site = await siteOf(fetch, api);
    if (site) return { source: sourceName(site.sitename), api, mainpage: site.mainpage };
  }
  return null;
}

// [name, page] for every article title on the wiki that can match screen
// text: no subpages (虎先锋/数据), not the main page, and by the rules of the
// background glossary (game-info.mjs termOf).
export async function guideTerms({ api, game, mainpage, fetch, sleep = pause }) {
  const gameName = normalize(game ?? '');
  const terms = new Map();
  let next = {};
  for (let i = 0; i < MAX_TITLE_PAGES; i++) {
    const r = await getJsonPatiently(fetch, api, {
      action: 'query', list: 'allpages', apnamespace: '0', apfilterredir: 'nonredirects', aplimit: TITLES_PER_PAGE, formatversion: '2',
      ...next,
    }, sleep);
    const pages = r?.query?.allpages ?? [];
    for (const { title } of pages) {
      if (title.includes('/') || title === mainpage) continue;
      const term = termOf(title, gameName);
      if (term && !terms.has(term[0])) terms.set(...term);
    }
    if (!r?.continue?.apcontinue) break;
    // A wiki may keep tens of thousands of subpages under one page (a map's
    // data points): when the titles stop inside such a tree, the rest of it
    // is skipped, as subpages are not terms. '0' sorts right after '/'.
    const last = pages.at(-1)?.title ?? '';
    next = last.includes('/') ? { apfrom: `${last.slice(0, last.indexOf('/'))}0` } : { apcontinue: r.continue.apcontinue };
  }
  return [...terms];
}

// { source, api, terms } of the game's guide wiki, or null when there is none.
// `title` is the game's background article title (game-info.mjs), a better
// name than the allow-list one, which may be a window title; `url` is the
// wiki address the user gave, or ''.
export async function lookupGuideWiki({ name, title = null, locale, url = '', fetch, sleep = pause }) {
  const names = [title, name];
  const site = url
    ? await resolveWikiAddress(fetch, url)
    : locale === 'zh-CN' ? await findBwiki(fetch, names, sleep) : await guessEnglishWiki(fetch, names);
  if (!site) return null;
  const terms = await guideTerms({ api: site.api, game: title ?? name, mainpage: site.mainpage, fetch, sleep });
  return { source: site.source, api: site.api, terms };
}
