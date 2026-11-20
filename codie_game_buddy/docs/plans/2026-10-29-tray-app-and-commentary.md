# Tray App and Commentary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows tray app: while a game on the user's allow list is in the foreground, Codie looks at the game window now and then and comments on it; a hotkey makes it look at once; a settings window manages the allow list, timings, hotkey and device pairing.

**Architecture:** Electron main process (ESM). Decision logic lives in pure modules with no Electron import (settings, dHash, trigger, turn lock, prompt, commentary, host state) and is unit-tested with `node:test`. Thin Electron modules (capture, tray, hotkey, settings window, main) wire them up. All device access goes through the codie-host SDK (`ToolClient`) to codie-agentd; the client keeps its registration alive with `serve()` (no tools until phase 3).

**Tech Stack:** Electron 44.7.2, Node ≥ 20 (Electron 44 bundles Node 24), `get-windows` 9.3.0 (foreground and open windows; N-API prebuilt for win32-x64), `codie-host` (local `file:../codie_host`), `node:test`, `@playwright/test` 1.64.1 (`_electron`).

**Spec:** `docs/specs/2026-10-29-game-buddy-design.md` (this repo) — phase 2 (§3.1), commentary (§4), settings (§4.3), codie_host routes (§6), testing (§8).

## Global Constraints

- Windows 10/11 x64 only in this phase (spec G1). macOS, signing, installer and packaging are out of scope (spec §9); the app runs with `npm start`.
- Exact versions: `electron` 44.7.2, `get-windows` 9.3.0, `@playwright/test` 1.64.1; `codie-host` as `file:../codie_host`. No other dependencies.
- ESM `.mjs` everywhere except the preload script (`.cjs`, required by sandboxed preloads); kebab-case file and folder names; English only in code, UI text, tests and docs; two-space indentation; semicolons (spec G7).
- Modules under `test/` never import `electron`; everything they test is pure or takes its Electron / codie-host collaborators as arguments.
- codie-host client name `game-buddy`; scope `{ tools: true, pair: true, api: ['/v1/api/data/user/chat/turns'] }` (spec §6).
- Settings (spec §4.3), stored in `app.getPath('userData')/settings.json`:

| Key | Default | Range |
|---|---|---|
| `commentaryEnabled` | `true` | boolean |
| `allowList` | `[]` | list of `{ process, name }` |
| `sampleMs` | 3000 | 1000–30000 |
| `cooldownMs` | 60000 | 15000–600000 |
| `changeThreshold` | 12 | 1–64 |
| `hotkey` | `Ctrl+Alt+G` | Electron accelerator |

