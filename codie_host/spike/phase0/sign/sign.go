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
