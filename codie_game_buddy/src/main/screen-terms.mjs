import { normalize } from './game-info.mjs';

// Glossary terms on the frame (spec §4.1.2): OCR text matched against the
// game's glossary (game-info.mjs), with what the wiki says about each.

export const MAX_SHOWN = 3;
// A two-character name is often an everyday word too ("不能"): it counts only
// on a line of its own, such as a speaker label, give or take OCR noise.
const SHORT_NAME = 2;
const NOISE = 2;

// [name, page title] of the glossary terms in `lines`, in screen order. A
// name inside a longer matched name is not counted again.
export function matchTerms(lines, terms) {
  const normLines = lines.map(normalize).filter(Boolean);
  const starts = normLines.map((_, i) => normLines.slice(0, i).reduce((sum, l) => sum + l.length + 1, 0));
  const text = normLines.join('\n');
  const found = terms.flatMap(([name, title]) => {
    const n = normalize(name);
    if (!n) return [];
    if ([...n].length > SHORT_NAME) {
      const at = text.indexOf(n);
      return at < 0 ? [] : [{ name, title, n, at }];
    }
    const i = normLines.findIndex(l => l.includes(n) && [...l].length <= [...n].length + NOISE);
    return i < 0 ? [] : [{ name, title, n, at: starts[i] + normLines[i].indexOf(n) }];
  });
  const inLonger = f => found.some(g => g.n.length > f.n.length && g.n.includes(f.n) && f.at >= g.at && f.at < g.at + g.n.length);
  return found.filter(f => !inLonger(f)).sort((a, b) => a.at - b.at).map(f => [f.name, f.title]);
}

// describe(lines, info): [{ name, text }] for up to MAX_SHOWN glossary terms
// of `info` (a game background with `terms`) in the frame's OCR `lines`.
// A term seen for the first time is described from a later turn on.
export function createScreenTerms({ termInfo, log = () => {} }) {
  return {
    describe(lines, info) {
      const matched = matchTerms(lines, info.terms);
      if (matched.length) log(`screen terms: ${matched.map(([name]) => name).join(', ')}`);
      return matched
        .map(([name, title]) => ({ name, described: termInfo.get({ source: info.source, title }) }))
        .filter(t => t.described)
        .slice(0, MAX_SHOWN)
        .map(t => ({ name: t.name, text: t.described.text }));
    },
  };
}
