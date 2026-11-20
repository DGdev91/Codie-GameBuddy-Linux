# Client device routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a local tool client (first: codie_game_buddy) call the device API within its scope, run an image + text chat turn on the device, and scan / pair devices, all through codie-agentd IPC and the JS SDK.

**Architecture:** New client routes under `/clients/:id/...` (the only routes a client token reaches, `ipc.mjs`). They sign device calls with the pairing's client credential (`DeviceClient.forPairing`) on the device tool hosting already uses (`toolDevice`). Chat turns post multipart to clt01 `/v1/api/data/user/chat/turns` and poll the turn. Pairing reuses `AgentApp`'s pairing tools. A new scope flag `pair` gates pairing.

**Tech Stack:** Node ≥ 20 ESM (`.mjs`), `node:test`, global `fetch` / `FormData` / `Blob`, `ws` (existing). No new dependencies.

**Spec:** `codie_game_buddy/docs/specs/2026-10-29-game-buddy-design.md` §6 (workspace path `D:\Devs\CodieWorkShop\codie_game_buddy\...`), which builds codie-host spec `docs/specs/2026-10-26-codie-host-design.md` §6.1 and §6.4.

## Global Constraints

- English only in code, comments, tests and docs; kebab-case file names; two-space indentation; semicolons; follow neighbouring files.
- No new npm dependencies.
- Images: JPEG or PNG only, ≤ 1 MiB (1048576 bytes) decoded; larger → `413 IMAGE_TOO_LARGE`. The daemon does not re-encode (the client compresses; the device scales to its maximum edge itself).
- `/v1/api/admin/`, `/v1/api/auth/`, `/v1/api/data/user/tool-integrations` are never reachable through a client (existing `FORBIDDEN` in `scope.mjs`).
- Error bodies keep the existing IPC shape `{ error, code }` (`HttpError` in `ipc.mjs`).
- Bump `AGENTD_VERSION` (agentd behaviour and IPC change, `src/agentd/daemon/version.mjs`).
- Baseline on Windows before this plan: `npm test` → 395 tests, 384 pass, 9 fail (POSIX-only: `hooks/stop … most recently active`, `ancestorPids …`, `belongsToSession`, four `codexRpc …`, `ensure.test.mjs`, `slug and dir follow Claude Code layout`). Those 9 may still fail; any other failure is yours.

## File map

| File | Change |
|---|---|
| `src/agentd/tools/scope.mjs` | `pair` flag |
| `src/agentd/daemon/ipc.mjs` | per-route `maxBytes` |
| `src/agentd/tools/sign.mjs` | multipart signing |
| `src/agentd/tools/device-client.mjs` | `postForm` |
| `src/agentd/tools/chat-turns.mjs` | **new**: request validation, multipart turn, polling |
| `src/agentd/daemon/client-device-routes.mjs` | **new**: `/clients/:id/{api,chat-turns,devices,pair/*}` |
| `src/agentd/app.mjs` | `scanDevices()` shared by `codie_list_devices` and the routes |
| `src/agentd/daemon/agentd-core.mjs` | mount the new routes |
| `src/agentd/daemon/version.mjs` | 27 → 28 |
| `sdk/index.mjs` | `api`, `chatTurn`, `devices`, `pairBegin`, `pairConfirm`, `pairCancel` |
| `test/agentd/helpers/fake-device.mjs` | chat turns, a readable `character` route |
| `test/agentd/tools.test.mjs`, `ipc.test.mjs` | new cases |
| `test/agentd/chat-turns.test.mjs`, `client-device-routes.test.mjs`, `sdk.test.mjs` | **new** |
| `docs/specs/2026-10-26-codie-host-design.md` | §6.1, §6.4, §9 match what was built |

---

### Task 1: `pair` scope flag

**Files:**
- Modify: `src/agentd/tools/scope.mjs`
- Test: `test/agentd/tools.test.mjs`

**Interfaces:**
- Produces: `normalizeScope(raw) → { tools: boolean, pair: boolean, api: string[] }`; `scopeCovers(granted, wanted)` also compares `pair`. Approved scopes stored before this change have no `pair` key and count as `pair: false`.

- [ ] **Step 1: Write the failing test** — in `test/agentd/tools.test.mjs`, change the last assertion of `'scope rejects admin, auth and tool-integration paths'` to:

```js
  assert.deepEqual(normalizeScope(undefined), { tools: false, pair: false, api: [] });
```

and add after `'scope coverage and path checks'`:

```js
test('pairing is its own permission', () => {
  assert.equal(normalizeScope({ pair: true }).pair, true);
  assert.equal(normalizeScope({ pair: 'yes' }).pair, false);
  const toolsOnly = normalizeScope({ tools: true });
  assert.ok(!scopeCovers(toolsOnly, normalizeScope({ tools: true, pair: true })));
  assert.ok(scopeCovers(normalizeScope({ tools: true, pair: true }), toolsOnly));
  // An approval stored before the flag existed has no pair key.
  assert.ok(!scopeCovers({ tools: true, api: [] }, normalizeScope({ pair: true })));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentd/tools.test.mjs`
Expected: FAIL — `normalizeScope(undefined)` lacks `pair`; `pairing is its own permission` fails.

- [ ] **Step 3: Implement** — in `src/agentd/tools/scope.mjs`:

```js
// A client's scope (spec §6.1): { tools: boolean, pair: boolean, api: string[] }.
// api lists device API path prefixes under /v1/api/; /admin/ and /auth/
// are never grantable, and tool-integrations belong to the daemon. pair lets
// the client scan for and pair devices.
```

```js
export function normalizeScope(raw) {
  if (raw === undefined || raw === null) return { tools: false, pair: false, api: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scope must be an object');
  const tools = raw.tools === true;
  const pair = raw.pair === true;
  const api = raw.api ?? [];
  if (!Array.isArray(api) || api.some(p => typeof p !== 'string')) throw new Error('scope.api must be a list of path prefixes');
  for (const p of api) {
    if (!p.startsWith('/v1/api/') || p.includes('..')) throw new Error(`scope.api: ${p} is not a /v1/api/ path`);
    if (FORBIDDEN.some(f => p.startsWith(f) || f.startsWith(p))) throw new Error(`scope.api: ${p} is reserved`);
  }
  return { tools, pair, api: [...new Set(api)].sort() };
}

// True when every permission in `wanted` is already in `granted`.
export function scopeCovers(granted, wanted) {
  if (wanted.tools && !granted.tools) return false;
  if (wanted.pair && !granted.pair) return false;
  return wanted.api.every(p => granted.api.some(g => p.startsWith(g)));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/agentd/tools.test.mjs test/agentd/tool-hosting.test.mjs`