- Commentary images: the foreground window captured inside a 1280×1280 box (aspect kept), JPEG, quality lowered until ≤ 1 MiB (1048576 bytes) (spec §4.1 step 4, §6).
- Only one device turn at a time: commentary, hotkey (and later `look_at_game`) share one lock (spec §4.1).
- `DEVICE_BLOCKED` / `AMBIENT_MODE_BLOCKED`: drop the frame, no retry, `lastSentAt` unchanged (spec §4.2).
- Settings window: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; the renderer writes untrusted strings (window titles, device names) only through `textContent`, never `innerHTML`.
- `GAME_BUDDY_HOME` (if set) replaces `userData`; `CODIE_HOME` (read by codie-host) isolates the daemon. Test and smoke runs set both to temp dirs **and `CODIE_PORT=19531`**: a temp daemon on the default device port 9530 fails with `EADDRINUSE` when the user's real codie-agentd is running (`CODIE_PORT` does not accept 0).
- Installing Electron: npm 11 runs install scripts only when allowed (`allowScripts` in `package.json`). If the Electron binary download fails with `fetch failed` (Node's `fetch` ignores `HTTPS_PROXY`), run `npm install` again with `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` set. `get-windows` ships its win32-x64 binary in the package; its blocked install script is not needed.

## File map

| File | Responsibility |
|---|---|
| `../codie_host/src/agentd/daemon/ensure.mjs` | (Task 1) spawn agentd as plain Node under Electron |
| `package.json`, `.gitignore` | (Task 2) project, scripts, pinned deps |
| `src/main/settings.mjs` | defaults, validation, load / save |
| `src/main/dhash.mjs` | 64-bit dHash of a 9×8 BGRA bitmap, Hamming distance |
| `src/main/trigger.mjs` | allow-list match, `shouldSend` |
| `src/main/turn-lock.mjs` | one device turn at a time |
| `src/main/prompt.mjs` | commentary prompt text |
| `src/main/host.mjs` | codie-host client, tray state, error classes |
| `src/main/commentary.mjs` | tick and hotkey decisions |
| `src/main/hotkey.mjs` | global shortcut (re)registration |
| `src/main/capture.mjs` | Electron + get-windows: foreground, sampling, JPEG |
| `src/main/tray.mjs` | tray icon and menu |
| `src/main/main.mjs` | app wiring |
| `src/main/settings-window.mjs` | settings `BrowserWindow` and its IPC |
| `src/preload/preload.cjs` | `window.buddy` bridge |
| `src/renderer/settings.html`, `settings.mjs`, `settings.css` | settings UI |
| `test/*.test.mjs` | unit tests; `host-integration.test.mjs` runs a real codie-agentd with codie_host's fake clt01 |
| `e2e/settings.spec.mjs`, `playwright.config.mjs` | Electron E2E |
| `README.md`, `docs/manual-checklist.md` | run instructions, on-device checklist |

---

### Task 1: codie_host spawns agentd as plain Node under Electron

**Working directory:** `D:\Devs\CodieWorkShop\codie_host` (a different repo).

**Files:**
- Modify: `src/agentd/daemon/ensure.mjs` (`agentdEnv`)
- Test: `test/agentd/agentd-env.test.mjs` (new; `ensure.test.mjs` does not load on Windows)

**Interfaces:**
- Produces: `agentdEnv(home, env = process.env, versions = process.versions)`; when `versions.electron` is set, the result has `ELECTRON_RUN_AS_NODE: '1'`. Without it, `spawnDetached` runs `process.execPath` — `electron.exe` in game_buddy — which would start a second Electron app instead of the daemon.

- [ ] **Step 1: Write the failing test** — `test/agentd/agentd-env.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentdEnv } from '../../src/agentd/daemon/ensure.mjs';

test('agentd runs as plain Node when the host process is Electron', () => {
  assert.equal(agentdEnv('/h', {}, { node: '24.21.0', electron: '44.7.2' }).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(agentdEnv('/h', {}, { node: '24.21.0' }).ELECTRON_RUN_AS_NODE, undefined);
});

test('agentd env sets CODIE_HOME and drops Claude Code variables', () => {
  const env = agentdEnv('/h', { PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '9', CLAUDE_PID: '3' }, { node: '24.21.0' });
  assert.deepEqual(env, { PATH: 'p', CODIE_HOME: '/h' });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentd/agentd-env.test.mjs`
Expected: the first test FAILS (`undefined !== '1'`); the second passes.

- [ ] **Step 3: Implement** — in `src/agentd/daemon/ensure.mjs`, replace `agentdEnv`:

```js
// Under Electron (game_buddy), process.execPath is the Electron binary:
// ELECTRON_RUN_AS_NODE makes it run the daemon as plain Node.
export function agentdEnv(home, env = process.env, versions = process.versions) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k === 'CLAUDE_PID') continue;
    out[k] = v;
  }
  out.CODIE_HOME = home;
  if (versions.electron) out.ELECTRON_RUN_AS_NODE = '1';
  return out;
}
```

Keep any comment that was above the old function if it still applies; merge it with this one.

- [ ] **Step 4: Run the tests**

Run: `node --test test/agentd/agentd-env.test.mjs test/agentd/tool-hosting.test.mjs`
Expected: PASS. Then `npm test`: 416 tests; the only failures are the 9 known POSIX-only ones (`hooks/stop … most recently active`, `ancestorPids …`, `belongsToSession`, four `codexRpc …`, `ensure.test.mjs`, `slug and dir follow Claude Code layout`).

- [ ] **Step 5: Commit** (in codie_host)

```bash
git add src/agentd/daemon/ensure.mjs test/agentd/agentd-env.test.mjs
git commit -m "fix: run agentd as plain Node when started from Electron"
```

---

### Task 2: project scaffold and settings

**Working directory:** `D:\Devs\CodieWorkShop\codie_game_buddy` (all remaining tasks).

**Files:**
- Create: `package.json`, `src/main/settings.mjs`, `test/settings.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces:
  - `DEFAULTS` (frozen settings object, values from Global Constraints).
  - `validateSettings(raw) → { settings, errors: string[] }` — `errors` lists the keys that fell back to defaults.
  - `loadSettings(file) → { settings, errors, firstRun }` — missing file: defaults, `firstRun: true`; unreadable JSON: defaults, `errors: ['file']`.
  - `saveSettings(file, raw) → { settings, errors, saved }` — writes atomically only when `errors` is empty.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "codie-game-buddy",
  "version": "0.1.0",
  "private": true,
  "description": "Codie keeps you company while you play: it watches your game and comments on it",
  "type": "module",
  "main": "src/main/main.mjs",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "electron .",
    "test": "node --test test/*.test.mjs",
    "e2e": "playwright test"
  },
  "dependencies": {
    "codie-host": "file:../codie_host",
    "get-windows": "9.3.0"
  },
  "devDependencies": {
    "@playwright/test": "1.64.1",
    "electron": "44.7.2"
  },
  "allowScripts": {
    "electron@44.7.2": true
  },
  "license": "UNLICENSED"
}
```

Append to `.gitignore`: `test-results/` and `playwright-report/` (it already has `node_modules/`, `out/`, `dist/`).

Run: `npm install` (see Global Constraints if the Electron download fails). Check: `node_modules/electron/dist/electron.exe` exists and `node_modules/get-windows/lib/binding/napi-9-win32-unknown-x64` exists.

- [ ] **Step 2: Write the failing test** — `test/settings.test.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, loadSettings, saveSettings, validateSettings } from '../src/main/settings.mjs';

const tmpFile = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-buddy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'settings.json');
};

test('defaults match the spec', () => {
  assert.deepEqual({ ...DEFAULTS }, {
    commentaryEnabled: true, allowList: [], sampleMs: 3000, cooldownMs: 60000, changeThreshold: 12, hotkey: 'Ctrl+Alt+G',
  });
});

test('valid values are kept, invalid ones fall back and are reported', () => {
  const { settings, errors } = validateSettings({
    commentaryEnabled: false, sampleMs: 500, cooldownMs: 90000, changeThreshold: 64.5, hotkey: '',
    allowList: [{ process: 'Game.exe', name: 'My Game', extra: 1 }],
  });
  assert.deepEqual(settings, {
    commentaryEnabled: false, allowList: [{ process: 'Game.exe', name: 'My Game' }], sampleMs: 3000, cooldownMs: 90000, changeThreshold: 12, hotkey: 'Ctrl+Alt+G',
  });
  assert.deepEqual(errors.sort(), ['changeThreshold', 'hotkey', 'sampleMs']);
});

test('the allow list needs exe names, names, and no duplicates', () => {
  const bad = list => validateSettings({ allowList: list }).errors;
  assert.deepEqual(bad([{ process: 'game', name: 'x' }]), ['allowList']);
  assert.deepEqual(bad([{ process: 'a/b.exe', name: 'x' }]), ['allowList']);
  assert.deepEqual(bad([{ process: 'g.exe', name: '' }]), ['allowList']);
  assert.deepEqual(bad([{ process: 'g.exe', name: 'a' }, { process: 'G.EXE', name: 'b' }]), ['allowList']);
  assert.deepEqual(bad('nope'), ['allowList']);
  assert.deepEqual(bad([{ process: 'g.exe', name: 'G' }]), []);
});

test('a missing file is a first run; a broken file is reported', t => {
  const file = tmpFile(t);
  assert.deepEqual(loadSettings(file), { settings: { ...DEFAULTS }, errors: [], firstRun: true });
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadSettings(file), { settings: { ...DEFAULTS }, errors: ['file'], firstRun: false });
});

test('save writes valid settings and refuses invalid ones', t => {
  const file = tmpFile(t);
  const ok = saveSettings(file, { ...DEFAULTS, cooldownMs: 120000 });
  assert.equal(ok.saved, true);
  assert.equal(loadSettings(file).settings.cooldownMs, 120000);
  const refused = saveSettings(file, { ...DEFAULTS, cooldownMs: 5 });
  assert.deepEqual([refused.saved, refused.errors], [false, ['cooldownMs']]);
  assert.equal(loadSettings(file).settings.cooldownMs, 120000);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/main/settings.mjs'`.

- [ ] **Step 4: Implement** — `src/main/settings.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';

// User settings (spec §4.3), kept in settings.json under userData.

export const DEFAULTS = Object.freeze({
  commentaryEnabled: true,
  allowList: Object.freeze([]),
  sampleMs: 3000,
  cooldownMs: 60000,
  changeThreshold: 12,
  hotkey: 'Ctrl+Alt+G',
});

const RANGES = Object.freeze({ sampleMs: [1000, 30000], cooldownMs: [15000, 600000], changeThreshold: [1, 64] });
const EXE_NAME = /^[^\\/:*?"<>|]+\.exe$/i;
const MAX_GAMES = 100;
const MAX_NAME = 80;
const MAX_HOTKEY = 64;

const inRange = ([lo, hi]) => v => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);

// The list as { process, name } entries, or undefined when any entry is invalid.
function normalizeAllowList(v) {
  if (!Array.isArray(v) || v.length > MAX_GAMES) return undefined;
  const seen = new Set();
  const out = [];
  for (const g of v) {
    const process = typeof g?.process === 'string' ? g.process.trim() : '';
    const name = typeof g?.name === 'string' ? g.name.trim() : '';
    if (!EXE_NAME.test(process) || !name || name.length > MAX_NAME || seen.has(process.toLowerCase())) return undefined;
    seen.add(process.toLowerCase());
    out.push({ process, name });
  }
  return out;
}

const NORMALIZERS = {
  commentaryEnabled: v => (typeof v === 'boolean' ? v : undefined),
  allowList: normalizeAllowList,
  sampleMs: inRange(RANGES.sampleMs),
  cooldownMs: inRange(RANGES.cooldownMs),
  changeThreshold: inRange(RANGES.changeThreshold),
  hotkey: v => (typeof v === 'string' && v.trim() && v.length <= MAX_HOTKEY ? v.trim() : undefined),
};

// Every invalid value falls back to its default and is named in `errors`.
export function validateSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const settings = {};
  for (const [key, normalize] of Object.entries(NORMALIZERS)) {
    const value = src[key] === undefined ? undefined : normalize(src[key]);
    if (src[key] !== undefined && value === undefined) errors.push(key);
    settings[key] = value === undefined ? DEFAULTS[key] : value;
  }
  return { settings, errors };
}

export function loadSettings(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { settings: { ...DEFAULTS }, errors: e.code === 'ENOENT' ? [] : ['file'], firstRun: e.code === 'ENOENT' };
  }
  return { ...validateSettings(raw), firstRun: false };
}

// Writes only fully valid settings, atomically.
export function saveSettings(file, raw) {
  const { settings, errors } = validateSettings(raw);
  if (errors.length) return { settings, errors, saved: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { settings, errors, saved: true };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/main/settings.mjs test/settings.test.mjs
git commit -m "feat: project scaffold and validated settings"
```

---

### Task 3: commentary decision helpers

**Files:**
- Create: `src/main/dhash.mjs`, `src/main/trigger.mjs`, `src/main/turn-lock.mjs`, `src/main/prompt.mjs`
- Test: `test/dhash.test.mjs`, `test/trigger.test.mjs`, `test/turn-lock.test.mjs`, `test/prompt.test.mjs`

**Interfaces:**
- Produces:
  - `HASH_WIDTH = 9`, `HASH_HEIGHT = 8`; `dHash(bgra: Buffer) → bigint` (throws unless `bgra.length === 9 * 8 * 4`); `hamming(a: bigint, b: bigint) → number`.
  - A *window* is `{ id: number, path: string, owner: string, title: string }` (Task 6's `capture.foreground()` returns this or `null`).
  - `matchAllowList(win, allowList) → { process, name } | null` — compares the exe file name of `win.path` case-insensitively.
  - `shouldSend({ hash, lastSentHash, now, lastSentAt, settings }) → boolean` — cooldown passed and (no previous frame or distance ≥ `changeThreshold`).
  - `createTurnLock() → { busy: boolean, run(fn) → Promise }` — `run` waits for the previous turn; a rejected turn does not block the next.
  - `commentaryPrompt(gameName) → string`.

- [ ] **Step 1: Write the failing tests**

`test/dhash.test.mjs`:

```js
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
```

`test/trigger.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchAllowList, shouldSend } from '../src/main/trigger.mjs';

const games = [{ process: 'EldenRing.exe', name: 'Elden Ring' }];
const settings = { cooldownMs: 60000, changeThreshold: 12 };

test('the allow list matches the exe file name, ignoring case and folders', () => {
  const win = p => ({ id: 1, path: p, owner: '', title: '' });
  assert.deepEqual(matchAllowList(win('C:\\Games\\ELDEN RING\\eldenring.exe'), games), games[0]);
  assert.equal(matchAllowList(win('C:\\Windows\\explorer.exe'), games), null);
  assert.equal(matchAllowList(win(''), games), null);
  assert.equal(matchAllowList(null, games), null);
});

test('the first frame is sent once the cooldown allows it', () => {
  assert.equal(shouldSend({ hash: 5n, lastSentHash: null, now: 0, lastSentAt: -Infinity, settings }), true);
});

test('a frame waits for the cooldown and for a large enough change', () => {
  const base = { lastSentHash: 0n, lastSentAt: 1000, settings };
  const big = (1n << 12n) - 1n; // 12 bits differ
  assert.equal(shouldSend({ ...base, hash: big, now: 1000 + 59999 }), false);
  assert.equal(shouldSend({ ...base, hash: big, now: 1000 + 60000 }), true);
  assert.equal(shouldSend({ ...base, hash: (1n << 11n) - 1n, now: 1000 + 60000 }), false);
});
```

`test/turn-lock.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnLock } from '../src/main/turn-lock.mjs';

test('turns run one at a time, in order', async () => {
  const lock = createTurnLock();
  const order = [];
  let release;
  const first = lock.run(() => new Promise(r => { order.push('first start'); release = r; }));
  const second = lock.run(async () => { order.push('second'); return 2; });
  await new Promise(r => setImmediate(r));
  assert.equal(lock.busy, true);
  assert.deepEqual(order, ['first start']);
  release(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first start', 'second']);
  await new Promise(r => setImmediate(r));
  assert.equal(lock.busy, false);
});

test('a failed turn does not block the next one', async () => {
  const lock = createTurnLock();
  await assert.rejects(lock.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await lock.run(async () => 'next'), 'next');
});
```

`test/prompt.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { commentaryPrompt } from '../src/main/prompt.mjs';

test('the prompt names the game and asks for a short spoken reaction', () => {
  const p = commentaryPrompt('Elden Ring');
  assert.match(p, /Elden Ring/);
  assert.match(p, /one or two short/);
  assert.match(p, /language you normally speak/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the four new files FAIL with `Cannot find module`; `settings.test.mjs` passes.

- [ ] **Step 3: Implement**

`src/main/dhash.mjs`:

```js
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
```

`src/main/trigger.mjs`:

```js
import path from 'node:path';
import { hamming } from './dhash.mjs';

// When commentary sends a frame (spec §4.1 steps 1 and 3).

// The allow-list entry for a window, by its exe file name (case-insensitive).
export function matchAllowList(win, allowList) {
  const exe = path.win32.basename(win?.path ?? '').toLowerCase();
  if (!exe) return null;
  return allowList.find(g => g.process.toLowerCase() === exe) ?? null;
}

export function shouldSend({ hash, lastSentHash, now, lastSentAt, settings }) {
  if (now - lastSentAt < settings.cooldownMs) return false;
  return lastSentHash === null || hamming(hash, lastSentHash) >= settings.changeThreshold;
}
```

`src/main/turn-lock.mjs`:

```js
// One device turn at a time (spec §4.1): commentary skips while busy; the
// hotkey and look_at_game wait their turn.
export function createTurnLock() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    get busy() { return pending > 0; },
    run(fn) {
      pending++;
      const result = tail.then(fn);
      tail = result.then(() => {}, () => {}).finally(() => { pending--; });
      return result;
    },
  };
}
```

`src/main/prompt.mjs`:

```js
// What Codie is asked with each commentary screenshot. Its character, voice
// and language come from the device; the prompt only sets the job.
export function commentaryPrompt(gameName) {
  return [
    `This is a screenshot of the game the user is playing right now: ${gameName}.`,
    'You are keeping them company. React in one or two short, natural spoken sentences: a joke, a cheer, or a remark about what is happening.',
    'Do not describe the screen item by item and do not mention the screenshot.',
    'Answer in the language you normally speak with the user.',
  ].join(' ');
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS (all five files).

- [ ] **Step 5: Commit**

```bash
git add src/main/dhash.mjs src/main/trigger.mjs src/main/turn-lock.mjs src/main/prompt.mjs test/dhash.test.mjs test/trigger.test.mjs test/turn-lock.test.mjs test/prompt.test.mjs
git commit -m "feat: frame hashing, send decision, turn lock and prompt"
```

---

### Task 4: codie-host client and tray state

**Files:**
- Create: `src/main/host.mjs`
- Test: `test/host.test.mjs`, `test/host-integration.test.mjs`

**Interfaces:**
- Consumes: `codie-host` SDK — `ToolClient({ name, scope, log })` with `status` (`'pending' | 'approved'`), `connect()`, `serve(handlers, { signal })`, `chatTurn({ image, text, speech, waitMs })`, `devices() → { found, paired }`, `pairBegin(id) → { ok, message }`, `pairConfirm(id, code) → { ok, toolsReady, message }`, `pairCancel(id)`, `close()`; `HostError` (`status`, `code`).
- Produces:
  - `CLIENT_NAME = 'game-buddy'`, `SCOPE` (Global Constraints).
  - `classify(error) → 'blocked' | 'pending' | 'not-paired' | 'offline' | 'error'`.
  - `createHost({ log?, onState?, client?, now?, watchMs?, recheckMs? }) → host` with:
    - `state`: `'connecting' | 'pending' | 'not-paired' | 'offline' | 'ready'`; `onState(state)` fires on each change.
    - `start(signal)`: registers, keeps the registration alive with `client.serve({}, { signal })`, watches approval and rechecks a non-ready state.
    - `chatTurn({ image, text, speech })` → `{ ok: true, turn }` or `{ ok: false, kind, error }` (never throws).
    - `devices()`, `pairBegin(id)`, `pairConfirm(id, code)`, `pairCancel(id)` — SDK pass-through (they throw `HostError`); a confirm with `toolsReady` sets `ready`.
    - `close()`.

- [ ] **Step 1: Write the failing test** — `test/host.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from 'codie-host';
import { CLIENT_NAME, SCOPE, classify, createHost } from '../src/main/host.mjs';

const tick = () => new Promise(r => setTimeout(r, 15));

function fakeClient(over = {}) {
  return {
    status: 'approved',
    calls: [],
    async connect() {},
    serve() { return new Promise(() => {}); },
    async devices() { return { found: [], paired: [{ deviceId: 'D1', name: 'Codie', online: false }] }; },
    async chatTurn(req) { this.calls.push(req); return { turn_id: 't', state: 'completed', assistant_text: 'hi', error: null }; },
    async pairConfirm() { return { ok: true, toolsReady: true, message: 'Paired.' }; },
    async close() {},
    ...over,
  };
}

test('the client asks for exactly the phase 2 and 3 scope', () => {
  assert.equal(CLIENT_NAME, 'game-buddy');
  assert.deepEqual(SCOPE, { tools: true, pair: true, api: ['/v1/api/data/user/chat/turns'] });
});

test('errors are classified for the tray', () => {
  const he = (status, code) => new HostError(status, code, code);
  assert.equal(classify(he(409, 'DEVICE_BLOCKED')), 'blocked');
  assert.equal(classify(he(409, 'AMBIENT_MODE_BLOCKED')), 'blocked');
  assert.equal(classify(he(403, 'APPROVAL_PENDING')), 'pending');
  assert.equal(classify(he(409, 'NOT_PAIRED')), 'not-paired');
  assert.equal(classify(he(409, 'REPAIR_REQUIRED')), 'not-paired');
  assert.equal(classify(he(503, 'DEVICE_OFFLINE')), 'offline');
  assert.equal(classify(he(400, 'INVALID_ARGUMENT')), 'error');
  assert.equal(classify(new TypeError('fetch failed')), 'offline');
});

test('an approved client with a paired device is ready', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const states = [];
  const host = createHost({ client: fakeClient(), onState: s => states.push(s), watchMs: 5 });
  await host.start(ac.signal);
  assert.equal(host.state, 'ready');
  assert.deepEqual(states, ['ready']);
});

test('a pending client becomes ready once approved; no device means not-paired', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const client = fakeClient({ status: 'pending', async devices() { return { found: [], paired: [] }; } });
  const host = createHost({ client, watchMs: 5 });
  await host.start(ac.signal);
  assert.equal(host.state, 'pending');
  client.status = 'approved';
  await tick();
  assert.equal(host.state, 'not-paired');
});

test('chat turns report their outcome and move the state', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  let fail = null;
  const client = fakeClient({ async chatTurn(req) { if (fail) throw fail; return { state: 'completed', req }; } });
  const host = createHost({ client, watchMs: 1000 });
  await host.start(ac.signal);

  const ok = await host.chatTurn({ image: Buffer.from([1]), text: 'look', speech: 'device' });
  assert.equal(ok.ok, true);

  fail = new HostError(409, 'DEVICE_BLOCKED', 'busy');
  assert.deepEqual([(await host.chatTurn({})).kind, host.state], ['blocked', 'ready']);
  fail = new HostError(409, 'NOT_PAIRED', 'no device');
  assert.deepEqual([(await host.chatTurn({})).kind, host.state], ['not-paired', 'not-paired']);
  fail = new TypeError('fetch failed');
  assert.deepEqual([(await host.chatTurn({})).kind, host.state], ['offline', 'offline']);
  fail = null;
  await host.chatTurn({});
  assert.equal(host.state, 'ready');
});

test('a non-ready state is rechecked; a confirmed pairing makes it ready', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  let paired = [];
  let clock = 0;
  const client = fakeClient({ async devices() { return { found: [], paired }; } });
  const host = createHost({ client, watchMs: 5, recheckMs: 100, now: () => clock });
  await host.start(ac.signal);
  assert.equal(host.state, 'not-paired');
  paired = [{ deviceId: 'D1' }];
  await tick();
  assert.equal(host.state, 'not-paired'); // recheck not due yet
  clock = 100;
  await tick();
  assert.equal(host.state, 'ready');

  paired = [];
  clock = 0;
  const other = createHost({ client: fakeClient({ async devices() { return { found: [], paired: [] }; } }), watchMs: 1000 });
  await other.start(ac.signal);
  assert.equal(other.state, 'not-paired');
  assert.equal((await other.pairConfirm('D1', '123456')).toolsReady, true);
  assert.equal(other.state, 'ready');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test`
Expected: `host.test.mjs` FAILS with `Cannot find module '../src/main/host.mjs'`.

- [ ] **Step 3: Implement** — `src/main/host.mjs`:

```js
import { HostError, ToolClient } from 'codie-host';

// game_buddy's link to codie-host (spec §6) and the state the tray shows.

export const CLIENT_NAME = 'game-buddy';
export const SCOPE = Object.freeze({ tools: true, pair: true, api: Object.freeze(['/v1/api/data/user/chat/turns']) });

const WATCH_MS = 2000; // approval shows in client.status, which serve() refreshes
const RECHECK_MS = 30_000; // how often a non-ready state asks for the paired devices

// What a failed call means for the tray.
export function classify(error) {
  if (!(error instanceof HostError)) return 'offline'; // codie-agentd did not answer
  switch (error.code) {
    case 'DEVICE_BLOCKED':
    case 'AMBIENT_MODE_BLOCKED': return 'blocked';
    case 'APPROVAL_PENDING': return 'pending';
    case 'NOT_PAIRED':
    case 'REPAIR_REQUIRED': return 'not-paired';
    case 'DEVICE_OFFLINE': return 'offline';
    default: return 'error';
  }
}

export function createHost({
  log = () => {}, onState = () => {}, client = new ToolClient({ name: CLIENT_NAME, scope: SCOPE, log }),
  now = Date.now, watchMs = WATCH_MS, recheckMs = RECHECK_MS,
} = {}) {
  let state = 'connecting';
  let lastCheck = -Infinity;
  let checking = false;

  const set = next => {
    if (next === state) return;
    state = next;
    onState(next);
  };
  // Blocked turns and other one-off errors leave the state as it is.
  const noteError = e => {
    const kind = classify(e);
    if (kind !== 'blocked' && kind !== 'error') set(kind);
    return kind;
  };

  async function refresh() {
    if (checking) return;
    checking = true;
    lastCheck = now();
    try {
      if (client.status !== 'approved') { set('pending'); return; }
      const { paired } = await client.devices();
      set(paired.length ? 'ready' : 'not-paired');
    } catch (e) {
      noteError(e);
    } finally {
      checking = false;
    }
  }

  return {
    get state() { return state; },

    async start(signal) {
      try {
        await client.connect();
      } catch (e) {
        noteError(e);
      }
      // No tools until phase 3: serve() only keeps the registration alive
      // and registers again after a codie-agentd restart.
      client.serve({}, { signal }).catch(e => log(`codie-host: ${e?.message ?? e}`));
      await refresh();
      const watch = setInterval(() => {
        const due = state === 'pending' ? client.status === 'approved' : state !== 'ready' && now() - lastCheck >= recheckMs;
        if (due) refresh();
      }, watchMs);
      signal.addEventListener('abort', () => clearInterval(watch), { once: true });
    },

    async chatTurn({ image, text, speech = 'device' }) {
      try {
        const turn = await client.chatTurn({ image, text, speech });
        set('ready');
        return { ok: true, turn };
      } catch (error) {
        return { ok: false, kind: noteError(error), error };
      }
    },

    devices: () => client.devices(),
    pairBegin: id => client.pairBegin(id),
    async pairConfirm(id, code) {
      const r = await client.pairConfirm(id, code);
      if (r.toolsReady) set('ready');
      return r;
    },
    pairCancel: id => client.pairCancel(id),
    close: () => client.close(),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 5: Integration test against a real codie-agentd (spec §8)** — `test/host-integration.test.mjs`. It runs agentd in-process with the fake clt01 from the sibling codie_host repo, and the real SDK `ToolClient` (with its own `home`, so the user's `~/.codie` is never touched):

```js
// host.mjs with the real SDK against an in-process codie-agentd and the fake
// clt01 of the sibling codie_host repo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolClient } from 'codie-host';
import { startAgentd } from 'codie-host/agentd/daemon/agentd-core.mjs';
import { Store } from 'codie-host/agentd/store.mjs';
import { startFakeDevice } from '../../codie_host/test/agentd/helpers/fake-device.mjs';
import { CLIENT_NAME, SCOPE, createHost } from '../src/main/host.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const noMdns = { sync: async () => {}, close: async () => {}, discover: async () => [] };

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail('condition not reached');
}

