# codie-host design

Date: 2026-10-26, revised 2026-10-28
Status: approved in discussion, pending spec review

Revision 2026-10-28: Codie's model reaches computer tools only through clt01 external tools (`ext.*`); the agents plugin moves onto them and codie-agent-service is retired (D8–D10); local clients get their own token and scope (D11); written in Node, evolved from the plugin's agentd (D4, D5). Sections 3, 5, 6, 9–12 changed accordingly.

## 1. Goal

One computer-side implementation for everything that talks to a Codie device.
Today there are four that overlap and diverge:

| Today | Language | Direction | Holds |
|---|---|---|---|
| `codie-plugin-for-agents` agentd (`codie-claude-plugin/src`) | Node | device → computer (voice tasks to Claude Code / Codex) | WS v1 :9530, mDNS, pairing, session routing, background dispatch; installs codie-agent-service |
| `workshop_inner/workshop_api` (Go SDK `workshop_inner_sdk`) | Go | computer → device (control over clt01 HTTP) | signing, pairing, 1.5.3 atomic API, firmware tiers, its own MCP server |
| `codie-plugin-for-govee` | Go overrides + Java APK | device-internal (`matter.*` injected into the host) | patched `libgojni.so` installed over ADB, a debug-signed side APK |
| `codie-agent-bridge` (codie-oclaw) | Dart | — | **abandoned**, not considered |

codie-host replaces the first two and gives the third a supported path. After it ships:

- The Claude Code and Codex plugins carry no Node code; their entry points are the `codie` binary.
- Any local program (`codie_game_buddy`, a Govee light tool, …) gets pairing, device control, and tools that Codie's model can call, through the same daemon.
- Codie's model calls every computer-side capability, the AI agent included, as a clt01 external tool. The device runs no extra APK.
- Everything workshop_api can do on the device is reachable, plus "look at this image and talk about it".
- No component on the computer ever persists the device master secret.

