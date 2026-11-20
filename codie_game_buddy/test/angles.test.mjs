import assert from 'node:assert/strict';
import test from 'node:test';
import { GENRES } from '../src/shared/genres.mjs';
import { ANGLES, anglesFor, nextAngle, playFocus } from '../src/main/angles.mjs';

test('a strategy game is talked about as one: economy, army, unit handling, progress and the map', () => {
  assert.deepEqual(anglesFor('strategy'), ['moment', 'world', 'economy', 'army', 'micro', 'progress', 'map', 'mood']);
  assert.match(playFocus('strategy', 'economy'), /resources coming in, the workers/);
  assert.match(playFocus('strategy', 'army'), /size and make-up/);
  assert.match(playFocus('strategy', 'micro'), /handle their units in a fight/);
});

test('every genre has its own sides of play; a game of no known genre has the one general angle', () => {
  for (const genre of GENRES) {
    const play = anglesFor(genre).filter(a => playFocus(genre, a));
    assert.ok(play.length >= (genre === 'other' ? 1 : 3), genre);
    assert.deepEqual(anglesFor(genre).filter(a => !play.includes(a)), ['moment', 'world', 'mood']);
  }
  assert.deepEqual(anglesFor('other'), ['moment', 'world', 'player', 'mood']);
  assert.deepEqual(anglesFor(undefined), anglesFor('other'));
  assert.equal(playFocus('strategy', 'mood'), null);
  assert.equal(playFocus('action', 'economy'), null);
});

test('the next angle is one of the genre\'s, away from the last two', () => {
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let used = [];
  for (let i = 0; i < 200; i++) {
    const next = nextAngle(used, random, { genre: 'strategy' });
    assert.ok(anglesFor('strategy').includes(next));
    assert.ok(!used.slice(0, 2).includes(next));
    used = [next, ...used];
  }
  assert.deepEqual([...new Set(used)].sort(), [...anglesFor('strategy')].sort());
});

test('the first remark may take any angle', () => {
  assert.equal(nextAngle([], () => 0), ANGLES[0]);
  assert.equal(nextAngle([], () => 0.999), ANGLES.at(-1));
});

test('a remark never takes one of the last two angles', () => {
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    const next = nextAngle(['world', 'moment', 'player'], random);
    assert.ok(['player', 'mood'].includes(next), next);
  }
  assert.equal(nextAngle(['mood', 'player'], () => 0), 'moment');
  assert.equal(nextAngle(['mood', 'player'], () => 0.999), 'world');
});

test('a game without a background never gets the world angle', () => {
  let used = [];
  for (let i = 0; i < 30; i++) {
    const next = nextAngle(used, () => (i % 3) / 3, { world: false });
    assert.notEqual(next, 'world');
    assert.ok(!used.slice(0, 2).includes(next));
    used = [next, ...used];
  }
  assert.deepEqual([...new Set(used)].sort(), ['moment', 'mood', 'player']);
});

test('a long run keeps moving: no angle twice within three remarks', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let used = [];
  for (let i = 0; i < 200; i++) {
    const next = nextAngle(used, random);
    assert.ok(!used.slice(0, 2).includes(next));
    used = [next, ...used];
  }
  assert.deepEqual([...new Set(used)].sort(), [...ANGLES].sort());
});
