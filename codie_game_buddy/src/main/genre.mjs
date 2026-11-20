// A game's genre, read from its looked-up background (game-info.mjs): the
// genre word that comes first wins, since the intro names the genre before
// anything else ("…开发的动作角色扮演游戏" is action, not rpg).
const WORDS = [
  ['moba', /多人在线战术|multiplayer online battle arena|\bmoba\b/i],
  ['card', /卡牌|集换式|card game|deck-?building/i],
  ['strategy', /即时战略|即时策略|策略游戏|战略游戏|real-time strategy|turn-based strategy|strategy (?:video )?game|\brts\b/i],
  ['shooter', /射击|shooter|\bfps\b/i],
  ['action', /动作|魂类|soulslike|hack and slash|\baction\b/i],
  ['rpg', /角色扮演|role-playing|\brpg\b/i],
];

// The genre of a background text, or null when it names none.
export function detectGenre(text) {
  let best = null;
  for (const [genre, re] of WORDS) {
    const at = text.search(re);
    if (at >= 0 && (best === null || at < best.at)) best = { genre, at };
  }
  return best?.genre ?? null;
}

// The genre a tip for `game` (an allow-list entry) is shaped by: the one the
// user set, else the one its background `info` names, else other.
export const genreOf = (game, info) => game?.genre ?? detectGenre(info?.text ?? '') ?? 'other';
