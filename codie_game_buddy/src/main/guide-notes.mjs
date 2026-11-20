import { cut, getJson } from './game-info.mjs';

// Tip notes for a guide wiki page (spec §4.1.4): the page's rendered HTML
// (BWIKI has no plain-text extracts) split into sections by heading, and the
// guide sections kept, best first: strategy, tips, weaknesses and phases;
// then the fight and how things combine; then moves and skills. A subsection
// ranks as its section unless its own heading says otherwise. Story, endings,
// trivia, galleries, skins and changelogs, and anything under them, never are.

export const TIP_MAX = 600;
// Shorter text says nothing a tip could be made of ("闪避后反击。" is enough).
const TIP_MIN = 4;
const TIP_RANKS = [
  /技巧|打法|攻略|指南|心得|应对|克制|弱点|耐性|抗性|战术|阶段|出装|\btips?\b|strateg|tactic|\bcounter|weakness|resist|phase|how to (?:beat|defeat)/i,
  /战斗|机制|搭配|协同|连招|boss fight|\bfight\b|combat|synergy|combo/i,
  /招式|技能|moveset|\bmoves\b|attacks|abilities/i,
];
const SKIP_HEADING = /剧情|结局|故事|画廊|图集|皮肤|更新|版本|参考|注释|链接|杂谈|台词|语音|配音|trivia|gallery|\bskins?\b|changelog|patch|history|references|notes|links|see also|lore|dialogue|quotes|ending|story|plot|media/i;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'tr', 'table', 'br', 'blockquote', 'section', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Elements whose text is never notes: edit links, the contents box,
// references, navboxes, galleries and links out (video lists).
const DROP_CLASS = /\b(?:mw-editsection|toc|reference|references|mw-references-wrap|navbox|gallery|external|noprint)\b/;
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

const decode = text => text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
  if (ENTITY[e]) return ENTITY[e];
  if (e[0] !== '#') return m;
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return code === 0xa0 ? ' ' : String.fromCodePoint(code);
});

const attr = (node, name) => {
  const m = node.attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[1] ?? m[2]) : '';
};

// A tree of { tag, attrs, children } elements and text strings. MediaWiki
// output is well formed; a stray closing tag closes up to its element.
function parseHtml(html) {
  const root = { tag: '#root', attrs: '', children: [] };
  const stack = [root];
  for (const m of html.matchAll(TOKEN)) {
    const top = stack.at(-1);
    if (m[2] === undefined) {
      if (!m[0].startsWith('<!--')) top.children.push(m[0]);
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.findLastIndex(n => n.tag === tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const node = { tag, attrs: m[3], children: [] };
    top.children.push(node);
    if (!VOID.has(tag) && !m[3].trimEnd().endsWith('/')) stack.push(node);
  }
  return root;
}

const isElement = node => typeof node !== 'string';
const hasExternalLink = node => node.children.some(c => isElement(c) && ((c.tag === 'a' && /\bexternal\b/.test(attr(c, 'class'))) || hasExternalLink(c)));
const dropped = node => node.tag === 'script' || node.tag === 'style' || attr(node, 'id') === 'toc'
  || DROP_CLASS.test(attr(node, 'class')) || (node.tag === 'li' && hasExternalLink(node));

function prune(node) {
  if (!isElement(node)) return node;
  if (dropped(node)) return null;
  return { ...node, children: node.children.map(prune).filter(c => c !== null) };
}

function textOf(node) {
  if (!isElement(node)) return decode(node);
  const inner = node.children.map(textOf).join('');
  return BLOCK.has(node.tag) ? `\n${inner}\n` : inner;
}

const clean = text => text.replace(/\s+/g, ' ').trim();
const find = (node, test) => (test(node) ? node : node.children.filter(isElement).map(c => find(c, test)).find(Boolean) ?? null);

// { level, text } for a heading (h2, or a newer MediaWiki's div.mw-heading
// holding one), or null.
function headingOf(node) {
  if (!isElement(node)) return null;
  const h = node.tag.match(/^h([1-6])$/);
  if (h) return { level: Number(h[1]), text: clean(textOf(node)) };
  if (node.tag !== 'div' || !/\bmw-heading\b/.test(attr(node, 'class'))) return null;
  const inner = node.children.find(c => isElement(c) && /^h[1-6]$/.test(c.tag));
  return inner ? headingOf(inner) : null;
}

// The page's sections in order: the lead first (level 1, no heading), then
// one per heading, each with its own text (not its subsections').
export function wikiSections(html) {
  const root = prune(parseHtml(html));
  const output = find(root, n => /\bmw-parser-output\b/.test(attr(n, 'class'))) ?? root;
  const sections = [{ level: 1, heading: '', parts: [] }];
  for (const node of output.children) {
    const heading = headingOf(node);
    if (heading) sections.push({ level: heading.level, heading: heading.text, parts: [] });
    else sections.at(-1).parts.push(textOf(node));
  }
  return sections.map(({ level, heading, parts }) => ({ level, heading, text: clean(parts.join('')) }));
}

const rankOf = heading => {
  const i = heading ? TIP_RANKS.findIndex(re => re.test(heading)) : -1;
  return i < 0 ? Infinity : i;
};
const enough = text => [...text].length >= TIP_MIN;

// Each section with its rank (Infinity: no guide) and whether it is skipped,
// both carried down from the section it is under.
function rankSections(sections) {
  const open = [];
  return sections.map((section, order) => {
    while (open.length && open.at(-1).level >= section.level) open.pop();
    const parent = open.at(-1);
    const own = rankOf(section.heading);
    const ranked = { ...section, order, rank: own < Infinity ? own : parent?.rank ?? Infinity, skip: Boolean(parent?.skip) || SKIP_HEADING.test(section.heading) };
    open.push(ranked);
    return ranked;
  });
}

// The page's guide sections, best first and each with its heading, as one
// line of at most `max` characters; without any, the first other text worth
// reading; '' for a page with neither.
export function pickTipNotes(html, max = TIP_MAX) {
  const sections = rankSections(wikiSections(html)).filter(s => !s.skip && enough(s.text));
  const guide = sections.filter(s => s.rank < Infinity).sort((a, b) => a.rank - b.rank || a.order - b.order);
  const text = guide.length ? guide.map(s => `${s.heading}: ${s.text}`).join(' ') : sections[0]?.text ?? '';
  return cut(text, max);
}

// { text } of tip notes for `title` on the guide wiki at `api`, or null.
export async function lookupGuideNotes({ api, title, fetch }) {
  const r = await getJson(fetch, api, { action: 'parse', page: title, prop: 'text', redirects: '1', disableeditsection: '1', disabletoc: '1', formatversion: '2' });
  const text = pickTipNotes(r?.parse?.text ?? '');
  return text ? { text } : null;
}