`twitter_read_play` (a workshop_api consumer, also deployed on servers) is a reference only; codie-host does not serve it.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Device control goes over clt01 HTTP with a **scoped client credential**, held only by the daemon | Large payloads (images, VRM up to 15 MB) fit HTTP; the 1.5.3 manual maps 1:1; the AIDL `sendMessage(String)` path is bound by the ~1 MB Binder transaction limit. Persisting the master secret is rejected: it can silently install any APK (`ApkInstaller.installSilently` pins no package). |
| D2 | Device control requires new firmware (client credential + 1.5.3 API). Older firmware keeps voice tasks only. | Supporting old firmware would bring back the master secret and a second firmware tier. |
| D3 | The daemon is a standalone component, not part of a plugin | game_buddy must work without Claude Code / Codex installed. |
| D4 | Written in **Node** (ESM, Node ≥ 20), evolved from the plugin's agentd; package `codie-host` with bin `codie` and a JS client SDK | Changed 2026-10-28 from Go: the agentd to evolve is already Node, so no parity rewrite; D9 drops the mDNS/WS server work Go was chosen for; more developers can read and extend it. Tools use the IPC from any language; a JS SDK ships first. |
| D5 | Plugins' entry points (MCP stdio, hooks, monitor) are subcommands of the same `codie` program | One language, one implementation. Standalone programs need Node or a Node single-executable build. |
| D6 | New repo `codie_host` (https://git.service.code27.cn/codie_host); workshop_api is absorbed and then deprecated | Clear ownership; one place for all consumers. |
| D7 | `/v1/api/admin/*` on the device accepts **only the master secret**; session and client credentials are refused | One rule on the device; today a session credential can call `/admin/install`. |
| D8 | Codie's model reaches the computer **only through clt01 external tools** (`ext.*`, `tool-integrations`); no `agent.ask` routing to clients, no JSON smuggled through `agent.ask` | Meeting 2026-10-28. One structured path for every tool; arguments are typed, the result goes back to the same model and its character in one turn. |
| D9 | The agents plugin moves onto D8 (`ask_agent`, `cancel_task`, §6.3); **codie-agent-service, WS v1 :9530, computer-side mDNS advertising and the AIDL hop are retired** | The device keeps a single entry point (clt01 HTTP/WS) signed with one credential; no vendor-signed APK, `service_secret` or APK pinning. |
| D10 | No tool-specific APK or host patch on the device. A capability that must run on the device goes into clt01 mainline; everything else runs on the computer behind codie-host | Side APKs installed over ADB and patched host libraries are lost or broken by launcher OTA and bypass the supported install path. |
| D11 | **Each local client has its own IPC token and scope** (allowed device API paths, may it host tools); the daemon enforces and logs per client | One shared token would give every local program full `/data/*` and `/resources/*` access. clt01 itself does not isolate integrations (its §4.6), so the daemon does. |

## 3. Architecture

```
                     codie (Node, repo codie_host)
 ┌──────────────────────────────────────────────────────────────┐
 │ subcommands                                                   │
 │   daemon         long-lived background process                │
 │   mcp            MCP stdio thin client (Claude Code / Codex)  │
 │   hook <route>   Stop / Notification hook forwarder           │
 │   inbox          Claude Code monitor (prints device tasks)    │
 │                                                               │
 │ modules (sdk/ is the JS SDK for local programs)               │
 │   clt01/   signing, pairing, client credential, 1.5.3 API,    │
 │            firmware tiers, device scan   (from workshop_api)  │
 │   tools/   tool-integrations catalog + WS per client (§6.2)   │
 │   router/  session registry, routing, background dispatch     │
 │            (from plugin JS)                                   │
 │   ipc/     127.0.0.1 HTTP, per-client token + scope (D11)     │
 │   store/   ~/.codie: pairings, client credentials, clients    │
 └──────────────────────────────────────────────────────────────┘
       ▲ IPC (127.0.0.1, per-client token)      │ HTTP + WS tool-integrations
  ┌────┴─────────┬──────────────┬─────────┐     │ (client credential)
 Claude plugin  Codex plugin   game_buddy  light tool     ▼
 (manifest →    (same)                               Codie device: clt01 only
  binary)
```

- **One daemon** per user owns the device connection and all credentials. Whoever needs it first starts it (`ensure` logic from `daemon/ensure.mjs`: a running daemon with an older version is replaced).
- **Connection direction**: the daemon connects to the device (scan + paired address, reconnect on IP change). The device no longer discovers the computer.
  - As built (`src/agentd/daemon/host-refresh.mjs`): a pairing keeps the address it was paired at until that address fails. A failure is a network-level error (refused, timeout, DNS) or a 401 that refuses our credential (`LOCAL_SESSION_EXPIRED` / `LOCAL_USER_MISMATCH` / `LOCAL_SECRET_MISMATCH`: another device may hold the address now) on a tool link (client or `agents`) or a client device call; other device errors say nothing about the address. A failure marks the device and asks for `refreshHosts()`: one 3 s mDNS scan that moves only marked devices, the first a minute after the last, the gap doubling to 10 min while scans move nothing and back to a minute on a move or once a marked device answers again (which clears its mark). Concurrent requests share one run. Scans for other reasons (CLI `scan`, pairing, the client `devices` route) never move a paired device: an mDNS answer (TXT `device_id`) proves nothing, and moving a healthy device on one would let any LAN host redirect its tool links and calls with a forged reply. A moved device's links reconnect at the new address; the failed call itself is not retried. There is no periodic scan.
- **Keep-alive**: the daemon exits after it has had no registered session or client for the idle timeout (today 10 min, `CODIE_AGENTD_IDLE_MS`). While it is down, no `ext.*` tool is online, so Codie's model is not offered them (clt01 declares only online integrations). Tools that must answer voice at any time (a light tool) run resident themselves; whether the daemon should also start at login is open (§11).
- **Data dir** stays `~/.codie` (`CODIE_HOME`); existing pairings keep working for voice tasks without re-pairing. `~/.clt01sdk` from workshop_api is not migrated (it holds master secrets).
- **Plugin packaging**: each plugin ships binaries for darwin/linux/windows × amd64/arm64 plus a tiny launcher (`codie.sh`, `codie.cmd`) that picks the right one; plugin manifests, hooks and monitors point at the launcher. No download-on-first-run (a bootstrapper would itself need a runtime).

## 4. Device side: client credential (clt01_embed_backend)

Today (`src/framework/auth/sign.go`): the master secret signs requests; `auth_scope=session` issues an in-memory derived credential (`X-Local-Session-Id` + derived secret, 12 h TTL, invalidated when the master secret rotates). `LocalAuthGuard` (`src/framework/routes/local_auth.go`) does not distinguish credentials, so session credentials reach `/admin/*`.

### 4.1 New credential kind

| | master | session (existing) | client (new) |
|---|---|---|---|
| Storage | settings | memory | database (survives reboot) |
| Lifetime | until rotation | 12 h | until revoked or master rotation |
| `/v1/api/admin/*` | yes | **no (changed, D7)** | no |
| `/v1/api/auth/credentials*` | yes | no | revoke self only |
| `/v1/api/data/*`, `/v1/api/resources/*` | yes | yes | yes |
| `/v1/ws/tool-integrations/*` | yes | yes | yes |

- Wire format unchanged: client credentials sign with the existing algorithm and send `X-Local-Session-Id: <credential id>`. `resolveLocalAuthSecret` looks the id up in sessions first, then client credentials.
- The scope check runs once in `LocalAuthGuard` after a successful signature check, by credential kind and path prefix. No per-route changes.
- New routes:
  - `POST /v1/api/auth/credentials` — master only. Body `{ "label": "codie-host <hostname>" }`. Returns `{ id, secret, created_at_ms }`.
  - `GET /v1/api/auth/credentials` — master only. Lists `{ id, label, created_at_ms, last_used_at_ms }` (no secrets).
  - `DELETE /v1/api/auth/credentials/:id` — master, or the client credential `:id` itself.
- Master rotation invalidates all client credentials (same hash binding as sessions).

### 4.2 Web console

`frontend/src/views/Pairing.vue:217` issues a session credential when "remember device" is unchecked. The lab pages (`views/lab/ApiDocs.vue`, `views/lab/System.vue`) call `/admin/api-docs`, `/admin/system/settings`, `/admin/user/settings`, `/admin/tunnel/status`. After D7 they get 403 on a session credential; they show "re-pair with 'remember device' checked to use this page". No exception path.

### 4.3 Other clt01 work

Owned by the clt01 owner; listed in §12.

## 5. codie-host: pairing flow

1. `pair/request` → user reads the 6-digit code → `pair/confirm` (permanent). Master secret is held in memory only.
2. `POST /v1/api/auth/credentials` → store `{ id, secret }` in `~/.codie` with the pairing (file readable by the current user only).
3. Drop the master secret.
4. Unpair: delete this host's tool integrations, `DELETE /v1/api/auth/credentials/<own id>` with the client credential, then remove local state.

No APK install, `pair/ensure` or `prefer-bridge` on new firmware (D9).

Old firmware is not supported (§10): if step 2 fails, pairing fails and nothing is saved; an existing pairing is left as it was. Pairings without a client credential need one re-pair.

## 6. codie-host: IPC

Same transport as today: HTTP on `127.0.0.1:<random>`, written to `~/.codie/agentd.json` (user-only permissions). Device credentials never leave the daemon.

### 6.1 Clients, tokens and scope (D11)

- `agentd.json` holds agentd's token (the one sessions use; owner-only file). Tool clients use it only for `POST /clients`; a client token reaches only that client's own `/clients/:id/...` routes. Approval is `codie clients approve <name>`, or pairing a device from a client that asked for `pair` (below); same-user programs can read `agentd.json`, so approval guards against accidental or over-broad clients, not same-user malware.
- `POST /clients` `{ name, scope }` registers a client and returns its own token. `scope` lists device API path prefixes (e.g. `/v1/api/data/user/character`) and whether the client may host tools and whether it may scan for and pair devices (`pair`). The first registration of a client name needs the user's approval in the daemon: `codie clients approve <name>`, or (decided 2026-10-30) a successful pairing from that client. A pending client whose scope has `pair` may scan and pair before it is approved, and nothing else; the pair confirm that succeeds approves the scope it asked for, because the user read the code off the device screen and typed it into that client. The approved scope is remembered in `~/.codie` and later registrations within it pass silently. A wider scope asks again.
- The Claude / Codex plugin subcommands register as the built-in client `agents` with the session routes, tool hosting, and the device API paths of §6.4.
- Every request is checked against the caller's scope; `/admin/*` and `/auth/*` are always refused. Each forwarded device call and each tool call is logged with the client name.
- A client token dies with `POST /clients/:id/close` or when the daemon restarts; clients re-register.
- **SDK connection (2026-11-02).** `createConnection` (`sdk/connection.mjs`) keeps a program's registration alive and serves its tools, follows approval, and reports one state (`connecting`, `pending`, `not-paired`, `ready`, `offline`); `classify` maps IPC errors to it, `noteReady` / `noteError` feed in the program's own calls, `devices()` merges the scan with the pairings, and pairing passes through. codie_game_buddy and govee_buddy build on it.

### 6.2 Tool hosting

A client describes its tools; the daemon makes them clt01 external tools and relays calls.

- **One integration per client.** The daemon derives a stable integration UUID from (device, client name), `PUT /v1/api/data/user/tool-integrations/<uuid>` with the client's catalog, and keeps one `GET /v1/ws/tool-integrations/<uuid>` connection per client, reconnecting after drops and catalog updates. clt01 limits (its `DEVICE_TOOL_SYSTEM_PLAN.md` §4.6): 8 integrations and 32 tools per user, 16 tools and 3 pending calls per integration, 100–20000 ms per call, 25 s per batch, a restricted JSON Schema subset.
- IPC routes for a client with tool scope:
  - `PUT /clients/:id/tools` — the catalog (tools with `name`, `version`, `description`, `parameters`, `result_schema`, `risk`, `idempotent`, `confirmation_required`, `timeout_ms`). The daemon validates against clt01's schema subset before sending.
  - `POST /clients/:id/calls` — long poll, returns pending `invoke`s (`invocation_id`, `name`, `arguments`, `deadline_unix_ms`); same pattern as `/sessions/:id/events`.
  - `POST /clients/:id/calls/:invocation_id/result` — `{ status: succeeded | failed | needs_clarification, data, code? }`, forwarded as the WS `result`.
- When the client closes or its keep-alive lapses, the daemon closes the WS; clt01 marks the integration offline and stops declaring it. `DELETE` happens only on unpair, when the client unregisters for good, or when its tools move to another device.
- **Catalog updates (2026-11-02).** `PUT /clients/:id/tools` may be sent again at any time (SDK `publishTools`); the client versions its tools, since clt01 refuses changed content under a published version. An empty list withdraws the tools: the daemon closes the client's device link, clt01 marks the integration offline, and the next non-empty catalog links again. The integration is not deleted.
- **The tools device.** Client tools are published to one paired device: `toolsDevice` in `settings.json` while that pairing holds a client credential, else the first pairing that does (the pairing order never changes on an update). agentd pins it at start when unset, so installs from before it keep the device they used. Pairing a device that issues a client credential, through any path (a session tool, the CLI, or a client with the pair scope), makes it the tools device for every client; the client route logs that. `codie tools device [<device_id>]` (IPC `GET` / `POST /tools-device`) shows or sets it and refuses a device without a client credential; it and `codie status` show `toolsDevice` and, when the fallback overrides the choice, `chosen`. When the tools device, its address or its credential changes, every client link moves: the old link closes, its integration is deleted on a device no longer used, and a new link republishes the catalog. The old device's integration is deleted only after the old link's last publish landed, and not if the tools went back to it meanwhile. Without a credentialed pairing the links close and calls fail `NOT_PAIRED`. Known limitation: calls in flight when the tools move are lost (their results go to the new link, which does not know them; the old device's call times out). Publishing to several devices at once is not built.
- Tools whose real work exceeds the call deadline return `accepted` and report the outcome later with `POST /devices/:id/speak` (§6.4), which uses clt01's idle-aware announce (§12).

### 6.3 The agents plugin on tool hosting (D9)

The `agents` client hosts:

| Tool | Parameters | Result |
|---|---|---|
| `ask_agent` | `prompt`; `mode`: `auto` \| `idle` \| `continue` \| `session`; `target` (only with `session`) | `{ status: accepted \| rejected, task_id, reason? }`; ambiguous or missing targets come back as `needs_clarification` with the candidates |
| `cancel_task` | `task_id` (optional: the latest task of this device) | `{ status: canceled \| not_found }` |

The descriptions carry today's `agent.ask` rules (you cannot see the computer; an accepted task is pending, never guess its outcome; never invent a target), within clt01's 512-character description limit; the routing rules move into the `mode` / `target` parameter descriptions. Routing behind `ask_agent` is the existing router: push session → listening session → background session → refusal.

As built (phase 4, `src/agentd/daemon/agents-host.mjs`):

- `agents` is not an IPC client: agentd itself publishes the integration (name `agents`) for every pairing with a client credential, and feeds `ask_agent` into the Router as a device message. It is the Router's, App's and Dispatcher's only device link.
- The `ask_agent` call is the device's waiting call: the Router's accept answers it `accepted`; a refusal answers it `rejected` with the reason. If no session has taken the task 2 s before clt01's 20 s deadline, the call is answered `accepted` and the task stays open; whatever happens later is spoken like a final answer.
- Final answers, `codie_notify` and turn-end reminders are spoken with clt01 `GET /v1/api/data/user/slot` + `POST /v1/api/data/user/tts/utterances` (verbatim, in the active character's voice) until C3 exists. That route is not idle-aware: while the device is busy it refuses, and agentd retries three times (5 s, 10 s, 15 s). Answers for an offline device are not queued.
- `cancel_task` ends the device's latest (or the named) tool-hosting task and tells its session.

### 6.4 Device routes

| Group | Routes | Users |
|---|---|---|
| Sessions | `/status`, `/sessions`, `/sessions/:id/{close,events,delivered,interrupted,tools/:name}`, `/hooks/:route`, `/shutdown` — **same contract as the JS agentd** | plugin `mcp`, `hook`, `inbox` |
| Clients | `POST /clients`, `POST /clients/:id/close`, tool hosting (§6.2) | all clients |
| Devices | `GET /devices` (scan + paired + online), `POST /devices/:id/pair/{begin,confirm,cancel}`, `DELETE /devices/:id` | plugins, game_buddy |
| Device API | `ANY /devices/:id/api/*` — forwarded to `/v1/api/*` on the device, signed by the daemon, within the caller's scope | plugins, game_buddy, other clients |
| Conveniences | `POST /devices/:id/speak` (idle-aware announce, §12), `POST /devices/:id/chat/turns` (image + text; daemon downscales/re-encodes the image to ≤ 1 MiB), model upload with firmware tiers (from workshop_api `facade.go`) | plugins, game_buddy, other clients |

- Pass-through is the default so every 1.5.3 endpoint is reachable without per-endpoint code; conveniences exist only where the daemon adds value (compression, multi-step flows, firmware tiers).
- `:id` is the device id; omitted when exactly one device is paired.
- **Built 2026-10-29 as client routes** (there `:id` is the client id; a client token reaches only `/clients/:id/...`): `POST /clients/:id/api` `{ method, path, body }` within `scope.api`; `POST /clients/:id/chat-turns` `{ image, text, speech, interrupt, retention, tools, wait_ms }` (JPEG/PNG ≤ 1 MiB; the client compresses, the daemon does not re-encode, the device scales; `interrupt: false` asks the device to fail the turn with `DEVICE_BUSY` rather than end a conversation in progress, sent to the device only when false because older firmware rejects unknown fields; `retention` (agentd 37, clt01 PR #206) is `full` (default), `chat` (chat history, no context maintenance) or `none` (no history, stored image or maintenance; the reply only in `assistant_text`), sent only when not `full`; `tools` (agentd 47) is `all` (default: the device's model may call the device tools and the ext.* tools online) or `none` (the model is offered no tool for the turn), sent only when `none`; `wait_ms` up to 180 s since agentd 36 (60 s before), exported to clients as the SDK's `TURN_WAIT_MAX_MS`, so a client can wait for a spoken turn to be heard to its end: game_buddy's chatty mode, where a remark longer than 30 s ended the wait early and the next one was refused as busy); `GET /clients/:id/devices` and `POST /clients/:id/pair/{begin,confirm,cancel}` with `scope.pair`. They act on the tools device (§6.2, `toolDevice`); `toolsReady` on pair confirm means the device issued a client credential and so became the tools device; a pair-scope client therefore changes where every client's tools go (logged). `speak`, unpair for clients and model upload are not built. Since agentd 34 (2026-11-02) the pair routes answer `{ ok, code, deviceName?, toolsReady? (confirm), message }`: `code` is a stable outcome a program words itself (agentd's own `PAIR_STARTED`, `PAIRED`, `CANCELLED`, `DEVICE_NOT_SCANNED`, `NO_PAIRING_IN_PROGRESS`, `DEVICE_UNREACHABLE`, `CREDENTIAL_NOT_ISSUED`, `DEVICE_NOT_SIGNED_IN`, `PAIR_FAILED`, or the device's code unchanged, `src/agentd/pairing.mjs`); `message` stays the agent wording of the MCP tools.
- `tool-integrations` paths are reserved for the daemon; clients use §6.2.

### 6.5 Plugin MCP tools

Existing tools keep their names and behavior. New tools, first batch:

- `codie_notify` gains an optional `text` (today it always plays the fixed `REMINDER`, `src/app.mjs:22`).
- `codie_say` — speak text via TTS, optional `voice_id`.
- `codie_character_get` / `codie_character_set`.
- `codie_look` — image (path) + prompt → device `chat/turns` `image_text`, speech on device.
- `codie_device_api` — escape hatch over the pass-through route.

Later batches follow workshop_api's capability groups (alarms, memos, diary, memory cards, lights, music, voices, models).

## 7. Errors

The IPC returns `{ code, message }` with a fixed set shared by all clients:

| Code | When |
|---|---|
| `NOT_PAIRED` | no pairing for the device |
| `DEVICE_OFFLINE` | device not reachable |
| `FIRMWARE_TOO_OLD` | credential route 404, or firmware < 1.5.3 |
| `REPAIR_REQUIRED` | pairing has no client credential, or the device answers `LOCAL_SESSION_REVOKED` / `LOCAL_SESSION_EXPIRED` (the pairing is marked) |
| `SCOPE_DENIED` | the request is outside the client's approved scope |
| `TOOL_CATALOG_INVALID` | the catalog fails clt01's schema subset or limits |
| `DEVICE_ERROR` | any other device error; carries the device's `code`, `message` and HTTP status unchanged |

## 8. Testing

- Unit tests per module (`node --test`).
- **Parity suite for phase 2**: WS frames and flow scenarios extracted from the current plugin tests (`codie-claude-plugin/test/*.test.mjs`) keep passing after the move into codie-host; this is the evidence that the move changes no behavior.
- Device API and tool hosting against a fake clt01 HTTP/WS server: signing, pass-through, scope checks, catalog validation, invoke/result relay, reconnect, error mapping, image downscaling, firmware tiers.
- clt01: permission matrix tests (master / session / client × admin / data / resources / credentials / tool-integrations).
- Live device tests behind env vars, skipped by default (as workshop_api's `CLT01_LIVE_*`).
- CI on windows, macOS and linux.

## 9. Phases

| Phase | Scope | User-visible result |
|---|---|---|
| 0 | **Feasibility spike** (Go, throwaway) on macOS and Windows. Windows passed 2026-10-26; macOS deferred. Its mDNS/WS v1 checks no longer matter (§10). | none |
| 1 | clt01 (owner, §12): client credential, D7, console 403 hint; idle-aware HTTP announce; external tools offered to the company cloud model | new firmware |
| 2 | Move the plugin's agentd (router, dispatch, link, mcp/hook/inbox entry points) into codie-host unchanged; the Claude and Codex plugins depend on it | same features, one daemon. **Built 2026-10-28**: `src/agentd/`; the plugins keep only the session side (MCP server, inbox, hooks, statusline) and pass their service APK pins to `runAgentd` (ignored since 2026-10-30) |
| 3 | Device API, clients with token and scope, credential on pairing | game_buddy can integrate. **Built 2026-10-28** and, 2026-10-29, the device API pass-through, image chat turns and client pairing (§6.4): tool clients register on agentd's IPC (`daemon/tool-hosting.mjs`), pairing issues a client credential, unpair revokes it; the `codie` command line drives agentd |
| 4 | Tool hosting; `ask_agent` / `cancel_task` replace `agent.ask` on new firmware | voice tasks through `ext.*`; local tools callable by Codie. **Built 2026-10-28**; the only path since 2026-10-30 (§10) |
| 5 | Plugin MCP tools, batch by batch (first: §6.5) | Claude makes Codie say specific things, look at images, change the character |
| 6 | Retire the transition path once phase 1 firmware is everywhere: drop `link/`, stop installing codie-agent-service, archive its repo and the plugins' `service-apk/`; workshop_api README marked deprecated → codie_host; workspace `CLAUDE.md` updated | one channel. **Done in codie_host 2026-10-30** (§10); the plugins' `service-apk/`, the repo archive and the docs are still to do |

Each phase gets its own implementation plan.

## 10. Transition

Retired in codie_host 2026-10-30. Old firmware (before clt01 retired codie-agent-service) is not supported, with no fallback: its `pair/confirm` issues no client credential, so pairing fails and saves nothing. The daemon no longer installs codie-agent-service, advertises `_codie._tcp`, listens on WS v1 :9530, hands the port over from the JS agentd or migrates its pairings; the `agentsVia` switch and `codie agents tools on|off` are gone. Every pairing has a client credential, and voice tasks always arrive as `ask_agent` (§6.3). mDNS is used only to discover devices (`_codie-config._tcp`).

## 11. Open items

- **Daemon at login**: tools that must answer voice at any time keep the daemon alive while they run; whether `codie daemon` should also install itself as a login item is not decided.
- **Apple Developer ID**: needed to sign and notarize game_buddy's macOS app. Plugins are installed by git clone and are not quarantined, so they are not blocked by it.

## 12. Dependencies on the clt01 owner

codie-host cannot ship phases 4 and 6 without these clt01 changes. They are requests to the clt01 owner, not codie-host work.

| # | Change | Why |
|---|---|---|
| C1 | Client credential and D7 (§4) | **Done** in 261027161 (`338d6a722`, `bb5bf8525`) |
| C2 | Offer external tools to the company cloud model: remove the custom-model-only rule (`AllowsExternalTools` in `src/services/ai/harness/external_tools.go`, from `64a451f6b`), including the external result history | Decided in the 2026-10-28 meeting; without it `ask_agent` would regress on the company cloud |
| C3 | Idle-aware announce over HTTP (same behavior as the WS `device.command announce` in `src/services/agent/devicecommand.go`: speak when idle, hold while busy, ≤ 200 runes) | Delivers results of tools that outlive the call deadline, and `codie_notify`, without WS v1 |
| C4 | Client credentials accepted on `/v1/ws/tool-integrations/*` | **Already true**: the WS check resolves `session_id` through `resolveLocalAuthSecret`, which accepts client credentials |
| C5 | Let a catalog declare a tool as async (`completion: "async"`): a succeeded result then ends the tool stage after one reply, as the retired `agent.ask` receipt did. Result data stays unable to control the lifecycle (`externaltools/manager.go:342`) | Found on device 2026-10-28: the model re-calls `ask_agent` within one turn (codie_host dedupes per `turn_id` meanwhile) |
| C6 | Short per-request upstream aliases for external tools instead of `ext_<32 hex>_<name>` (`externaltools/catalog.go:70`) | Found on device 2026-10-28: the model mistyped the hex, the cloud answered "undeclared tool" |
| B1 | Do not send `tool_choice` when a request has no tools (`cloude2e/llm.go:146`; `runner.go:306-317` keeps the policy on the final round) | Found on device 2026-10-28: every local_harness turn on the company cloud that ends its tool stage fails, alarm prepare too |

C3 became blocking with `9c2899064`, which removed the WS announce path (`handle_device_announce.go`, `HandleAgentResultTTS`): until it exists codie_host speaks results with `tts/utterances` after polling `ai/backend` `active_state` for Idle, and those results never enter the chat history. Details and evidence: `docs/handoff/2026-10-28-clt01-requests.md`.

## 13. Out of scope

- game_buddy itself and other tools (their own projects; consume §6).
- `twitter_read_play` and other workshop_api consumers.
- Encrypting the pairing exchange (`pair/confirm` returns the master secret over plain HTTP on the LAN). Noted; separate effort.
- Restricting `install/service` to package `com.codie.agent` and its signing certificate in `ApkInstaller` (moot once codie-agent-service is retired; D7 already keeps non-master credentials away from it).
