// Checks the Linux stand-ins on this desktop, without a Codie device:
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/linux-probe.mjs
// The ScreenCast portal asks for a screen on the first frame. Writes probe-frame.jpg.
import fs from 'node:fs';
import { app } from 'electron';

const capture = await import('../src/main/capture.mjs');
const { createOcr, windowBackend } = await import('../src/main/linux.mjs');
console.log('window backend:', windowBackend);

const timed = async (label, fn) => {
  const t = Date.now();
  const r = await fn();
  console.log(`${label} (${Date.now() - t} ms):`, r);
  return r;
};

app.whenReady().then(async () => {
  try {
    await timed('foreground', () => capture.foreground());
    await timed('windows', async () => (await capture.listWindows()).map(w => `${w.path} | ${w.title}`));
    await timed('hash', () => capture.sampleHash(null));
    const frame = await capture.captureJpeg(null);
    console.log('jpeg bytes:', frame?.length);
    if (frame) {
      fs.writeFileSync('probe-frame.jpg', frame);
      await timed('ocr', () => createOcr({ log: console.log }).read(frame, 'en'));
    }
    await timed('hash again', () => capture.sampleHash(null));
  } catch (e) {
    console.error(e);
  }
  app.exit(0);
});
