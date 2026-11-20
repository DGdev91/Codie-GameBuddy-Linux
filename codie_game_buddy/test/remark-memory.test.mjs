import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemarkMemory } from '../src/main/remark-memory.mjs';

const game = { process: 'game.exe', name: 'Game' };

test('history is isolated by program and game and ignores empty or unlisted remarks', () => {
  const memory = createRemarkMemory();
  memory.add(game, ' Blue and white look good.\n');
  memory.add(game, '   ');
  memory.add(null, 'Private window');
  assert.deepEqual(memory.get({ process: 'GAME.EXE', name: 'GAME' }), ['Blue and white look good.']);
  assert.deepEqual(memory.get({ ...game, process: 'other.exe' }), []);
  assert.deepEqual(memory.get({ ...game, name: 'Other Game' }), []);
  const copy = memory.get(game);
  copy.push('not stored');
  assert.equal(memory.get(game).length, 1);
});

test('history has bounds on remarks, prompt size and remembered games', () => {
  const memory = createRemarkMemory({ maxGames: 2, maxRemarks: 3, maxChars: 10 });
  for (const text of ['1111', '2222', '3333']) memory.add(game, text);
  assert.deepEqual(memory.get(game), ['3333', '2222']);
  memory.add({ ...game, name: 'B' }, 'b');
  memory.add(game, 'new'); // refresh the active game
  memory.add({ ...game, name: 'C' }, 'c');
  assert.deepEqual(memory.get({ ...game, name: 'B' }), []);
  assert.deepEqual(memory.get(game), ['new', '3333']);
});
