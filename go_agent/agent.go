package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func contains(s, sub string) bool { return strings.Contains(s, sub) }

var (
	sessionEndTime time.Time
	hasSession     bool
	currentSIO     *SocketIO
	fatalReject    bool // 영구 거부 → 재시도 없이 종료
)

func setupHandlers(sio *SocketIO) {
	currentSIO = sio

	sio.OnConnect(func() {
		fmt.Printf("[agent] 서버 연결됨: %s\n", SERVER_URL)
		sio.Emit("agent_hello", map[string]interface{}{
			"code":     accessCode,
			"platform": "Windows",
			"version":  VERSION,
		})
	})

	sio.OnDisconnect(func() {
		fmt.Println("[agent] 서버 연결 끊김.")
		hasSession = false
	})

	sio.On("agent_accepted", func(data json.RawMessage) {
		var d struct {
			ExpiresInMinutes int    `json:"expires_in_minutes"`
			ExpiryDate       string `json:"expiry_date"`
		}
		json.Unmarshal(data, &d)

		const unlimited = 99999
		if d.ExpiresInMinutes >= unlimited {
			fmt.Printf("[agent] 접속 승인  —  세션: 무제한  /  사용 만료일: %s\n", d.ExpiryDate)
		} else {
			fmt.Printf("[agent] 접속 승인  —  세션: %d분  /  사용 만료일: %s\n",
				d.ExpiresInMinutes, d.ExpiryDate)
			sessionEndTime = time.Now().Add(time.Duration(d.ExpiresInMinutes) * time.Minute)
			hasSession = true
			go startCountdown(sio)
		}

		go pushDevices(sio)
		go pushPorts(sio)
	})

	sio.On("agent_rejected", func(data json.RawMessage) {
		var d struct {
			Reason string `json:"reason"`
		}
		json.Unmarshal(data, &d)
		fmt.Println()
		fmt.Println("==================================================")
		fmt.Println("  접속 거부")
		fmt.Printf("  %s\n", d.Reason)
		fmt.Println("==================================================")

		// 영구 거부 사유 → 재시도 없이 종료
		reason := d.Reason
		if contains(reason, "다른 기기") ||
			contains(reason, "사용이 완료") ||
			contains(reason, "유효하지 않은") ||
			contains(reason, "만료") {
			fatalReject = true
			fmt.Println("[agent] 재연결을 중단합니다.")
			closeShutdown()
		}
		sio.Disconnect()
	})

	sio.On("agent_kicked", func(data json.RawMessage) {
		var d struct {
			Reason string `json:"reason"`
		}
		json.Unmarshal(data, &d)
		fmt.Println()
		fmt.Println("==================================================")
		fmt.Printf("  세션 종료: %s\n", d.Reason)
		fmt.Println("==================================================")
		sio.Disconnect()
	})

	sio.On("command", func(data json.RawMessage) {
		go handleCommand(sio, data)
	})

	sio.On("get_device_info", func(data json.RawMessage) {
		var d struct {
			CtrlSID string `json:"ctrl_sid"`
		}
		json.Unmarshal(data, &d)
		go sendDeviceInfo(sio, d.CtrlSID)
	})
}

func startCountdown(sio *SocketIO) {
	fmtRemaining := func(rem time.Duration) string {
		if rem >= time.Minute {
			// 올림: 11분59초 → 12분
			mins := int((rem + 59*time.Second) / time.Minute)
			return fmt.Sprintf("%d분", mins)
		}
		return fmt.Sprintf("%d초", int(rem.Seconds()))
	}

	nextInterval := func(rem time.Duration) time.Duration {
		switch {
		case rem > 10*time.Minute:
			iv := rem % (10 * time.Minute)
			if iv == 0 {
				iv = 10 * time.Minute
			}
			return iv
		case rem > time.Minute:
			iv := rem % time.Minute
			if iv == 0 {
				iv = time.Minute
			}
			return iv
		case rem > 10*time.Second:
			iv := rem % (10 * time.Second)
			if iv == 0 {
				iv = 10 * time.Second
			}
			return iv
		default:
			return time.Second
		}
	}

	last := ""
	for {
		select {
		case <-shutdown:
			return
		default:
		}
		if !sio.Connected() {
			return
		}

		rem := time.Until(sessionEndTime)
		if rem <= 0 {
			break
		}

		msg := fmtRemaining(rem)
		if msg != last {
			fmt.Printf("[agent] 세션 만료까지: %s\n", msg)
			last = msg
		}

		wait := nextInterval(rem)
		select {
		case <-shutdown:
			return
		case <-time.After(wait):
		}
	}
}
