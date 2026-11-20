# Per-vendor service APK + device client credential — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Install the codie-agent-service APK signed with the device's own platform key: today the plugins ship only a `code27`-signed APK, so they cannot install on YGKJ devices. (B) Phase 1 of the codie-host spec: persisted, scoped client credentials on clt01, with `/v1/api/admin/*` accepting the master secret only.

**Architecture:** clt01 reports the SHA-256 of its own signing certificate. That certificate is the device platform certificate, because clt01 runs as the system uid. The plugins pin one APK per certificate and pick the one whose certificate matches. codie-agent-service builds per vendor with `-Pvendor=<id>`. Client credentials reuse the existing `X-Local-Session-Id` signing path; `LocalAuthGuard` enforces scope by credential kind and path prefix.

**Tech Stack:** Go (gin, gorm, sqlite) + Kotlin (clt01_embed_backend), Kotlin/Gradle (codie-agent-service), Node ESM (codie-plugin-for-agents).

**Spec:** `docs/specs/2026-10-26-codie-host-design.md` §4 (B). A comes from the phase 0 findings (`docs/spikes/2026-10-26-phase0-results.md`, finding 2).

## Global Constraints

- Delivery: clt01_embed_backend → feature branch + pull request to `master`. codie-agent-service and codie-plugin-for-agents → commit and push to `main` directly.
- Follow each repo's own CLAUDE.md/AGENTS.md. clt01: Chinese logs, English identifiers, `gofmt`. Plugin: English only, kebab-case `.mjs`, build **both** plugins after shared `src` changes (`dist/` is committed).
- Windows: a known set of plugin tests fails regardless of changes. Compare against a baseline run before attributing failures.
- **Contract 1 — certificate digest:** `GET /v1/api/admin/install/service/status` adds `"platformCertSha256": "<64 lowercase hex>"` to `data` (camelCase, like the existing `versionCode`/`versionName`). It is the SHA-256 of the DER-encoded signing certificate of clt01's own package (`signingInfo.apkContentsSigners[0]`). `""` when unknown. This is the same digest `apksigner verify --print-certs` prints as `certificate SHA-256 digest`.
- **Contract 2 — APK naming:** pinned APK file `codie-agent-service-<versionName>-<vendor>.apk`. All vendors of one version share the Release tag `codie-agent-service-v<versionName>`.
- **Fallback:** a device whose status lacks `platformCertSha256` (older firmware) gets the `code27` APK, which is today's behavior.
- Signing secrets in `clt01_embed_backend/config/vendors.properties` are never printed, logged or committed anywhere else.

---

## Part A — per-vendor APK

### Task A1: clt01 reports its platform certificate digest

**Files:**
- Modify: `Codie/Clients/clt01_embed_backend/go-library/aar/clt01_lib.go` (`ServiceInstaller` interface + `serviceInstallerAdapter`)
- Modify: `Codie/Clients/clt01_embed_backend/src/services/serviceinstall/installer.go` (`Installer` interface; new `PlatformCertSha256() (string, error)`)
- Modify: `Codie/Clients/clt01_embed_backend/src/services/handlers_gin/web/admin_install_status_gin.go`
- Modify: `Codie/Clients/clt01_embed_backend/android/app/src/main/java/com/clt01/embed/system/ServiceInstallerAdapter.kt`, `ApkInstaller.kt`
- Test: `src/services/handlers_gin/web/admin_install_status_gin_test.go` (create)

**Interfaces:**
- Produces: gomobile `ServiceInstaller.GetPlatformCertSha256() string`; Go `serviceinstall.PlatformCertSha256() (string, error)` (error only when no installer is registered); Contract 1.