Expected: PASS (tool-hosting covers remembered approvals).

- [ ] **Step 5: Commit**

```bash
git add src/agentd/tools/scope.mjs test/agentd/tools.test.mjs
git commit -m "feat: pair permission in client scopes"
```

---

### Task 2: per-route body cap in the IPC server

**Files:**
- Modify: `src/agentd/daemon/ipc.mjs`
- Test: `test/agentd/ipc.test.mjs`

**Interfaces:**
- Produces: a route object may carry `maxBytes` (`{ client?, maxBytes?, handler }`); it replaces the server-wide cap for that route only. Task 5 uses it for chat turns (2 MiB: base64 of a 1 MiB image plus text).

- [ ] **Step 1: Write the failing test** — after `'body over the cap → 413'` in `test/agentd/ipc.test.mjs`:

```js
test('a route can raise its own body cap', () => withServer({
  'POST /big': { maxBytes: 1000, handler: async body => ({ n: body.x.length }) },
  'POST /small': async () => ({}),
}, async call => {
  const body = JSON.stringify({ x: 'y'.repeat(200) });
  const big = await call('POST', '/big', { body });
  assert.equal(big.status, 200);
  assert.deepEqual(await big.json(), { n: 200 });
  assert.equal((await call('POST', '/small', { body })).status, 413);
}, { maxBytes: 100 }));
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentd/ipc.test.mjs`
Expected: FAIL — `/big` answers 413.

- [ ] **Step 3: Implement** — in `src/agentd/daemon/ipc.mjs`, update the comment above `compile` and `compile` itself:

```js
// 'POST /sessions/:id/tools/:name' → { method, parts }.
// A route is a handler (needs the agentd token) or { client: true, handler }
// (needs the token of the client named by its :id). `maxBytes` on a route
// object replaces the server's body cap for that route.
function compile(key, route) {
  const [method, path] = key.split(' ');
  const { client = false, maxBytes, handler } = typeof route === 'function' ? { handler: route } : route;
  return { method, parts: path.split('/').slice(1), client, maxBytes, handler };
}
```

and in the request handler, right before `const chunks = [];`:

```js
    const cap = route.maxBytes ?? maxBytes;
```

then replace `if (size <= maxBytes) { chunks.push(c); return; }` with `if (size <= cap) { chunks.push(c); return; }`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/agentd/ipc.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agentd/daemon/ipc.mjs test/agentd/ipc.test.mjs
git commit -m "feat: per-route IPC body cap"
```

---

### Task 3: signed multipart device requests

**Files:**
- Modify: `src/agentd/tools/sign.mjs`, `src/agentd/tools/device-client.mjs`
- Test: `test/agentd/tools.test.mjs`

**Interfaces:**
- Produces: `signedMultipartHeaders(method, path, credential, now?) → headers` (payload mode `multipart`, body hash `UNSIGNED-PAYLOAD`, as clt01 `local_auth.go` requires); `UNSIGNED_PAYLOAD`; `DeviceClient#postForm(path, form: FormData) → data` (same success / `DeviceError` rules as `request`). `fetch` sets the multipart `content-type` with its boundary; do not set it.

- [ ] **Step 1: Write the failing test** — in `test/agentd/tools.test.mjs`, extend the sign import to `import { EMPTY_BODY_HASH, UNSIGNED_PAYLOAD, sha256Hex, signedHeaders, signedMultipartHeaders, signedWsQuery } from '../../src/agentd/tools/sign.mjs';` and add:

```js
test('multipart headers sign the literal UNSIGNED-PAYLOAD', () => {
  const h = signedMultipartHeaders('POST', '/v1/api/data/user/chat/turns', cred, 1_700_000_000_000);
  assert.equal(h['X-Local-Payload-Mode'], 'multipart');
  assert.equal(h['X-Local-Body-Hash'], UNSIGNED_PAYLOAD);
  assert.equal(h['X-Local-Session-Id'], 'cred-1');
  assert.equal(h['content-type'], undefined);
  const canonical = ['POST', '/v1/api/data/user/chat/turns', '1700000000', h['X-Local-Nonce'], 'multipart', UNSIGNED_PAYLOAD, 'u1'].join('|');
  assert.equal(h['X-Local-Sig'], hmac(canonical));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentd/tools.test.mjs`
Expected: FAIL — `signedMultipartHeaders` is not exported.

- [ ] **Step 3: Implement `sign.mjs`** — replace `signedHeaders` with a shared builder:

```js
// Multipart bodies are not hashed: clt01 takes this literal (local_auth.go).
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function headersFor({ method, path, payloadMode, bodyHash, credential, now }) {
  const { sig, timestamp, nonce } = sign({ method, path, payloadMode, bodyHash, credential, now });
  const headers = {
    'X-Local-Sig': sig,
    'X-Local-Nonce': nonce,
    'X-Local-Timestamp': timestamp,
    'X-Local-Payload-Mode': payloadMode,
    'X-Local-Body-Hash': bodyHash,
    'X-Local-User-Id': credential.userId,
  };
  if (credential.id) headers['X-Local-Session-Id'] = credential.id;
  return headers;
}

// credential: { secret, userId, id? } — id is set for a client credential.
export function signedHeaders(method, path, bodyText, credential, now = Date.now()) {
  return headersFor({ method, path, payloadMode: 'json', bodyHash: sha256Hex(bodyText ?? ''), credential, now });
}

export function signedMultipartHeaders(method, path, credential, now = Date.now()) {
  return headersFor({ method, path, payloadMode: 'multipart', bodyHash: UNSIGNED_PAYLOAD, credential, now });
}
```

- [ ] **Step 4: Implement `device-client.mjs`** — import `signedMultipartHeaders`, split response handling out of `call`, add `postForm`:

```js
import { signedHeaders, signedMultipartHeaders } from './sign.mjs';
```

```js
async function parse(res) {
  if (res.status === 204) return null;
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || parsed?.success === false) {
    throw new DeviceError(res.status, parsed?.code, parsed?.message || parsed?.error);
  }
  return parsed?.data ?? null;
}

async function call(base, method, path, body, credential, fetchImpl) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  // clt01 verifies the signature over URL.Path only (local_auth.go): no query.
  if (credential) Object.assign(headers, signedHeaders(method, path.split('?')[0], text, credential));
  return parse(await fetchImpl(base + path, {
    method,
    headers,
    body: text || undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
}
```