test('once approved and paired, a chat turn reaches the device', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'game-buddy-host-'));
  const device = await startFakeDevice({ credential });
  new Store(home).upsertPairing({
    deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port, bridgeId: 'b1', serviceSecret: 's1',
    userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
  });
  const agentd = await startAgentd({ home, port: 0, legacyDirs: [], handoffDirs: [], clt01: {}, log: () => {}, exit: () => {}, mdns: noMdns });
  const ac = new AbortController();
  const host = createHost({ client: new ToolClient({ name: CLIENT_NAME, scope: SCOPE, home }), watchMs: 20 });
  t.after(async () => {
    ac.abort();
    await host.close();
    await agentd.shutdown();
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  await host.start(ac.signal);
  assert.equal(host.state, 'pending');
  await fetch(`http://127.0.0.1:${agentd.ipcPort}/clients/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agentd.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: CLIENT_NAME }),
  });
  await until(() => host.state === 'ready');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const r = await host.chatTurn({ image: jpeg, text: 'cheer me on', speech: 'device' });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.turn.state, 'completed');
  assert.deepEqual(device.turns[0].request.output, { speech: 'device' });
  assert.ok(device.turns[0].image.equals(jpeg));
});
```

Run: `npm test` — Expected: PASS. (Approval reaches `client.status` through `serve()`'s 2 s approval poll, so this test takes a few seconds.)

- [ ] **Step 6: Commit**

```bash
git add src/main/host.mjs test/host.test.mjs test/host-integration.test.mjs
git commit -m "feat: codie-host client and tray state"
```

---

### Task 5: commentary decisions

**Files:**
- Create: `src/main/commentary.mjs`
- Test: `test/commentary.test.mjs`

**Interfaces:**
- Consumes: `matchAllowList`, `shouldSend` (Task 3), `commentaryPrompt` (Task 3), a lock from `createTurnLock()` (Task 3), a host with `chatTurn({ image, text, speech }) → { ok, turn } | { ok: false, kind, error }` (Task 4).
- Produces: `createCommentary({ capture, host, lock, settings, now?, log? }) → { tick(), hotkey() }`.
  - `capture` (Task 6 provides the real one): `foreground() → window | null`, `sampleHash(windowId) → bigint | null`, `captureJpeg(windowId) → Buffer | null`.
  - `settings`: a function returning the current settings object.
  - `tick() → 'skip' | 'no-game' | 'no-frame' | 'unchanged' | 'sent' | <failure kind>` — spec §4.1 steps 1–5.
  - `hotkey() → 'no-window' | 'no-frame' | 'sent' | <failure kind>` — the foreground window at once, no allow-list, change or cooldown check; waits for a turn in flight.

- [ ] **Step 1: Write the failing test** — `test/commentary.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommentary } from '../src/main/commentary.mjs';
import { createTurnLock } from '../src/main/turn-lock.mjs';

const GAME = { id: 7, path: 'C:\\Games\\game.exe', owner: 'Game', title: 'Game - Level 1' };
const BROWSER = { id: 8, path: 'C:\\Apps\\chrome.exe', owner: 'Chrome', title: 'Bank' };
const BIG = (1n << 20n) - 1n; // 20 bits from 0n

function setup({ win = GAME, hash = 0n, outcome = { ok: true } } = {}) {
  const state = { win, hash, outcome, clock: 100_000, sent: [], captured: [] };
  const settings = { commentaryEnabled: true, allowList: [{ process: 'game.exe', name: 'Test Game' }], cooldownMs: 60000, changeThreshold: 12 };
  const capture = {
    foreground: async () => state.win,
    sampleHash: async () => state.hash,
    captureJpeg: async id => { state.captured.push(id); return Buffer.from([0xff, 0xd8, 0xff]); },
  };
  const host = { chatTurn: async req => { state.sent.push(req); return state.outcome; } };
  const lock = createTurnLock();
  const c = createCommentary({ capture, host, lock, settings: () => settings, now: () => state.clock });
  return { c, state, settings, lock };
}

test('an allowed game in front gets a comment with the game name, spoken on the device', async () => {
  const { c, state } = setup();
  assert.equal(await c.tick(), 'sent');
  assert.deepEqual(state.captured, [7]);
  assert.equal(state.sent[0].speech, 'device');
  assert.match(state.sent[0].text, /Test Game/);
  assert.ok(Buffer.isBuffer(state.sent[0].image));
});

test('other windows, disabled commentary and a busy lock send nothing', async () => {
  const { c, state, settings, lock } = setup({ win: BROWSER });
  assert.equal(await c.tick(), 'no-game');
  state.win = null;
  assert.equal(await c.tick(), 'no-game');
  state.win = GAME;
  settings.commentaryEnabled = false;
  assert.equal(await c.tick(), 'skip');
  settings.commentaryEnabled = true;
  let release;
  const held = lock.run(() => new Promise(r => { release = r; }));
  assert.equal(await c.tick(), 'skip');
  release();
  await held;
  assert.equal(state.sent.length, 0);
});

test('the same scene stays quiet until it changes and the cooldown passed', async () => {
  const { c, state } = setup();
  assert.equal(await c.tick(), 'sent');
  state.clock += 10_000;
  state.hash = BIG;
  assert.equal(await c.tick(), 'unchanged'); // changed, cooldown not passed
  state.clock += 60_000;
  state.hash = 0n;
  assert.equal(await c.tick(), 'unchanged'); // cooldown passed, same scene
  state.hash = BIG;
  assert.equal(await c.tick(), 'sent');
  assert.equal(state.sent.length, 2);
});

test('a blocked device drops the frame and the next tick tries again', async () => {
  const { c, state } = setup({ outcome: { ok: false, kind: 'blocked' } });
  assert.equal(await c.tick(), 'blocked');
  state.outcome = { ok: true };
  assert.equal(await c.tick(), 'sent');
});

test('no sample or no capture sends nothing', async () => {
  const { c, state } = setup({ hash: null });
  assert.equal(await c.tick(), 'no-frame');
  const capture = { foreground: async () => GAME, sampleHash: async () => 0n, captureJpeg: async () => null };
  const settings = () => ({ commentaryEnabled: true, allowList: [{ process: 'game.exe', name: 'G' }], cooldownMs: 60000, changeThreshold: 12 });
  const none = createCommentary({ capture, host: { chatTurn: async () => assert.fail('no turn') }, lock: createTurnLock(), settings, now: () => 0 });
  assert.equal(await none.tick(), 'no-frame');
  assert.equal(state.sent.length, 0);
});

test('the hotkey sends the window in front at once, allowed or not, after a turn in flight', async () => {
  const { c, state, lock } = setup({ win: BROWSER });
  let release;
  const held = lock.run(() => new Promise(r => { release = r; }));
  const pressed = c.hotkey();
  await new Promise(r => setImmediate(r));
  assert.equal(state.sent.length, 0);
  release();
  await held;
  assert.equal(await pressed, 'sent');
  assert.match(state.sent[0].text, /Bank/);
  assert.equal(await c.hotkey(), 'sent'); // no cooldown for the hotkey
  state.win = null;
  assert.equal(await c.hotkey(), 'no-window');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test`
Expected: `commentary.test.mjs` FAILS with `Cannot find module '../src/main/commentary.mjs'`.

- [ ] **Step 3: Implement** — `src/main/commentary.mjs`:

```js
import { commentaryPrompt } from './prompt.mjs';
import { matchAllowList, shouldSend } from './trigger.mjs';

// The commentary loop (spec §4.1): which frame to send and when. Capture,
// the codie-host link and the clock are injected.
export function createCommentary({ capture, host, lock, settings, now = Date.now, log = () => {} }) {
  let lastSentHash = null;
  let lastSentAt = -Infinity;

  async function send(win, name, hash) {
    const image = await capture.captureJpeg(win.id);
    if (!image) return 'no-frame';
    const r = await host.chatTurn({ image, text: commentaryPrompt(name), speech: 'device' });
    if (!r.ok) {
      if (r.kind !== 'blocked') log(`commentary: ${r.error?.code ?? r.kind} ${r.error?.message ?? ''}`);
      return r.kind;
    }
    lastSentHash = hash;
    lastSentAt = now();
    return 'sent';
  }

  return {
    async tick() {
      const s = settings();
      if (!s.commentaryEnabled || lock.busy) return 'skip';
      const win = await capture.foreground();
      const game = win ? matchAllowList(win, s.allowList) : null;
      if (!game) return 'no-game';
      const hash = await capture.sampleHash(win.id);
      if (hash === null) return 'no-frame';
      if (!shouldSend({ hash, lastSentHash, now: now(), lastSentAt, settings: s })) return 'unchanged';
      if (lock.busy) return 'skip'; // the hotkey took the device meanwhile
      return lock.run(() => send(win, game.name, hash));
    },

    // The user asked: no allow-list, change or cooldown check.
    async hotkey() {
      const win = await capture.foreground();
      if (!win) return 'no-window';
      const game = matchAllowList(win, settings().allowList);
      const hash = (await capture.sampleHash(win.id)) ?? lastSentHash;
      return lock.run(() => send(win, game?.name ?? (win.title || win.owner || 'a game'), hash));
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add src/main/commentary.mjs test/commentary.test.mjs
git commit -m "feat: commentary tick and hotkey decisions"
```

---

### Task 6: the running tray app

**Files:**
- Create: `src/main/hotkey.mjs`, `src/main/capture.mjs`, `src/main/tray.mjs`, `src/main/main.mjs`
- Test: `test/hotkey.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2–5; Task 1's codie_host fix (through the `file:` dependency).
- Produces:
  - `registerHotkey(shortcut, accelerator, onPress) → string | null` — `shortcut` is Electron's `globalShortcut` (or a fake with `unregisterAll()` and `register(accelerator, fn) → boolean`); returns an error message, or `null` when registered.
  - `capture.mjs`: `foreground()`, `listWindows() → window[]`, `sampleHash(windowId)`, `captureJpeg(windowId)` (window shape from Task 3).
  - `tray.mjs`: `STATE_TEXT` (state → menu text), `createTray({ onToggle, onQuit }) → { render({ state, commentaryEnabled }), destroy() }`. Task 7 adds `onSettings`.
  - `main.mjs`: the app. Task 7 extends it.

- [ ] **Step 1: Write the failing test** — `test/hotkey.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHotkey } from '../src/main/hotkey.mjs';

function fakeShortcut({ taken = [], invalid = [] } = {}) {
  return {
    registered: new Map(),
    unregisterAll() { this.registered.clear(); },
    register(acc, fn) {
      if (invalid.includes(acc)) throw new TypeError(`conversion failure: ${acc}`);
      if (taken.includes(acc)) return false;
      this.registered.set(acc, fn);
      return true;
    },
  };
}

test('a free accelerator is registered and replaces the previous one', () => {
  const s = fakeShortcut();
  assert.equal(registerHotkey(s, 'Ctrl+Alt+G', () => {}), null);
  assert.equal(registerHotkey(s, 'Ctrl+Alt+H', () => {}), null);
  assert.deepEqual([...s.registered.keys()], ['Ctrl+Alt+H']);
});

test('taken and invalid accelerators are reported', () => {
  assert.match(registerHotkey(fakeShortcut({ taken: ['F1'] }), 'F1', () => {}), /F1 is used by another program/);
  assert.match(registerHotkey(fakeShortcut({ invalid: ['Nope+'] }), 'Nope+', () => {}), /Nope\+ is not a valid shortcut/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test`
Expected: `hotkey.test.mjs` FAILS with `Cannot find module`.

- [ ] **Step 3: Implement `src/main/hotkey.mjs`**

```js
// The commentary hotkey (spec §4.1): one global shortcut at a time.
// Returns an error message for the settings window, or null.
export function registerHotkey(shortcut, accelerator, onPress) {
  shortcut.unregisterAll();
  try {
    return shortcut.register(accelerator, onPress) ? null : `${accelerator} is used by another program`;
  } catch {
    return `${accelerator} is not a valid shortcut`;
  }
}
```

Run: `npm test` — Expected: PASS.

- [ ] **Step 4: Implement `src/main/capture.mjs`** (Electron; verified on this machine with Electron 44.7.2: `activeWindow().id` matches the `desktopCapturer` source id `window:<id>:0`, thumbnails keep the window's aspect inside `thumbnailSize`, `toBitmap()` is BGRA)

```js
import { desktopCapturer } from 'electron';
import { activeWindow, openWindows } from 'get-windows';
import { HASH_HEIGHT, HASH_WIDTH, dHash } from './dhash.mjs';

// Windows and frames (spec §4.1 steps 1, 2 and 4).

const MAX_IMAGE_BYTES = 1 << 20; // codie-host refuses larger images
const QUALITIES = [80, 65, 50, 35];
const SAMPLE_SIZE = { width: 64, height: 36 };
const SEND_SIZE = { width: 1280, height: 1280 }; // the window fits inside, aspect kept

const toWindow = w => (w ? { id: w.id, path: w.owner?.path ?? '', owner: w.owner?.name ?? '', title: w.title ?? '' } : null);

export async function foreground() {
  return toWindow(await activeWindow());
}

export async function listWindows() {
  return (await openWindows()).map(toWindow);
}

async function thumbnail(windowId, size) {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size });
  const source = sources.find(s => s.id.startsWith(`window:${windowId}:`));
  return source && !source.thumbnail.isEmpty() ? source.thumbnail : null;
}

export async function sampleHash(windowId) {
  const img = await thumbnail(windowId, SAMPLE_SIZE);
  return img ? dHash(img.resize({ width: HASH_WIDTH, height: HASH_HEIGHT }).toBitmap()) : null;
}

// A JPEG of the window that codie-host accepts, or null.
export async function captureJpeg(windowId) {
  const img = await thumbnail(windowId, SEND_SIZE);
  if (!img) return null;
  for (const quality of QUALITIES) {
    const jpeg = img.toJPEG(quality);
    if (jpeg.length <= MAX_IMAGE_BYTES) return jpeg;
  }
  return null;
}
```

- [ ] **Step 5: Implement `src/main/tray.mjs`**

```js
import { Menu, Tray, nativeImage } from 'electron';

// The tray icon (spec §4.2): green ready, yellow waiting on the user, grey
// connecting or offline. Icons are drawn here, no image files.

const ICON_SIZE = 16;
const COLORS = {
  ready: [0x43, 0xa0, 0x47],
  pending: [0xff, 0xb3, 0x00],
  'not-paired': [0xff, 0xb3, 0x00],
  connecting: [0x9e, 0x9e, 0x9e],
  offline: [0x9e, 0x9e, 0x9e],
};

export const STATE_TEXT = {
  connecting: 'Connecting to codie-host…',
  pending: 'Waiting for approval: run "codie clients approve game-buddy"',
  'not-paired': 'No Codie paired: open Settings to pair one',
  offline: 'Codie is offline',
  ready: 'Codie is watching your games',
};

function icon(state) {
  const [r, g, b] = COLORS[state];
  const bitmap = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  for (let i = 0; i < bitmap.length; i += 4) bitmap.set([b, g, r, 0xff], i);
  return nativeImage.createFromBitmap(bitmap, { width: ICON_SIZE, height: ICON_SIZE });
}

export function createTray({ onToggle, onQuit }) {
  const tray = new Tray(icon('connecting'));
  return {
    render({ state, commentaryEnabled }) {
      tray.setImage(icon(state));
      tray.setToolTip(`Codie Game Buddy: ${STATE_TEXT[state]}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: STATE_TEXT[state], enabled: false },
        { type: 'separator' },
        { label: 'Commentary', type: 'checkbox', checked: commentaryEnabled, click: onToggle },
        { type: 'separator' },
        { label: 'Quit', click: onQuit },
      ]));
    },
    destroy: () => tray.destroy(),
  };
}
```

- [ ] **Step 6: Implement `src/main/main.mjs`**

```js
import path from 'node:path';
import { app, globalShortcut } from 'electron';
import * as capture from './capture.mjs';
import { createCommentary } from './commentary.mjs';
import { createHost } from './host.mjs';
import { registerHotkey } from './hotkey.mjs';
import { loadSettings, saveSettings } from './settings.mjs';
import { createTray } from './tray.mjs';
import { createTurnLock } from './turn-lock.mjs';

// Codie Game Buddy: a tray app that lets Codie comment on the game in front.

const log = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

if (process.env.GAME_BUDDY_HOME) app.setPath('userData', path.resolve(process.env.GAME_BUDDY_HOME));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const loaded = loadSettings(settingsFile);
  if (loaded.errors.length) log(`settings: invalid ${loaded.errors.join(', ')}; using the defaults for them`);
  let settings = loaded.settings;
  let tray = null;
  let timer = null;
  const ac = new AbortController();

  const view = () => ({ state: host.state, commentaryEnabled: settings.commentaryEnabled });
  const host = createHost({ log, onState: state => { log(`codie-host: ${state}`); tray?.render(view()); } });
  const lock = createTurnLock();
  const commentary = createCommentary({ capture, host, lock, settings: () => settings, log });

  const onHotkey = () => commentary.hotkey().then(r => log(`hotkey: ${r}`), e => log(`hotkey: ${e?.message ?? e}`));

  // Applies saved settings; returns the hotkey error, if any.
  const apply = next => {
    settings = next;
    tray?.render(view());
    const hotkeyError = registerHotkey(globalShortcut, settings.hotkey, onHotkey);
    if (hotkeyError) log(`hotkey: ${hotkeyError}`);
    return hotkeyError;
  };

  const loop = async () => {
    try {
      const r = await commentary.tick();
      if (r === 'sent' || r === 'blocked') log(`commentary: ${r}`);
    } catch (e) {
      log(`commentary: ${e?.message ?? e}`);
    } finally {
      if (!ac.signal.aborted) timer = setTimeout(loop, settings.sampleMs);
    }
  };

  app.whenReady().then(() => {
    tray = createTray({
      onToggle: () => {
        const r = saveSettings(settingsFile, { ...settings, commentaryEnabled: !settings.commentaryEnabled });
        if (r.saved) apply(r.settings);
      },
      onQuit: () => app.quit(),
    });
    apply(settings);
    host.start(ac.signal);
    loop();
  });

  app.on('window-all-closed', () => {}); // the tray keeps running
  app.on('will-quit', () => {
    ac.abort();
    clearTimeout(timer);
    globalShortcut.unregisterAll();
    host.close().catch(() => {});
    tray?.destroy();
  });
}
```

- [ ] **Step 7: Run the app** (no device needed). In Git Bash, from the repo root:

```bash
export SMOKE="$TEMP/game-buddy-smoke"; rm -rf "$SMOKE"; mkdir -p "$SMOKE/app"
printf '{"allowList":[{"process":"notepad.exe","name":"Notepad Test"}],"cooldownMs":15000}\n' > "$SMOKE/app/settings.json"
GAME_BUDDY_HOME="$SMOKE/app" CODIE_HOME="$SMOKE/codie" CODIE_PORT=19531 npx electron . 2> "$SMOKE/log.txt" &
```

(Run the `npx electron .` line as a background command so your shell does not block.)

Then:
1. `$SMOKE/log.txt` shows `Waiting for approval. Run: codie clients approve game-buddy` and `codie-host: pending`; a grey/yellow tray icon appears; `$SMOKE/codie/agentd.json` exists (the daemon started as plain Node — Task 1).
2. Run `CODIE_HOME="$SMOKE/codie" node ../codie_host/bin/codie.mjs clients approve game-buddy`. Within a few seconds the log shows `codie-host: not-paired` (no device is paired in this temp home) and the icon is yellow.
3. Open Notepad and keep it in front for ~10 s: the log shows `commentary: NOT_PAIRED …` (frames are captured and sent; codie-host refuses because no device is paired).
4. Press `Ctrl+Alt+G` with any window in front: the log shows `hotkey: not-paired`.
5. Tray menu → Commentary unchecks; `$SMOKE/app/settings.json` now has `"commentaryEnabled": false`; Notepad in front no longer logs commentary lines.
6. Tray menu → Quit: the process exits. Stop the temp daemon: `CODIE_HOME="$SMOKE/codie" node ../codie_host/bin/codie.mjs stop`.

Record the log lines you saw for each check in your report. If any check fails, stop and report it; do not work around it.

- [ ] **Step 8: Run the unit tests and commit**

Run: `npm test` — Expected: PASS.

```bash
git add src/main/hotkey.mjs src/main/capture.mjs src/main/tray.mjs src/main/main.mjs test/hotkey.test.mjs
git commit -m "feat: tray app with commentary loop and hotkey"
```

---

### Task 7: settings window with pairing

**Files:**
- Create: `src/main/settings-window.mjs`, `src/preload/preload.cjs`, `src/renderer/settings.html`, `src/renderer/settings.mjs`, `src/renderer/settings.css`, `playwright.config.mjs`, `e2e/settings.spec.mjs`
- Modify: `src/main/main.mjs`, `src/main/tray.mjs`

**Interfaces:**
- Consumes: `saveSettings`, `DEFAULTS` (Task 2); `host.devices/pairBegin/pairConfirm/pairCancel` (Task 4); `capture.listWindows()`, `STATE_TEXT`, `createTray`, `apply()` in `main.mjs` (Task 6).
- Produces:
  - `registerSettingsIpc({ getView, save, listGames, host })` and `openSettingsWindow()`, `pushView(view)`.
  - IPC channels (renderer → main, `ipcRenderer.invoke`): `settings:get` → `{ settings, errors, state, stateText }`; `settings:save` (raw settings) → `{ settings, errors, saved, hotkeyError }`; `games:list` → `[{ process, name }]`; `devices:list` → `{ found, paired }`; `pair:begin` (deviceId) → `{ ok, message }`; `pair:confirm` (deviceId, code) → `{ ok, toolsReady, message }`; `pair:cancel` (deviceId) → `{ ok, message }`. Host failures come back as `{ error, code }` instead of throwing. Main → renderer event `view` with `{ state, stateText }`.
  - `window.buddy` in the renderer: `getSettings()`, `saveSettings(s)`, `listGames()`, `listDevices()`, `pairBegin(id)`, `pairConfirm(id, code)`, `pairCancel(id)`, `onView(fn)`.
  - The settings window opens on first run (no `settings.json`), when the app is started again while running, and from the tray (`Settings…`, double-click).

- [ ] **Step 1: Write the failing E2E test** — `playwright.config.mjs`:

```js
export default {
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
};
```

`e2e/settings.spec.mjs`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

// The settings window against a fresh userData and a fresh codie-agentd.

let home;

test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'game-buddy-e2e-'));
});

test.afterEach(async () => {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'codie', 'agentd.json'), 'utf8'));
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } });
  } catch { /* the daemon never started */ }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const launch = () => electron.launch({
  args: ['.'],
  env: { ...process.env, GAME_BUDDY_HOME: path.join(home, 'app'), CODIE_HOME: path.join(home, 'codie'), CODIE_PORT: '19531' },
});

