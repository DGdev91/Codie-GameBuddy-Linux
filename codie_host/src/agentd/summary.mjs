const FALLBACK = 'The task has finished.';

// Closing brackets/quotes/markdown that may trail a question mark.
const TRAILING = /[\s)）\]】」』"”'’`*_~]+$/u;

// True when the message's final sentence is a question (ends with ? or ？).
export function endsWithQuestion(text) {
  if (!text) return false;
  const s = String(text).replace(/```[\s\S]*?```\s*$/, '').replace(TRAILING, '');
  return /[?？]$/.test(s);
}

// Device TTS reads this aloud, so code and markdown syntax must go.
export function toSpokenSummary(text, max = 200) {
  if (!text) return FALLBACK;
  const s = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*|__|\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return FALLBACK;
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…';
}
