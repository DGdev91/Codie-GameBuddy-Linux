# Phase 0 feasibility results

Plan: `docs/plans/2026-10-26-phase0-feasibility-spike.md`. Binary: `spike/phase0` (`codie-spike`), built with Go 1.25.4, `CGO_ENABLED=0`.

## Windows — PASS (2026-10-26)

Host: Windows 11, interface `WLAN` 10.10.32.198. Device: `YGKJ2511921S00043` (10.10.32.60:8081, `rk3588s_yt921`, Android 12 userdebug). The Node agentd was running on 9530 the whole time; the spike used 9531.

| Check | Result | Note |
|---|---|---|
| interface | PASS | picked the interface on the device subnet |
| mdns-browse | PASS | 36 devices found via `_codie-config._tcp` in 4 s |
| pair-request / pair | PASS | |
| bootstrap | PASS | |
| signed-get (`/v1/api/data/user/system`) | PASS | Go signing accepted by real clt01 |
| ensure | PASS | |
| prefer-bridge | WARN | `403 CAPABILITY_REQUIRED` on this firmware; best-effort, as in the plugin |
| ws-listen / mdns-advertise | PASS | grandcat/zeroconf, pinned to one interface |
| ws-auth | PASS | device connected ~2 s after advertising and authenticated |

No Windows Firewall prompt appeared (the interface was already on a private network profile).

## macOS — deferred

Decided 2026-10-26: not tested in phase 0. Development will continue on a Mac, so the macOS checks (Task 6 steps 2-3: mDNS next to mDNSResponder, Local Network permission when launched from Terminal and when started in the background by Claude Code) run there, with `spike/phase0/dist/codie-spike-darwin-*`, as the first step of phase 2 work on macOS. Until then, macOS remains an open risk for D4.

## Findings that change the plan

1. **Release firmware up to 1.5.3 blocks service install.** On clt01 branches `1.3.0`…`1.5.3`, `POST /admin/install/service` and `POST /admin/agent/prefer-bridge` are behind feature-policy capabilities that the `release` / `exhibition` feature tags disable (`origin/1.5.3:src/framework/featurepolicy/feature_policy.go`, `fallbackConfig`). The plugin's pairing on this device failed with `CAPABILITY_REQUIRED`. The gates were removed on master in `4b57b7624` (2026-10-23), present on `master` and `1.6.0` only. Consequence: on release firmware before 1.6.0 **even voice tasks do not work** unless codie-agent-service is preinstalled.
2. **Two platform signing vendors; the plugin ships only one.** `clt01_embed_backend/config/vendors.properties` defines `code27` and `ygkj` (default `ygkj`). The plugin pins a `code27`-signed APK; on a YGKJ device `adb install` fails with `INSTALL_FAILED_SHARED_USER_INCOMPATIBLE`. YGKJ devices cannot get the service from the plugin on any firmware. For this spike a `ygkj`-signed build (versionName 1.8, from `Codie/Clients/codie-agent-service` at `69ece39`) was installed over USB adb.
3. **Go dependencies:** zeroconf v1.0.0 pulls `golang.org/x/net` from 2020, which fails to link for darwin with current Go (`invalid reference to syscall.recvmsg`). Pinned `x/net v0.47.0`, `x/sys v0.38.0`, `x/crypto v0.45.0` (the latest releases require Go 1.26).

## Device state left behind

- `YGKJ2511921S00043` now runs the `ygkj`-signed codie-agent-service 1.8.
- Three spike bridge pairings were provisioned into its service allowlist (bridge ids `4286507a…` (unprovisioned: confirm only), `de78327d…`, `c6149704…`). Nothing advertises them once the spike exits, so the service ignores them.
- The plugin's pairing for this device was saved but never provisioned (its install step failed first), so the plugin still cannot reach this device until it is paired again.

## Verdict

Windows: D4 (Go) holds for the full device link. macOS deferred to the first development session on a Mac. Findings 1 and 2 are product issues independent of codie-host and need decisions (firmware rollout of 1.6.0; per-vendor service APKs).
