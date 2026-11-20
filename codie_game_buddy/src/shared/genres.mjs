// The game genres a guide tip is shaped by (spec §4.1.4), shared by the main
// process and the settings page. `other` is any game none of the rest fits.
export const GENRES = Object.freeze(['action', 'strategy', 'rpg', 'shooter', 'moba', 'card', 'other']);

// Whether a game's resources are read before each remark (spec §4.1.6): as
// the user set it for the game, else for the genres that keep a resource bar
// on screen. `genre` is the game's own or the one its background names.
const COUNTER_GENRES = Object.freeze(['strategy']);
export const countersByGenre = genre => COUNTER_GENRES.includes(genre);
export const readsCounters = (game, genre) => game?.readCounters ?? countersByGenre(genre);
