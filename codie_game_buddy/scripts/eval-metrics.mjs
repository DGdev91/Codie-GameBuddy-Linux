// How much a run of commentary remarks repeats itself (eval-commentary.mjs).

const OPENING_CHARS = 2;
const letters = text => [...text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')];

function bigrams(text) {
  const chars = letters(text);
  return new Set(chars.slice(0, -1).map((c, i) => c + chars[i + 1]));
}

// Jaccard similarity of two remarks' character bigrams, 0 to 1.
export function similarity(a, b) {
  const [x, y] = [bigrams(a), bigrams(b)];
  const shared = [...x].filter(g => y.has(g)).length;
  const union = x.size + y.size - shared;
  return union ? shared / union : 0;
}

const round = n => Math.round(n * 100) / 100;
const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);

// `remarks` in the order said. duplicates: remarks said before, word for
// word; sameOpening: remarks starting like an earlier one; meanNearest and
// maxNearest: each remark's similarity to the earlier remark closest to it.
export function repetition(remarks) {
  const later = remarks.map((remark, i) => ({ remark, earlier: remarks.slice(0, i) })).slice(1);
  const opening = text => letters(text).slice(0, OPENING_CHARS).join('');
  const nearest = later.map(({ remark, earlier }) => Math.max(...earlier.map(e => similarity(remark, e))));
  return {
    remarks: remarks.length,
    duplicates: later.filter(({ remark, earlier }) => earlier.some(e => letters(e).join('') === letters(remark).join(''))).length,
    sameOpening: later.filter(({ remark, earlier }) => earlier.some(e => opening(e) === opening(remark))).length,
    meanNearest: round(mean(nearest)),
    maxNearest: round(Math.max(0, ...nearest)),
    meanLength: round(mean(remarks.map(r => letters(r).length))),
  };
}
