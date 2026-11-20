# Pairing codes and the client connection — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Client pairing routes answer with stable outcome codes instead of agent-facing text, the SDK gives local programs their connection state and live tool catalog updates, and an empty catalog withdraws a client's tools.

**Architecture:** Pairing moves out of the MCP `switch` into `App.pairBegin/pairConfirm/pairCancel`, which return `{ ok, code, ... }`; the MCP tools and the client routes both word those outcomes (the MCP text unchanged). The SDK gains `ToolClient.publishTools` and a new `sdk/connection.mjs` (`createConnection`, `classify`, `mergeDevices`), ported from codie_game_buddy's `src/main/host.mjs`.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, no new dependencies.

**Spec:** `../codie-govee-buddy/docs/specs/2026-11-02-govee-buddy-design.md` §4 (this repo's `docs/specs/2026-10-26-codie-host-design.md` §6 is updated as built).

## Global Constraints

- English only in code, comments, tests and docs; kebab-case `.mjs` files; match the surrounding style (short comments that say why).
- `AGENTD_VERSION` 33 → 34 (IPC response shape changes).
- The MCP texts of `codie_pair_begin|confirm|cancel` do not change; existing `test/agentd/app.test.mjs` pairing tests pass unmodified.
- Client pairing responses keep `ok`, `toolsReady` and `message`; they only gain `code` and `deviceName`.
- `bin/codie-agentd.mjs` and `bin/codie.mjs` carry someone else's uncommitted change: never stage them. Stage files by name.
- Work on branch `feat/pairing-codes` (`git switch -c feat/pairing-codes` from `main`; the uncommitted `bin/` change comes along untouched).
- On Windows some tests may fail regardless of this work: Task 1 Step 1 records the baseline; compare against it, not against zero.

---

### Task 1: Pairing outcomes as codes in agentd

**Files:**
- Create: `src/agentd/pairing.mjs`
- Modify: `src/agentd/clt01.mjs` (`deviceAuth`), `src/agentd/app.mjs` (imports, `#clientCredential`, new pairing methods, the three `codie_pair_*` cases)
- Test: `test/agentd/app.test.mjs`, `test/agentd/clt01.test.mjs`

**Interfaces:**
- Produces: `PAIR` (frozen code table), `failureCode(e)`, `credentialFailureCode(e)` in `pairing.mjs`; on `App`: `pairBegin(deviceId)`, `pairConfirm(deviceId, code)`, `pairCancel(deviceId)` → `Promise<{ ok: boolean, code: string, deviceName?: string, reason?: string, stage?: 'credential' }>`, and `pairText(outcome, pairHint = this.pairHint) → string`.

- [ ] **Step 1: Branch and record the baseline**

```bash
git switch -c feat/pairing-codes
npm test 2>&1 | tail -20
```

Write down the failing test names, if any; later runs are compared against this list.

- [ ] **Step 2: Write the failing tests**

Append to `test/agentd/app.test.mjs`:

```js
test('pairing steps answer with codes; device codes pass through', async () => {
  const { app } = mkApp();
  assert.deepEqual(await app.pairBegin('d1'), { ok: false, code: 'DEVICE_NOT_SCANNED' });
  await app.scanDevices();
  assert.deepEqual(await app.pairConfirm('d1', '123456'), { ok: false, code: 'NO_PAIRING_IN_PROGRESS' });
  assert.deepEqual(await app.pairBegin('d1'), { ok: true, code: 'PAIR_STARTED', deviceName: 'Living room' });
  assert.deepEqual(await app.pairConfirm('d1', '123456'), { ok: true, code: 'PAIRED', deviceName: 'Living room' });
  assert.deepEqual(await app.pairCancel('d1'), { ok: true, code: 'CANCELLED' });
});

test('a failed pairing step says why as a code, and saves nothing', async () => {
  const codeErr = (msg, code) => Object.assign(new Error(msg), { code });
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const cases = [
    [{ pairConfirm: async () => { throw codeErr('Invalid pairing code', 'INVALID_CODE'); } }, 'INVALID_CODE', undefined],
    [{ pairConfirm: async () => { throw codeErr('Pairing code expired', 'PAIRING_CODE_EXPIRED'); } }, 'PAIRING_CODE_EXPIRED', undefined],
    [{ pairConfirm: async () => { throw refused; } }, 'DEVICE_UNREACHABLE', undefined],
    [{ pairConfirm: async () => { throw new Error('HTTP 500'); } }, 'PAIR_FAILED', undefined],
    [{ deviceAuth: async () => { throw codeErr('bootstrap: device not signed in (no user_id)', 'DEVICE_NOT_SIGNED_IN'); } }, 'DEVICE_NOT_SIGNED_IN', 'credential'],
    [{ issueClientCredential: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } }, 'CREDENTIAL_NOT_ISSUED', 'credential'],
    [{ issueClientCredential: async () => { throw refused; } }, 'DEVICE_UNREACHABLE', 'credential'],
  ];
  for (const [clt01, code, stage] of cases) {
    const { app, store } = mkApp({ clt01 });
    await app.scanDevices();
    await app.pairBegin('d1');
    const o = await app.pairConfirm('d1', '123456');
    assert.deepEqual([o.ok, o.code, o.stage], [false, code, stage], code);
    assert.equal(typeof o.reason, 'string');
    assert.deepEqual(store.listPairings(), []);
  }
  const { app } = mkApp({ clt01: { pairRequest: async () => { throw codeErr('slow down', 'PAIRING_REQUEST_RATE_LIMITED'); } } });
  await app.scanDevices();
  assert.deepEqual(await app.pairBegin('d1'), { ok: false, code: 'PAIRING_REQUEST_RATE_LIMITED', reason: 'slow down (PAIRING_REQUEST_RATE_LIMITED)' });
});
```

In `test/agentd/clt01.test.mjs`, add `import { isNetworkError } from '../../src/agentd/tools/device-client.mjs';` and append:

```js
test('deviceAuth marks a logged-out device and keeps why bootstrap failed', async () => {
  const f = await fakeClt01({ [BOOT]: { status: 200, body: { success: true, data: {} } } });
  try {
    await assert.rejects(deviceAuth('127.0.0.1', f.port, 'L'), { code: 'DEVICE_NOT_SIGNED_IN' });
  } finally { await new Promise(r => f.srv.close(r)); }
  // The closed port refuses (a low port like 1 is one fetch never dials).
  const e = await deviceAuth('127.0.0.1', f.port, 'L').catch(x => x);
  assert.match(e.message, /^bootstrap: /);
  assert.equal(isNetworkError(e.cause), true);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test --test-name-pattern="pairing step|deviceAuth marks" test/agentd/app.test.mjs test/agentd/clt01.test.mjs`
Expected: FAIL (`app.pairBegin is not a function`; no `code` on the bootstrap error).

- [ ] **Step 4: Create `src/agentd/pairing.mjs`**

```js
import { isNetworkError } from './tools/device-client.mjs';

// Pairing outcomes as stable codes (govee_buddy spec §4.1): what happened, for
// a program to put in its own words. Device business codes (INVALID_CODE,
// PAIRING_CODE_EXPIRED, ...) pass through unchanged; these are agentd's own.
export const PAIR = Object.freeze({
  STARTED: 'PAIR_STARTED',
  PAIRED: 'PAIRED',
  CANCELLED: 'CANCELLED',
  NOT_SCANNED: 'DEVICE_NOT_SCANNED',
  NO_PAIRING: 'NO_PAIRING_IN_PROGRESS',
  UNREACHABLE: 'DEVICE_UNREACHABLE',
  CREDENTIAL_NOT_ISSUED: 'CREDENTIAL_NOT_ISSUED',
  NOT_SIGNED_IN: 'DEVICE_NOT_SIGNED_IN',
  FAILED: 'PAIR_FAILED',
});

// deviceAuth wraps a failed bootstrap: the network error is its cause.
const unreachable = e => isNetworkError(e) || isNetworkError(e?.cause);

// A failed pair/request or pair/confirm: the device's own code when it sent one.
export function failureCode(e) {
  if (unreachable(e)) return PAIR.UNREACHABLE;
  return typeof e?.code === 'string' && e.code ? e.code : PAIR.FAILED;
}

// A failed client credential (bootstrap, then the credential route) after
// pair/confirm succeeded.
export function credentialFailureCode(e) {
  if (unreachable(e)) return PAIR.UNREACHABLE;
  return e?.code === PAIR.NOT_SIGNED_IN ? PAIR.NOT_SIGNED_IN : PAIR.CREDENTIAL_NOT_ISSUED;
}
```

- [ ] **Step 5: Give the bootstrap failures a code and a cause in `src/agentd/clt01.mjs`**

Replace the end of `deviceAuth`:

```js
  } catch (e) {
    throw new Error(`bootstrap: ${e?.message ?? e}`);
  }
  if (typeof userId !== 'string' || !userId) throw new Error('bootstrap: device not signed in (no user_id)');
```

with:

```js
  } catch (e) {
    throw new Error(`bootstrap: ${e?.message ?? e}`, { cause: e });
  }
  if (typeof userId !== 'string' || !userId) {
    throw Object.assign(new Error('bootstrap: device not signed in (no user_id)'), { code: 'DEVICE_NOT_SIGNED_IN' });
  }
```

- [ ] **Step 6: Pairing methods in `src/agentd/app.mjs`**

Add to the imports:

```js
import { PAIR, credentialFailureCode, failureCode } from './pairing.mjs';
```

Below `const errorText = e => \`Failed: ${errorReason(e)}\`;` add:

```js
const failed = e => ({ ok: false, code: failureCode(e), reason: errorReason(e) });
```

In `#clientCredential`, replace `return { error: errorReason(e) };` with:

```js
      return { error: errorReason(e), code: credentialFailureCode(e) };
```

Directly after `#clientCredential`, add:

```js
  // Pairing steps as outcomes { ok, code, deviceName?, reason?, stage? }
  // (pairing.mjs): device failures come back as codes, not exceptions.
  // `reason` is the English failure, for logs and the MCP text.
  async pairBegin(deviceId) {
    const d = this.lastScan.get(deviceId);
    if (!d) return { ok: false, code: PAIR.NOT_SCANNED };
    try {
      const { challengeId } = await this.clt01.pairRequest(d.host, d.port);
      this.challenges.set(d.deviceId, challengeId);
    } catch (e) {
      return failed(e);
    }
    return { ok: true, code: PAIR.STARTED, deviceName: d.name || d.deviceId };
  }

  async pairConfirm(deviceId, code) {
    const d = this.lastScan.get(deviceId);
    const challengeId = this.challenges.get(deviceId);
    if (!d || !challengeId) return { ok: false, code: PAIR.NO_PAIRING };
    let r;
    try {
      r = await this.clt01.pairConfirm(d.host, d.port, challengeId, String(code).trim());
    } catch (e) {
      return failed(e);
    }
    this.challenges.delete(d.deviceId);
    // Key by the mDNS-scanned id: clt01's r.deviceId may be ''. Without a
    // client credential the pairing could do nothing, so none is saved.
    const credential = await this.#clientCredential(d, r.localSecret);
    if (credential.error) return { ok: false, code: credential.code, reason: credential.error, stage: 'credential' };
    this.store.upsertPairing({ deviceId: d.deviceId, name: r.name || d.name, host: d.host, port: d.port, ...credential });
    // The device just paired is the one tools go to (toolDevice).
    this.store.updateSettings({ toolsDevice: d.deviceId });
    this.onPairingsChanged();
    return { ok: true, code: PAIR.PAIRED, deviceName: r.name || d.name || d.deviceId };
  }

  async pairCancel(deviceId) {
    const d = this.lastScan.get(deviceId);
    const challengeId = this.challenges.get(deviceId);
    if (d && challengeId) await this.clt01.pairCancel(d.host, d.port, challengeId);
    this.challenges.delete(deviceId);
    return { ok: true, code: PAIR.CANCELLED };
  }

  // A pairing outcome in words for an agent; programs word the code themselves.
  pairText(o, pairHint = this.pairHint) {
    switch (o.code) {
      case PAIR.NOT_SCANNED: return 'Scan with codie_list_devices first, then pick a device by device_id.';
      case PAIR.STARTED: return `Pairing requested. Read the 6-digit code on the screen of "${o.deviceName}" and tell me.`;
      case PAIR.NO_PAIRING: return 'No pairing in progress; call codie_pair_begin first.';
      case PAIR.PAIRED: return `Paired "${o.deviceName}".`;
      case PAIR.CANCELLED: return 'Pairing cancelled.';
      default:
        return o.stage === 'credential'
          ? `The device did not issue a client credential (${o.reason}); nothing saved (the existing pairing is unchanged). Update the Codie firmware, then retry ${pairHint}.`
          : `Failed: ${o.reason}`;
    }
  }
```

Replace the three cases `codie_pair_begin`, `codie_pair_confirm`, `codie_pair_cancel` in `#call` (from `case 'codie_pair_begin': {` up to the closing `}` of `codie_pair_cancel`) with:

```js
      case 'codie_pair_begin': {
        const o = await this.pairBegin(args.device_id);
        return text(this.pairText(o, pairHint), !o.ok);
      }

      case 'codie_pair_confirm': {
        const o = await this.pairConfirm(args.device_id, args.code);
        return text(this.pairText(o, pairHint), !o.ok);
      }

      case 'codie_pair_cancel': {
        const o = await this.pairCancel(args.device_id);
        return text(this.pairText(o, pairHint), !o.ok);
      }
```

- [ ] **Step 7: Run the new and the existing pairing tests**

Run: `node --test test/agentd/app.test.mjs test/agentd/clt01.test.mjs test/agentd/client-device-routes.test.mjs`
Expected: PASS, including the unchanged `pair begin + confirm persists record` and `pair tool errors include clt01 err.code when present` (the MCP texts are the same).

- [ ] **Step 8: Commit**

```bash
git add src/agentd/pairing.mjs src/agentd/clt01.mjs src/agentd/app.mjs test/agentd/app.test.mjs test/agentd/clt01.test.mjs
git commit -m "refactor: pairing steps return outcome codes; MCP texts unchanged"
```

---

### Task 2: Client pairing routes answer with codes

**Files:**
- Modify: `src/agentd/daemon/client-device-routes.mjs` (pair routes, drop `textOf`), `src/agentd/daemon/version.mjs`, `docs/specs/2026-10-26-codie-host-design.md` §6.4
- Test: `test/agentd/client-device-routes.test.mjs`

**Interfaces:**
- Consumes: `app.pairBegin/pairConfirm/pairCancel/pairText` (Task 1).
- Produces: `POST /clients/:id/pair/begin|cancel` → `{ ok, code, deviceName?, message }`; `POST /clients/:id/pair/confirm` → `{ ok, code, deviceName?, toolsReady, message }`. `AGENTD_VERSION = 34`.

- [ ] **Step 1: Write the failing tests**

In `test/agentd/client-device-routes.test.mjs`, test `a client with the pair permission scans and pairs a device`: after `assert.equal(begin.body.ok, true, begin.body.message);` add

```js
  assert.deepEqual([begin.body.code, begin.body.deviceName], ['PAIR_STARTED', 'Desk Codie']);
```

after the `wrong` assertion add

```js
  assert.equal(wrong.body.code, 'PAIRING_CODE_INVALID');
```

after `assert.equal(done.body.toolsReady, true, done.body.message);` add

```js
  assert.equal(done.body.code, 'PAIRED');
```

and replace the last line with

```js
  const cancel = await c.call('POST', '/pair/cancel', { device_id: 'NEW1' });
  assert.deepEqual([cancel.body.ok, cancel.body.code], [true, 'CANCELLED']);
```

In `a device that issues no client credential is not paired, and approves nothing`, after the `assert.deepEqual([done.body.ok, done.body.toolsReady], ...)` line add

```js
  assert.equal(done.body.code, 'CREDENTIAL_NOT_ISSUED');
```

Append a new test after it:

```js
test('pairing says what went wrong as a code a program can word', async t => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const { client } = await setup(t, {
    paired: false, clt01: { ...pairingClt01, pairRequest: async () => { throw refused; } },
    discover: async () => [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', port: 8081 }],
  });
  const c = await client('buddy', { pair: true });
  const unscanned = await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  assert.deepEqual([unscanned.status, unscanned.body.ok, unscanned.body.code], [200, false, 'DEVICE_NOT_SCANNED']);
  await c.call('GET', '/devices');
  const nothing = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '123456' });
  assert.deepEqual([nothing.body.ok, nothing.body.code, nothing.body.toolsReady], [false, 'NO_PAIRING_IN_PROGRESS', false]);
  const down = await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  assert.deepEqual([down.body.ok, down.body.code], [false, 'DEVICE_UNREACHABLE']);
  assert.match(down.body.message, /^Failed: fetch failed/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --test-name-pattern="pair" test/agentd/client-device-routes.test.mjs`
Expected: FAIL (`code` is undefined).

- [ ] **Step 3: Answer with the outcome in `src/agentd/daemon/client-device-routes.mjs`**

Delete `const textOf = r => r.content.map(c => c.text).join('\n');` and add in its place:

```js
// A pairing outcome as the client routes answer it (govee_buddy spec §4.1):
// `code` for the program to word itself; `message` the agent wording, for logs
// and for callers from before the codes.
const outcomeBody = (app, o, extra = {}) => ({
  ok: o.ok, code: o.code, ...(o.deviceName ? { deviceName: o.deviceName } : {}), ...extra, message: app.pairText(o),
});
```

Replace the begin route body with:

```js
    'POST /clients/:id/pair/begin': clientRoute(async (body, { client }) => {
      mayPair(client);
      return outcomeBody(app, await app.pairBegin(deviceIdOf(body)));
    }),
```

In the confirm route replace

```js
      const r = await app.callTool('codie_pair_confirm', { device_id: deviceId, code: body.code.trim() });
```

with

```js
      const o = await app.pairConfirm(deviceId, body.code.trim());
```

and replace everything from `const ok = !r.isError;` through `return { ok, toolsReady, message: textOf(r) };` with:

```js
      const toolsReady = Boolean(after) && after !== before && toolsAfter === deviceId;
      // The user read the code off the device and typed it into this client:
      // that approves the scope it asked for, as `codie clients approve` would.
      if ((o.ok || toolsReady) && client.status !== 'approved') {
        registry.approve(client.name);
        log(`[clients] ${client.name} approved by pairing ${deviceId}`);
      }
      if (!o.ok) log(`[clients] ${client.name} pairing ${deviceId} failed: ${o.code}`);
      return outcomeBody(app, o, { toolsReady });
```

Replace the cancel route body with:

```js
    'POST /clients/:id/pair/cancel': clientRoute(async (body, { client }) => {
      mayPair(client);
      return outcomeBody(app, await app.pairCancel(deviceIdOf(body)));
    }),
```

- [ ] **Step 4: Bump the version**

In `src/agentd/daemon/version.mjs`: `export const AGENTD_VERSION = 34;`

- [ ] **Step 5: Run the tests**

Run: `node --test test/agentd/client-device-routes.test.mjs test/agentd/agentd.test.mjs`
Expected: PASS.

- [ ] **Step 6: Record it in the design spec**

In `docs/specs/2026-10-26-codie-host-design.md` §6.4, at the end of the bullet that starts `**Built 2026-10-29 as client routes**`, append:

```markdown
 Since agentd 34 (2026-11-02) the pair routes answer `{ ok, code, deviceName?, toolsReady? (confirm), message }`: `code` is a stable outcome a program words itself (agentd's own `PAIR_STARTED`, `PAIRED`, `CANCELLED`, `DEVICE_NOT_SCANNED`, `NO_PAIRING_IN_PROGRESS`, `DEVICE_UNREACHABLE`, `CREDENTIAL_NOT_ISSUED`, `DEVICE_NOT_SIGNED_IN`, `PAIR_FAILED`, or the device's code unchanged, `src/agentd/pairing.mjs`); `message` stays the agent wording of the MCP tools.
```

- [ ] **Step 7: Commit**

```bash
git add src/agentd/daemon/client-device-routes.mjs src/agentd/daemon/version.mjs test/agentd/client-device-routes.test.mjs docs/specs/2026-10-26-codie-host-design.md
git commit -m "feat: client pairing routes answer with outcome codes; agentd 34"
```

---

### Task 3: Live catalog updates, and an empty catalog withdraws the tools

**Files:**
- Modify: `src/agentd/tools/clients.mjs` (`setTools`), `src/agentd/daemon/tool-hosting.mjs` (`PUT /clients/:id/tools` answer), `sdk/index.mjs` (`publishTools`), `docs/specs/2026-10-26-codie-host-design.md` §6.2
- Test: `test/agentd/tool-hosting.test.mjs`, `test/agentd/sdk.test.mjs`

**Interfaces:**
- Produces: `ToolClient#publishTools(tools: object[]) → Promise<void>` (an empty array withdraws); `PUT /clients/:id/tools` with `{ tools: [] }` → `200 { tools: [] }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/agentd/tool-hosting.test.mjs`:

```js
test('an empty catalog withdraws the tools until the next one', async t => {
  const { ipc, device } = await setup(t);
  const { id, token } = (await ipc('POST', '/clients', { name: 'echo-tool', scope: { tools: true } })).body;
  await ipc('POST', '/clients/approve', { name: 'echo-tool' });
  const iid = integrationId('DEV1', 'echo-tool');
  await ipc('PUT', `/clients/${id}/tools`, { tools }, token);
  await until(() => device.connected(iid));

  const empty = await ipc('PUT', `/clients/${id}/tools`, { tools: [] }, token);
  assert.deepEqual([empty.status, empty.body.tools], [200, []]);
  await until(() => !device.connected(iid));
  assert.equal((await ipc('GET', `/clients/${id}`, undefined, token)).body.online, false);

  await ipc('PUT', `/clients/${id}/tools`, { tools }, token);
  await until(() => device.connected(iid));
});
```

Append to `test/agentd/sdk.test.mjs`:

```js
test('publishTools waits for approval, then updates and withdraws a serving client\'s catalog', async t => {
  const { home, start } = await pairedHome(t);
  const a = await start();
  const sdk = new ToolClient({ name: 'echo-tool', scope: { tools: true }, home });
  const ac = new AbortController();
  const served = sdk.serve({}, { signal: ac.signal });
  t.after(async () => {
    ac.abort();
    await served;
    await sdk.close();
    await a.shutdown();
  });
  await until(() => sdk.status === 'pending');
  await sdk.publishTools(ECHO); // kept for serve(): not approved yet
  const published = async () => (await admin(a, 'GET', '/clients')).clients[0].tools;
  assert.deepEqual(await published(), []);

  await admin(a, 'POST', '/clients/approve', { name: 'echo-tool' });
  await until(async () => (await published()).length === 1, 15_000);
  await sdk.publishTools([{ ...ECHO[0], name: 'echo_again' }]);
  assert.deepEqual(await published(), ['echo_again']);
  await sdk.publishTools([]);
  assert.deepEqual(await published(), []);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --test-name-pattern="empty catalog|publishTools" test/agentd/tool-hosting.test.mjs test/agentd/sdk.test.mjs`
Expected: FAIL (`TOOL_CATALOG_INVALID` for `[]`; `sdk.publishTools is not a function`).

- [ ] **Step 3: Withdraw on an empty list in `src/agentd/tools/clients.mjs`**

In `setTools`, after the two permission checks and before `let tools;`, add:

```js
    // An empty list withdraws the tools: the device link closes, so clt01
    // stops declaring them; the integration stays for the next catalog.
    if (Array.isArray(rawTools) && rawTools.length === 0) {
      client.tools = null;
      this.relink(client, false);
      return;
    }
```

In `src/agentd/daemon/tool-hosting.mjs`, `PUT /clients/:id/tools`, replace `return { tools: client.tools.map(t => t.name) };` with:

```js
        return { tools: client.tools?.map(t => t.name) ?? [] };
```

- [ ] **Step 4: `publishTools` in `sdk/index.mjs`**

After `setTools(tools) { this.tools = tools; }` add:

```js
  // Replaces the catalog and publishes it now when registered and approved;
  // otherwise serve() publishes it once approved. An empty list withdraws the
  // tools. The caller versions its tools: the device refuses changed content
  // under a version it already has.
  async publishTools(tools) {
    this.tools = tools;
    if (this.id && this.status === 'approved') await this.#call('PUT', '/tools', { tools });
  }
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/agentd/tool-hosting.test.mjs test/agentd/sdk.test.mjs`
Expected: PASS.

- [ ] **Step 6: Record it in the design spec**

In `docs/specs/2026-10-26-codie-host-design.md` §6.2, after the bullet starting `When the client closes or its keep-alive lapses`, add:

```markdown
- **Catalog updates (2026-11-02).** `PUT /clients/:id/tools` may be sent again at any time (SDK `publishTools`); the client versions its tools, since clt01 refuses changed content under a published version. An empty list withdraws the tools: the daemon closes the client's device link, clt01 marks the integration offline, and the next non-empty catalog links again. The integration is not deleted.
```

- [ ] **Step 7: Commit**

```bash
git add src/agentd/tools/clients.mjs src/agentd/daemon/tool-hosting.mjs sdk/index.mjs test/agentd/tool-hosting.test.mjs test/agentd/sdk.test.mjs docs/specs/2026-10-26-codie-host-design.md
git commit -m "feat: clients republish their catalog live; an empty one withdraws the tools"
```

---

### Task 4: The client connection in the SDK

**Files:**
- Create: `sdk/connection.mjs`, `test/agentd/connection.test.mjs`
- Modify: `sdk/index.mjs` (re-export), `docs/specs/2026-10-26-codie-host-design.md` §6.1

**Interfaces:**
- Consumes: `ToolClient` (`connect`, `serve`, `status`, `devices`, `pairBegin/Confirm/Cancel`, `setTools`, `publishTools` from Task 3, `close`), `HostError`.
- Produces (exported from `codie-host`):
  - `classify(error) → 'offline' | 'pending' | 'not-paired' | 'blocked' | 'error'`
  - `mergeDevices({ found, paired }) → [{ deviceId, name, host, paired, found, online }]`
  - `createConnection({ name, scope, tools?, handlers?, log?, onState?, client?, watchMs?, serveRetryMs? })` → `{ state, client, start(signal), setTools(tools) → Promise<Error|null>, devices(), pairBegin(id), pairConfirm(id, code), pairCancel(id), noteReady(), noteError(e) → kind, close() }`; `state` is one of `'connecting' | 'pending' | 'not-paired' | 'ready' | 'offline'`.

- [ ] **Step 1: Write the failing tests**

Create `test/agentd/connection.test.mjs` (ported from codie_game_buddy `test/host.test.mjs`):

```js
// The client connection (sdk/connection.mjs) against a fake ToolClient.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError, classify, createConnection, mergeDevices } from '../../sdk/index.mjs';

const tick = () => new Promise(r => setTimeout(r, 15));

function fakeClient(over = {}) {
  return {
    status: 'approved',
    published: [],
    served: [],
    async connect() {},
    setTools(tools) { this.tools = tools; },
    async publishTools(tools) { this.published.push(tools); },
    serve(handlers) { this.served.push(handlers); return new Promise(() => {}); },
    async devices() { return { found: [], paired: [{ deviceId: 'D1', name: 'Codie', online: false }] }; },
    async pairConfirm() { return { ok: true, code: 'PAIRED', toolsReady: true }; },
    async close() {},
    ...over,
  };
}

async function started(t, client, opts = {}) {
  const ac = new AbortController();
  t.after(() => ac.abort());
  const states = [];
  const conn = createConnection({ client, onState: s => states.push(s), watchMs: 5, ...opts });
  await conn.start(ac.signal);
  return { conn, states };
}

test('errors are classified', () => {
  const he = (status, code) => new HostError(status, code, code);
  assert.equal(classify(he(409, 'DEVICE_BUSY')), 'blocked');
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
  const { conn, states } = await started(t, fakeClient());
  assert.equal(conn.state, 'ready');
  assert.deepEqual(states, ['ready']);
});

test('a pending client becomes ready once approved; no device means not-paired', async t => {
  const client = fakeClient({ status: 'pending', async devices() { return { found: [], paired: [] }; } });
  const { conn } = await started(t, client);
  assert.equal(conn.state, 'pending');
  client.status = 'approved';
  await tick();
  assert.equal(conn.state, 'not-paired');
});

test('the program\'s own call outcomes move the state; blocked and other errors do not', async t => {
  const { conn } = await started(t, fakeClient(), { watchMs: 1000 });
  assert.equal(conn.noteError(new HostError(409, 'DEVICE_BUSY', 'busy')), 'blocked');
  assert.equal(conn.noteError(new HostError(400, 'INVALID_ARGUMENT', 'x')), 'error');
  assert.equal(conn.state, 'ready');
  assert.equal(conn.noteError(new HostError(409, 'NOT_PAIRED', 'none')), 'not-paired');
  assert.equal(conn.state, 'not-paired');
  conn.noteReady();
  assert.equal(conn.state, 'ready');
});

test('an offline from a call stays offline across watcher ticks', async t => {
  const { conn } = await started(t, fakeClient());
  conn.noteError(new TypeError('fetch failed'));
  await tick();
  await tick();
  assert.equal(conn.state, 'offline'); // devices() still reports a pairing
});

test('a confirmed pairing makes the state ready', async t => {
  const { conn } = await started(t, fakeClient({ async devices() { return { found: [], paired: [] }; } }), { watchMs: 1000 });
  assert.equal(conn.state, 'not-paired');
  assert.equal((await conn.pairConfirm('D1', '123456')).toolsReady, true);
  assert.equal(conn.state, 'ready');
});

test('a failed start is offline, then recovers once the client registers and is approved', async t => {
  let serves = 0;
  const client = fakeClient({
    status: null,
    async connect() { throw new TypeError('fetch failed'); },
    serve() {
      serves += 1;
      if (serves === 1) return Promise.reject(new TypeError('fetch failed'));
      client.status = 'pending';
      setTimeout(() => { client.status = 'approved'; }, 20);
      return new Promise(() => {});
    },
  });
  const { conn } = await started(t, client, { serveRetryMs: 5 });
  assert.equal(conn.state, 'offline');
  await tick();
  assert.equal(serves, 2); // the rejected serve() was retried
  await tick();
  await tick();
  assert.equal(conn.state, 'ready');
});

test('close stops the watcher', async t => {
  let calls = 0;
  const client = fakeClient({ status: 'pending', async devices() { calls += 1; return { found: [], paired: [{ deviceId: 'D1' }] }; } });
  const { conn } = await started(t, client);
  client.status = 'approved';
  await tick();
  assert.equal(calls, 1); // the watcher is alive before close
  await conn.close();
  client.status = 'pending';
  await tick();
  client.status = 'approved';
  await tick();
  assert.equal(calls, 1);
});

test('serve() answers with the handlers; setTools publishes and returns a failure instead of throwing', async t => {
  const handlers = { light_status: async () => ({}) };
  const client = fakeClient();
  const { conn } = await started(t, client, { tools: [{ name: 'a' }], handlers, watchMs: 1000 });
  assert.deepEqual(client.tools, [{ name: 'a' }]);
  assert.equal(client.served[0], handlers);
  assert.equal(await conn.setTools([{ name: 'b' }]), null);
  assert.deepEqual(client.published, [[{ name: 'b' }]]);
  client.publishTools = async () => { throw new HostError(400, 'TOOL_CATALOG_INVALID', 'bad'); };
  assert.equal((await conn.setTools([])).code, 'TOOL_CATALOG_INVALID');
  assert.equal(conn.state, 'ready');
});

test('devices lists every device found, then the paired ones the scan missed', async t => {
  assert.deepEqual(mergeDevices({
    found: [
      { deviceId: 'A', name: 'Desk', host: '10.0.0.2', paired: true, online: true },
      { deviceId: 'B', name: '', host: '10.0.0.3', paired: false, online: false },
    ],
    paired: [{ deviceId: 'A', name: 'Desk', online: true }, { deviceId: 'C', name: 'Kitchen', online: false }],
  }), [
    { deviceId: 'A', name: 'Desk', host: '10.0.0.2', paired: true, found: true, online: true },
    { deviceId: 'B', name: 'B', host: '10.0.0.3', paired: false, found: true, online: false },
    { deviceId: 'C', name: 'Kitchen', host: '', paired: true, found: false, online: false },
  ]);
  const { conn } = await started(t, fakeClient(), { watchMs: 1000 });
  assert.deepEqual(await conn.devices(), [{ deviceId: 'D1', name: 'Codie', host: '', paired: true, found: false, online: false }]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agentd/connection.test.mjs`
Expected: FAIL (`createConnection` is not exported).

- [ ] **Step 3: Create `sdk/connection.mjs`**

```js
import { HostError, ToolClient } from './index.mjs';

// A local program's link to codie-agentd as one state (govee_buddy spec §4.2):
// the registration kept alive, approval followed, pairing, and its tools.
// Ported from codie_game_buddy's host.mjs.

const WATCH_MS = 2000; // approval shows in client.status, which serve() refreshes
const SERVE_RETRY_MS = 5000; // delay before serve() is started again after it fails

// The device would not take the request now (busy in a conversation, screen
// off, ambient mode).
const BLOCKED = new Set(['DEVICE_BUSY', 'DEVICE_BLOCKED', 'AMBIENT_MODE_BLOCKED']);

// What a failed call means for the program's state.
export function classify(error) {
  if (!(error instanceof HostError)) return 'offline'; // codie-agentd did not answer
  if (BLOCKED.has(error.code)) return 'blocked';
  switch (error.code) {
    case 'APPROVAL_PENDING': return 'pending';
    case 'NOT_PAIRED':
    case 'REPAIR_REQUIRED': return 'not-paired';
    case 'DEVICE_OFFLINE': return 'offline';
    default: return 'error';
  }
}

// The LAN scan and the pairings as one list: every device found, then the
// paired ones the scan missed.
export function mergeDevices({ found = [], paired = [] }) {
  const pairedIds = new Set(paired.map(d => d.deviceId));
  const foundIds = new Set(found.map(d => d.deviceId));
  return [
    ...found.map(d => ({
      deviceId: d.deviceId, name: d.name || d.deviceId, host: d.host, paired: pairedIds.has(d.deviceId), found: true, online: Boolean(d.online),
    })),
    ...paired.filter(d => !foundIds.has(d.deviceId)).map(d => ({
      deviceId: d.deviceId, name: d.name || d.deviceId, host: '', paired: true, found: false, online: Boolean(d.online),
    })),
  ];
}

export function createConnection({
  name, scope, tools = null, handlers = {}, log = () => {}, onState = () => {},
  client = new ToolClient({ name, scope, log }), watchMs = WATCH_MS, serveRetryMs = SERVE_RETRY_MS,
}) {
  if (tools) client.setTools(tools);
  let state = 'connecting';
  let checking = false;
  let seenStatus; // client.status as of the last refresh
  let watch = null;
  const stop = new AbortController();

  const set = next => {
    if (next === state) return;
    state = next;
    onState(next);
  };
  // Blocked requests and other one-off errors leave the state as it is.
  const noteError = e => {
    const kind = classify(e);
    if (kind !== 'blocked' && kind !== 'error') set(kind);
    return kind;
  };

  async function refresh() {
    if (checking) return;
    checking = true;
    seenStatus = client.status;
    try {
      if (client.status == null) { set('offline'); return; } // never registered
      if (client.status !== 'approved') { set('pending'); return; }
      const { paired } = await client.devices();
      set(paired.length ? 'ready' : 'not-paired');
    } catch (e) {
      noteError(e);
    } finally {
      checking = false;
    }
  }

  // serve() keeps the registration alive and answers tool calls; start it
  // again whenever it fails.
  async function keepServing() {
    while (!stop.signal.aborted) {
      try {
        await client.serve(handlers, { signal: stop.signal });
        return;
      } catch (e) {
        log(`codie-host: ${e?.message ?? e}`);
        await new Promise(resolve => {
          const timer = setTimeout(resolve, serveRetryMs);
          stop.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    }
  }

  const close = async () => {
    stop.abort();
    clearInterval(watch);
    await client.close();
  };

  return {
    get state() { return state; },
    client,

    // Never rejects: a daemon that is not there yet shows as offline.
    async start(signal) {
      try {
        await client.connect();
      } catch (e) {
        noteError(e);
      }
      keepServing();
      await refresh();
      // Call outcomes and pairConfirm decide the other state changes; the
      // watcher only follows registration and approval.
      watch = setInterval(() => {
        if (client.status !== seenStatus) refresh();
      }, watchMs);
      signal.addEventListener('abort', () => { stop.abort(); clearInterval(watch); }, { once: true });
    },

    // null once published or kept for serve(); the error when the publish
    // failed (serve() publishes the kept catalog after a reconnect).
    async setTools(next) {
      try {
        await client.publishTools(next);
        return null;
      } catch (e) {
        noteError(e);
        log(`codie-host: tools not published: ${e?.message ?? e}`);
        return e;
      }
    },

    devices: async () => mergeDevices(await client.devices()),
    pairBegin: id => client.pairBegin(id),
    async pairConfirm(id, code) {
      const r = await client.pairConfirm(id, code);
      if (r.toolsReady) set('ready');
      return r;
    },
    pairCancel: id => client.pairCancel(id),
    noteReady: () => set('ready'),
    noteError,
    close,
  };
}
```

At the end of `sdk/index.mjs` add:

```js
export { classify, createConnection, mergeDevices } from './connection.mjs';
```

(`connection.mjs` imports `HostError` and `ToolClient` back from `index.mjs`; it uses them only inside functions, so the cycle is safe.)

- [ ] **Step 4: Run the tests**

Run: `node --test test/agentd/connection.test.mjs test/agentd/sdk.test.mjs`
Expected: PASS.

- [ ] **Step 5: Record it in the design spec**

In `docs/specs/2026-10-26-codie-host-design.md` §6.1, append a bullet:

```markdown
- **SDK connection (2026-11-02).** `createConnection` (`sdk/connection.mjs`) keeps a program's registration alive and serves its tools, follows approval, and reports one state (`connecting`, `pending`, `not-paired`, `ready`, `offline`); `classify` maps IPC errors to it, `noteReady` / `noteError` feed in the program's own calls, `devices()` merges the scan with the pairings, and pairing passes through. codie_game_buddy and govee_buddy build on it.
```

- [ ] **Step 6: Full suite against the baseline**

Run: `npm test 2>&1 | tail -20`
Expected: no failures beyond the Task 1 Step 1 baseline.

- [ ] **Step 7: Commit**

```bash
git add sdk/connection.mjs sdk/index.mjs test/agentd/connection.test.mjs docs/specs/2026-10-26-codie-host-design.md
git commit -m "feat: SDK connection state for local programs"
```
