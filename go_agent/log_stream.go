package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"sync"
)

// ── 스트리밍 프로세스 관리 ─────────────────────────────────────────────

type streamProc struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	stop chan struct{}
}

func (s *streamProc) kill() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stop != nil {
		close(s.stop)
		s.stop = nil
	}
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
		s.cmd = nil
	}
}

var (
	logcatProc = &streamProc{}
	logProc    = &streamProc{}
)

// ── adb_logcat_start / adb_logcat_stop ────────────────────────────────

func logcatStart(sio *SocketIO, cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}

	// 기존 실행 중이면 먼저 중단
	logcatProc.kill()

	args := []string{"-s", cmd.Serial, "logcat"}
	// cmd.Args 에 추가 인자가 있으면 붙임 (예: "-v time *:W")
	if cmd.Args != "" {
		args = append(args, cmd.Args)
	}

	proc := exec.Command(adbPath, args...)
	stdout, err := proc.StdoutPipe()
	proc.Stderr = nil
	if err != nil {
		r.Success = false
		r.Error = fmt.Sprintf("logcat pipe 실패: %v", err)
		return r
	}
	if err := proc.Start(); err != nil {
		r.Success = false
		r.Error = fmt.Sprintf("logcat 시작 실패: %v", err)
		return r
	}

	stop := make(chan struct{})
	logcatProc.mu.Lock()
	logcatProc.cmd = proc
	logcatProc.stop = stop
	logcatProc.mu.Unlock()

	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			select {
			case <-stop:
				proc.Process.Kill()
				return
			default:
			}
			line := scanner.Text()
			sio.Emit("logcat_line", map[string]string{"line": line})
		}
		proc.Wait()
	}()

	r.Success = true
	r.Message = "logcat 스트림 시작"
	return r
}

func logcatStop(cmd CmdData) CmdResult {
	logcatProc.kill()
	return CmdResult{
		ID: cmd.ID, BrowserSID: cmd.BrowserSID,
		Success: true, Message: "logcat 중단",
	}
}

// ── log_start / log_stop  (tail -f <path>) ────────────────────────────

func logStart(sio *SocketIO, cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}

	path := cmd.Path
	if path == "" {
		r.Success = false
		r.Error = "path 가 비어있음"
		return r
	}

	logProc.kill()

	proc := exec.Command(adbPath, "-s", cmd.Serial, "shell", "tail", "-f", path)
	stdout, err := proc.StdoutPipe()
	proc.Stderr = nil
	if err != nil {
		r.Success = false
		r.Error = fmt.Sprintf("log pipe 실패: %v", err)
		return r
	}
	if err := proc.Start(); err != nil {
		r.Success = false
		r.Error = fmt.Sprintf("log 시작 실패: %v", err)
		return r
	}

	stop := make(chan struct{})
	logProc.mu.Lock()
	logProc.cmd = proc
	logProc.stop = stop
	logProc.mu.Unlock()

	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			select {
			case <-stop:
				proc.Process.Kill()
				return
			default:
			}
			line := scanner.Text()
			sio.Emit("log_line", map[string]interface{}{
				"line":   line,
				"source": "log",
			})
		}
		proc.Wait()
	}()

	r.Success = true
	r.Message = "log 스트림 시작: " + path
	return r
}

func logStop(cmd CmdData) CmdResult {
	logProc.kill()
	return CmdResult{
		ID: cmd.ID, BrowserSID: cmd.BrowserSID,
		Success: true, Message: "log 스트림 중단",
	}
}

// ── kmsg_start / kmsg_stop  (adb shell dmesg 줄 단위 스트리밍) ────────

var kmsgProc = &streamProc{}

func kmsgStart(sio *SocketIO, cmd CmdData) CmdResult {
	r := CmdResult{ID: cmd.ID, BrowserSID: cmd.BrowserSID}

	kmsgProc.kill()

	proc := exec.Command(adbPath, "-s", cmd.Serial, "shell", "dmesg")
	stdout, err := proc.StdoutPipe()
	proc.Stderr = nil
	if err != nil {
		r.Success = false
		r.Error = fmt.Sprintf("kmsg pipe 실패: %v", err)
		return r
	}
	if err := proc.Start(); err != nil {
		r.Success = false
		r.Error = fmt.Sprintf("kmsg 시작 실패: %v", err)
		return r
	}

	stop := make(chan struct{})
	kmsgProc.mu.Lock()
	kmsgProc.cmd = proc
	kmsgProc.stop = stop
	kmsgProc.mu.Unlock()

	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			select {
			case <-stop:
				proc.Process.Kill()
				return
			default:
			}
			sio.Emit("log_line", map[string]interface{}{
				"line":   scanner.Text(),
				"source": "kmsg",
			})
		}
		proc.Wait()
	}()

	r.Success = true
	r.Message = "kmsg 스트림 시작"
	return r
}

func kmsgStop(cmd CmdData) CmdResult {
	kmsgProc.kill()
	return CmdResult{
		ID: cmd.ID, BrowserSID: cmd.BrowserSID,
		Success: true, Message: "kmsg 스트림 중단",
	}
}
