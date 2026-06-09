package main

import (
	"encoding/json"
	"fmt"
)

// ── 명령 데이터 구조 ─────────────────────────────────────────────────

type CmdData struct {
	ID         string  `json:"id"`
	CmdType    string  `json:"cmd_type"` // 서버 → agent 경로
	Type       string  `json:"type"`     // RC → browser → agent 경로
	BrowserSID string  `json:"browser_sid"`
	Serial     string  `json:"serial"`
	Port       string  `json:"port"`
	Command    string  `json:"command"`
	Timeout    int     `json:"timeout"`
	IP         string  `json:"ip"`
	SrsdPort   int     `json:"port_int"` // SRSD UDP 포트
}

type CmdResult struct {
	ID         string      `json:"id"`
	BrowserSID string      `json:"browser_sid"`
	Success    bool        `json:"success"`
	Stdout     string      `json:"stdout,omitempty"`
	Stderr     string      `json:"stderr,omitempty"`
	Error      string      `json:"error,omitempty"`
	Data       interface{} `json:"data,omitempty"`
	Message    string      `json:"message,omitempty"`
}

// ── 명령 디스패처 ────────────────────────────────────────────────────

func handleCommand(sio *SocketIO, raw json.RawMessage) {
	var cmd CmdData
	if err := json.Unmarshal(raw, &cmd); err != nil {
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
	case "adb_port_list":
		result = portList(cmd)
	case "port_open":
		result = portOpen(cmd)
	case "port_close":
		result = portClose(cmd)
	case "at_command":
		result = atCommand(cmd)

	// ── 로그 업로드 ──────────────────────────────────────────────────
	case "log_upload":
		go doLogUpload(sio, cmd)
		result.Success = true
		result.Message = "로그 수집 시작됨"
	case "kmsg_upload":
		go doKmsgUpload(sio, cmd)
		result.Success = true
		result.Message = "kmsg 수집 시작됨"

	// ── 미구현 ───────────────────────────────────────────────────────
	case "adb_logcat_start", "adb_logcat_stop",
		"log_start", "log_stop",
		"srsd_discover", "srsd_shell", "srsd_at",
		"srsd_log_upload", "srsd_kmsg_upload":
		result.Success = false
		result.Error = fmt.Sprintf("미구현 명령 (Go 버전): %s", cmdType)

	default:
		result.Success = false
		result.Error = fmt.Sprintf("알 수 없는 명령: %s", cmdType)
	}

	result.ID = cmd.ID
	result.BrowserSID = cmd.BrowserSID
	sio.Emit("result", result)
}
