import assert from 'node:assert/strict';
import test from 'node:test';
import { HASH_HEIGHT, HASH_WIDTH, dHash, hamming } from '../src/main/dhash.mjs';

// A 9×8 BGRA bitmap whose pixel (x, y) has gray level f(x, y).
const bitmap = f => {
  const buf = Buffer.alloc(HASH_WIDTH * HASH_HEIGHT * 4);
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH; x++) {
      const v = f(x, y);
      buf.set([v, v, v, 255], (y * HASH_WIDTH + x) * 4);
    }
  }
  return buf;
};

test('a flat image hashes to 0 and a falling gradient to all ones', () => {
  assert.equal(dHash(bitmap(() => 128)), 0n);
  assert.equal(dHash(bitmap(x => 255 - x * 20)), (1n << 64n) - 1n);
  assert.equal(dHash(bitmap(x => x * 20)), 0n);
});

test('dHash refuses other sizes', () => {
  assert.throws(() => dHash(Buffer.alloc(10)), /9x8 BGRA/);
});

test('hamming counts differing bits', () => {
  assert.equal(hamming(0n, 0n), 0);
  assert.equal(hamming(0b1011n, 0b0001n), 2);
  assert.equal(hamming(0n, (1n << 64n) - 1n), 64);
});
