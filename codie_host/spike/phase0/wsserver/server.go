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