- [ ] Write a failing handler test: register a fake installer returning version 12/"1.9"/installed and digest `"ab"*32`, call the handler through gin's test recorder, and assert `data.platformCertSha256 == "abab…"`. Add a second case where the fake returns `""`: the field is present and empty.
- [ ] Run `go test ./src/services/handlers_gin/web/ -run InstallStatus`; expect FAIL.
- [ ] Add the method to both Go interfaces and the aar adapter. The handler adds the field.
- [ ] Kotlin: `ApkInstaller.platformCertSha256(context)` reads `packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo.apkContentsSigners[0].toByteArray()`, computes SHA-256, and returns lowercase hex. On any exception it logs and returns `""`. The adapter forwards to it.
- [ ] `go test ./src/services/...` and `go vet ./...` pass; the Kotlin compiles (`cd android && ./gradlew :app:compileReleaseKotlin` or the repo's documented equivalent).
- [ ] Commit on branch `feat/client-credential-and-platform-cert`.

### Task A2: codie-agent-service builds per vendor

**Files:**
- Modify: `Codie/Clients/codie-agent-service/app/build.gradle.kts` (vendor resolution, currently fixed to `code27`)
- Modify: `Codie/Clients/codie-agent-service/CLAUDE.md` (signing section)

- [ ] Replace the fixed `code27` vendor with `project.findProperty("vendor") ?: "code27"`. It reads `vendor.<id>.sign.*` from the sibling clt01 `config/vendors.properties`, and an unknown id fails at configuration time with a clear message. The four-property `PLATFORM_KEYSTORE_*` override keeps precedence.
- [ ] Verify with `./gradlew :app:assembleRelease -Pvendor=ygkj` and `-Pvendor=code27`, using `apksigner verify --print-certs` on each output. The two digests must differ, and the `ygkj` one must equal the digest of the YGKJ device's clt01 (read it with `adb shell dumpsys package com.clt01.embed`, or compute it from the installed APK).
- [ ] Update CLAUDE.md: building per vendor, default `code27`.
- [ ] Commit and push `main`; record the new commit for the plugin's submodule bump.

### Task A3: plugins pin and pick one APK per certificate

**Files:**
- Modify: `codie-plugin-for-agents/scripts/pin-service-apk.mjs` — `node scripts/pin-service-apk.mjs <apk>:<vendor> [<apk>:<vendor> …]`. Each APK's cert digest comes from `apksigner verify --print-certs` (build-tools from `ANDROID_HOME`). Versions must match across APKs. It writes `SERVICE_APKS` (array) and copies each APK to `service-apk/<file>`.
- Modify: `codie-claude-plugin/src/service-apk-pin.mjs` (generated)
- Modify: `codie-claude-plugin/src/service-apk.mjs` — `pickServiceApk(pins, certSha256)`: the entry whose `certSha256` matches; a missing or empty digest falls back to the `code27` entry; a digest with no match fails with a message that names the digest.
- Modify: `codie-claude-plugin/src/clt01.mjs` (`serviceStatus` returns `platformCertSha256`), `src/app.mjs` (`#ensureService` picks the pin from the status before comparing versions and installing), `src/daemon/agentd-core.mjs` (passes the pin list; `load(pin)`).
- Modify: `scripts/publish-codie-plugins.sh` (checks/uploads every pinned APK to the one tag)
- Modify: `codie-agent-service` submodule pointer → A2 commit
- Test: `codie-claude-plugin/test/service-apk.test.mjs` and the `app`/router tests that cover `#ensureService`

- [ ] Write failing tests:
  - `pickServiceApk` covers a match, an empty digest (falls back to code27), and an unknown digest (error).
  - `#ensureService`: a status with a ygkj digest makes it load and install the ygkj APK; a status without the field installs code27.
- [ ] Implement until green. Run the plugin test suite and compare it with a baseline run taken before the change.
- [ ] Build the A2 APKs for both vendors, pin them with `<apk>:code27 <apk>:ygkj` at the current versionName, and commit the pin together with `service-apk/`.
- [ ] `npm run build` in both plugins and commit `dist/`. Bump the plugin version per `docs/runbooks/codie-plugin-publish.md` only if a release is being cut. **Not part of this task**: releasing is a separate decision.
- [ ] Push `main`.

---

## Part B — client credential (clt01_embed_backend, same branch as A1)

### Task B1: storage

**Files:**
- Create: `src/framework/middleware/sql/init/37_init_usr_local_client_credentials.sql`
- Create: `src/framework/middleware/sql/v1.1.4/001_usr_local_client_credentials.sql` (same DDL; existing devices). Before naming the directory, confirm `v1.1.4` is the next version and that fresh databases baseline the versioned scripts (`orm/gorm.go` `baselineFreshDatabaseMigrations`).
- Create: `src/services/models/local_client_credential.go` (+ `_test.go`)

Table `local_client_credentials`: `id TEXT PRIMARY KEY` (uuid), `secret TEXT NOT NULL`, `label TEXT NOT NULL DEFAULT ''`, `master_secret_hash TEXT NOT NULL` (hex SHA-256 of the master secret at issue time), `created_at DATETIME`, `last_used_at DATETIME`.

**Interfaces (produces):** `CreateLocalClientCredentialWithDB(db, label, masterSecretHash string) (*LocalClientCredential, error)` (generates id + 32-byte hex secret); `GetLocalClientCredentialWithDB(db, id)`; `ListLocalClientCredentialsWithDB(db)`; `DeleteLocalClientCredentialWithDB(db, id) (bool, error)`; `TouchLocalClientCredentialWithDB(db, id, at)`; plus `orm.GetUserDB()` wrappers, following `pending_service_pairing.go`.

- [ ] Write failing model tests on an in-memory sqlite database with the init DDL applied: create→get, list omits nothing, delete returns `true` then `false`, touch updates `last_used_at`.
- [ ] Implement; tests pass; commit.

### Task B2: verification and scope

**Files:**
- Modify: `src/framework/auth/sign.go` (`resolveLocalAuthSecret`, `LocalAuthorization`)
- Modify: `src/framework/routes/local_auth.go`
- Test: `src/framework/auth/local_client_credential_test.go`, `src/framework/routes/local_auth_scope_test.go`

Rules:
- `X-Local-Session-Id` is looked up in in-memory sessions first, then in `local_client_credentials`. A client row whose `master_secret_hash` differs from the current master secret is deleted and returns `ErrLocalSessionRevoked` (same as sessions).
- `LocalAuthorization` gains `Kind` (`master` | `session` | `client`) and `CredentialID`.
- After a successful verification in `LocalAuthGuard`, scope applies. A non-master credential on `/v1/api/admin/*` gets 403 with code `MASTER_CREDENTIAL_REQUIRED`. On `/v1/api/auth/credentials*`, a non-master credential is allowed only for `DELETE /v1/api/auth/credentials/<its own id>`; anything else gets 403 with the same code.
- A successful client request touches `last_used_at` (best effort; errors only logged).

- [ ] Write failing tests for the permission matrix: {master, session, client} × {`GET /v1/api/admin/install/service/status`, `GET /v1/api/data/user/system`, `POST /v1/api/auth/credentials`, `DELETE /v1/api/auth/credentials/<own>`, `DELETE /v1/api/auth/credentials/<other>`}, with expected status codes per the rules. Also: a client credential stops verifying after the master secret changes. Build the router with the real `LocalAuthGuard` and stub handlers.
- [ ] Implement; `go test ./src/framework/...` passes; commit.

### Task B3: credential routes and console hint

**Files:**
- Create: `src/services/handlers_gin/web/auth_credentials_gin.go` (+ `_test.go`)
- Modify: `src/framework/routes/routes.go` (`authGroup`: `POST/GET /credentials`, `DELETE /credentials/:id`)
- Modify: `frontend/src/views/lab/ApiDocs.vue`, `frontend/src/views/lab/System.vue` (or their shared API layer): on 403 with `MASTER_CREDENTIAL_REQUIRED`, show "Re-pair with 'Remember this device' checked to use this page" (localized as the console's existing strings are).

Responses (envelope as elsewhere):
- `POST {label}` → 200 `{id, secret, label, created_at_ms}`; an empty label becomes `"client"`.
- `GET` → 200 `{items:[{id, label, created_at_ms, last_used_at_ms}]}` (no secrets).
- `DELETE /:id` → 200 `{deleted:true}`, or 404 `CREDENTIAL_NOT_FOUND`.

- [ ] Write failing handler tests for the three routes, including that `GET` never returns `secret`.
- [ ] Implement; wire the routes; the scope rules from B2 apply automatically.
- [ ] Frontend: implement the hint; run the frontend's lint/type check (`npm run build` or the repo's documented check).
- [ ] `go test ./...` (compare with a baseline for pre-existing failures), `go vet ./...`, `gofmt -l` clean; commit.

### Task B4: pull request

- [ ] Push branch `feat/client-credential-and-platform-cert` (A1 + B1–B3) and open a pull request to `master` on git.service.code27.cn. Describe: the two features, contract 1, the D7 behavior change (session credentials lose `/admin/*`; console users must pair with "remember device" for lab pages), the new migration `v1.1.4/001`, and how it was tested. Report the PR URL.

---

## Order

A1 and B1–B3 share one clt01 branch and run in sequence there. A2 → A3 run in parallel with them; A3 depends only on contracts 1 and 2, not on the clt01 merge.
