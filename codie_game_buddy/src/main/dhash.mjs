// 64-bit difference hash of a 9×8 BGRA bitmap (Electron NativeImage#toBitmap
// on Windows): bit by bit, is a pixel brighter than its right neighbour.

export const HASH_WIDTH = 9;
export const HASH_HEIGHT = 8;

export function dHash(bgra) {
  if (bgra.length !== HASH_WIDTH * HASH_HEIGHT * 4) throw new Error(`expected a ${HASH_WIDTH}x${HASH_HEIGHT} BGRA bitmap`);
  const luma = at => 0.114 * bgra[at] + 0.587 * bgra[at + 1] + 0.299 * bgra[at + 2];
  let hash = 0n;
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const at = (y * HASH_WIDTH + x) * 4;
      hash = (hash << 1n) | (luma(at) > luma(at + 4) ? 1n : 0n);
    }
  }
  return hash;
}

export function hamming(a, b) {
  let v = a ^ b;
  let n = 0;
  while (v) {
    n += Number(v & 1n);
    v >>= 1n;
  }
  return n;
}