and in `DeviceClient`, after `request`:

```js
  // multipart/form-data POST (chat turn images); fetch sets the boundary.
  async postForm(path, form) {
    return parse(await this.fetchImpl(this.base + path, {
      method: 'POST',
      headers: signedMultipartHeaders('POST', path, this.credential),
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
  }
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/agentd/tools.test.mjs test/agentd/tool-hosting.test.mjs test/agentd/agents-host.test.mjs`
Expected: PASS (the last two exercise the refactored `call`).

- [ ] **Step 6: Commit**

```bash
git add src/agentd/tools/sign.mjs src/agentd/tools/device-client.mjs test/agentd/tools.test.mjs
git commit -m "feat: signed multipart device requests"
```

---

### Task 4: chat turn module

**Files:**
- Create: `src/agentd/tools/chat-turns.mjs`
- Test: `test/agentd/chat-turns.test.mjs`

**Interfaces:**
- Consumes: `ClientError` (`./clients.mjs`); a device with `request(method, path, body)` and `postForm(path, form)` (Task 3).
- Produces:
  - `parseTurnRequest(body) → { image: Buffer, type: 'image/jpeg' | 'image/png', text: string, speech: 'device' | 'none', waitMs: number }`; throws `ClientError` (`400 INVALID_ARGUMENT`, `413 IMAGE_TOO_LARGE`).
  - `runChatTurn(device, req, { signal?, now?, pollMs? }) → { turn_id, state, assistant_text, error }`. `state` is clt01's (`completed`, `failed`, `cancelled` are final); a non-final state means `waitMs` ran out. Device failures propagate as `DeviceError`.
  - Constants `MAX_IMAGE_BYTES = 1 << 20`, `CHAT_TURNS_PATH = '/v1/api/data/user/chat/turns'`.

- [ ] **Step 1: Write the failing test** — `test/agentd/chat-turns.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_TURNS_PATH, MAX_IMAGE_BYTES, parseTurnRequest, runChatTurn } from '../../src/agentd/tools/chat-turns.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const b64 = buf => buf.toString('base64');

const codeOf = fn => { try { fn(); } catch (e) { return [e.status, e.code]; } return null; };

test('parseTurnRequest accepts JPEG and PNG with defaults', () => {
  const r = parseTurnRequest({ image: b64(JPEG), text: '  look  ' });
  assert.deepEqual([r.type, r.text, r.speech, r.waitMs], ['image/jpeg', 'look', 'device', 30_000]);
  assert.ok(r.image.equals(JPEG));
  assert.equal(parseTurnRequest({ image: b64(PNG), speech: 'none', wait_ms: 999_999 }).waitMs, 60_000);
  assert.equal(parseTurnRequest({ image: b64(PNG) }).type, 'image/png');
});

test('parseTurnRequest refuses bad input', () => {
  assert.deepEqual(codeOf(() => parseTurnRequest({})), [400, 'INVALID_ARGUMENT']);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(Buffer.from('GIF89a')) })), [400, 'INVALID_ARGUMENT']);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(JPEG), speech: 'client' })), [400, 'INVALID_ARGUMENT']);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(JPEG), text: 'x'.repeat(16_001) })), [400, 'INVALID_ARGUMENT']);
  const big = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.deepEqual(codeOf(() => parseTurnRequest({ image: b64(big) })), [413, 'IMAGE_TOO_LARGE']);
});

function fakeDevice({ finishAfter = 2, slot = 3 } = {}) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    async request(method, path) {
      calls.push([method, path]);
      if (path === '/v1/api/data/user/slot') return { slot_number: slot };
      polls++;
      return polls >= finishAfter
        ? { turn_id: 't1', state: 'completed', assistant_text: 'Nice jump!', error: null }
        : { turn_id: 't1', state: 'thinking', assistant_text: '' };
    },
    async postForm(path, form) {
      calls.push(['FORM', path, JSON.parse(form.get('request')), form.get('image')]);
      return { turn_id: 't1', state: 'thinking', assistant_text: '' };
    },
  };
}

test('runChatTurn posts on the active slot and polls to a final state', async () => {
  const device = fakeDevice();
  const req = parseTurnRequest({ image: b64(JPEG), text: 'what now?', speech: 'none' });
  const r = await runChatTurn(device, req, { pollMs: 1 });
  assert.deepEqual(r, { turn_id: 't1', state: 'completed', assistant_text: 'Nice jump!', error: null });
  const [, path, request, image] = device.calls[1];
  assert.equal(path, CHAT_TURNS_PATH);
  assert.equal(request.slot, 3);
  assert.match(request.request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(request.input, { type: 'image_text', text: 'what now?' });
  assert.deepEqual(request.output, { speech: 'none' });
  assert.equal(image.type, 'image/jpeg');
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(JPEG));
  assert.deepEqual(device.calls.slice(2).map(c => c[1]), [`${CHAT_TURNS_PATH}/t1`, `${CHAT_TURNS_PATH}/t1`]);
});

test('runChatTurn omits empty text and returns the last state when wait runs out', async () => {
  const device = fakeDevice({ finishAfter: Infinity });
  let clock = 0;
  const req = parseTurnRequest({ image: b64(JPEG), wait_ms: 100 });
  const r = await runChatTurn(device, req, { pollMs: 1, now: () => (clock += 40) });
  assert.equal(r.state, 'thinking');
  assert.deepEqual(device.calls[1][2].input, { type: 'image_text' });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentd/chat-turns.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/agentd/tools/chat-turns.mjs`:

