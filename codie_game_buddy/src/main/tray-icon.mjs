// Activity silhouettes with a separate connection badge, drawn at each DPI.
const COLORS = {
  ready: [67, 190, 96], pending: [255, 185, 32], 'not-paired': [255, 185, 32],
  connecting: [150, 158, 171], offline: [150, 158, 171],
};
const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2;
const capsule = (x, y, ax, ay, bx, by, r) => {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return circle(x, y, ax + t * (bx - ax), ay + t * (by - ay), r);
};
const controller = (x, y, inset = 0) => capsule(x, y, 4, 6, 10.5, 6, 3 - inset)
  || capsule(x, y, 3.8, 6.7, 2.8, 10, 2.4 - inset)
  || capsule(x, y, 10.7, 6.7, 11.7, 10, 2.4 - inset);

// The device call includes both generation and playback; it exposes no precise speech start.
export const trayActivity = (state, phase) => state === 'ready'
  && ['capturing', 'analyzing', 'responding'].includes(phase) ? 'commentary' : 'idle';

const wave = (x, y) => (Math.abs(x - 12) < 0.45 && Math.abs(y - 2.3) < 0.75)
  || (Math.abs(x - 13.5) < 0.45 && Math.abs(y - 2.3) < 1.5)
  || (Math.abs(x - 15) < 0.45 && Math.abs(y - 2.3) < 2.2);
const moon = (x, y, inset = 0) => circle(x, y, 6.5, 7.6, 5.3 - inset)
  && !circle(x, y, 9.2, 4.4, 4.8 + inset);
const sleep = (x, y) => capsule(x, y, 10.2, 3.3, 12.8, 3.3, 0.5)
  || capsule(x, y, 12.8, 3.3, 10.2, 6, 0.5)
  || capsule(x, y, 10.2, 6, 12.8, 6, 0.5);

export function trayBitmap(state, size = 32, activity = 'idle') {
  const bitmap = Buffer.alloc(size * size * 4);
  const badge = COLORS[state] ?? COLORS.offline;
  // Supersampling keeps the silhouette legible at both 100% and 200% DPI.
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const sum = [0, 0, 0];
    let covered = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const x = (px + (sx + 0.5) / 4) * 16 / size;
      const y = (py + (sy + 0.5) / 4) * 16 / size;
      let color = null;
      if (activity === 'commentary') {
        if (controller(x, y)) color = [35, 44, 62];
        if (controller(x, y, 0.8)) color = [236, 241, 249];
        if ((Math.abs(x - 4.3) < 0.6 && Math.abs(y - 6.7) < 1.7)
          || (Math.abs(x - 4.3) < 1.7 && Math.abs(y - 6.7) < 0.6)) color = [45, 58, 80];
        if (circle(x, y, 9.3, 7, 0.7)) color = [41, 139, 214];
        if (circle(x, y, 11.1, 5.5, 0.7)) color = [45, 58, 80];
        if (wave(x, y)) color = [41, 180, 238];
      } else {
        if (moon(x, y)) color = [35, 44, 62];
        if (moon(x, y, 0.6)) color = [236, 241, 249];
        if (sleep(x, y)) color = [87, 180, 238];
      }
      if (circle(x, y, 12.5, 12, 2.7)) color = [35, 44, 62];
      if (circle(x, y, 12.5, 12, 1.9)) color = badge;
      if (color) { covered++; for (let i = 0; i < 3; i++) sum[i] += color[i]; }
    }
    const offset = (py * size + px) * 4;
    // NativeImage uses premultiplied BGRA on Windows.
    bitmap[offset] = Math.round(sum[2] / 16);
    bitmap[offset + 1] = Math.round(sum[1] / 16);
    bitmap[offset + 2] = Math.round(sum[0] / 16);
    bitmap[offset + 3] = Math.round(covered * 255 / 16);
  }
  return bitmap;
}
