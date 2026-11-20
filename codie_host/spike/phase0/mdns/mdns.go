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
