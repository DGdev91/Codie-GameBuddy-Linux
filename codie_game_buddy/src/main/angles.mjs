// What a passing remark is about. The model starts every turn from nothing
// and a scene barely changes between remarks, so the loop, not the model,
// moves the remarks from one angle to the next (spec §4.1.5).

// The sides of the player's game a remark can look at, per genre (genre.mjs):
// what someone who plays that kind of game would talk about.
const PLAY = {
  strategy: {
    economy: 'their economy: the resources coming in, the workers, what they can afford',
    army: "their army: its size and make-up, and how it matches the enemy's",
    micro: 'how they handle their units in a fight: positioning, focus, retreats',
    progress: 'their base and progress: buildings, upgrades, the age or tech they have reached',
    map: 'the map: what they hold, scout or leave open',
  },
  action: {
    fight: "the fight: how they read the enemy's attacks, dodge and find openings",
    survival: 'how they are holding up: health, healing, the risks they take',
    route: 'where they are heading and how they explore',
  },
  rpg: {
    quest: 'the quest or goal they are on and how it is going',
    party: 'their character or party: build, gear, the skills in use',
    choices: 'the choices they make: in talk, on the way, in a fight',
  },
  shooter: {
    aim: 'their aim and how they take fights',
    position: 'their positioning and movement: cover, angles, rotations',
    round: 'the round: the score, what is left of each side, their loadout',
  },
  moba: {
    lane: 'their lane or role: farm, trades, pressure',
    lead: "their gold, level and items against the enemy's",
    fights: 'team fights and objectives: when they join and what they take',
  },
  card: {
    hand: 'their hand and energy: what they play and in what order',
    deck: 'their deck or build: what works together in it',
    threat: 'what the enemy is about to do and how they answer it',
  },
  other: {
    player: 'what they just pulled off, how they play, or where it is going wrong for them',
  },
};

const playOf = genre => PLAY[genre] ?? PLAY.other;

// A genre's angles: the moment, the game's world, each side of the player's
// game, and the mood of the scene.
export const anglesFor = genre => ['moment', 'world', ...Object.keys(playOf(genre)), 'mood'];
export const ANGLES = Object.freeze(anglesFor('other'));

// What a play angle of `genre` looks at, or null for another angle.
export const playFocus = (genre, angle) => playOf(genre)[angle] ?? null;

// How many of the last angles the next remark stays away from.
const AVOID = 2;

// The next remark's angle: one of the genre's not among the last two taken
// (`used`, newest first). `world` is open only to a game with a looked-up
// background: without one the model made the lore up.
export function nextAngle(used, random = Math.random, { world = true, genre = 'other' } = {}) {
  const open = anglesFor(genre).filter(a => (world || a !== 'world') && !used.slice(0, AVOID).includes(a));
  return open[Math.floor(random() * open.length)];
}