test('first run opens settings; saved values persist', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#cooldown')).toHaveValue('60');
    await expect(page.locator('#status')).toContainText(/approval|codie-host/i);

    await page.locator('#cooldown').fill('90');
    await page.locator('#manual-process').fill('game.exe');
    await page.locator('#manual-name').fill('Test Game');
    await page.locator('#manual-add').click();
    await expect(page.locator('#games li')).toHaveCount(1);
    await page.locator('#save').click();
    await expect(page.locator('#save-status')).toHaveText('Saved.');

    await page.reload();
    await expect(page.locator('#cooldown')).toHaveValue('90');
    await expect(page.locator('#games li')).toContainText('Test Game (game.exe)');
  } finally {
    await app.close();
  }
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'app', 'settings.json'), 'utf8'));
  expect(saved.cooldownMs).toBe(90000);
  expect(saved.allowList).toEqual([{ process: 'game.exe', name: 'Test Game' }]);
});

test('invalid values are refused and nothing is written', async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator('#cooldown').fill('5');
    await page.locator('#save').click();
    await expect(page.locator('#save-status')).toContainText('cooldownMs');
  } finally {
    await app.close();
  }
  expect(fs.existsSync(path.join(home, 'app', 'settings.json'))).toBe(false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx playwright test`
Expected: FAIL — `firstWindow` times out (no window opens yet).

- [ ] **Step 3: Implement `src/main/settings-window.mjs`**

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain } from 'electron';

// The settings window (spec §4.3) and the IPC it uses.

const HERE = path.dirname(fileURLToPath(import.meta.url));
let win = null;

// Host calls answer { error, code } instead of rejecting into the renderer.
const hostCall = fn => async (event, ...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    return { error: e?.message ?? String(e), code: e?.code ?? '' };
  }
};

export function registerSettingsIpc({ getView, save, listGames, host }) {
  ipcMain.handle('settings:get', () => getView());
  ipcMain.handle('settings:save', (event, raw) => save(raw));
  ipcMain.handle('games:list', () => listGames());
  ipcMain.handle('devices:list', hostCall(() => host.devices()));
  ipcMain.handle('pair:begin', hostCall(id => host.pairBegin(id)));
  ipcMain.handle('pair:confirm', hostCall((id, code) => host.pairConfirm(id, code)));
  ipcMain.handle('pair:cancel', hostCall(id => host.pairCancel(id)));
}

export function openSettingsWindow() {
  if (win) {
    win.show();
    win.focus();
    return win;
  }
  win = new BrowserWindow({
    width: 560,
    height: 760,
    title: 'Codie Game Buddy',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(HERE, '..', 'renderer', 'settings.html'));
  return win;
}

export function pushView(view) {
  win?.webContents.send('view', view);
}
```

- [ ] **Step 4: Implement `src/preload/preload.cjs`**

```js
const { contextBridge, ipcRenderer } = require('electron');

// The only API the settings page gets.
contextBridge.exposeInMainWorld('buddy', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  listGames: () => ipcRenderer.invoke('games:list'),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  pairBegin: id => ipcRenderer.invoke('pair:begin', id),
  pairConfirm: (id, code) => ipcRenderer.invoke('pair:confirm', id, code),
  pairCancel: id => ipcRenderer.invoke('pair:cancel', id),
  onView: fn => ipcRenderer.on('view', (event, view) => fn(view)),
});
```

- [ ] **Step 5: Implement the page** — `src/renderer/settings.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'">
  <title>Codie Game Buddy</title>
  <link rel="stylesheet" href="settings.css">
</head>
<body>
  <main>
    <h1>Codie Game Buddy</h1>
    <p id="status" class="status"></p>

    <section>
      <h2>Commentary</h2>
      <label><input type="checkbox" id="enabled"> Let Codie comment on my games</label>
      <label>Look every <input type="number" id="sample" min="1" max="30" step="1"> seconds</label>
      <label>Wait at least <input type="number" id="cooldown" min="15" max="600" step="1"> seconds between comments</label>
      <label>Scene change needed <input type="number" id="threshold" min="1" max="64" step="1"> (1–64, higher = bigger change)</label>
      <label>Hotkey <input type="text" id="hotkey" maxlength="64"></label>
    </section>

    <section>
      <h2>Games</h2>
      <ul id="games"></ul>
      <div class="row">
        <select id="running"></select>
        <button id="running-refresh" type="button">Refresh</button>
        <button id="running-add" type="button">Add</button>
      </div>
      <div class="row">
        <input type="text" id="manual-process" placeholder="game.exe">
        <input type="text" id="manual-name" placeholder="Game name" maxlength="80">
        <button id="manual-add" type="button">Add</button>
      </div>
    </section>

    <div class="row">
      <button id="save" type="button">Save</button>
      <span id="save-status"></span>
    </div>

    <section>
      <h2>Codie device</h2>
      <div class="row"><button id="scan" type="button">Scan for devices</button></div>
      <ul id="devices"></ul>
      <div id="pairing" hidden>
        <label>Code on the device screen <input type="text" id="code" maxlength="6" inputmode="numeric"></label>
        <div class="row">
          <button id="confirm" type="button">Pair</button>
          <button id="cancel" type="button">Cancel</button>
        </div>
      </div>
      <p id="pair-status"></p>
    </section>
  </main>
  <script type="module" src="settings.mjs"></script>
</body>
</html>
```

`src/renderer/settings.css`:

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; font-size: 14px; }
body { margin: 0; }
main { padding: 16px 20px; }
h1 { font-size: 18px; margin: 0 0 8px; }
h2 { font-size: 15px; margin: 20px 0 8px; }
label { display: block; margin: 6px 0; }
input[type="number"] { width: 64px; }
.row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
.status { padding: 8px; border-radius: 6px; background: rgba(127, 127, 127, 0.15); }
ul { padding-left: 18px; }
li button { margin-left: 8px; }
```

`src/renderer/settings.mjs`:

```js
// The settings page: talks to the main process only through window.buddy.
const $ = id => document.getElementById(id);
const api = window.buddy;
let games = [];
let pairingId = null;