```js
import { randomUUID } from 'node:crypto';
import { ClientError } from './clients.mjs';

// Image + text chat turns on the device (clt01 chat_turn_gin.go): one
// multipart POST on the active slot, then polling until a final state.

export const CHAT_TURNS_PATH = '/v1/api/data/user/chat/turns';
export const MAX_IMAGE_BYTES = 1 << 20; // clt01 refuses larger attachments
const MAX_TEXT_CHARS = 16_000;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60_000;
const POLL_MS = 300;
const FINAL = new Set(['completed', 'failed', 'cancelled']);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const invalid = message => new ClientError(400, 'INVALID_ARGUMENT', message);

function imageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  return null;
}

// The IPC body → a validated request. The client compresses: the daemon
// does not re-encode images.
export function parseTurnRequest(body) {
  const speech = body?.speech ?? 'device';
  if (speech !== 'device' && speech !== 'none') throw invalid('speech must be device or none');
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if ([...text].length > MAX_TEXT_CHARS) throw invalid(`text must not exceed ${MAX_TEXT_CHARS} characters`);
  if (typeof body?.image !== 'string' || !body.image) throw invalid('image must be a base64 JPEG or PNG');
  const image = Buffer.from(body.image, 'base64');
  const type = imageType(image);
  if (!type) throw invalid('image must be a base64 JPEG or PNG');
  if (image.length > MAX_IMAGE_BYTES) throw new ClientError(413, 'IMAGE_TOO_LARGE', 'image must not exceed 1 MiB; compress it first');
  const waitMs = Math.min(Math.max(Number(body?.wait_ms ?? DEFAULT_WAIT_MS) || 0, 0), MAX_WAIT_MS);
  return { image, type, text, speech, waitMs };
}

const view = s => ({ turn_id: s?.turn_id ?? '', state: s?.state ?? '', assistant_text: s?.assistant_text ?? '', error: s?.error ?? null });

export async function runChatTurn(device, req, { signal, now = Date.now, pollMs = POLL_MS } = {}) {
  const slot = (await device.request('GET', '/v1/api/data/user/slot'))?.slot_number;
  const input = req.text ? { type: 'image_text', text: req.text } : { type: 'image_text' };
  const form = new FormData();
  form.set('request', JSON.stringify({ request_id: randomUUID(), slot, input, output: { speech: req.speech } }));
  form.set('image', new Blob([req.image], { type: req.type }), req.type === 'image/png' ? 'screen.png' : 'screen.jpg');
  let snap = await device.postForm(CHAT_TURNS_PATH, form);
  const deadline = now() + req.waitMs;
  while (!FINAL.has(snap?.state) && now() < deadline && !signal?.aborted) {
    await sleep(pollMs);
    snap = await device.request('GET', `${CHAT_TURNS_PATH}/${encodeURIComponent(snap.turn_id)}`);
  }
  return view(snap);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/agentd/chat-turns.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agentd/tools/chat-turns.mjs test/agentd/chat-turns.test.mjs
git commit -m "feat: image chat turns on the device"
```

---

### Task 5: client routes for the device API and chat turns

**Files:**
- Create: `src/agentd/daemon/client-device-routes.mjs`
- Modify: `src/agentd/daemon/agentd-core.mjs`, `test/agentd/helpers/fake-device.mjs`
- Test: `test/agentd/client-device-routes.test.mjs`

**Interfaces:**
- Consumes: `toolDevice`, `NOT_PAIRED` (`tool-hosting.mjs`); `DeviceClient`, `DeviceError` (Task 3); `parseTurnRequest`, `runChatTurn`, `CHAT_TURNS_PATH` (Task 4); `allowsApiPath`; `HttpError`; route `maxBytes` (Task 2).
- Produces:
  - `createClientDeviceRoutes({ store, app, fetchImpl?, log? }) → routes` (Task 6 adds the pairing routes to the same function; `app` is unused until then).
  - `POST /clients/:id/api` `{ method, path, body? }` → `{ data }`.
  - `POST /clients/:id/chat-turns` `{ image, text?, speech?, wait_ms? }` → `{ turn_id, state, assistant_text, error }`.
  - Errors (`{ error, code }`): `403 APPROVAL_PENDING`, `403 SCOPE_DENIED`, `400 INVALID_ARGUMENT`, `409 NOT_PAIRED`, `413 IMAGE_TOO_LARGE`, `409 REPAIR_REQUIRED` (device refused the credential), `503 DEVICE_OFFLINE` (no answer), otherwise the device's own status and code (e.g. `409 DEVICE_BLOCKED`).
  - Fake device: `turns` (each `{ turn_id, request, image: Buffer, imageType }`), `setChat({ block?, assistantText?, pollsToFinish? })`; `GET /v1/api/data/user/character` → `{ name: 'Codie' }`.

- [ ] **Step 1: Extend the fake device** — in `test/agentd/helpers/fake-device.mjs`, add next to `const state = …`:

```js
  const turns = [];
  const chat = { block: null, assistantText: 'Nice jump!', pollsToFinish: 2 };
```

make the `end` listener async (`req.on('end', async () => {`) and add these branches right after the `/v1/api/data/user/slot` branch:

```js
      if (req.method === 'GET' && path === '/v1/api/data/user/character') return reply(200, { success: true, data: { name: 'Codie' } });
      if (req.method === 'POST' && path === '/v1/api/data/user/chat/turns') {
        // Like local_auth.go: multipart is signed over the literal UNSIGNED-PAYLOAD.
        if (h['x-local-payload-mode'] !== 'multipart' || h['x-local-body-hash'] !== 'UNSIGNED-PAYLOAD') return reply(401, { success: false, code: 'INVALID_SIGNATURE' });
        if (chat.block) return reply(409, { success: false, code: chat.block, message: 'Chat API admission blocked.' });
        const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': h['content-type'] } }).formData();
        const request = JSON.parse(form.get('request'));
        if (request.slot !== slot) return reply(409, { success: false, code: 'SLOT_MISMATCH' });
        const file = form.get('image');
        const turn = { turn_id: `turn-${turns.length + 1}`, request, image: Buffer.from(await file.arrayBuffer()), imageType: file.type, polls: 0 };
        turns.push(turn);
        return reply(200, { success: true, data: { turn_id: turn.turn_id, state: 'thinking', assistant_text: '', error: null } });
      }
      const turnPath = path.match(/^\/v1\/api\/data\/user\/chat\/turns\/([^/]+)$/);
      if (req.method === 'GET' && turnPath) {
        const turn = turns.find(t => t.turn_id === turnPath[1]);
        if (!turn) return reply(404, { success: false, code: 'TURN_NOT_FOUND' });
        turn.polls++;
        const done = turn.polls >= chat.pollsToFinish;
        return reply(200, { success: true, data: { turn_id: turn.turn_id, state: done ? 'completed' : 'thinking', assistant_text: done ? chat.assistantText : '', error: null } });
      }
```

and add to the returned object:

```js
    turns,
    setChat: patch => { Object.assign(chat, patch); },
```

Update the helper's header comment to mention chat turns and the `character` route.

