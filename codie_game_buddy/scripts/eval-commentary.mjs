// Runs the commentary loop on fixed screenshots against the paired device and
// measures how much the remarks repeat themselves, so two versions of the
// prompt can be compared on the same frames.
//
//   node scripts/eval-commentary.mjs --shots <dir> [--src <dir>] [--rounds 12] [--locale zh-CN] [--out <file.json>]
//
// <dir>/shots.json lists the frames: [{ "file": "a.jpg", "name": "Elden Ring", "genre": "action" }].
// Each frame is a still scene in chatty mode: the same screenshot, `rounds`
// remarks in a row. `--src` is the src directory whose commentary loop is run
// (default: this checkout's), so an older one can be measured as the baseline.
// Turns are silent (speech none) and leave nothing in the device's history
// (retention none). Close game_buddy first: both register as the same client.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookupGameInfo } from '../src/main/game-info.mjs';
import { createHost } from '../src/main/host.mjs';
import { createTurnLock } from '../src/main/turn-lock.mjs';
import { repetition } from './eval-metrics.mjs';

const READY_MS = 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

function options() {
  const { values } = parseArgs({ options: {
    shots: { type: 'string' }, src: { type: 'string', default: path.join(HERE, '..', 'src') },
    rounds: { type: 'string', default: '12' }, locale: { type: 'string', default: 'zh-CN' }, out: { type: 'string' },
  } });
  if (!values.shots) throw new Error('--shots <dir> is required');
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 2) throw new Error('--rounds must be a whole number, 2 or more');
  return { ...values, rounds };
}

async function connect() {
  const ac = new AbortController();
  const host = createHost();
  await host.start(ac.signal);
  const end = Date.now() + READY_MS;
  while (host.state !== 'ready') {
    if (Date.now() > end) throw new Error(`codie-host is ${host.state}, not ready`);
    await new Promise(r => setTimeout(r, 200));
  }
  return { host, close: async () => { ac.abort(); await host.close(); } };
}

// One frame as a still scene: the loop of `createCommentary`, in chatty mode,
// ticked `rounds` times on the same screenshot.
async function runShot({ createCommentary, host, shot, image, info, rounds, locale }) {
  const turns = [];
  const win = { id: 1, path: 'C:\\Games\\eval.exe', owner: shot.name, title: shot.name };
  const settings = {
    commentaryEnabled: true, chattyMode: true, avoidInterrupting: true, guideTips: false,
    allowList: [{ process: 'eval.exe', name: shot.name, ...(shot.genre && { genre: shot.genre }) }], cooldownMs: 0, changeThreshold: 0, sampleMs: 0,
  };
  const commentary = createCommentary({
    capture: { foreground: async () => win, sampleHash: async () => 0n, captureJpeg: async () => image },
    host: {
      chatTurn: async req => {
        const r = await host.chatTurn({ ...req, speech: 'none' });
        turns.push({ prompt: req.text, said: (r.turn?.assistant_text ?? '').replace(/\s+/g, ' ').trim(), error: r.ok ? null : r.error?.code ?? r.kind });
        return r;
      },
    },
    lock: createTurnLock(), settings: () => settings, locale: () => locale, gameInfo: { get: () => info },
  });
  for (let i = 0; i < rounds; i++) await commentary.tick();
  return turns;
}

async function main() {
  const o = options();
  const { createCommentary } = await import(pathToFileURL(path.join(path.resolve(o.src), 'main', 'commentary.mjs')));
  const shots = JSON.parse(fs.readFileSync(path.join(o.shots, 'shots.json'), 'utf8'));
  const { host, close } = await connect();
  const results = [];
  try {
    for (const shot of shots) {
      const image = fs.readFileSync(path.join(o.shots, shot.file));
      const info = await lookupGameInfo({ name: shot.name, locale: o.locale, fetch });
      const turns = await runShot({ createCommentary, host, shot, image, info, rounds: o.rounds, locale: o.locale });
      const said = turns.map(t => t.said).filter(Boolean);
      const metrics = repetition(said);
      results.push({ shot: shot.file, name: shot.name, background: info?.source ?? null, metrics, turns });
      process.stdout.write(`\n== ${shot.name} (${shot.file}), background: ${info?.source ?? 'none'}\n`);
      turns.forEach((t, i) => process.stdout.write(`${String(i + 1).padStart(2)}. ${t.said || `[${t.error ?? 'silent'}]`}\n`));
      process.stdout.write(`${JSON.stringify(metrics)}\n`);
    }
  } finally {
    await close();
  }
  if (o.out) fs.writeFileSync(o.out, JSON.stringify({ src: path.resolve(o.src), rounds: o.rounds, locale: o.locale, results }, null, 2));
}

main().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
