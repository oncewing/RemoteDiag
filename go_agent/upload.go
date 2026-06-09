package main

import (
	"bytes"
	"compress/zlib"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ── HTTP 로그 업로드 ──────────────────────────────────────────────────

func httpLogUpload(files map[string]string, errors []string,
	phone, imei, deviceID, browserSID string) error {

	payload, err := json.Marshal(map[string]interface{}{
		"code":        accessCode,
		"browser_sid": browserSID,
		"device":      deviceID,
		"phone":       phone,
		"imei":        imei,
		"files":       files,
		"errors":      errors,
	})
	if err != nil {
		return err
	}

	// zlib 압축
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	w.Write(payload)
	w.Close()

	// 업로드 URL 생성
	u, _ := url.Parse(SERVER_URL)
	switch u.Scheme {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	}
	// "/remotediag/socket.io" → "/remotediag"  (마지막 "/" 이후 제거)
	basePath := SERVER_SOCKET_PATH[:strings.LastIndex(SERVER_SOCKET_PATH, "/")]
	uploadURL := u.String() + basePath + "/api/log-upload"

	req, err := http.NewRequest("POST", uploadURL, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("응답 파싱 실패: %v", err)
	}
	if success, ok := result["success"].(bool); !ok || !success {
		return fmt.Errorf("서버 오류: %v", result["error"])
	}
	return nil
}

// ── kmsg 업로드 ──────────────────────────────────────────────────────

func doKmsgUpload(sio *SocketIO, cmd CmdData) {
	serial     := cmd.Serial
	browserSID := cmd.BrowserSID

	get := func(c string) string {
		out, _, _ := runADBTimeout(5, "-s", serial, "shell", c)
		return strings.TrimSpace(out)
	}

	phone := cleanPhone(get("cat /var/tmp/phone_number"))
	imei  := get("cat /var/tmp/imei")
	if phone == "" { phone = "unknown" }
	if imei == ""  { imei  = "unknown" }

	fmt.Printf("[agent] kmsg_upload: 전화번호=%s  IMEI=%s\n", phone, imei)

	files  := map[string]string{}
	errors := []string{}

	fmt.Println("[agent] kmsg_upload: dmesg 수집 중...")
	if dmesg, _, err := runADBTimeout(60, "-s", serial, "shell", "dmesg | tail -n 3000"); err == nil && dmesg != "" {
		files["kmsg.log"] = dmesg
	} else {
		errors = append(errors, "dmesg: 실패")
	}

	fmt.Println("[agent] kmsg_upload: 서버 전송 중...")
	if err := httpLogUpload(files, errors, phone, imei, serial, browserSID); err != nil {
		fmt.Printf("[agent] kmsg_upload: 전송 실패: %v\n", err)
	} else {
		fmt.Printf("[agent] kmsg_upload: 전송 완료. (파일 %d개, 오류 %d건)\n", len(files), len(errors))
	}
}

// ── log 업로드 ───────────────────────────────────────────────────────

func doLogUpload(sio *SocketIO, cmd CmdData) {
	serial     := cmd.Serial
	browserSID := cmd.BrowserSID

	get := func(c string) string {
		out, _, _ := runADBTimeout(5, "-s", serial, "shell", c)
		return strings.TrimSpace(out)
	}

	phone := cleanPhone(get("cat /var/tmp/phone_number"))
	imei  := get("cat /var/tmp/imei")
	if phone == "" { phone = "unknown" }
	if imei == ""  { imei  = "unknown" }

	fmt.Printf("[agent] log_upload: 전화번호=%s  IMEI=%s  경로=ADB\n", phone, imei)

	files  := map[string]string{}
	errors := []string{}

	// dmesg
	fmt.Println("[agent] log_upload: dmesg 수집 중...")
	if dmesg, _, err := runADBTimeout(60, "-s", serial, "shell", "dmesg | tail -n 3000"); err == nil && dmesg != "" {
		files["dmesg.log"] = dmesg
	} else {
		errors = append(errors, "dmesg: 실패")
	}

	// /data/logs
	fmt.Println("[agent] log_upload: /data/logs 수집 중...")
	if fileList, _, err := runADBTimeout(15, "-s", serial, "shell",
		"find /data/logs -maxdepth 3 -type f 2>/dev/null"); err == nil {
		for _, fpath := range strings.Split(fileList, "\n") {
			fpath = strings.TrimSpace(fpath)
			if fpath == "" {
				continue
			}
			rel := strings.TrimPrefix(fpath, "/")
			rel = strings.ReplaceAll(rel, "/", "_")
			if content, _, err := runADBTimeout(60, "-s", serial, "shell",
				fmt.Sprintf("cat '%s'", fpath)); err == nil && content != "" {
				files["data_logs/"+rel] = content
			}
		}
	} else {
		errors = append(errors, "/data/logs: 실패")
	}

	// /var/log/messages
	fmt.Println("[agent] log_upload: /var/log/messages 수집 중...")
	if msgs, _, err := runADBTimeout(60, "-s", serial, "shell",
		"tail -n 20000 /var/log/messages"); err == nil && msgs != "" {
		files["var_log_messages.log"] = msgs
	} else {
		errors = append(errors, "/var/log/messages: 실패")
	}

	fmt.Printf("[agent] log_upload: %d개 파일 수집 완료, 서버 전송 중...\n", len(files))
	if err := httpLogUpload(files, errors, phone, imei, serial, browserSID); err != nil {
		fmt.Printf("[agent] log_upload: 전송 실패: %v\n", err)
	} else {
		fmt.Printf("[agent] log_upload: 전송 완료. (파일 %d개, 오류 %d건)\n", len(files), len(errors))
	}
}

// ── SRSD log/kmsg 업로드 ─────────────────────────────────────────────

func doSrsdLogUpload(sio *SocketIO, cmd CmdData) {
	ip         := cmd.IP
	port       := cmd.SrsdPort
	browserSID := cmd.BrowserSID
	if port == 0 {
		port = srsdPort
	}

	sh := func(c string, timeout float64) string {
		r := srsdShell(ip, port, c, timeout)
		return r.stdout
	}

	phone := cleanPhone(sh("cat /var/tmp/phone_number", 5))
	imei  := strings.TrimSpace(sh("cat /var/tmp/imei", 5))
	if phone == "" { phone = "unknown" }
	if imei == ""  { imei  = "unknown" }

	fmt.Printf("[agent] srsd_log_upload: 전화번호=%s  IMEI=%s\n", phone, imei)

	files  := map[string]string{}
	errors := []string{}

	fmt.Println("[agent] srsd_log_upload: dmesg 수집 중...")
	if out := sh("dmesg | tail -n 3000", 60); out != "" {
		files["dmesg.log"] = out
	} else {
		errors = append(errors, "dmesg: 실패")
	}

	fmt.Println("[agent] srsd_log_upload: /data/logs 수집 중...")
	fileList := sh("find /data/logs -maxdepth 3 -type f 2>/dev/null", 15)
	for _, fpath := range strings.Split(fileList, "\n") {
		fpath = strings.TrimSpace(fpath)
		if fpath == "" {
			continue
		}
		rel := strings.ReplaceAll(strings.TrimPrefix(fpath, "/"), "/", "_")
		if content := sh(fmt.Sprintf("cat '%s'", fpath), 60); content != "" {
			files["data_logs/"+rel] = content
		}
	}

	fmt.Println("[agent] srsd_log_upload: /var/log/messages 수집 중...")
	if out := sh("tail -n 20000 /var/log/messages", 60); out != "" {
		files["var_log_messages.log"] = out
	} else {
		errors = append(errors, "/var/log/messages: 실패")
	}

	fmt.Printf("[agent] srsd_log_upload: %d개 파일 수집 완료, 서버 전송 중...\n", len(files))
	if err := httpLogUpload(files, errors, phone, imei, ip, browserSID); err != nil {
		fmt.Printf("[agent] srsd_log_upload: 전송 실패: %v\n", err)
	} else {
		fmt.Printf("[agent] srsd_log_upload: 전송 완료. (파일 %d개)\n", len(files))
	}
}

func doSrsdKmsgUpload(sio *SocketIO, cmd CmdData) {
	ip         := cmd.IP
	port       := cmd.SrsdPort
	browserSID := cmd.BrowserSID
	if port == 0 {
		port = srsdPort
	}

	sh := func(c string, timeout float64) string {
		r := srsdShell(ip, port, c, timeout)
		return r.stdout
	}

	phone := cleanPhone(sh("cat /var/tmp/phone_number", 5))
	imei  := strings.TrimSpace(sh("cat /var/tmp/imei", 5))
	if phone == "" { phone = "unknown" }
	if imei == ""  { imei  = "unknown" }

	fmt.Printf("[agent] srsd_kmsg_upload: 전화번호=%s  IMEI=%s\n", phone, imei)

	files  := map[string]string{}
	errors := []string{}

	fmt.Println("[agent] srsd_kmsg_upload: dmesg 수집 중...")
	if out := sh("dmesg | tail -n 3000", 60); out != "" {
		files["kmsg.log"] = out
	} else {
		errors = append(errors, "dmesg: 실패")
	}

	fmt.Println("[agent] srsd_kmsg_upload: 서버 전송 중...")
	if err := httpLogUpload(files, errors, phone, imei, ip, browserSID); err != nil {
		fmt.Printf("[agent] srsd_kmsg_upload: 전송 실패: %v\n", err)
	} else {
		fmt.Printf("[agent] srsd_kmsg_upload: 전송 완료. (파일 %d개)\n", len(files))
	}
}

func cleanPhone(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "+", "")
	s = strings.ReplaceAll(s, "-", "")
	s = strings.ReplaceAll(s, " ", "")
	return s
}
