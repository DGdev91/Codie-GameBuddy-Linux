# game_buddy on the codie-host connection — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** game_buddy uses codie-host's `createConnection` for registration, approval and state, and its settings page words pairing outcomes from codie-host's result codes, in English and Simplified Chinese, instead of showing the daemon's agent-facing English text.

**Architecture:** `src/main/host.mjs` shrinks to `createConnection` plus its chat turns. A new `src/shared/pair-text.mjs` turns a pairing answer (`{ ok, code, deviceName? }` or `{ error, code }`) into words through the UI translator; the renderer uses it for scan, begin and confirm. The device list comes merged from the SDK.

**Tech Stack:** Electron 44, Node ≥ 20 ESM, `node:test`, Playwright for the settings window.

**Spec:** `../codie-govee-buddy/docs/specs/2026-11-02-govee-buddy-design.md` §5 (codie_host side: `../codie_host/docs/plans/2026-11-02-pairing-codes-and-connection.md`, branch `feat/pairing-codes`, agentd 34).

## Global Constraints

- English only in code, comments and tests; UI text in `src/locales/en.json` and `src/locales/zh-CN.json`, same keys and placeholders in both (`test/i18n.test.mjs`).
- Uncommitted work in progress (OCR, game info) lives in `README.md`, `docs/specs/2026-10-29-game-buddy-design.md`, `package.json`, `package-lock.json`, `src/main/{commentary,main,prompt}.mjs`, `test/{commentary,prompt}.test.mjs` and untracked files. Never stage those, except the one spec hunk of Task 2, staged through `git apply --cached`.
- Branch `feat/codie-host-connection` from `master`; the work in progress comes along untouched.
- `../codie_host` must be on `feat/pairing-codes` (it is: `file:` dependency, read from the working tree).
- `createHost`'s returned shape stays (`state`, `start`, `chatTurn`, `devices`, `pairBegin`, `pairConfirm`, `pairCancel`, `close`), so `main.mjs` and `commentary.mjs` do not change; `devices()` now returns the merged list.

---

### Task 1: host.mjs on createConnection

**Files:**
- Modify: `src/main/host.mjs`
- Test: `test/host.test.mjs`, `test/host-integration.test.mjs`

**Interfaces:**
- Consumes: `createConnection`, `classify` from `codie-host`.
- Produces: `createHost({ log, onState, client, watchMs, serveRetryMs })` as today; `devices()` → `[{ deviceId, name, host, paired, found, online }]`; `classify` re-exported.

- [ ] **Step 1: Branch and baseline**

```bash
git switch -c feat/codie-host-connection
npm test 2>&1 | grep -E "^✖ |^ℹ (tests|pass|fail)"
```

- [ ] **Step 2: Write the failing tests**

In `test/host.test.mjs`, append:

```js
test('devices come merged from codie-host', async t => {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const client = fakeClient({ async devices() {
    return { found: [{ deviceId: 'D2', name: 'Desk', host: '10.0.0.2', online: true }], paired: [{ deviceId: 'D1', name: 'Codie', online: false }] };
  } });
  const host = createHost({ client, watchMs: 1000 });
  await host.start(ac.signal);
  assert.deepEqual(await host.devices(), [
    { deviceId: 'D2', name: 'Desk', host: '10.0.0.2', paired: false, found: true, online: true },
    { deviceId: 'D1', name: 'Codie', host: '', paired: true, found: false, online: false },
  ]);
});
```

In `test/host-integration.test.mjs`, after `await until(() => host.state === 'ready');` add:

```js
  assert.deepEqual(await host.devices(), [{ deviceId: 'DEV1', name: 'Codie', host: '', paired: true, found: false, online: true }]);
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test test/host.test.mjs test/host-integration.test.mjs`
Expected: FAIL (`devices()` returns `{ found, paired }`).

- [ ] **Step 4: Replace `src/main/host.mjs`**

