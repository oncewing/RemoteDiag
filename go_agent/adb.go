package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const adbPath = "adb"

// ── ADB 셸 실행 ──────────────────────────────────────────────────────

func runADB(args ...string) (stdout, stderr string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, adbPath, args...)
	out, runErr := cmd.Output()
	if runErr != nil {
		if ex, ok := runErr.(*exec.ExitError); ok {
			return string(out), string(ex.Stderr), nil
		}
		return "", "", runErr
	}
	return string(out), "", nil
}

func runADBTimeout(timeoutSec int, args ...string) (stdout, stderr string, err error) {
	if timeoutSec <= 0 {
		timeoutSec = 30
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, adbPath, args...)
	out, runErr := cmd.Output()
	if runErr != nil {
		if ex, ok := runErr.(*exec.ExitError); ok {
			return string(out), string(ex.Stderr), nil
		}
		return "", "", runErr
	}
	return string(out), "", nil
}

// ── 기기 목록 ────────────────────────────────────────────────────────

func listADBDevices() []map[string]string {
	out, _, err := runADB("devices")
	if err != nil {
		return nil
	}
	var devices []map[string]string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "List") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 && parts[1] == "device" {
			devices = append(devices, map[string]string{
				"serial": parts[0],
				"status": parts[1],
			})
		}
	}
	return devices
}

// ── 명령 핸들러 ──────────────────────────────────────────────────────

func adbDevices(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	devices := listADBDevices()
	r.Success = true
	r.Data = devices
	return r
}

func adbShellCmd(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	if cmd.Serial == "" {
		r.Error = "serial이 필요합니다."
		return r
	}
	timeout := cmd.Timeout
	if timeout <= 0 {
		timeout = 30
	}
	stdout, stderr, err := runADBTimeout(timeout, "-s", cmd.Serial, "shell", cmd.Command)
	if err != nil {
		r.Error = err.Error()
		r.Stderr = stderr
		return r
	}
	r.Success = true
	r.Stdout = stdout
	r.Stderr = stderr
	return r
}

func adbInfo(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	serial := cmd.Serial
	if serial == "" {
		r.Error = "serial이 필요합니다."
		return r
	}

	get := func(shellCmd string) string {
		out, _, _ := runADBTimeout(10, "-s", serial, "shell", shellCmd)
		return strings.TrimSpace(out)
	}

	phone := strings.ReplaceAll(
		strings.ReplaceAll(get("cat /var/tmp/phone_number"), "-", ""), " ", "")
	imei  := get("cat /var/tmp/imei")
	model := get("getprop ro.product.model")

	r.Success = true
	r.Data = map[string]string{
		"imei":  imei,
		"phone": phone,
		"model": model,
	}
	return r
}

func adbPortForward(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	// adb -s <serial> forward tcp:<local> tcp:<remote>
	// cmd.Command 형식: "tcp:5555 tcp:5555"
	args := append([]string{"-s", cmd.Serial, "forward"}, strings.Fields(cmd.Command)...)
	_, stderr, err := runADB(args...)
	if err != nil {
		r.Error = fmt.Sprintf("%v: %s", err, stderr)
		return r
	}
	r.Success = true
	return r
}

func adbPortForwardRemove(cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}
	args := append([]string{"-s", cmd.Serial, "forward", "--remove"}, strings.Fields(cmd.Command)...)
	_, stderr, err := runADB(args...)
	if err != nil {
		r.Error = fmt.Sprintf("%v: %s", err, stderr)
		return r
	}
	r.Success = true
	return r
}

// ── push 헬퍼 ────────────────────────────────────────────────────────

func pushDevices(sio *SocketIO) {
	devices := listADBDevices()
	sio.Emit("device_update", map[string]interface{}{"list": devices})
}

func sendDeviceInfo(sio *SocketIO, ctrlSID string) {
	devices := listADBDevices()
	if len(devices) == 0 {
		sio.Emit("device_info", map[string]interface{}{
			"ctrl_sid": ctrlSID, "imei": "N/A", "phone": "N/A",
			"note": "연결된 단말 없음",
		})
		return
	}

	serial := devices[0]["serial"]
	get := func(c string) string {
		out, _, _ := runADBTimeout(5, "-s", serial, "shell", c)
		return strings.TrimSpace(out)
	}

	imei  := get("cat /var/tmp/imei")
	phone := strings.ReplaceAll(
		strings.ReplaceAll(strings.ReplaceAll(get("cat /var/tmp/phone_number"), "+", ""), "-", ""), " ", "")

	if imei == "" { imei = "N/A" }
	if phone == "" { phone = "N/A" }

	sio.Emit("device_info", map[string]interface{}{
		"ctrl_sid": ctrlSID,
		"serial":   serial,
		"imei":     imei,
		"phone":    phone,
	})
}
