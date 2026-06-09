package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ── 상수 ─────────────────────────────────────────────────────────────

const (
	srsdCmdAT    = 2
	srsdCmdShell = 102
	srsdPort     = 5002
)

var (
	srsdProvider [16]byte // init() 에서 XOR 디코딩
	srsdSecure   [16]byte // init() 에서 XOR 디코딩
)

func init() {
	srsdProvider, srsdSecure = decodeSRSDSecrets()
}

var srsdErrors = map[string]bool{
	"PROVIDER ERROR": true, "SECURE CODE ERROR": true, "CRC ERROR": true,
	"UNSUPPORTED": true, "INVALID ARGUMENT": true, "INTERNAL ERROR": true,
}

// ── CRC16 ─────────────────────────────────────────────────────────────

func srsdCRC16(data []byte) []byte {
	if len(data) == 0 {
		return []byte{'0', '0'}
	}
	wCRC := uint16(0xFFFF)
	for _, b := range data {
		ch := (b ^ uint8(wCRC&0xFF)) & 0xFF
		ch = (ch ^ ((ch << 4) & 0xFF)) & 0xFF
		wCRC = (wCRC >> 8) ^ (uint16(ch) << 8) ^ (uint16(ch) << 3) ^ (uint16(ch) >> 4)
	}
	wCRC = ^wCRC
	return []byte{uint8(wCRC & 0xFF), uint8(wCRC >> 8)}
}

// ── 프레임 빌드 ────────────────────────────────────────────────────────

func srsdBuildFrame(command uint16, payload []byte) []byte {
	payloadSize := uint32(len(payload))
	frameLength := uint32(42 + payloadSize + 2)

	header := make([]byte, 42)
	binary.LittleEndian.PutUint32(header[0:4], frameLength)
	copy(header[4:20], srsdProvider[:])
	copy(header[20:36], srsdSecure[:])
	binary.LittleEndian.PutUint16(header[36:38], command)
	binary.LittleEndian.PutUint32(header[38:42], payloadSize)

	body := append(header, payload...)
	crc := srsdCRC16(body)
	return append(body, crc...)
}

// ── UDP 송수신 ─────────────────────────────────────────────────────────

func srsdSendRecv(ip string, port int, command uint16, payload []byte, timeout float64) ([]byte, error) {
	frame := srsdBuildFrame(command, payload)
	addr := fmt.Sprintf("%s:%d", ip, port)

	conn, err := net.DialTimeout("udp", addr, time.Duration(timeout*float64(time.Second)))
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	deadline := time.Now().Add(time.Duration(timeout * float64(time.Second)))
	conn.SetDeadline(deadline)

	if _, err := conn.Write(frame); err != nil {
		return nil, err
	}

	resp := make([]byte, 0, 4096)
	buf := make([]byte, 65535)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		conn.SetReadDeadline(time.Now().Add(remaining))
		n, err := conn.Read(buf)
		if n > 0 {
			resp = append(resp, buf[:n]...)
			if len(resp) >= 4 {
				expected := binary.LittleEndian.Uint32(resp[:4])
				if uint32(len(resp)) >= expected {
					break
				}
			}
		}
		if err != nil {
			break
		}
	}
	return resp, nil
}

// ── 응답 파싱 ─────────────────────────────────────────────────────────

type srsdResult struct {
	success  bool
	response string // AT
	stdout   string // shell
	stderr   string
	err      string
}

func srsdParse(data []byte, cmdType string) srsdResult {
	if len(data) < 42 {
		return srsdResult{err: fmt.Sprintf("응답 데이터 부족 (%d bytes)", len(data))}
	}
	payloadSize := binary.LittleEndian.Uint32(data[38:42])
	end := 42 + int(payloadSize)
	if end > len(data) {
		end = len(data)
	}
	text := strings.TrimSpace(string(data[42:end]))

	if srsdErrors[text] {
		return srsdResult{err: text, response: text, stderr: text}
	}
	if cmdType == "at" {
		return srsdResult{success: true, response: text}
	}
	return srsdResult{success: true, stdout: text}
}

// ── 공개 헬퍼 ─────────────────────────────────────────────────────────

func srsdAT(ip string, port int, command string, timeout float64) srsdResult {
	payload := []byte(strings.TrimSpace(command))
	resp, err := srsdSendRecv(ip, port, srsdCmdAT, payload, timeout)
	if err != nil {
		return srsdResult{err: err.Error()}
	}
	return srsdParse(resp, "at")
}