- [ ] **Step 2: Write the failing test** — `test/agentd/client-device-routes.test.mjs`:

```js
// Client device routes through codie-agentd (spec §6.4 as client routes):
// the real loopback IPC and a fake clt01.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startAgentd } from '../../src/agentd/daemon/agentd-core.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { startFakeDevice } from './helpers/fake-device.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const noMdns = { sync: async () => {}, close: async () => {}, discover: async () => [] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const TURNS = '/v1/api/data/user/chat/turns';

async function setup(t, { paired = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-host-'));
  const device = await startFakeDevice({ credential });
  if (paired) {
    new Store(home).upsertPairing({
      deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port, bridgeId: 'b1', serviceSecret: 's1',
      userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
    });
  }
  const a = await startAgentd({ home, port: 0, legacyDirs: [], handoffDirs: [], clt01: {}, log: () => {}, exit: () => {}, mdns: noMdns });
  const ipc = async (method, route, body, token = a.token) => {
    const res = await fetch(`http://127.0.0.1:${a.ipcPort}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const client = async (name, scope, { approve = true } = {}) => {
    const reg = (await ipc('POST', '/clients', { name, scope })).body;
    if (approve) await ipc('POST', '/clients/approve', { name });
    return { call: (method, sub, body) => ipc(method, `/clients/${reg.id}${sub}`, body, reg.token) };
  };
  t.after(async () => {
    await a.shutdown();
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { device, client };
}

test('device API pass-through stays within the scope', async t => {
  const { client } = await setup(t);
  const c = await client('reader', { api: ['/v1/api/data/user/character'] });
  const ok = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { data: { name: 'Codie' } });
  const outside = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/memo' });
  assert.deepEqual([outside.status, outside.body.code], [403, 'SCOPE_DENIED']);
  const admin = await c.call('POST', '/api', { method: 'POST', path: '/v1/api/admin/install/service' });
  assert.deepEqual([admin.status, admin.body.code], [403, 'SCOPE_DENIED']);
  const bad = await c.call('POST', '/api', { method: 'TRACE', path: '/v1/api/data/user/character' });
  assert.deepEqual([bad.status, bad.body.code], [400, 'INVALID_ARGUMENT']);
});

test('a pending client reaches nothing', async t => {
  const { client } = await setup(t);
  const c = await client('waiting', { api: ['/v1/api/data/user/character'] }, { approve: false });
  const r = await c.call('POST', '/api', { method: 'GET', path: '/v1/api/data/user/character' });
  assert.deepEqual([r.status, r.body.code], [403, 'APPROVAL_PENDING']);
});

test('a chat turn posts the image on the active slot and returns the answer', async t => {
  const { client, device } = await setup(t);
  const c = await client('buddy', { api: [TURNS] });
  const r = await c.call('POST', '/chat-turns', { image: JPEG.toString('base64'), text: 'how do I pass this?', speech: 'none' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { turn_id: 'turn-1', state: 'completed', assistant_text: 'Nice jump!', error: null });
  const [turn] = device.turns;
  assert.equal(turn.request.slot, 2);
  assert.deepEqual(turn.request.output, { speech: 'none' });
  assert.equal(turn.imageType, 'image/jpeg');
  assert.ok(turn.image.equals(JPEG));
});

test('chat turn failures carry stable codes', async t => {
  const { client, device } = await setup(t);
  const c = await client('buddy', { api: [TURNS] });
  device.setChat({ block: 'DEVICE_BLOCKED' });
  const blocked = await c.call('POST', '/chat-turns', { image: JPEG.toString('base64') });
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'DEVICE_BLOCKED']);
  const big = Buffer.concat([JPEG, Buffer.alloc(1 << 20)]);
  const tooBig = await c.call('POST', '/chat-turns', { image: big.toString('base64') });
  assert.deepEqual([tooBig.status, tooBig.body.code], [413, 'IMAGE_TOO_LARGE']);
  const noScope = await client('other', {});
  const denied = await noScope.call('POST', '/chat-turns', { image: JPEG.toString('base64') });
  assert.deepEqual([denied.status, denied.body.code], [403, 'SCOPE_DENIED']);
});