const text = (el, value) => { el.textContent = value; };
const seconds = ms => String(Math.round(ms / 1000));
const millis = id => Number($(id).value) * 1000;

function li(label, button) {
  const item = document.createElement('li');
  text(item, label);
  if (button) item.append(button);
  return item;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  text(b, label);
  b.addEventListener('click', onClick);
  return b;
}

function renderGames() {
  $('games').replaceChildren(...games.map((g, i) => li(`${g.name} (${g.process})`,
    button('Remove', () => { games = games.filter((_, j) => j !== i); renderGames(); }))));
}

function addGame(process, name) {
  if (!process || !name || games.some(g => g.process.toLowerCase() === process.toLowerCase())) return;
  games = [...games, { process, name }];
  renderGames();
}

function show({ settings, errors = [], stateText }) {
  $('enabled').checked = settings.commentaryEnabled;
  $('sample').value = seconds(settings.sampleMs);
  $('cooldown').value = seconds(settings.cooldownMs);
  $('threshold').value = String(settings.changeThreshold);
  $('hotkey').value = settings.hotkey;
  games = settings.allowList;
  renderGames();
  text($('status'), stateText);
  text($('save-status'), errors.length ? `Invalid in settings.json, using defaults: ${errors.join(', ')}` : '');
}

async function refreshRunning() {
  const list = await api.listGames();
  $('running').replaceChildren(...list.map(g => {
    const o = document.createElement('option');
    o.value = JSON.stringify(g);
    text(o, `${g.name} (${g.process})`);
    return o;
  }));
}

