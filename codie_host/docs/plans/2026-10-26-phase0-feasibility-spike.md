# Phase 0 Feasibility Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a single Go binary can do, on Windows and macOS, everything the device link needs: pair with clt01, make signed HTTP calls, advertise `_codie._tcp` over mDNS, and accept codie-agent-service's WS v1 connection and auth.

**Architecture:** A throwaway CLI `codie-spike` in its own Go module under `spike/phase0/` (kept out of the future root module). Four small packages: `sign` (clt01 HMAC), `clt01` (pairing and signed GET), `mdns` (advertise and browse via `github.com/grandcat/zeroconf`), `wsserver` (WS v1 auth via `github.com/gorilla/websocket`). One command, `run`, wires them and prints `PASS`/`FAIL` per check. Results go into a results doc. The code is deleted when phase 2 starts.

**Tech Stack:** Go 1.25 (installed: go1.25.4 windows/amd64), grandcat/zeroconf, gorilla/websocket.

**Spec:** `docs/specs/2026-10-26-codie-host-design.md` (§9 phase 0, §10 open items)

## Global Constraints

- English only in code, comments, docs (same rule as the plugin repo).
- Throwaway: no package outside `spike/phase0/` may import it.
- Do not stop or disturb the running Node agentd: the spike listens on its own port (`--ws-port`, default 9531). The device learns the port from the mDNS SRV record.
- The spike creates a **new pairing** on the device (its own `bridge_id`); it never reads or writes `~/.codie`. While it runs, the service may pick the spike's bridge over the Node agentd (it holds one bridge connection at a time, `connection_manager.cpp:113-146`), so voice tasks to Claude Code may pause until the spike exits.
- Wire facts (verified in source, do not change):
  - Signature: `hex(HMAC-SHA256(secret, "METHOD|path|timestamp|nonce|payloadMode|bodyHash|userID"))`; headers `X-Local-Sig/-Nonce/-Timestamp/-Payload-Mode/-Body-Hash/-User-Id`; JSON mode `json`, body hash `sha256(body)` (empty body → `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`). Source: `codie-plugin-for-agents/codie-claude-plugin/src/clt01.mjs:14-34`.
  - Pairing: `POST /v1/api/auth/pair/request {}` → `{data:{challenge_id, expires_at_ms}}`; `POST /v1/api/auth/pair/confirm {challenge_id, pairing_code}` → `{data:{local_secret, bridge_id, service_secret, has_service, device_id, name}}`; `GET /v1/api/auth/bootstrap` → `{data:{user_id}}`; signed `POST /v1/api/auth/pair/ensure {bridge_id, service_secret}`; signed `POST /v1/api/admin/agent/prefer-bridge {bridge_id:""}`. Failures: non-2xx or `success:false` with `message`/`code`.
  - mDNS: advertise type `_codie._tcp`, instance `codie-spike-<bridge_id[:8]>`, TXT `bridge_id=<bridge_id>`, IPv4 only, pinned to the interface on the device's subnet. The service ignores bridges whose `bridge_id` it was not provisioned with (`codie-agent-service/.../MdnsDiscovery.kt:103`, `PairingFilter.kt`).
  - Device control plane browse: `_codie-config._tcp`, TXT `device_id`, `name`, `ipv4` (csv); use the IP from TXT, not A records (`src/mdns.mjs:4-16`).
  - WS v1: plain WS on `/`; device sends `{"v":1,"type":"auth","deviceId":"…","secret":"<service_secret>"}`; reply `{"v":1,"type":"auth_result","success":true,"deviceId":"…"}` then `{"v":1,"type":"gateway_status","connected":true}`; unknown secret → `auth_result` with `success:false` and close (`src/link.mjs:259-276`, `src/protocol.mjs:10-23`).

---

### Task 1: Module scaffold and clt01 signing

**Files:**
- Create: `spike/phase0/go.mod`
- Create: `spike/phase0/sign/sign.go`
- Test: `spike/phase0/sign/sign_test.go`

**Interfaces:**
- Produces: `sign.Headers(method, path, payloadMode, bodyHash, secret, userID, ts, nonce string) map[string]string`; `sign.BodyHash(body []byte) string`.

- [ ] **Step 1: Scaffold the module**

```bash
cd spike/phase0 && go mod init codie_host/spike/phase0
```

