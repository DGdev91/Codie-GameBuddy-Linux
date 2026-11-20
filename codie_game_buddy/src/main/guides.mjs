import { detectGenre } from './genre.mjs';
import { matchTerms } from './screen-terms.mjs';

// Guide tips (spec §4.1.4): which guide wiki a game has, and which tip a frame
// gets. `gameInfo`, `guideWikis` and `guideNotes` are lookup caches
// (lookup-cache.mjs) of game-info.mjs, guide-wiki.mjs and guide-notes.mjs.

// A page whose tip was given is not offered again for this long, so a long
// boss fight gets a tip now and then, not in every remark.
export const TIP_REPEAT_MS = 5 * 60_000;

export function createGuides({ gameInfo, guideWikis, guideNotes, now = Date.now, log = () => {} }) {
  const lastGiven = new Map(); // page key -> when its tip was given

  // The lookup for `game` (an allow-list entry), or null while it cannot start:
  // without a wiki address it waits for the game's background, whose article
  // title names the game better than a window title does.
  function wikiArgs(game, locale) {
    const url = game.guideWiki ?? '';
    if (url) return { name: game.name, locale, url, title: null };
    const infoArgs = { name: game.name, locale };
    const info = gameInfo.get(infoArgs);
    if (!info && !gameInfo.settled(infoArgs)) return null;
    return { name: game.name, locale, url, title: info?.title ?? null };
  }

  const pageKey = (source, title) => `${source}:${title}`;

  return {
    // { source, api, terms } of the game's guide wiki, or null (a lookup may start).
    wikiFor(game, locale) {
      const args = wikiArgs(game, locale);
      return args ? guideWikis.get(args) : null;
    },

    // { name, title, source, text } for the first name in the OCR `lines`
    // whose page on `wiki` has tip notes and was not given lately, or null.
    tipFor(lines, wiki) {
      for (const [name, title] of matchTerms(lines, wiki.terms)) {
        if (now() - (lastGiven.get(pageKey(wiki.source, title)) ?? -Infinity) < TIP_REPEAT_MS) continue;
        const notes = guideNotes.get({ api: wiki.api, title });
        if (!notes) continue;
        log(`guide tip: ${name}`);
        return { name, title, source: wiki.source, text: notes.text };
      }
      return null;
    },

    // The tip went out in a remark.
    used(tip) {
      lastGiven.set(pageKey(tip.source, tip.title), now());
    },

    // For the settings window: { source, looking, genre } of `game`, where
    // genre is the one its background names (null when it names none).
    status(game, locale) {
      const info = gameInfo.get({ name: game.name, locale });
      const args = wikiArgs(game, locale);
      const wiki = args ? guideWikis.get(args) : null;
      return { source: wiki?.source ?? null, looking: !args || !guideWikis.settled(args), genre: info ? detectGenre(info.text ?? '') : null };
    },
  };
}