func srsdShell(ip string, port int, command string, timeout float64) srsdResult {
	payload := []byte(strings.TrimSpace(command))
	resp, err := srsdSendRecv(ip, port, srsdCmdShell, payload, timeout)
	if err != nil {
		return srsdResult{err: err.Error()}
	}
	return srsdParse(resp, "shell")
}

// ── 탐색 ─────────────────────────────────────────────────────────────

var reGateway = []*regexp.Regexp{
	regexp.MustCompile(`Default Gateway[^:]*:\s*([\d.]+)`),
	regexp.MustCompile(`기본 게이트웨이[^:]*:\s*([\d.]+)`),
}
var reIPv4 = []*regexp.Regexp{
	regexp.MustCompile(`IPv4 Address[^:]*:\s*([\d.]+)`),
	regexp.MustCompile(`IPv4 주소[^:]*:\s*([\d.]+)`),
}

func srsdDiscover(port int) []string {
	candidates := map[string]bool{}

	raw, err := exec.Command("ipconfig", "/all").Output()
	if err == nil {
		out := decodeCP949(raw)
		for _, re := range reGateway {
			for _, m := range re.FindAllStringSubmatch(out, -1) {
				gw := strings.TrimSpace(m[1])
				if gw != "" && gw != "0.0.0.0" {
					candidates[gw] = true
				}
			}
		}
		for _, re := range reIPv4 {
			for _, m := range re.FindAllStringSubmatch(out, -1) {
				ip := strings.TrimSpace(strings.Split(m[1], "(")[0])
				if ip != "" && !strings.HasPrefix(ip, "127.") && strings.Count(ip, ".") == 3 {
					prefix := strings.Join(strings.Split(ip, ".")[:3], ".")
					candidates[prefix+".1"] = true
					candidates[prefix+".2"] = true
				}
			}
		}
	}

	if len(candidates) == 0 {
		return nil
	}

	var mu sync.Mutex
	var found []string
	var wg sync.WaitGroup

	for ip := range candidates {
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			r := srsdAT(ip, port, "AT", 2.0)
			if r.success {
				mu.Lock()
				found = append(found, ip)
				mu.Unlock()
			}
		}(ip)
	}
	wg.Wait()
	return found
}

// decodeCP949: Windows ipconfig 출력을 CP949 → UTF-8 변환 시도
func decodeCP949(raw []byte) string {
	// golang.org/x/text 없이 간단히 처리: UTF-8 유효하면 그대로, 아니면 latin-1 대체
	if isValidUTF8(raw) {
		return string(raw)
	}
	// CP949 핵심 구조(ASCII 범위)는 그대로 읽힘; 한글은 깨지지만 IP 파싱에는 무관
	out := make([]byte, 0, len(raw))
	for _, b := range raw {
		if b < 0x80 {
			out = append(out, b)
		}
	}
	return string(out)
}

func isValidUTF8(b []byte) bool {
	for i := 0; i < len(b); {
		if b[i] < 0x80 {
			i++
			continue
		}
		var n int
		switch {
		case b[i]&0xE0 == 0xC0:
			n = 2
		case b[i]&0xF0 == 0xE0:
			n = 3
		case b[i]&0xF8 == 0xF0:
			n = 4
		default:
			return false
		}
		if i+n > len(b) {
			return false
		}
		for j := 1; j < n; j++ {
			if b[i+j]&0xC0 != 0x80 {
				return false
			}
		}
		i += n
	}
	return true
}

// ── 명령 핸들러 ───────────────────────────────────────────────────────

func cmdSrsdDiscover(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	port := cmd.SrsdPort
	if port == 0 {
		port = srsdPort
	}
	ips := srsdDiscover(port)
	r.Success = true
	r.Data = ips
	return r
}

func cmdSrsdAT(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	port := cmd.SrsdPort
	if port == 0 {
		port = srsdPort
	}
	timeout := float64(cmd.Timeout)
	if timeout <= 0 {
		timeout = 10
	}
	res := srsdAT(cmd.IP, port, cmd.Command, timeout)
	r.Success = res.success
	r.Response = res.response
	r.Error = res.err
	return r
}

func cmdSrsdShell(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	port := cmd.SrsdPort
	if port == 0 {
		port = srsdPort
	}
	timeout := float64(cmd.Timeout)
	if timeout <= 0 {
		timeout = 30
	}
	res := srsdShell(cmd.IP, port, cmd.Command, timeout)
	r.Success = res.success
	r.Stdout = res.stdout
	r.Stderr = res.stderr
	r.Error = res.err
	return r
}