- [ ] **Step 2: Write the failing test** (vector computed with the plugin's Node implementation)

```go
package sign

import "testing"

func TestHeadersMatchPluginVector(t *testing.T) {
	bh := BodyHash(nil)
	if bh != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("body hash %s", bh)
	}
	h := Headers("GET", "/v1/api/data/user/system", "json", bh, "s3cret", "user-1", "1700000000", "abc123")
	want := map[string]string{
		"X-Local-Sig":          "f5ee203f44f111295dbaf4c7a08d03fdb07ab06fbcd4b5ebceb3e5cc5b7ca67e",
		"X-Local-Nonce":        "abc123",
		"X-Local-Timestamp":    "1700000000",
		"X-Local-Payload-Mode": "json",
		"X-Local-Body-Hash":    bh,
		"X-Local-User-Id":      "user-1",
	}
	for k, v := range want {
		if h[k] != v {
			t.Errorf("%s = %q, want %q", k, h[k], v)
		}
	}
}
```

- [ ] **Step 3: Run it, expect a compile failure**

Run: `go test ./sign/` — Expected: FAIL, `undefined: BodyHash`.

- [ ] **Step 4: Implement**

```go
// Package sign implements clt01's LocalAuthGuard request signature.
package sign

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

func BodyHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func Headers(method, path, payloadMode, bodyHash, secret, userID, ts, nonce string) map[string]string {
	canonical := strings.Join([]string{method, path, ts, nonce, payloadMode, bodyHash, userID}, "|")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	return map[string]string{
		"X-Local-Sig":          hex.EncodeToString(mac.Sum(nil)),
		"X-Local-Nonce":        nonce,
		"X-Local-Timestamp":    ts,
		"X-Local-Payload-Mode": payloadMode,
		"X-Local-Body-Hash":    bodyHash,
		"X-Local-User-Id":      userID,
	}
}
```

- [ ] **Step 5: Run, expect PASS; commit**

```bash
go test ./sign/
git add spike/phase0 && git commit -m "chore(spike): scaffold phase0 module with clt01 signing"
```

---

### Task 2: clt01 pairing client

**Files:**
- Create: `spike/phase0/clt01/client.go`
- Test: `spike/phase0/clt01/client_test.go`

**Interfaces:**
- Consumes: `sign.Headers`, `sign.BodyHash`.
- Produces:
  - `type Client struct { Base string; HTTP *http.Client }`, `func New(hostPort string) *Client` (Base `http://<hostPort>`, 15 s timeout)
  - `type Pairing struct { LocalSecret, BridgeID, ServiceSecret, DeviceID, Name string; HasService bool }`
  - `func (c *Client) PairRequest(ctx) (challengeID string, err error)`
  - `func (c *Client) PairConfirm(ctx, challengeID, code string) (Pairing, error)`
  - `func (c *Client) UserID(ctx) (string, error)` (bootstrap)
  - `func (c *Client) Signed(ctx, method, path string, body any, secret, userID string) (json.RawMessage, error)` — returns the envelope's `data`

- [ ] **Step 1: Write the failing test** — a fake clt01 that verifies the signature with the same algorithm and serves the pairing routes

```go
package clt01

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codie_host/spike/phase0/sign"
)

func fakeDevice(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		write := func(data any) { json.NewEncoder(w).Encode(map[string]any{"success": true, "data": data}) }
		switch r.URL.Path {
		case "/v1/api/auth/pair/request":
			write(map[string]any{"challenge_id": "ch-1", "expires_at_ms": 1})
		case "/v1/api/auth/pair/confirm":
			var in map[string]string
			json.Unmarshal(body, &in)
			if in["challenge_id"] != "ch-1" || in["pairing_code"] != "123456" {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]any{"success": false, "message": "bad code", "code": "PAIRING_CODE_INVALID"})
				return
			}
			write(map[string]any{"local_secret": "s3cret", "bridge_id": "b-1", "service_secret": "ss", "has_service": true, "device_id": "d-1", "name": "Codie"})
		case "/v1/api/auth/bootstrap":
			write(map[string]any{"user_id": "user-1"})
		default:
			h := sign.Headers(r.Method, r.URL.Path, r.Header.Get("X-Local-Payload-Mode"), sign.BodyHash(body), "s3cret",
				r.Header.Get("X-Local-User-Id"), r.Header.Get("X-Local-Timestamp"), r.Header.Get("X-Local-Nonce"))
			if h["X-Local-Sig"] != r.Header.Get("X-Local-Sig") || r.Header.Get("X-Local-Body-Hash") != sign.BodyHash(body) {
				w.WriteHeader(401)
				json.NewEncoder(w).Encode(map[string]any{"success": false, "message": "bad sig", "code": "INVALID_SIGNATURE"})
				return
			}
			write(map[string]any{"path": r.URL.Path})
		}
	}))
}

func TestPairThenSigned(t *testing.T) {
	srv := fakeDevice(t)
	defer srv.Close()
	c := New(strings.TrimPrefix(srv.URL, "http://"))
	ctx := context.Background()

	ch, err := c.PairRequest(ctx)
	if err != nil || ch != "ch-1" {
		t.Fatalf("PairRequest = %q, %v", ch, err)
	}
	p, err := c.PairConfirm(ctx, ch, "123456")
	if err != nil || p.LocalSecret != "s3cret" || p.BridgeID != "b-1" || p.ServiceSecret != "ss" {
		t.Fatalf("PairConfirm = %+v, %v", p, err)
	}
	uid, err := c.UserID(ctx)
	if err != nil || uid != "user-1" {
		t.Fatalf("UserID = %q, %v", uid, err)
	}
	if _, err := c.Signed(ctx, "GET", "/v1/api/data/user/system", nil, p.LocalSecret, uid); err != nil {
		t.Fatalf("signed GET: %v", err)
	}
	if _, err := c.Signed(ctx, "POST", "/v1/api/auth/pair/ensure", map[string]string{"bridge_id": "b-1", "service_secret": "ss"}, p.LocalSecret, uid); err != nil {
		t.Fatalf("signed POST: %v", err)
	}
	if _, err := c.Signed(ctx, "GET", "/v1/api/data/user/system", nil, "wrong", uid); err == nil || !strings.Contains(err.Error(), "INVALID_SIGNATURE") {
		t.Fatalf("wrong secret err = %v", err)
	}
	if _, err := c.PairConfirm(ctx, ch, "000000"); err == nil || !strings.Contains(err.Error(), "PAIRING_CODE_INVALID") {
		t.Fatalf("bad code err = %v", err)
	}
}
```

- [ ] **Step 2: Run it, expect a compile failure** — `go test ./clt01/` → `undefined: New`.

- [ ] **Step 3: Implement**

```go
// Package clt01 is a minimal clt01 pairing and signed-request client.
package clt01

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"codie_host/spike/phase0/sign"
)

type Client struct {
	Base string
	HTTP *http.Client
}

type Pairing struct {
	LocalSecret   string `json:"local_secret"`
	BridgeID      string `json:"bridge_id"`
	ServiceSecret string `json:"service_secret"`
	HasService    bool   `json:"has_service"`
	DeviceID      string `json:"device_id"`
	Name          string `json:"name"`
}

func New(hostPort string) *Client {
	return &Client{Base: "http://" + hostPort, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

type envelope struct {
	Success *bool           `json:"success"`
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func (c *Client) do(ctx context.Context, method, path string, body any, headers map[string]string) (json.RawMessage, error) {
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	var env envelope
	_ = json.NewDecoder(res.Body).Decode(&env)
	if res.StatusCode/100 != 2 || (env.Success != nil && !*env.Success) {
		return nil, fmt.Errorf("%s %s: HTTP %d %s %s", method, path, res.StatusCode, env.Code, env.Message)
	}
	return env.Data, nil
}

func (c *Client) PairRequest(ctx context.Context) (string, error) {
	data, err := c.do(ctx, "POST", "/v1/api/auth/pair/request", map[string]any{}, nil)
	if err != nil {
		return "", err
	}
	var out struct {
		ChallengeID string `json:"challenge_id"`
	}
	if err := json.Unmarshal(data, &out); err != nil || out.ChallengeID == "" {
		return "", fmt.Errorf("pair/request: malformed response")
	}
	return out.ChallengeID, nil
}

func (c *Client) PairConfirm(ctx context.Context, challengeID, code string) (Pairing, error) {
	data, err := c.do(ctx, "POST", "/v1/api/auth/pair/confirm", map[string]string{"challenge_id": challengeID, "pairing_code": code}, nil)
	if err != nil {
		return Pairing{}, err
	}
	var p Pairing
	if err := json.Unmarshal(data, &p); err != nil || p.BridgeID == "" || p.ServiceSecret == "" {
		return Pairing{}, fmt.Errorf("pair/confirm: malformed response or empty bridge credentials")
	}
	return p, nil
}

func (c *Client) UserID(ctx context.Context) (string, error) {
	data, err := c.do(ctx, "GET", "/v1/api/auth/bootstrap", nil, nil)
	if err != nil {
		return "", err
	}
	var out struct {
		UserID string `json:"user_id"`
	}
	if err := json.Unmarshal(data, &out); err != nil || out.UserID == "" {
		return "", fmt.Errorf("bootstrap: device not signed in (no user_id)")
	}
	return out.UserID, nil
}

func (c *Client) Signed(ctx context.Context, method, path string, body any, secret, userID string) (json.RawMessage, error) {
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	h := sign.Headers(method, path, "json", sign.BodyHash(raw), secret, userID, ts, hex.EncodeToString(nonce))
	return c.do(ctx, method, path, body, h)
}
```

- [ ] **Step 4: Run, expect PASS; commit**

```bash
go test ./clt01/
git add spike/phase0/clt01 && git commit -m "chore(spike): clt01 pairing and signed requests"
```

---

### Task 3: WS v1 auth server

**Files:**
- Create: `spike/phase0/wsserver/server.go`
- Test: `spike/phase0/wsserver/server_test.go`

**Interfaces:**
- Produces: `func Handler(secret string, onAuth func(deviceID string), logf func(format string, args ...any)) http.Handler` — accepts the WS upgrade on `/`, authenticates by `secret`, logs every later frame type.

- [ ] **Step 1: Add the dependency** — `go get github.com/gorilla/websocket@v1.5.3`

- [ ] **Step 2: Write the failing test**

```go
package wsserver

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(url, "http")+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestAuth(t *testing.T) {
	got := make(chan string, 1)
	srv := httptest.NewServer(Handler("ss", func(id string) { got <- id }, t.Logf))
	defer srv.Close()

	c := dial(t, srv.URL)
	c.WriteJSON(map[string]any{"v": 1, "type": "auth", "deviceId": "android-1", "secret": "ss"})
	var f map[string]any
	if err := c.ReadJSON(&f); err != nil || f["type"] != "auth_result" || f["success"] != true || f["deviceId"] != "android-1" {
		t.Fatalf("auth_result = %v, %v", f, err)
	}
	if err := c.ReadJSON(&f); err != nil || f["type"] != "gateway_status" || f["connected"] != true {
		t.Fatalf("gateway_status = %v, %v", f, err)
	}
	if id := <-got; id != "android-1" {
		t.Fatalf("onAuth got %q", id)
	}

	bad := dial(t, srv.URL)
	bad.WriteJSON(map[string]any{"v": 1, "type": "auth", "deviceId": "android-2", "secret": "nope"})
	if err := bad.ReadJSON(&f); err != nil || f["success"] != false {
		t.Fatalf("bad auth_result = %v, %v", f, err)
	}
	if _, _, err := bad.ReadMessage(); err == nil {
		t.Fatal("connection with a bad secret stayed open")
	}
}
```

- [ ] **Step 3: Run it, expect a compile failure** — `go test ./wsserver/` → `undefined: Handler`.

- [ ] **Step 4: Implement**

```go
// Package wsserver accepts codie-agent-service's WS v1 connection and auth.
package wsserver

import (
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func Handler(secret string, onAuth func(deviceID string), logf func(string, ...any)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logf("ws upgrade from %s failed: %v", r.RemoteAddr, err)
			return
		}
		defer c.Close()
		logf("ws connection from %s", r.RemoteAddr)
		authed := false
		for {
			var f map[string]any
			if err := c.ReadJSON(&f); err != nil {
				logf("ws closed: %v", err)
				return
			}
			typ, _ := f["type"].(string)
			if typ == "auth" {
				id, _ := f["deviceId"].(string)
				if s, _ := f["secret"].(string); s != secret {
					c.WriteJSON(map[string]any{"v": 1, "type": "auth_result", "success": false, "deviceId": id, "reason": "unknown secret"})
					return
				}
				authed = true
				c.WriteJSON(map[string]any{"v": 1, "type": "auth_result", "success": true, "deviceId": id})
				c.WriteJSON(map[string]any{"v": 1, "type": "gateway_status", "connected": true})
				onAuth(id)
				continue
			}
			logf("frame type=%q authed=%v", typ, authed)
		}
	})
}
```

- [ ] **Step 5: Run, expect PASS; commit**

```bash
go test ./wsserver/
git add spike/phase0 && git commit -m "chore(spike): WS v1 auth server"
```

---

### Task 4: mDNS advertise and browse

**Files:**
- Create: `spike/phase0/mdns/mdns.go`
- Test: `spike/phase0/mdns/mdns_test.go`

**Interfaces:**
- Produces:
  - `func InterfaceFor(deviceIP string) (*net.Interface, net.IP, error)` — the up, non-loopback IPv4 interface whose subnet contains `deviceIP`
  - `func Advertise(bridgeID string, port int, iface *net.Interface) (stop func(), err error)`
  - `type Device struct { ID, Name, IP string; Port int }`
  - `func Browse(ctx context.Context, iface *net.Interface) ([]Device, error)` — `_codie-config._tcp` until ctx ends; IP from TXT `ipv4`

- [ ] **Step 1: Add the dependency** — `go get github.com/grandcat/zeroconf@v1.0.0`

- [ ] **Step 2: Write the failing test** (pure logic only; multicast is checked on real networks in Task 6)

```go
package mdns

import "testing"

func TestParseDevice(t *testing.T) {
	d, ok := parseDevice([]string{"device_id=d-1", "name=Codie", "ipv4=169.254.1.2, 192.168.1.20"}, 8081)
	if !ok || d.ID != "d-1" || d.Name != "Codie" || d.IP != "169.254.1.2" || d.Port != 8081 {
		t.Fatalf("got %+v %v", d, ok)
	}
	if _, ok := parseDevice([]string{"device_id=unknown0", "ipv4=1.2.3.4"}, 1); ok {
		t.Fatal("unknown0 must be skipped")
	}
	if _, ok := parseDevice([]string{"device_id=d-2"}, 1); ok {
		t.Fatal("missing ipv4 must be skipped")
	}
}
```

- [ ] **Step 3: Run it, expect a compile failure** — `go test ./mdns/` → `undefined: parseDevice`.

- [ ] **Step 4: Implement** (the first valid IPv4 in TXT wins, as in `src/mdns.mjs:12`)

```go
// Package mdns advertises _codie._tcp and browses _codie-config._tcp.
package mdns

import (
	"context"
	"fmt"
	"net"
	"strings"

	"github.com/grandcat/zeroconf"
)

type Device struct {
	ID, Name, IP string
	Port         int
}

func parseDevice(txt []string, port int) (Device, bool) {
	kv := map[string]string{}
	for _, s := range txt {
		if k, v, ok := strings.Cut(s, "="); ok {
			kv[k] = v
		}
	}
	d := Device{ID: kv["device_id"], Name: kv["name"], Port: port}
	if d.ID == "" || d.ID == "unknown0" {
		return d, false
	}
	for _, ip := range strings.Split(kv["ipv4"], ",") {
		if p := net.ParseIP(strings.TrimSpace(ip)); p != nil && p.To4() != nil {
			d.IP = p.String()
			return d, true
		}
	}
	return d, false
}

func InterfaceFor(deviceIP string) (*net.Interface, net.IP, error) {
	target := net.ParseIP(deviceIP)
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, nil, err
	}
	for i := range ifaces {
		ifc := ifaces[i]
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && n.Contains(target) {
				return &ifc, n.IP, nil
			}
		}
	}
	return nil, nil, fmt.Errorf("no interface on the subnet of %s", deviceIP)
}

func Advertise(bridgeID string, port int, iface *net.Interface) (func(), error) {
	name := "codie-spike-" + bridgeID[:min(8, len(bridgeID))]
	srv, err := zeroconf.Register(name, "_codie._tcp", "local.", port, []string{"bridge_id=" + bridgeID}, []net.Interface{*iface})
	if err != nil {
		return nil, err
	}
	return srv.Shutdown, nil
}

func Browse(ctx context.Context, iface *net.Interface) ([]Device, error) {
	r, err := zeroconf.NewResolver(zeroconf.SelectIfaces([]net.Interface{*iface}), zeroconf.SelectIPTraffic(zeroconf.IPv4))
	if err != nil {
		return nil, err
	}
	entries := make(chan *zeroconf.ServiceEntry)
	found := map[string]Device{}
	done := make(chan struct{})
	go func() {
		for e := range entries {
			if d, ok := parseDevice(e.Text, e.Port); ok {
				found[d.ID] = d
			}
		}
		close(done)
	}()
	if err := r.Browse(ctx, "_codie-config._tcp", "local.", entries); err != nil {
		return nil, err
	}
	<-ctx.Done()
	<-done
	out := make([]Device, 0, len(found))
	for _, d := range found {
		out = append(out, d)
	}
	return out, nil
}
```

- [ ] **Step 5: Run, expect PASS; `go vet ./...`; commit**

```bash
go test ./mdns/ && go vet ./...
git add spike/phase0 && git commit -m "chore(spike): mDNS advertise and browse"
```

---

### Task 5: `codie-spike` CLI and cross-builds

**Files:**
- Create: `spike/phase0/cmd/codie-spike/main.go`
- Create: `spike/phase0/build.sh`

**Interfaces:**
- Consumes: everything above.
- Produces: `codie-spike browse --via <any-device-subnet-ip>` and `codie-spike run --device <ip:port> [--ws-port 9531] [--wait 120s]`. `run` prints one line per check, `PASS <check>` or `FAIL <check>: <reason>`, and exits non-zero on the first failure. Checks, in order: `interface`, `pair` (prompts for the 6-digit code on stdin), `bootstrap`, `signed-get` (`GET /v1/api/data/user/system`), `ensure` (`pair/ensure`), `prefer-bridge`, `ws-listen`, `mdns-advertise`, `ws-auth` (the device connects and authenticates within `--wait`).

- [ ] **Step 1: Implement**

```go
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"codie_host/spike/phase0/clt01"
	"codie_host/spike/phase0/mdns"
	"codie_host/spike/phase0/wsserver"
)

func check(name string, err error) {
	if err != nil {
		fmt.Printf("FAIL %s: %v\n", name, err)
		os.Exit(1)
	}
	fmt.Printf("PASS %s\n", name)
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, time.Now().Format("15:04:05 ")+format+"\n", args...)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: codie-spike browse --via <ip> | run --device <ip:port> [--ws-port 9531] [--wait 120s]")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "browse":
		browse(os.Args[2:])
	case "run":
		run(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, "unknown command", os.Args[1])
		os.Exit(2)
	}
}

func browse(args []string) {
	fs := flag.NewFlagSet("browse", flag.ExitOnError)
	via := fs.String("via", "", "an IPv4 on the device subnet (picks the interface)")
	fs.Parse(args)
	ifc, _, err := mdns.InterfaceFor(*via)
	check("interface", err)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	devs, err := mdns.Browse(ctx, ifc)
	if err == nil && len(devs) == 0 {
		err = fmt.Errorf("no _codie-config._tcp device found in 4s")
	}
	check("mdns-browse", err)
	for _, d := range devs {
		fmt.Printf("  %s %q %s:%d\n", d.ID, d.Name, d.IP, d.Port)
	}
}

func run(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	device := fs.String("device", "", "clt01 host:port, e.g. 192.168.1.20:8081")
	wsPort := fs.Int("ws-port", 9531, "WS v1 listen port (not 9530: the Node agentd may hold it)")
	wait := fs.Duration("wait", 120*time.Second, "how long to wait for the device to connect")
	fs.Parse(args)
	host, _, err := net.SplitHostPort(*device)
	check("device-flag", err)
	ifc, ip, err := mdns.InterfaceFor(host)
	check("interface", err)
	logf("interface %s %s", ifc.Name, ip)

	ctx := context.Background()
	c := clt01.New(*device)
	ch, err := c.PairRequest(ctx)
	check("pair-request", err)
	fmt.Print("6-digit code on the device screen: ")
	code, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	p, err := c.PairConfirm(ctx, ch, strings.TrimSpace(code))
	check("pair", err)
	logf("bridge_id=%s has_service=%v", p.BridgeID, p.HasService)
	if !p.HasService {
		check("service-installed", fmt.Errorf("codie-agent-service is not installed; pair once with the plugin first"))
	}
	uid, err := c.UserID(ctx)
	check("bootstrap", err)
	_, err = c.Signed(ctx, "GET", "/v1/api/data/user/system", nil, p.LocalSecret, uid)
	check("signed-get", err)
	_, err = c.Signed(ctx, "POST", "/v1/api/auth/pair/ensure", map[string]string{"bridge_id": p.BridgeID, "service_secret": p.ServiceSecret}, p.LocalSecret, uid)
	check("ensure", err)
	_, err = c.Signed(ctx, "POST", "/v1/api/admin/agent/prefer-bridge", map[string]string{"bridge_id": ""}, p.LocalSecret, uid)
	check("prefer-bridge", err)

	authed := make(chan string, 1)
	ln, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(*wsPort)))
	check("ws-listen", err)
	go http.Serve(ln, wsserver.Handler(p.ServiceSecret, func(id string) {
		select {
		case authed <- id:
		default:
		}
	}, logf))
	stop, err := mdns.Advertise(p.BridgeID, *wsPort, ifc)
	check("mdns-advertise", err)
	defer stop()

	select {
	case id := <-authed:
		check("ws-auth", nil)
		logf("device android id %s", id)
	case <-time.After(*wait):
		check("ws-auth", fmt.Errorf("device did not connect within %s", *wait))
	}
}
```

- [ ] **Step 2: Cross-build script**

```bash
#!/usr/bin/env bash
# Builds codie-spike for the phase 0 targets into dist/.
set -euo pipefail
cd "$(dirname "$0")"
for target in windows/amd64 darwin/arm64 darwin/amd64; do
  os=${target%/*}; arch=${target#*/}; ext=""; [ "$os" = windows ] && ext=.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -o "dist/codie-spike-$os-$arch$ext" ./cmd/codie-spike
done
ls -l dist
```

- [ ] **Step 3: Verify** — `go vet ./... && go test ./... && bash build.sh`. Expected: all tests pass and three binaries exist. A failing darwin build with `CGO_ENABLED=0` is itself a phase 0 finding (record it in Task 6).

- [ ] **Step 4: Commit** (add `spike/phase0/dist/` to `.gitignore`)

```bash
echo "spike/phase0/dist/" >> .gitignore
git add .gitignore spike/phase0 && git commit -m "chore(spike): codie-spike CLI and cross-build"
```

---

### Task 6: Run on real hardware and record results

Needs a person: a Codie on the LAN with codie-agent-service already installed, one Windows PC, one Mac (macOS 15 if available, which has the Local Network permission).

**Files:**
- Create: `docs/spikes/2026-10-26-phase0-results.md`

- [ ] **Step 1: Windows** — from the same LAN: `dist/codie-spike-windows-amd64.exe browse --via <device-ip>`, then `... run --device <device-ip>:<clt01-port>` (port from `browse`). Note any Windows Firewall prompt and whether `ws-auth` passes with the Node agentd still running on 9530.
- [ ] **Step 2: macOS, launched from Terminal** — copy `codie-spike-darwin-<arch>` to the Mac (via `scp` or git; not a browser download, which adds quarantine), `chmod +x`, run `browse` and `run`. Record: any Local Network prompt (and which app it names), whether `mdns-advertise` coexists with mDNSResponder, whether `ws-auth` passes.
- [ ] **Step 3: macOS, launched the way the plugin will launch it** — from a Claude Code session on the Mac, have it start `codie-spike run …` detached in the background (`nohup … &`), enter the code, and record whether the Local Network permission is attributed to and granted for the background process.
- [ ] **Step 4: Write the results doc** with one table per platform (check × PASS/FAIL × note), plus a verdict:
  - all PASS on both platforms → D4 (Go) stands; phase 1 and 2 plans can start;
  - mDNS fails on macOS → retry with `github.com/brutella/dnssd` (pure Go, built for coexisting with mDNSResponder); if that also fails, record that `dns_sd` via cgo is required (macOS builds need a macOS builder);
  - Local Network denied for background launch → record the exact behavior; it blocks D4 until resolved.
- [ ] **Step 5: Clean up the device** — the spike's pairing stays in codie-agent-service's allowlist; remove it from the device's pairing UI if available, else record it in the results doc.
- [ ] **Step 6: Commit**

```bash
git add docs/spikes/2026-10-26-phase0-results.md && git commit -m "docs: phase 0 feasibility results"
```
