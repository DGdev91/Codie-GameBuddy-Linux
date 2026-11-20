import assert from 'node:assert/strict';
import test from 'node:test';
import { detectGenre, genreOf } from '../src/main/genre.mjs';
import { GENRES } from '../src/shared/genres.mjs';

test('the first genre word in the background decides', () => {
  assert.equal(detectGenre('《黑神话：悟空》是游戏科学开发的动作角色扮演游戏。'), 'action');
  assert.equal(detectGenre('Elden Ring is an action role-playing game.'), 'action');
  assert.equal(detectGenre('《星际争霸II》是暴雪娱乐制作的即时战略游戏。'), 'strategy');
  assert.equal(detectGenre('StarCraft II is a military science fiction real-time strategy video game.'), 'strategy');
  assert.equal(detectGenre("Baldur's Gate 3 is a role-playing video game."), 'rpg');
  assert.equal(detectGenre('《无畏契约》是拳头游戏开发的第一人称射击游戏。'), 'shooter');
  assert.equal(detectGenre('League of Legends is a multiplayer online battle arena video game.'), 'moba');
  assert.equal(detectGenre('《炉石传说》是一款集换式卡牌游戏。'), 'card');
  assert.equal(detectGenre('Slay the Spire is a roguelike deck-building game.'), 'card');
});

test('a background without a genre word gives null', () => {
  assert.equal(detectGenre('A game about rings.'), null);
  assert.equal(detectGenre(''), null);
});

test("a game's own genre wins over the detected one; neither gives other", () => {
  assert.equal(genreOf({ name: 'G', genre: 'moba' }, { text: '即时战略游戏' }), 'moba');
  assert.equal(genreOf({ name: 'G' }, { text: '即时战略游戏' }), 'strategy');
  assert.equal(genreOf({ name: 'G' }, null), 'other');
  assert.equal(genreOf(null, null), 'other');
});

test('every detected genre is one the settings know', () => {
  const texts = ['动作', '即时战略', '角色扮演', '射击', 'multiplayer online battle arena', '卡牌'];
  for (const text of texts) assert.ok(GENRES.includes(detectGenre(text)), text);
  assert.ok(GENRES.includes('other'));
});
