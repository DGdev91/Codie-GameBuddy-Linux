import { desktopCapturer } from 'electron';
import { activeWindow, openWindows } from 'get-windows';
import { HASH_HEIGHT, HASH_WIDTH, dHash } from './dhash.mjs';

// Linux (KDE Wayland): windows from KWin, frames from the ScreenCast portal.
const linux = process.platform === 'linux' ? await import('./linux.mjs') : null;

// Windows and frames (spec §4.1 steps 1, 2 and 4).

const MAX_IMAGE_BYTES = 1 << 20; // codie-host refuses larger images
const QUALITIES = [80, 65, 50, 35];
const SAMPLE_SIZE = { width: 64, height: 36 };
const SEND_SIZE = { width: 1280, height: 1280 }; // the window fits inside, aspect kept

const toWindow = w => (w ? { id: w.id, path: w.owner?.path ?? '', owner: w.owner?.name ?? '', title: w.title ?? '' } : null);

export async function foreground() {
  return linux ? linux.activeWindow() : toWindow(await activeWindow());
}

export async function listWindows() {
  return linux ? linux.openWindows() : (await openWindows()).map(toWindow);
}

async function thumbnail(windowId, size) {
  if (linux) return linux.thumbnail(size);
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size });
  const source = sources.find(s => s.id.startsWith(`window:${windowId}:`));
  return source && !source.thumbnail.isEmpty() ? source.thumbnail : null;
}

export async function sampleHash(windowId) {
  const img = await thumbnail(windowId, SAMPLE_SIZE);
  return img ? dHash(img.resize({ width: HASH_WIDTH, height: HASH_HEIGHT }).toBitmap()) : null;
}

// A JPEG of the window of at most `maxBytes` (what codie-host accepts in a
// chat turn, unless given), or null.
export async function captureJpeg(windowId, maxBytes = MAX_IMAGE_BYTES) {
  const img = await thumbnail(windowId, SEND_SIZE);
  if (!img) return null;
  for (const quality of QUALITIES) {
    const jpeg = img.toJPEG(quality);
    if (jpeg.length <= maxBytes) return jpeg;
  }
  return null;
}
