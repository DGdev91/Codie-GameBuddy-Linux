import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOcr } from '../src/main/ocr.mjs';

// A fake helper process: records what is written to stdin and lets the test
// answer on stdout.
function setup({ platform = 'win32', timeoutMs = 1_000 } = {}) {
  const state = { spawns: [], written: [], logs: [] };
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.stdin = Object.assign(new EventEmitter(), { write: line => state.written.push(line), end: () => { state.ended = true; } });
    state.spawns.push({ cmd, args, opts, child });
    return child;
  };
  const ocr = createOcr({ spawn, platform, timeoutMs, log: line => state.logs.push(line) });
  const reply = (body, child = state.spawns.at(-1).child) => child.stdout.emit('data', `${JSON.stringify(body)}\n`);
  return { ocr, state, reply };
}

const IMAGE = Buffer.from([0xff, 0xd8, 0xff]);
const tick = () => new Promise(r => setImmediate(r));

test('a frame is sent to one Windows PowerShell helper as "<id> <language> <base64>" and its lines come back', async () => {
  const { ocr, state } = setup();
  const pending = ocr.read(IMAGE, 'zh-CN');
  assert.equal(state.spawns.length, 1);
  const { cmd, args, opts } = state.spawns[0];
  assert.equal(cmd, 'powershell.exe');
  assert.ok(args.includes('-EncodedCommand'));
  assert.equal(opts.windowsHide, true);
  assert.deepEqual(state.written, [`1 zh-Hans-CN ${IMAGE.toString('base64')}\n`]);
  const out = state.spawns[0].child.stdout;
  out.emit('data', '{"id":1,"lines":["万 邪');
  out.emit('data', ' 王","HP"]}\r\n');
  assert.deepEqual(await pending, ['万 邪 王', 'HP']);
  ocr.read(IMAGE, 'en');
  assert.equal(state.spawns.length, 1); // the helper stays
  assert.match(state.written[1], /^2 en-US /);
});

test('an OCR error gives no lines and is logged once', async () => {
  const { ocr, state, reply } = setup();
  const first = ocr.read(IMAGE, 'en');
  reply({ id: 1, error: 'no OCR language en-US' });
  assert.deepEqual(await first, []);
  const second = ocr.read(IMAGE, 'en');
  reply({ id: 2, error: 'no OCR language en-US' });
  assert.deepEqual(await second, []);
  assert.deepEqual(state.logs, ['ocr: no OCR language en-US']);
});

test('no answer in time gives no lines', async () => {
  const { ocr } = setup({ timeoutMs: 5 });
  assert.deepEqual(await ocr.read(IMAGE, 'zh-CN'), []);
});

test('a helper that exits fails its pending frames, and the next frame starts a new one', async () => {
  const { ocr, state, reply } = setup();
  const pending = ocr.read(IMAGE, 'zh-CN');
  state.spawns[0].child.emit('exit', 1);
  assert.deepEqual(await pending, []);
  const next = ocr.read(IMAGE, 'zh-CN');
  assert.equal(state.spawns.length, 2);
  reply({ id: 2, lines: ['玉儿'] });
  assert.deepEqual(await next, ['玉儿']);
});

test('a helper that cannot start gives no lines', async () => {
  const { ocr, state } = setup();
  const pending = ocr.read(IMAGE, 'zh-CN');
  state.spawns[0].child.emit('error', new Error('spawn powershell.exe ENOENT'));
  assert.deepEqual(await pending, []);
  assert.deepEqual(state.logs, ['ocr: spawn powershell.exe ENOENT']);
});

test('off Windows nothing is started; stop ends the helper', async () => {
  const off = setup({ platform: 'darwin' });
  assert.deepEqual(await off.ocr.read(IMAGE, 'zh-CN'), []);
  assert.equal(off.state.spawns.length, 0);
  const { ocr, state } = setup();
  ocr.read(IMAGE, 'zh-CN');
  await tick();
  ocr.stop();
  assert.equal(state.ended, true);
});

// The real helper on Windows, when the Chinese OCR language is installed.
const hasChineseOcr = () => {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]; [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | % LanguageTag'], { encoding: 'utf8' });
    return /zh-Hans/.test(out);
  } catch { return false; }
};

test('the real helper reads Chinese text off a JPEG', { skip: !hasChineseOcr() && 'needs Windows with the zh-Hans OCR language' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-ocr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Frame.jpg');
  // Rendered with System.Drawing: no image fixture in the repo.
  execFileSync('powershell.exe', ['-NoProfile', '-Command', [
    'Add-Type -AssemblyName System.Drawing',
    '$b = New-Object System.Drawing.Bitmap 640, 160',
    '$g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::Black)',
    '$f = New-Object System.Drawing.Font "Microsoft YaHei", 36',
    `$g.DrawString([string][char[]](0x4E0A,0x5B98,0x65A9), $f, [System.Drawing.Brushes]::White, 40, 40)`,
    `$b.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Jpeg)`,
  ].join('; ')]);
  const ocr = createOcr({ timeoutMs: 15_000 });
  t.after(() => ocr.stop());
  const lines = await ocr.read(fs.readFileSync(file), 'zh-CN');
  assert.match(lines.join('').replace(/\s/g, ''), /上官斩/);
});
