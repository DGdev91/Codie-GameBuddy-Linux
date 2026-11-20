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
