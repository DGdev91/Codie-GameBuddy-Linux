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
