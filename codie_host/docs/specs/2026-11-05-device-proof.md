# Device proof: the device proves it holds the credential

Status: agentd side on branch `feat/device-proof` (codie_host). It ships only
after clt01 firmware with the changes below is released: an agentd with this
change cannot talk to firmware without them (every tool-integration socket is
refused).

## Why

agentd signs every HTTP call and WebSocket upgrade with the client
credential (`sign.mjs`, clt01 `sign.go`), so the device knows the caller is
the paired computer. Nothing goes the other way: whatever answers at the
device's address is believed. A LAN host that takes over the device's IP
(DHCP, a device that is off), or announces the device's `device_id` over mDNS
after the device failed (`host-refresh.mjs` then moved the pairing to it),
could accept agentd's calls, send `ready` and then
`invoke ask_agent {prompt: …}`. agentd handed that prompt to the user's coding
agent as the user's own voice request, and sent task results and
`codie_notify` text to that host.

## Protocol (v1)

`proof = hex(HMAC-SHA256(secret, "codie-device-proof|v1|" + context + "|" + challenge))`

- `secret`: the secret of the credential that signed the request (the client
  credential for agentd; master or session secrets work the same way).
- `challenge`: 32 lowercase hex characters, fresh for each socket or request.
  The device rejects any other shape with 400 `INVALID_ARGUMENT`.

### 1. Tool-integration WebSocket `ready`

`GET /v1/ws/tool-integrations/<id>/executor?sig=…&challenge=<hex>` (the signed query
is unchanged; `challenge` is outside the signature, as are all query params).

The device adds `proof` to its `ready`, with `context = "ws:" + <integration id>`:

```json
{"type":"ready","data":{"protocol_version":"v1","integration_id":"<id>","revision":3,"proof":"<hex>"}}
```

agentd counts the socket only after a matching proof: before it, and when it
does not match, every `invoke` is ignored; on a mismatch agentd closes the
socket, retries with backoff, and looks for the device at another address.

clt01: the upgrade handler already resolved the secret while verifying the
signature (`tool_integrations_gin.go`, which calls `Serve`); pass the proof (or the secret) into
`externaltools.Manager.Serve`, which writes `ready` (`manager.go`).

### 2. `GET /v1/api/data/user/device-proof?challenge=<hex>`

Behind LocalAuthGuard (signed like any data route), `context = "http"`:

```json
{"success":true,"data":{"proof":"<hex>"}}
```

agentd calls it at a candidate address before moving a pairing there
(`host-refresh.mjs`): a device moves only to an address that proves the
pairing's credential.

## Test vectors

secret `client-secret`, challenge `00112233445566778899aabbccddeeff`:

| context | proof |
|---|---|
| `ws:3f1c2a4b-0d5e-5f60-8a71-92b3c4d5e6f7` | `3e40d7ffae8d82de3dc71da2295f2611e826d8f7048bbe79d52e4cd32f1192cf` |
| `http` | `a569ec7dcb69b7efec54a847b9a6eb50c63028b91d69d88ae8f93077e5cef306` |

## What this does not cover

An active man in the middle on the LAN (ARP spoofing) between a proven
device and agentd can still inject frames into an open plain `ws://`
socket or read pushes: that needs an encrypted, authenticated transport
(TLS with the device's certificate pinned at pairing, or a PAKE bound to the
pairing code), which also fixes the clear-text `pair/confirm` that returns
the master secret. Tracked separately.
