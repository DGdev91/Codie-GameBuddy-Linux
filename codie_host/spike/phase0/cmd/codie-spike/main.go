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
	// Best-effort, as in the plugin's finishPairing: firmware may gate it.
	if _, err = c.Signed(ctx, "POST", "/v1/api/admin/agent/prefer-bridge", map[string]string{"bridge_id": ""}, p.LocalSecret, uid); err != nil {
		fmt.Printf("WARN prefer-bridge: %v\n", err)
	} else {
		check("prefer-bridge", nil)
	}

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