async function save() {
  const r = await api.saveSettings({
    commentaryEnabled: $('enabled').checked,
    sampleMs: millis('sample'),
    cooldownMs: millis('cooldown'),
    changeThreshold: Number($('threshold').value),
    hotkey: $('hotkey').value,
    allowList: games,
  });
  if (!r.saved) text($('save-status'), `Not saved, invalid: ${r.errors.join(', ')}`);
  else text($('save-status'), r.hotkeyError ? `Saved. Hotkey not active: ${r.hotkeyError}` : 'Saved.');
}

async function scan() {
  text($('pair-status'), 'Scanning…');
  const r = await api.listDevices();
  if (r.error) { text($('pair-status'), r.error); return; }
  const paired = new Set(r.paired.map(d => d.deviceId));
  const found = new Set(r.found.map(d => d.deviceId));
  $('devices').replaceChildren(
    ...r.found.map(d => li(`${d.name || d.deviceId} (${d.host})${paired.has(d.deviceId) ? ' · paired' : ''}`,
      button('Pair', () => begin(d.deviceId)))),
    ...r.paired.filter(d => !found.has(d.deviceId)).map(d => li(`${d.name || d.deviceId} · paired, not found on the network now`)),
  );
  text($('pair-status'), r.found.length || r.paired.length ? '' : 'No Codie found on this network.');
}