test('without a paired device the routes say so', async t => {
  const { client } = await setup(t, { paired: false });
  const c = await client('buddy', { api: [TURNS] });
  const r = await c.call('POST', '/chat-turns', { image: JPEG.toString('base64') });
  assert.deepEqual([r.status, r.body.code], [409, 'NOT_PAIRED']);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test test/agentd/client-device-routes.test.mjs`
Expected: FAIL — `/clients/:id/api` answers 404.

- [ ] **Step 4: Implement** — `src/agentd/daemon/client-device-routes.mjs`:

```js
import { ClientError } from '../tools/clients.mjs';
import { CHAT_TURNS_PATH, parseTurnRequest, runChatTurn } from '../tools/chat-turns.mjs';
import { DeviceClient, DeviceError } from '../tools/device-client.mjs';
import { allowsApiPath } from '../tools/scope.mjs';
import { HttpError } from './ipc.mjs';
import { NOT_PAIRED, toolDevice } from './tool-hosting.mjs';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CHAT_TURN_MAX_BYTES = 2 << 20; // base64 of a 1 MiB image plus text

const fail = (status, code, message) => new HttpError(status, message, code);

// Any failure → the IPC error a client sees (spec §7).
function asHttp(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof ClientError) return fail(e.status, e.code, e.message);
  if (e instanceof DeviceError) {
    if (e.status === 401) return fail(409, 'REPAIR_REQUIRED', 'the device refused this computer\'s credential; pair the device again');
    return fail(e.status >= 400 ? e.status : 502, e.code || 'DEVICE_ERROR', e.message);
  }
  return fail(503, 'DEVICE_OFFLINE', `the device did not answer: ${e?.message ?? e}`);
}

const clientRoute = (handler, extra = {}) => ({
  client: true,
  ...extra,
  handler: async (body, ctx) => { try { return await handler(body, ctx); } catch (e) { throw asHttp(e); } },
});

function approved(client) {
  if (client.status !== 'approved') throw fail(403, 'APPROVAL_PENDING', `run: codie clients approve ${client.name}`);
}

function within(client, path) {
  approved(client);
  if (!allowsApiPath(client.scope, path)) throw fail(403, 'SCOPE_DENIED', `${path} is outside this client's scope`);
}

// What a client does on the device beyond tool hosting (spec §6.4): device
// API calls within its scope and image chat turns, on the device tool
// hosting uses. Every forwarded call is logged with the client name.
export function createClientDeviceRoutes({ store, fetchImpl = fetch, log = () => {} }) {
  const device = () => {
    const record = toolDevice(store);
    if (!record) throw fail(409, 'NOT_PAIRED', NOT_PAIRED);
    return DeviceClient.forPairing(record, fetchImpl);
  };

  return {
    'POST /clients/:id/api': clientRoute(async (body, { client }) => {
      const method = String(body?.method ?? '').toUpperCase();
      const path = body?.path;
      if (!METHODS.has(method)) throw fail(400, 'INVALID_ARGUMENT', 'method must be GET, POST, PUT, PATCH or DELETE');
      if (typeof path !== 'string' || !path.startsWith('/v1/api/') || path.includes('..')) {
        throw fail(400, 'INVALID_ARGUMENT', 'path must be a /v1/api/ path');
      }
      const bare = path.split('?')[0];
      within(client, bare);
      log(`[clients] ${client.name} ${method} ${bare}`);
      return { data: await device().request(method, path, body.body) };
    }),
    'POST /clients/:id/chat-turns': clientRoute(async (body, { client, signal }) => {
      within(client, CHAT_TURNS_PATH);
      const req = parseTurnRequest(body);
      log(`[clients] ${client.name} chat turn (${req.image.length} bytes, speech ${req.speech})`);
      return runChatTurn(device(), req, { signal });
    }, { maxBytes: CHAT_TURN_MAX_BYTES }),
  };
}
```

- [ ] **Step 5: Mount the routes** — in `src/agentd/daemon/agentd-core.mjs` add the import:

```js
import { createClientDeviceRoutes } from './client-device-routes.mjs';
```

and in the `routes` object, right after `...hosting.routes,`:

```js
    ...createClientDeviceRoutes({ store, app, log, fetchImpl: toolHostingOptions.fetchImpl }),
```

(`app` is passed now so Task 6 only touches the routes file; a `fetchImpl` of `undefined` falls back to the default `fetch`.)

- [ ] **Step 6: Run the tests**

Run: `node --test test/agentd/client-device-routes.test.mjs test/agentd/tool-hosting.test.mjs test/agentd/agents-host.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agentd/daemon/client-device-routes.mjs src/agentd/daemon/agentd-core.mjs test/agentd/helpers/fake-device.mjs test/agentd/client-device-routes.test.mjs
git commit -m "feat: device API and chat turn routes for tool clients"
```

---

### Task 6: scan and pairing for clients

**Files:**
- Modify: `src/agentd/app.mjs`, `src/agentd/daemon/client-device-routes.mjs`
- Test: `test/agentd/client-device-routes.test.mjs`, `test/agentd/app.test.mjs` (existing `list devices marks paired/online` must keep passing)

**Interfaces:**
- Consumes: `App#callTool('codie_pair_begin' | 'codie_pair_confirm' | 'codie_pair_cancel', args)` (existing, returns `{ content: [{ text }], isError? }`); `App#statusSnapshot()`.
- Produces:
  - `App#scanDevices(ms = 3000) → [{ deviceId, name, host, paired, online }]`; it also refreshes `lastScan`, which pairing needs.
  - `GET /clients/:id/devices` → `{ found: [scanDevices entries], paired: statusSnapshot().devices }`.
  - `POST /clients/:id/pair/begin` `{ device_id }` → `{ ok, message }`.
  - `POST /clients/:id/pair/confirm` `{ device_id, code }` → `{ ok, toolsReady, message }`. `toolsReady` is true when this confirm stored a new client credential for the device (what game_buddy needs), even if the transitional codie-agent-service install reported a problem.
  - `POST /clients/:id/pair/cancel` `{ device_id }` → `{ ok, message }`.
  - All four need `scope.pair` (`403 SCOPE_DENIED` otherwise) and approval.

- [ ] **Step 1: Write the failing test** — in `test/agentd/client-device-routes.test.mjs`, let `setup` take `clt01` and `discover` options and pass them to `startAgentd`:

```js
async function setup(t, { paired = true, clt01 = {}, discover = async () => [] } = {}) {
```

```js
  const a = await startAgentd({ home, port: 0, legacyDirs: [], handoffDirs: [], clt01, log: () => {}, exit: () => {},
    mdns: { ...noMdns, discover } });
```

return `store: new Store(home)` from `setup` as well (`return { device, client, store: new Store(home) };`), then add:

```js
const pairingClt01 = {
  pairRequest: async () => ({ challengeId: 'c1' }),
  pairConfirm: async (h, p, challengeId, code) => {
    if (code !== '123456') throw Object.assign(new Error('wrong code'), { code: 'PAIRING_CODE_INVALID' });
    return { bridgeId: 'b2', serviceSecret: 's2', hasService: true, deviceId: 'NEW1', name: 'Desk Codie', localSecret: 'master' };
  },
  pairCancel: async () => {},
  deviceAuth: async (h, p, secret) => ({ secret, userId: 'user-9' }),
  issueClientCredential: async () => ({ id: 'cred-new', secret: 'new-secret' }),
  serviceStatus: async () => ({ installed: true, versionCode: 99, versionName: '9.9', platformCertSha256: '' }),
  installService: async () => {},
  finishPairing: async () => [],
};

test('a client with the pair permission scans and pairs a device', async t => {
  const { client, store } = await setup(t, {
    paired: false, clt01: pairingClt01,
    discover: async () => [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', port: 8081 }],
  });
  const c = await client('buddy', { pair: true });
  const scan = await c.call('GET', '/devices');
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  assert.deepEqual(scan.body.found, [{ deviceId: 'NEW1', name: 'Desk Codie', host: '127.0.0.1', paired: false, online: false }]);
  assert.deepEqual(scan.body.paired, []);

  const begin = await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  assert.equal(begin.body.ok, true, begin.body.message);
  const wrong = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '000000' });
  assert.deepEqual([wrong.body.ok, wrong.body.toolsReady], [false, false]);

  await c.call('POST', '/pair/begin', { device_id: 'NEW1' });
  const done = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '123456' });
  assert.equal(done.status, 200);
  assert.equal(done.body.toolsReady, true, done.body.message);
  assert.equal(store.listPairings().find(r => r.deviceId === 'NEW1').credentialId, 'cred-new');
  assert.equal((await c.call('POST', '/pair/cancel', { device_id: 'NEW1' })).body.ok, true);
});

test('pairing needs the pair permission and a well-formed request', async t => {
  const { client } = await setup(t, { clt01: pairingClt01 });
  const plain = await client('plain', { tools: true });
  const denied = await plain.call('GET', '/devices');
  assert.deepEqual([denied.status, denied.body.code], [403, 'SCOPE_DENIED']);
  const c = await client('buddy', { pair: true });
  const noId = await c.call('POST', '/pair/begin', {});
  assert.deepEqual([noId.status, noId.body.code], [400, 'INVALID_ARGUMENT']);
  const badCode = await c.call('POST', '/pair/confirm', { device_id: 'NEW1', code: '12ab' });
  assert.deepEqual([badCode.status, badCode.body.code], [400, 'INVALID_ARGUMENT']);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentd/client-device-routes.test.mjs`
Expected: the two new tests FAIL (`/clients/:id/devices` → 404); the Task 5 tests still PASS.

- [ ] **Step 3: Add `scanDevices` to `App`** — in `src/agentd/app.mjs`, add above `statusSnapshot()`:

```js
  // Scans the LAN and remembers the result for pairing (pair begin/confirm
  // look devices up in it): [{ deviceId, name, host, paired, online }].
  async scanDevices(ms = 3000) {
    const found = await this.discover(ms);
    this.lastScan = new Map(found.map(d => [d.deviceId, d]));
    const paired = new Set(this.store.listPairings().map(r => r.deviceId));
    const online = new Set(this.link.onlineDevices().map(d => d.deviceId));
    return found.map(d => ({ deviceId: d.deviceId, name: d.name || '', host: d.host, paired: paired.has(d.deviceId), online: online.has(d.deviceId) }));
  }
```

and replace the body of `case 'codie_list_devices':` with:

```js
      case 'codie_list_devices': {
        const found = await this.scanDevices(3000);
        if (!found.length) return text('No Codie device found on the LAN (make sure the device is on and on the same network as the computer).');
        const lines = found.map((d, i) => {
          const st = d.paired ? (d.online ? 'paired · online' : 'paired · offline') : 'not paired';
          return `${i + 1}. ${d.name || d.deviceId}   ${d.host}   ${st}   (device_id=${d.deviceId})`;
        });
        return text(lines.join('\n'));
      }
```

- [ ] **Step 4: Add the pairing routes** — in `src/agentd/daemon/client-device-routes.mjs`, take `app` in the signature (`createClientDeviceRoutes({ store, app, fetchImpl = fetch, log = () => {} })`), add these helpers above it:

```js
const SCAN_MS = 3000;
const PAIRING_CODE = /^\d{6}$/;
const textOf = r => r.content.map(c => c.text).join('\n');

function mayPair(client) {
  approved(client);
  if (!client.scope.pair) throw fail(403, 'SCOPE_DENIED', 'this client did not request pairing');
}

function deviceIdOf(body) {
  const id = body?.device_id;
  if (typeof id !== 'string' || !id) throw fail(400, 'INVALID_ARGUMENT', 'device_id is required');
  return id;
}
```

and these entries to the returned routes (update the function comment: "… image chat turns, and scanning / pairing devices with the pair permission …"):

```js
    'GET /clients/:id/devices': clientRoute(async (body, { client }) => {
      mayPair(client);
      return { found: await app.scanDevices(SCAN_MS), paired: app.statusSnapshot().devices };
    }),
    'POST /clients/:id/pair/begin': clientRoute(async (body, { client }) => {
      mayPair(client);
      const r = await app.callTool('codie_pair_begin', { device_id: deviceIdOf(body) });
      return { ok: !r.isError, message: textOf(r) };
    }),
    // toolsReady: this confirm stored a new client credential, which is all a
    // tool client needs; the transitional service install may still complain.
    'POST /clients/:id/pair/confirm': clientRoute(async (body, { client }) => {
      mayPair(client);
      const deviceId = deviceIdOf(body);
      if (typeof body?.code !== 'string' || !PAIRING_CODE.test(body.code.trim())) throw fail(400, 'INVALID_ARGUMENT', 'code must be the 6 digits on the device screen');
      const credentialOf = () => store.listPairings().find(r => r.deviceId === deviceId)?.credentialId;
      const before = credentialOf();
      log(`[clients] ${client.name} pairs ${deviceId}`);
      const r = await app.callTool('codie_pair_confirm', { device_id: deviceId, code: body.code.trim() });
      const after = credentialOf();
      return { ok: !r.isError, toolsReady: Boolean(after) && after !== before, message: textOf(r) };
    }),
    'POST /clients/:id/pair/cancel': clientRoute(async (body, { client }) => {
      mayPair(client);
      const r = await app.callTool('codie_pair_cancel', { device_id: deviceIdOf(body) });
      return { ok: !r.isError, message: textOf(r) };
    }),
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/agentd/client-device-routes.test.mjs test/agentd/app.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agentd/app.mjs src/agentd/daemon/client-device-routes.mjs test/agentd/client-device-routes.test.mjs
git commit -m "feat: scan and pairing routes for tool clients"
```

---

### Task 7: SDK methods, version bump, spec update

**Files:**
- Modify: `sdk/index.mjs`, `src/agentd/daemon/version.mjs`, `docs/specs/2026-10-26-codie-host-design.md`
- Test: `test/agentd/sdk.test.mjs`

**Interfaces:**
- Consumes: the routes of Tasks 5 and 6.
- Produces (on `ToolClient`; each registers first when needed and throws `HostError` with the route's `status` / `code`):
  - `api(method, path, body?) → data`
  - `chatTurn({ image: Buffer | Uint8Array, text?, speech? = 'device', waitMs? = 30000, signal? }) → { turn_id, state, assistant_text, error }`
  - `devices() → { found, paired }`
  - `pairBegin(deviceId) → { ok, message }`, `pairConfirm(deviceId, code) → { ok, toolsReady, message }` (130 s timeout: pairing may install the service APK), `pairCancel(deviceId) → { ok, message }`

- [ ] **Step 1: Write the failing test** — `test/agentd/sdk.test.mjs`. agentd runs in this process; `ensureDaemon(home)` finds it through `agentd.json` (same pid, current version):

```js
// The client SDK against an in-process codie-agentd and a fake clt01.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HostError, ToolClient } from '../../sdk/index.mjs';
import { startAgentd } from '../../src/agentd/daemon/agentd-core.mjs';
import { Store } from '../../src/agentd/store.mjs';
import { startFakeDevice } from './helpers/fake-device.mjs';

const credential = { id: 'cred-1', secret: 'client-secret', userId: 'user-1' };
const noMdns = { sync: async () => {}, close: async () => {}, discover: async () => [] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const TURNS = '/v1/api/data/user/chat/turns';

test('ToolClient runs chat turns and API calls once approved', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codie-host-'));
  const device = await startFakeDevice({ credential });
  new Store(home).upsertPairing({
    deviceId: 'DEV1', name: 'Codie', host: '127.0.0.1', port: device.port, bridgeId: 'b1', serviceSecret: 's1',
    userId: credential.userId, credentialId: credential.id, credentialSecret: credential.secret,
  });
  const a = await startAgentd({ home, port: 0, legacyDirs: [], handoffDirs: [], clt01: {}, log: () => {}, exit: () => {}, mdns: noMdns });
  const sdk = new ToolClient({ name: 'game-buddy', scope: { pair: true, api: [TURNS, '/v1/api/data/user/character'] }, home });
  t.after(async () => {
    await sdk.close();
    await a.shutdown();
    await device.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  await assert.rejects(sdk.chatTurn({ image: JPEG }), e => e instanceof HostError && e.code === 'APPROVAL_PENDING');
  await fetch(`http://127.0.0.1:${a.ipcPort}/clients/approve`, {
    method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'game-buddy' }),
  });

  const turn = await sdk.chatTurn({ image: JPEG, text: 'cheer me on', waitMs: 5000 });
  assert.deepEqual([turn.state, turn.assistant_text], ['completed', 'Nice jump!']);
  assert.deepEqual(device.turns[0].request.output, { speech: 'device' });
  assert.deepEqual(await sdk.api('GET', '/v1/api/data/user/character'), { name: 'Codie' });
  assert.deepEqual(await sdk.devices(), { found: [], paired: [{ deviceId: 'DEV1', name: 'Codie', online: false }] });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agentd/sdk.test.mjs`
Expected: FAIL — `sdk.chatTurn is not a function`.

- [ ] **Step 3: Implement** — in `sdk/index.mjs`, add constants next to `POLL_WAIT_MS`:

```js
const PAIR_CONFIRM_MS = 130_000; // pairing may install the service APK
const SCAN_TIMEOUT_MS = 15_000;
const TURN_SLACK_MS = 15_000; // upload and polling beyond the turn's own wait
```

and in `ToolClient`, after `setTools(tools)`:

```js
  async #ready() { if (!this.id) await this.#register(); }

  // Device API call within this client's scope: the device's `data`.
  async api(method, path, body) {
    await this.#ready();
    return (await this.#call('POST', '/api', { method, path, body })).data;
  }

  // One image + text turn on the device. `image` is JPEG or PNG ≤ 1 MiB.
  // Resolves when the turn ends or after `waitMs` (then `state` is not final).
  async chatTurn({ image, text = '', speech = 'device', waitMs = 30_000, signal } = {}) {
    await this.#ready();
    const timeout = AbortSignal.timeout(waitMs + TURN_SLACK_MS);
    return this.#call('POST', '/chat-turns', { image: Buffer.from(image).toString('base64'), text, speech, wait_ms: waitMs },
      signal ? AbortSignal.any([signal, timeout]) : timeout);
  }

  // Needs scope.pair. `found`: the LAN scan; `paired`: devices paired already.
  async devices() {
    await this.#ready();
    return this.#call('GET', '/devices', undefined, AbortSignal.timeout(SCAN_TIMEOUT_MS));
  }

  async pairBegin(deviceId) {
    await this.#ready();
    return this.#call('POST', '/pair/begin', { device_id: deviceId });
  }

  async pairConfirm(deviceId, code) {
    await this.#ready();
    return this.#call('POST', '/pair/confirm', { device_id: deviceId, code }, AbortSignal.timeout(PAIR_CONFIRM_MS));
  }

  async pairCancel(deviceId) {
    await this.#ready();
    return this.#call('POST', '/pair/cancel', { device_id: deviceId });
  }
