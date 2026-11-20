// The wording a run of remarks keeps coming back to (spec §4.1.5). The model
// sees its last remarks and still reaches for the same words, so the loop
// names them: Latin words of five letters or more, and runs of two to eight
// characters in scripts written without spaces.
const MAX_CHARS = 8;
const LATIN_MIN = 5;
const RUNS = /[\p{Script=Latin}\p{N}]+|[^\p{Script=Latin}\p{N}\P{L}]+/gu;
const isLatin = run => /^[\p{Script=Latin}\p{N}]/u.test(run);

function phrasesOf(text) {
  const phrases = new Set();
  for (const [run] of text.toLowerCase().matchAll(RUNS)) {
    if (isLatin(run)) {
      if (run.length >= LATIN_MIN) phrases.add(run);
      continue;
    }
    const chars = [...run];
    for (let n = 2; n <= Math.min(MAX_CHARS, chars.length); n++) {
      for (let i = 0; i + n <= chars.length; i++) phrases.add(chars.slice(i, i + n).join(''));
    }
  }
  return phrases;
}

// Two phrases are one piece of wording when one holds the other or one's end
// is the other's start (的样 and 样子 are both of 的样子).
const joins = (a, b) => [...a].some((_, i) => i > 0 && b.startsWith([...a].slice(i).join('')));
const overlap = (a, b) => a.includes(b) || b.includes(a) || joins(a, b) || joins(b, a);

// [{ phrase, n }]: the phrases found in at least `min` of the remarks and how
// many remarks hold each, the most used and then the longest first. Of two
// phrases that are one piece of wording, only the one that comes first stays.
export function repeatedPhrases(remarks, min = 2) {
  const count = new Map();
  for (const remark of remarks) for (const phrase of phrasesOf(remark)) count.set(phrase, (count.get(phrase) ?? 0) + 1);
  return [...count]
    .filter(([, n]) => n >= min)
    .map(([phrase, n]) => ({ phrase, n }))
    .sort((a, b) => b.n - a.n || b.phrase.length - a.phrase.length || (a.phrase < b.phrase ? -1 : 1))
    .reduce((kept, next) => (kept.some(k => overlap(k.phrase, next.phrase)) ? kept : [...kept, next]), []);
}

// Up to `max` phrases that two or more of the remarks share.
export const wornPhrases = (remarks, max = 6) => repeatedPhrases(remarks).slice(0, max).map(r => r.phrase);