async function begin(id) {
  const r = await api.pairBegin(id);
  text($('pair-status'), r.error ?? r.message);
  if (r.ok) { pairingId = id; $('pairing').hidden = false; $('code').value = ''; $('code').focus(); }
}

async function confirm() {
  text($('pair-status'), 'Pairing…');
  const r = await api.pairConfirm(pairingId, $('code').value.trim());
  text($('pair-status'), r.error ?? (r.toolsReady ? `${r.message} Codie is ready.` : r.message));
  if (r.ok || r.toolsReady) { pairingId = null; $('pairing').hidden = true; }
}

async function cancel() {
  if (pairingId) await api.pairCancel(pairingId);
  pairingId = null;
  $('pairing').hidden = true;
  text($('pair-status'), 'Pairing cancelled.');
}

$('save').addEventListener('click', save);
$('manual-add').addEventListener('click', () => {
  addGame($('manual-process').value.trim(), $('manual-name').value.trim());
  $('manual-process').value = '';
  $('manual-name').value = '';
});
$('running-refresh').addEventListener('click', refreshRunning);
$('running-add').addEventListener('click', () => {
  if (!$('running').value) return;
  const g = JSON.parse($('running').value);
  addGame(g.process, g.name);
});
$('scan').addEventListener('click', scan);
$('confirm').addEventListener('click', confirm);
$('cancel').addEventListener('click', cancel);
api.onView(view => text($('status'), view.stateText));

