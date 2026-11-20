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
