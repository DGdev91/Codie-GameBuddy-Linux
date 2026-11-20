import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Text lines on a frame, by Windows' built-in OCR (Windows.Media.Ocr) in one
// resident ocr-helper.ps1 process, started on the first frame. read() never
// fails: an error, a missing OCR language, a slow or dead helper, or another
// platform all give [] so a comment is never held up by it.

export const OCR_TIMEOUT_MS = 3_000;
const SCRIPT = fileURLToPath(new URL('./ocr-helper.ps1', import.meta.url));
const LANGUAGE = { 'zh-CN': 'zh-Hans-CN', en: 'en-US' };

export function createOcr({ spawn = nodeSpawn, platform = process.platform, timeoutMs = OCR_TIMEOUT_MS, log = () => {} } = {}) {
  const pending = new Map();
  const reported = new Set();
  let child = null;
  let buffer = '';
  let nextId = 1;

  const report = message => {
    if (reported.has(message)) return;
    reported.add(message);
    log(`ocr: ${message}`);
  };

  function settle(id, lines) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(lines);
  }

  function onLine(line) {
    let reply;
    try { reply = JSON.parse(line); } catch { return; }
    if (reply.error) report(reply.error);
    settle(reply.id, Array.isArray(reply.lines) ? reply.lines : []);
  }

  function onGone(self) {
    if (child !== self) return;
    child = null;
    buffer = '';
    for (const id of [...pending.keys()]) settle(id, []);
  }

  function start() {
    // The script goes on the command line, so it can be read out of an asar.
    const script = Buffer.from(fs.readFileSync(SCRIPT, 'utf8'), 'utf16le').toString('base64');
    const self = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script], { windowsHide: true });
    self.stdout.setEncoding('utf8');
    self.stdout.on('data', chunk => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        onLine(buffer.slice(0, i).trim());
        buffer = buffer.slice(i + 1);
      }
    });
    self.stdin.on('error', () => onGone(self));
    self.on('error', e => { report(e.message); onGone(self); });
    self.on('exit', () => onGone(self));
    return self;
  }

  return {
    // The text lines on a JPEG frame, OCR'd in `locale`'s language.
    read(image, locale) {
      if (platform !== 'win32') return Promise.resolve([]);
      child ??= start();
      const id = nextId++;
      return new Promise(resolve => {
        pending.set(id, { resolve, timer: setTimeout(() => settle(id, []), timeoutMs) });
        child.stdin.write(`${id} ${LANGUAGE[locale] ?? LANGUAGE.en} ${image.toString('base64')}\n`);
      });
    },
    stop() {
      child?.stdin.end();
      child = null;
    },
  };
}