```

Update the file's header comment to: `// Client SDK for local programs (spec §6): starts codie-agentd when it is not running, registers this program, publishes its tools, answers calls from Codie's model, and reaches the device (API calls, image chat turns, pairing) within its scope.`

- [ ] **Step 4: Run it**

Run: `node --test test/agentd/sdk.test.mjs`
Expected: PASS.

- [ ] **Step 5: Bump the version** — `src/agentd/daemon/version.mjs`: `export const AGENTD_VERSION = 28;`

- [ ] **Step 6: Update the codie-host spec** — `docs/specs/2026-10-26-codie-host-design.md`:
  - §6.1, in the `POST /clients` bullet, after "whether the client may host tools": add "and whether it may scan for and pair devices (`pair`)".
  - §6.4: replace the Devices, Device API and Conveniences rows' routes for clients with the built ones and add a note under the table:

```markdown
- **Built 2026-10-29 as client routes** (a client token reaches only `/clients/:id/...`): `POST /clients/:id/api` `{ method, path, body }` within `scope.api`; `POST /clients/:id/chat-turns` `{ image, text, speech, wait_ms }` (JPEG/PNG ≤ 1 MiB; the client compresses, the daemon does not re-encode, the device scales); `GET /clients/:id/devices` and `POST /clients/:id/pair/{begin,confirm,cancel}` with `scope.pair`. They act on the device tool hosting uses (`toolDevice`). `speak`, unpair for clients and model upload are not built.
```

  - §9, phase 3 row: change "except the device API pass-through" to "and, 2026-10-29, the device API pass-through, image chat turns and client pairing (§6.4)".

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: 395 + 15 new tests (410); the only failures are the 9 baseline ones listed in Global Constraints.

- [ ] **Step 8: Commit**

```bash
git add sdk/index.mjs src/agentd/daemon/version.mjs docs/specs/2026-10-26-codie-host-design.md test/agentd/sdk.test.mjs
git commit -m "feat: SDK device routes for tool clients; agentd 28"
```

---

## After this plan

- The Claude / Codex plugins bundle codie_host into `dist/`; they pick this up on their next rebuild (not part of this plan; their release steps are in `codie-plugin-for-agents/CLAUDE.md`).
- Next: the game_buddy phase 2 plan (tray app + commentary), in the `codie_game_buddy` repo.
