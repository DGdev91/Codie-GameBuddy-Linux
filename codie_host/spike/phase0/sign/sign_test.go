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