show(await api.getSettings());
refreshRunning();
```

- [ ] **Step 6: Wire it into the app.** In `src/main/tray.mjs`, take `onSettings` and add the menu item and double-click:

```js
export function createTray({ onSettings, onToggle, onQuit }) {
  const tray = new Tray(icon('connecting'));
  tray.on('double-click', onSettings);
  return {
    render({ state, commentaryEnabled }) {
      tray.setImage(icon(state));
      tray.setToolTip(`Codie Game Buddy: ${STATE_TEXT[state]}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: STATE_TEXT[state], enabled: false },
        { type: 'separator' },
        { label: 'Commentary', type: 'checkbox', checked: commentaryEnabled, click: onToggle },
        { label: 'Settings…', click: onSettings },
        { type: 'separator' },
        { label: 'Quit', click: onQuit },
      ]));
    },
    destroy: () => tray.destroy(),
  };
}
```

In `src/main/main.mjs`:
- import the window module and `STATE_TEXT`:

```js
import { openSettingsWindow, pushView, registerSettingsIpc } from './settings-window.mjs';
import { STATE_TEXT, createTray } from './tray.mjs';
```

  (replace the old `import { createTray } from './tray.mjs';`).
- after `const commentary = …`, add:

```js
  const OWN_EXE = path.win32.basename(process.execPath).toLowerCase();
  // Running windows as allow-list candidates: one per exe, not this app.
  const listGames = async () => {
    const seen = new Set([OWN_EXE]);
    const games = [];
    for (const w of await capture.listWindows()) {
      const exe = path.win32.basename(w.path);
      if (!exe || seen.has(exe.toLowerCase())) continue;
      seen.add(exe.toLowerCase());
      games.push({ process: exe, name: (w.title || w.owner || exe).slice(0, 80) });
    }
    return games;
  };
  const stateView = () => ({ state: host.state, stateText: STATE_TEXT[host.state] });
```

- change the `onState` callback of `createHost` to also push to the window: `onState: state => { log(`codie-host: ${state}`); tray?.render(view()); pushView(stateView()); }`.
- in `app.whenReady().then(…)`, register the IPC before the tray, pass `onSettings`, and open the window on first run:

```js
  app.whenReady().then(() => {
    registerSettingsIpc({
      getView: () => ({ settings, errors: loaded.errors, ...stateView() }),
      save: raw => {
        const r = saveSettings(settingsFile, raw);
        return r.saved ? { ...r, hotkeyError: apply(r.settings) } : { ...r, hotkeyError: null };
      },
      listGames,
      host,
    });
    tray = createTray({
      onSettings: openSettingsWindow,
      onToggle: () => {
        const r = saveSettings(settingsFile, { ...settings, commentaryEnabled: !settings.commentaryEnabled });
        if (r.saved) apply(r.settings);
      },
      onQuit: () => app.quit(),
    });
    apply(settings);
    host.start(ac.signal);
    loop();
    if (loaded.firstRun) openSettingsWindow();
  });

  app.on('second-instance', () => { if (app.isReady()) openSettingsWindow(); });
```

- [ ] **Step 7: Run the E2E and unit tests**

Run: `npx playwright test` — Expected: 2 passed.
Run: `npm test` — Expected: PASS.

Then check by hand once (same `$SMOKE` setup as Task 6 Step 7, with `settings.json` deleted so it is a first run): the window opens; `Refresh` lists running programs (Notepad, a browser…) but not `electron.exe`; adding one and saving shows `Saved.`; `Scan for devices` reports `No Codie found on this network.` or lists devices (it needs the client approved first: before approval it shows the `APPROVAL_PENDING` message); starting `npx electron .` a second time with the same env brings the window to the front. Record what you saw.

- [ ] **Step 8: Commit**

```bash
git add playwright.config.mjs e2e/settings.spec.mjs src/main/settings-window.mjs src/preload/preload.cjs src/renderer/settings.html src/renderer/settings.mjs src/renderer/settings.css src/main/main.mjs src/main/tray.mjs
git commit -m "feat: settings window with allow list and pairing"
```

---

### Task 8: run instructions and on-device checklist

**Files:**
- Create: `README.md`, `docs/manual-checklist.md`
- Modify: `D:\Devs\CodieWorkShop\CLAUDE.md` (workspace file, not in any repo: the layout row for `codie_game_buddy/`)

**Interfaces:** none (documentation).

- [ ] **Step 1: Write `README.md`**

```markdown
# Codie Game Buddy

A Windows tray app that keeps you company through a Codie device: while a game on your list is in front, Codie looks at it now and then and says a line or two in its own voice. Press the hotkey (default `Ctrl+Alt+G`) to make it look right away.

Design: [docs/specs/2026-10-29-game-buddy-design.md](docs/specs/2026-10-29-game-buddy-design.md).

## Requirements

- Windows 10/11 x64, Node.js 20+.
- `codie_host` checked out next to this repo (`../codie_host`): game_buddy talks to the Codie device only through its daemon, codie-agentd.
- A Codie device on the same network, with firmware that issues client credentials.

## Run

```bash
npm install          # if the Electron download fails: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
npm start
```

First run:

1. The settings window opens and the tray icon is yellow: game_buddy is waiting for your approval. Approve it once:
   `node ../codie_host/bin/codie.mjs clients approve game-buddy`
   (it asks for: hosting tools, image chat turns, pairing).
2. In **Codie device**, scan, pick your Codie, and type the 6-digit code shown on its screen. The tray turns green.
3. In **Games**, add your games (pick a running one, or type its exe name), then **Save**.

Play: with an allowed game in front, Codie comments when the scene changes and the cooldown has passed. Switching to another program pauses it. The tray menu turns commentary off.

Games in exclusive full-screen mode may capture as a black frame; use borderless or windowed mode.

## Develop

```bash
npm test             # unit tests (node:test)
npx playwright test  # settings window E2E
```

`GAME_BUDDY_HOME` moves the settings folder and `CODIE_HOME` the daemon's folder, for a clean test run. The on-device checklist is [docs/manual-checklist.md](docs/manual-checklist.md).
```

- [ ] **Step 2: Write `docs/manual-checklist.md`**

```markdown
# On-device checklist (phase 2)

Run before calling commentary done. Needs a paired Codie device (firmware with client credentials) on the same network and one installed game. Record date, device firmware and game for each run.

| # | Do | Expect |
|---|---|---|
| 1 | Start the app with the game on the allow list, tray green | Within one cooldown, Codie says one or two sentences about the game, in its own voice and language |
| 2 | Stay on the same scene (menu, pause screen) for two cooldowns | Codie stays quiet |
| 3 | Move to a clearly different scene after the cooldown | Codie comments again |
| 4 | Press `Ctrl+Alt+G` right after a comment | Codie comments at once (no cooldown), after it finishes speaking |
| 5 | Switch to a browser for two cooldowns | No comment; the log shows no `commentary: sent` |
| 6 | Talk to Codie (or let it speak) while a comment is due | The frame is dropped (`commentary: blocked` in the log); no retry for that frame |
| 7 | Uncheck Commentary in the tray | No comments; the hotkey still works |
| 8 | Unplug the device's network | Tray goes grey within a minute; comments resume after it reconnects |
| 9 | Quit from the tray | The app exits; no Codie speech afterwards |

Results:

| Date | Firmware | Game | Failed rows | Notes |
|---|---|---|---|---|
```

- [ ] **Step 3: Update the workspace layout** — in `D:\Devs\CodieWorkShop\CLAUDE.md`, the table currently ends a row with `| \`codie_game_buddy/\` | — | Empty placeholder. |` (it may sit on the same line as the previous row). Replace that cell group with:

```markdown
| `codie_game_buddy/` | own repo (`master`, local only) | Windows Electron tray app: Codie comments on the game in front. Uses the codie-host SDK (`file:../codie_host`). See its `README.md`. |
```

and make sure it is on its own line. Also change the `AGENTS.md` line `- \`codie_game_buddy/\`: currently empty.` in `D:\Devs\CodieWorkShop\AGENTS.md` to `- \`codie_game_buddy/\`: Electron tray app (Node ESM); \`npm test\`, \`npx playwright test\`, \`npm start\`.` These two workspace files are not in a repo: no commit for them.

- [ ] **Step 4: Commit** (game_buddy)

```bash
git add README.md docs/manual-checklist.md
git commit -m "docs: run instructions and on-device checklist"
```

---

## After this plan

- The user runs `docs/manual-checklist.md` on a real device; that is the phase 2 acceptance.
- Phase 3 (`look_at_game`) waits for the phase 0 spike (spec §7).
- codie_host's Task 1 commit is on its local `main`; pushing it is the user's call.