```js
import { createConnection } from 'codie-host';

// game_buddy's link to codie-host (spec §6): codie-host's connection
// (registration, approval, state, pairing) plus the chat turns of commentary.

export { classify } from 'codie-host';

export const CLIENT_NAME = 'game-buddy';
export const SCOPE = Object.freeze({ tools: true, pair: true, api: Object.freeze(['/v1/api/data/user/chat/turns']) });

// A turn the device would not take now (busy in a conversation, screen off,
// ambient mode) that failed when it was to start.
const BLOCKED = new Set(['DEVICE_BUSY', 'DEVICE_BLOCKED', 'AMBIENT_MODE_BLOCKED']);

export function createHost({ log = () => {}, onState = () => {}, client, watchMs, serveRetryMs } = {}) {
  // No tools until phase 3: serve() only keeps the registration alive.
  const conn = createConnection({ name: CLIENT_NAME, scope: SCOPE, log, onState, client, watchMs, serveRetryMs });

  return {
    get state() { return conn.state; },
    start: signal => conn.start(signal),

    // `interrupt: false`: a device busy in a conversation fails the turn (DEVICE_BUSY).
    async chatTurn({ image, text, speech = 'device', interrupt = true } = {}) {
      try {
        const turn = await conn.client.chatTurn({ image, text, speech, interrupt });
        if (turn.state === 'failed' || turn.state === 'cancelled') {
          return { ok: false, kind: BLOCKED.has(turn.error?.code) ? 'blocked' : 'error', turn, error: turn.error };
        }
        conn.noteReady();
        return { ok: true, turn };
      } catch (error) {
        return { ok: false, kind: conn.noteError(error), error };
      }
    },

    devices: () => conn.devices(),
    pairBegin: id => conn.pairBegin(id),
    pairConfirm: (id, code) => conn.pairConfirm(id, code),
    pairCancel: id => conn.pairCancel(id),
    close: () => conn.close(),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/host.test.mjs test/host-integration.test.mjs`
Expected: PASS, all existing host tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/main/host.mjs test/host.test.mjs test/host-integration.test.mjs docs/plans/2026-11-02-codie-host-connection.md
git commit -m "refactor: host builds on codie-host's connection"
```

---

### Task 2: Pairing outcomes in the user's language

**Files:**
- Create: `src/shared/pair-text.mjs`, `test/pair-text.test.mjs`
- Modify: `src/renderer/settings.mjs` (`scan`, `begin`, `confirm`), `src/locales/en.json`, `src/locales/zh-CN.json`, `e2e/settings.spec.mjs`, `docs/specs/2026-10-29-game-buddy-design.md` §6 (one hunk, staged alone)

**Interfaces:**
- Consumes: pairing answers `{ ok, code, deviceName?, toolsReady? }` (codie-host agentd 34) and the settings IPC's `{ error, code }` for failed calls; `PAIR` from `codie-host/agentd/pairing.mjs` (tests only).
- Produces: `pairText(t, answer) → string`.

- [ ] **Step 1: Write the failing tests**

Create `test/pair-text.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { PAIR } from 'codie-host/agentd/pairing.mjs';
import { translatorFor } from '../src/main/i18n.mjs';
import { pairText } from '../src/shared/pair-text.mjs';

// agentd's own codes and the device codes it passes through (clt01 user_config_gin.go).
const CODES = [...Object.values(PAIR), 'INVALID_CODE', 'PAIRING_CODE_EXPIRED', 'PAIRING_CODE_USED', 'PAIRING_SOURCE_MISMATCH',
  'PAIRING_REQUEST_RATE_LIMITED', 'PAIRING_SOURCE_NOT_ALLOWED', 'PAIRING_SESSION_CREATE_FAILED', 'LOCAL_SECRET_INIT_FAILED'];

test('every pairing code codie-host answers has words in both languages', () => {
  for (const locale of ['en', 'zh-CN']) {
    const t = translatorFor(locale);
    for (const code of CODES) {
      const said = pairText(t, { ok: false, code, deviceName: 'Desk' });
      assert.notEqual(said, t('pair.result.unknown', { code }), `${locale} ${code}`);
      assert.doesNotMatch(said, /pair\.result|\{name\}/, `${locale} ${code}`);
    }
  }
});

