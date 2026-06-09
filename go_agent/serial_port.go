package main

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
	"go.bug.st/serial/enumerator"
)

const (
	atBaudRate = 115200
	atTimeout  = 5 // 초
)

var (
	openPorts = map[string]serial.Port{}
	portMu    sync.Mutex
)

// ── 포트 목록 ────────────────────────────────────────────────────────

func portList(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	ports, err := enumerator.GetDetailedPortsList()
	if err != nil {
		r.Error = err.Error()
		return r
	}
	var list []map[string]string
	for _, p := range ports {
		entry := map[string]string{
			"port":        p.Name,
			"description": p.Product,
			"hwid":        p.SerialNumber,
		}
		if p.IsUSB {
			entry["vid"] = p.VID
			entry["pid"] = p.PID
		}
		list = append(list, entry)
	}
	r.Success = true
	r.Data = list
	r.Open = getOpenPortNames()
	return r
}

func pushPorts(sio *SocketIO) {
	ports, err := enumerator.GetDetailedPortsList()
	if err != nil {
		return
	}
	var list []map[string]string
	for _, p := range ports {
		list = append(list, map[string]string{
			"port":        p.Name,
			"description": p.Product,
			"hwid":        p.SerialNumber,
		})
	}
	sio.Emit("port_update", map[string]interface{}{
		"ports": list,
		"open":  getOpenPortNames(),
	})
}

func getOpenPortNames() []string {
	portMu.Lock()
	defer portMu.Unlock()
	names := make([]string, 0, len(openPorts))
	for name := range openPorts {
		names = append(names, name)
	}
	return names
}

// ── 포트 열기/닫기 ───────────────────────────────────────────────────

func portOpen(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	name := cmd.Port
	if name == "" {
		r.Error = "port가 필요합니다."
		return r
	}

	portMu.Lock()
	defer portMu.Unlock()

	if _, ok := openPorts[name]; ok {
		r.Success = true // 이미 열려 있음
		return r
	}

	p, err := serial.Open(name, &serial.Mode{BaudRate: atBaudRate})
	if err != nil {
		r.Error = fmt.Sprintf("포트 열기 실패 (%s): %v", name, err)
		return r
	}
	openPorts[name] = p
	r.Success = true
	return r
}

func portClose(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	name := cmd.Port

	portMu.Lock()
	defer portMu.Unlock()

	if p, ok := openPorts[name]; ok {
		p.Close()
		delete(openPorts, name)
	}
	r.Success = true
	return r
}

// ── AT 명령 ──────────────────────────────────────────────────────────

func atCommand(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	name := cmd.Port
	if name == "" {
		r.Error = "port가 필요합니다."
		return r
	}

	portMu.Lock()
	p, ok := openPorts[name]
	portMu.Unlock()

	if !ok {
		r.Error = fmt.Sprintf("포트가 열려 있지 않습니다: %s", name)
		return r
	}

	// 명령 전송
	atCmd := cmd.Command
	if !strings.HasSuffix(atCmd, "\r") {
		atCmd += "\r"
	}
	if _, err := p.Write([]byte(atCmd)); err != nil {
		r.Error = err.Error()
		return r
	}

	// 응답 수집
	timeout := cmd.Timeout
	if timeout <= 0 {
		timeout = atTimeout
	}
	p.SetReadTimeout(time.Duration(timeout) * time.Second)

	var sb strings.Builder
	buf := make([]byte, 256)
	deadline := time.Now().Add(time.Duration(timeout) * time.Second)

	for time.Now().Before(deadline) {
		n, err := p.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
			resp := sb.String()
			// OK 또는 ERROR 응답 확인
			if strings.Contains(resp, "\r\nOK\r\n") ||
				strings.Contains(resp, "\r\nERROR\r\n") ||
				strings.Contains(resp, "+CME ERROR") {
				break
			}
		}
		if err != nil {
			break
		}
	}

	r.Success = true
	r.Stdout = sb.String()
	return r
}
