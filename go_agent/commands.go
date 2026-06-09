package main

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// ── 명령 데이터 구조 ─────────────────────────────────────────────────

// cmdDataRaw 는 "port" 필드가 string(COM포트) 또는 int(SRSD UDP 포트) 둘 다 올 수 있어
// json.RawMessage 로 먼저 받은 뒤 CmdData 로 변환한다.
type cmdDataRaw struct {
	ID         string          `json:"id"`
	CmdType    string          `json:"cmd_type"`
	Type       string          `json:"type"`
	BrowserSID string          `json:"browser_sid"`
	Serial     string          `json:"serial"`
	Port       json.RawMessage `json:"port"` // string or int
	Command    string          `json:"command"`
	Timeout    int             `json:"timeout"`
	IP         string          `json:"ip"`
	SrsdPort   int             `json:"port_int"`
	Path       string          `json:"path"`
	Args       string          `json:"args"`
}

type CmdData struct {
	ID         string
	CmdType    string
	Type       string
	BrowserSID string
	Serial     string
	Port       string // COM 포트 이름 (e.g. "COM3")
	Command    string
	Timeout    int
	IP         string
	SrsdPort   int    // SRSD UDP 포트 번호
	Path       string // 로그 파일 경로 (log_start)
	Args       string // 추가 인자 (logcat_start)
}

func parseCmdData(raw json.RawMessage) (CmdData, error) {
	var r cmdDataRaw
	if err := json.Unmarshal(raw, &r); err != nil {
		return CmdData{}, err
	}
	cmd := CmdData{
		ID: r.ID, CmdType: r.CmdType, Type: r.Type,
		BrowserSID: r.BrowserSID, Serial: r.Serial,
		Command: r.Command, Timeout: r.Timeout,
		IP: r.IP, SrsdPort: r.SrsdPort,
		Path: r.Path, Args: r.Args,
	}
	// port 가 string → COM 포트 이름, int → SRSD UDP 포트 번호
	if len(r.Port) > 0 {
		var s string
		if err := json.Unmarshal(r.Port, &s); err == nil {
			cmd.Port = s
		} else {
			var n int
			if err := json.Unmarshal(r.Port, &n); err == nil {
				if n > 0 {
					cmd.SrsdPort = n
				}
			} else {
				// 혹시 따옴표 없이 온 숫자 문자열 처리
				if n, err := strconv.Atoi(string(r.Port)); err == nil && n > 0 {
					cmd.SrsdPort = n
				}
			}
		}
	}
	return cmd, nil
}

type CmdResult struct {
	ID         string      `json:"id"`
	BrowserSID string      `json:"browser_sid"`
	Success    bool        `json:"success"`
	Stdout     string      `json:"stdout,omitempty"`
	Stderr     string      `json:"stderr,omitempty"`
	Error      string      `json:"error,omitempty"`
	Response   string      `json:"response,omitempty"`
	Serial     string      `json:"serial,omitempty"`
	Data       interface{} `json:"data,omitempty"`
	Open       interface{} `json:"open,omitempty"`
	Message    string      `json:"message,omitempty"`
}

// ── 명령 디스패처 ────────────────────────────────────────────────────

func handleCommand(sio *SocketIO, raw json.RawMessage) {
	cmd, err := parseCmdData(raw)
	if err != nil {
		return
	}

	// cmd_type / type 둘 다 지원
	cmdType := cmd.CmdType
	if cmdType == "" {
		cmdType = cmd.Type
	}

	var result CmdResult
	result.ID = cmd.ID
	result.BrowserSID = cmd.BrowserSID

	switch cmdType {
	// ── ADB ──────────────────────────────────────────────────────────
	case "adb_devices":
		result = adbDevices(cmd)
	case "adb_shell":
		result = adbShellCmd(cmd)
	case "adb_info":
		result = adbInfo(cmd)
	case "adb_port_open":
		result = adbPortForward(cmd)
	case "adb_port_close":
		result = adbPortForwardRemove(cmd)

	// ── 시리얼 포트 ──────────────────────────────────────────────────
	case "at_ports", "adb_port_list":
		result = portList(cmd)
	case "port_open", "at_open":
		result = portOpen(cmd)
	case "port_close", "at_close":
		result = portClose(cmd)
	case "at_command":
		result = atCommand(cmd)
	case "at_match_device":
		result = atMatchDevice(cmd)

	// ── 로그 업로드 ──────────────────────────────────────────────────
	case "log_upload":
		go doLogUpload(sio, cmd)
		result.Success = true
		result.Message = "로그 수집 시작됨"
	case "kmsg_upload":
		go doKmsgUpload(sio, cmd)
		result.Success = true
		result.Message = "kmsg 수집 시작됨"

	// ── SRSD 네트워크 ────────────────────────────────────────────────
	case "srsd_discover":
		result = cmdSrsdDiscover(cmd)
	case "srsd_at":
		result = cmdSrsdAT(cmd)
	case "srsd_shell":
		result = cmdSrsdShell(cmd)

	case "srsd_log_upload":
		go doSrsdLogUpload(sio, cmd)
		result.Success = true
		result.Message = "로그 수집 시작됨"
	case "srsd_kmsg_upload":
		go doSrsdKmsgUpload(sio, cmd)
		result.Success = true
		result.Message = "kmsg 수집 시작됨"

	// ── kmsg ─────────────────────────────────────────────────────────
	case "kmsg_get":
		stdout, stderr, err := runADBTimeout(30, "-s", cmd.Serial, "shell", "dmesg")
		if err != nil {
			result.Error = err.Error()
		} else if stderr != "" && stdout == "" {
			result.Success = false
			result.Error = stderr
		} else {
			result.Success = true
			result.Data = stdout
		}

	// ── 로그 스트리밍 ────────────────────────────────────────────────
	case "adb_logcat_start":
		result = logcatStart(sio, cmd)
	case "adb_logcat_stop":
		result = logcatStop(cmd)
	case "log_start":
		result = logStart(sio, cmd)
	case "log_stop":
		result = logStop(cmd)

	default:
		result.Success = false
		result.Error = fmt.Sprintf("알 수 없는 명령: %s", cmdType)
	}

	result.ID = cmd.ID
	result.BrowserSID = cmd.BrowserSID
	sio.Emit("result", result)
}