test('the device name goes in; an unknown code or a failed call names what happened', () => {
  const t = translatorFor('en');
  assert.match(pairText(t, { ok: true, code: 'PAIR_STARTED', deviceName: 'Desk' }), /Desk/);
  assert.match(pairText(t, { ok: true, code: 'PAIRED', deviceName: 'Desk' }), /Desk/);
  assert.equal(pairText(t, { ok: false, code: 'NEW_DEVICE_CODE' }), t('pair.result.unknown', { code: 'NEW_DEVICE_CODE' }));
  assert.equal(pairText(t, { error: 'fetch failed', code: '' }), t('pair.result.unknown', { code: 'fetch failed' }));
});
```

In `e2e/settings.spec.mjs`, append:

```js
test('pairing answers are worded from their codes in the UI language', async () => {
  const app = await launch('zh-CN');
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#cooldown')).toHaveValue('60');
    // No device on the test network: answer the settings IPC as codie-host would.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('devices:list');
      ipcMain.handle('devices:list', () => [{ deviceId: 'D1', name: 'Desk', host: '10.0.0.2', paired: false, found: true, online: false }]);
      ipcMain.removeHandler('pair:begin');
      ipcMain.handle('pair:begin', () => ({ ok: false, code: 'DEVICE_UNREACHABLE', message: 'Failed: fetch failed' }));
    });
    await page.locator('#scan').click();
    await page.locator('#devices li button').click();
    await expect(page.locator('#pair-status')).toHaveText('Codie 没有响应。请确认它已开机，并和这台电脑连着同一个网络。');
  } finally {
    await closeApp(app);
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/pair-text.test.mjs`
Expected: FAIL (module `src/shared/pair-text.mjs` not found).

- [ ] **Step 3: Create `src/shared/pair-text.mjs`**

```js
// Shared by the settings page and its tests: a pairing answer in the UI
// language. codie-host answers with a result code (govee_buddy spec §4.1);
// a failed call comes back from the settings IPC as { error, code }.
export function pairText(t, answer) {
  const key = `pair.result.${answer.code}`;
  const said = t(key, { name: answer.deviceName ?? '' });
  return said === key ? t('pair.result.unknown', { code: answer.code || answer.error || '' }) : said;
}
```

- [ ] **Step 4: Add the texts**

In `src/locales/en.json`, after `"device.ready": "{message} Codie is ready."` (add a comma to that line), add:

```json
  "pair.code-format": "Enter the 6 digits shown on the device screen.",
  "pair.result.PAIR_STARTED": "Type the 6-digit code shown on {name}.",
  "pair.result.PAIRED": "Paired with {name}.",
  "pair.result.CANCELLED": "Pairing cancelled.",
  "pair.result.DEVICE_NOT_SCANNED": "Scan again, then pick the device.",
  "pair.result.NO_PAIRING_IN_PROGRESS": "This pairing has ended. Press Pair again.",
  "pair.result.DEVICE_UNREACHABLE": "Codie did not answer. Check that it is on and on the same network as this computer.",
  "pair.result.CREDENTIAL_NOT_ISSUED": "This Codie's firmware is too old to pair. Update it, then pair again.",
  "pair.result.DEVICE_NOT_SIGNED_IN": "This Codie is not signed in to an account. Sign in on the device, then pair again.",
  "pair.result.INVALID_CODE": "Wrong code. Check the code on the device screen.",
  "pair.result.PAIRING_CODE_EXPIRED": "The code has expired. Press Pair to get a new one.",
  "pair.result.PAIRING_CODE_USED": "This code was already used. Press Pair to get a new one.",
  "pair.result.PAIRING_SOURCE_MISMATCH": "The code was requested from another computer. Press Pair again here.",
  "pair.result.PAIRING_REQUEST_RATE_LIMITED": "Too many pairing attempts. Wait a minute, then try again.",
  "pair.result.PAIRING_SOURCE_NOT_ALLOWED": "Codie refused pairing from this computer.",
  "pair.result.PAIRING_SESSION_CREATE_FAILED": "Pairing failed on the device. Try again.",
  "pair.result.LOCAL_SECRET_INIT_FAILED": "Pairing failed on the device. Try again.",
  "pair.result.PAIR_FAILED": "Pairing failed. Try again.",
  "pair.result.unknown": "Pairing failed ({code})."
```

In `src/locales/zh-CN.json`, after `"device.ready": "{message} Codie 已就绪。"` (add a comma to that line), add:

```json
  "pair.code-format": "请输入设备屏幕上显示的 6 位数字。",
  "pair.result.PAIR_STARTED": "请输入 {name} 屏幕上显示的 6 位配对码。",
  "pair.result.PAIRED": "已和 {name} 配对。",
  "pair.result.CANCELLED": "已取消配对。",
  "pair.result.DEVICE_NOT_SCANNED": "请重新搜索，再选择设备。",
  "pair.result.NO_PAIRING_IN_PROGRESS": "这次配对已经结束，请重新点“配对”。",
  "pair.result.DEVICE_UNREACHABLE": "Codie 没有响应。请确认它已开机，并和这台电脑连着同一个网络。",
  "pair.result.CREDENTIAL_NOT_ISSUED": "这台 Codie 的固件太旧，无法配对。请先升级固件，再配对。",
  "pair.result.DEVICE_NOT_SIGNED_IN": "这台 Codie 还没有登录账号。请先在设备上登录，再配对。",
  "pair.result.INVALID_CODE": "配对码不对，请核对设备屏幕上的配对码。",
  "pair.result.PAIRING_CODE_EXPIRED": "配对码已过期，请点“配对”重新获取。",
  "pair.result.PAIRING_CODE_USED": "这个配对码已经用过了，请点“配对”重新获取。",
  "pair.result.PAIRING_SOURCE_MISMATCH": "这个配对码是另一台电脑申请的，请在这里重新点“配对”。",
  "pair.result.PAIRING_REQUEST_RATE_LIMITED": "配对请求太频繁，请等一分钟再试。",
  "pair.result.PAIRING_SOURCE_NOT_ALLOWED": "Codie 拒绝了这台电脑的配对请求。",
  "pair.result.PAIRING_SESSION_CREATE_FAILED": "设备上配对失败，请重试。",
  "pair.result.LOCAL_SECRET_INIT_FAILED": "设备上配对失败，请重试。",
  "pair.result.PAIR_FAILED": "配对失败，请重试。",
  "pair.result.unknown": "配对失败（{code}）。"
```

- [ ] **Step 5: Use it in `src/renderer/settings.mjs`**

Add to the imports:

```js
import { pairText } from '../shared/pair-text.mjs';
```

Replace `scan`, `begin` and `confirm` with:

```js
// The device list comes merged from codie-host: found devices first, then
// paired ones the scan missed.
async function scan() {
  text($('pair-status'), t('device.scanning'));
  const r = await api.listDevices();
  if (r.error) { text($('pair-status'), pairText(t, r)); return; }
  $('devices').replaceChildren(...r.map(d => (d.found
    ? li(`${d.name} (${d.host})${d.paired ? t('device.paired') : ''}`, button(t('device.pair'), () => begin(d.deviceId)))
    : li(`${d.name}${t('device.paired-missing')}`))));
  text($('pair-status'), r.length ? '' : t('device.none'));
}

async function begin(id) {
  const r = await api.pairBegin(id);
  text($('pair-status'), pairText(t, r));
  if (r.ok) { pairingId = id; $('pairing').hidden = false; $('code').value = ''; $('code').focus(); }
}

async function confirm() {
  const code = $('code').value.trim();
  if (!/^\d{6}$/.test(code)) { text($('pair-status'), t('pair.code-format')); return; }
  text($('pair-status'), t('device.pairing'));
  const r = await api.pairConfirm(pairingId, code);
  const said = pairText(t, r);
  text($('pair-status'), r.toolsReady ? t('device.ready', { message: said }) : said);
  if (r.ok || r.toolsReady) { pairingId = null; $('pairing').hidden = true; }
}
```

- [ ] **Step 6: Run the tests**

```bash
npm test 2>&1 | grep -E "^✖ |^ℹ (tests|pass|fail)"
npx playwright test 2>&1 | tail -15
```

Expected: unit tests as the Task 1 baseline plus the new ones passing; all E2E tests pass.

- [ ] **Step 7: Record it in the design spec, staging only this hunk**

The spec file has uncommitted work in progress elsewhere. Make the change on a copy of the committed version, stage that diff alone, then apply it to the working file:

```bash
F=docs/specs/2026-10-29-game-buddy-design.md
git show HEAD:$F > "$TEMP/spec-head.md"
cp "$TEMP/spec-head.md" "$TEMP/spec-new.md"
```

In `$TEMP/spec-new.md`, after the line starting `game_buddy's scope:` in §6, add a blank line and:

```markdown
Since codie_host agentd 34 (2026-11-02, govee_buddy spec §4): `src/main/host.mjs` builds on the SDK's `createConnection` (registration, approval watch, state, pairing) and keeps only the chat turns; the settings page words pairing outcomes from their result codes (`pair.result.<CODE>`, `src/shared/pair-text.mjs`) instead of showing the daemon's message, and lists the SDK's merged device list.
```

Then:

```bash
(cd "$TEMP" && diff -u spec-head.md spec-new.md) | sed "1s|.*|--- a/$F|;2s|.*|+++ b/$F|" > "$TEMP/spec.patch"
git apply --cached "$TEMP/spec.patch"
git apply "$TEMP/spec.patch"
git diff --cached --stat   # only the spec, one hunk
```

- [ ] **Step 8: Commit**

```bash
git add src/shared/pair-text.mjs test/pair-text.test.mjs src/renderer/settings.mjs src/locales/en.json src/locales/zh-CN.json e2e/settings.spec.mjs
git commit -m "feat: settings words pairing outcomes from codie-host's result codes"
```
