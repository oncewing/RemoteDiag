package main

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
	"go.bug.st/serial/enumerator"
)

var reIMEI = regexp.MustCompile(`\d{14,15}`)

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
	r.Success = true
	r.Data = buildPortList()
	r.Open = getOpenPortNames()
	return r
}

func buildPortList() []map[string]string {
	ports, _ := enumerator.GetDetailedPortsList()

	// enumerator 결과를 맵으로 인덱싱
	byName := map[string]map[string]string{}
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
		byName[p.Name] = entry
	}

	// 장치관리자 모뎀 항목 병합
	for port, name := range modemPorts() {
		if e, ok := byName[port]; ok {
			if e["description"] == "" {
				e["description"] = name
			}
		} else {
			byName[port] = map[string]string{
				"port":        port,
				"description": name,
				"hwid":        "",
			}
		}
	}

	list := make([]map[string]string, 0, len(byName))
	for _, e := range byName {
		list = append(list, e)
	}
	return list
}

func pushPorts(sio *SocketIO) {
	sio.Emit("port_update", map[string]interface{}{
		"ports": buildPortList(),
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
	// 포트 오픈 직후 모뎀이 쌓아둔 *WIND: 등 비동기 URC 버퍼를 비움
	p.ResetInputBuffer()
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

// ── AT 포트 ↔ ADB 단말 IMEI 매칭 ────────────────────────────────────

func atMatchDevice(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	port := cmd.Port
	if port == "" {
		r.Error = "port가 필요합니다."
		return r
	}

	// 1. AT+CGSN 으로 IMEI 조회
	atRes := atSend(port, "AT+CGSN", 5)
	imeiMatch := reIMEI.FindString(atRes)
	if imeiMatch == "" {
		r.Error = "AT+CGSN IMEI 조회 실패"
		return r
	}

	// 2. ADB 단말 IMEI와 비교
	for _, dev := range listADBDevices() {
		serial := dev["serial"]
		out, _, err := runADBTimeout(5, "-s", serial, "shell", "cat /var/tmp/imei")
		if err != nil {
			continue
		}
		if strings.TrimSpace(out) == imeiMatch {
			r.Success = true
			r.Serial = serial
			r.Data = map[string]string{"serial": serial, "imei": imeiMatch}
			return r
		}
	}

	r.Error = "매칭 단말기 없음"
	return r
}

// ── AT 명령 ──────────────────────────────────────────────────────────

// atSend는 이미 열려 있는 포트에 AT 명령을 전송하고 응답 문자열을 반환합니다.
// Python _at_send 와 동일하게 줄 단위로 읽어 strip 후 \n 으로 조인합니다.
func atSend(portName, command string, timeoutSec int) string {
	portMu.Lock()
	p, ok := openPorts[portName]
	portMu.Unlock()
	if !ok {
		return ""
	}
	// AT 표준 종료자는 \r (CR). \r\n 은 일부 모뎀에서 오작동.
	cmd := strings.TrimSpace(command) + "\r"
	if _, err := p.Write([]byte(cmd)); err != nil {
		return ""
	}
	if timeoutSec <= 0 {
		timeoutSec = atTimeout
	}
	p.SetReadTimeout(time.Duration(timeoutSec) * time.Second)

	var raw strings.Builder
	buf := make([]byte, 256)
	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	for time.Now().Before(deadline) {
		n, err := p.Read(buf)
		if n > 0 {
			raw.Write(buf[:n])
			resp := raw.String()
			if strings.Contains(resp, "\nOK") ||
				strings.Contains(resp, "\nERROR") ||
				strings.Contains(resp, "+CME ERROR") ||
				strings.Contains(resp, "+CMS ERROR") ||
				strings.Contains(resp, "NO CARRIER") ||
				strings.Contains(resp, "BUSY") {
				break
			}
		}
		if err != nil {
			break
		}
	}

	// Python: readline → strip → join("\n") — 빈 줄 제거
	var lines []string
	for _, l := range strings.Split(raw.String(), "\n") {
		l = strings.TrimSpace(l)
		if l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return "(응답 없음)"
	}
	return strings.Join(lines, "\n")
}

func atCommand(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	if cmd.Port == "" {
		r.Error = "port가 필요합니다."
		return r
	}
	portMu.Lock()
	_, ok := openPorts[cmd.Port]
	portMu.Unlock()
	if !ok {
		r.Error = fmt.Sprintf("포트가 열려 있지 않습니다: %s", cmd.Port)
		return r
	}
	r.Success = true
	r.Response = atSend(cmd.Port, cmd.Command, cmd.Timeout)
	return r
}
