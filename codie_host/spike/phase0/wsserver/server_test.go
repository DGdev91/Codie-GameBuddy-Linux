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
