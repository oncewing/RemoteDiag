package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

const ntpDelta uint32 = 2208988800 // 1900-01-01 ~ 1970-01-01 초 차이

func getNTPTime(host string, timeout time.Duration) (time.Time, error) {
	conn, err := net.DialTimeout("udp", host+":123", timeout)
	if err != nil {
		return time.Time{}, err
	}
	defer conn.Close()

	conn.SetDeadline(time.Now().Add(timeout))

	req := make([]byte, 48)
	req[0] = 0x1b // LI=0, VN=3, Mode=3 (client)
	if _, err := conn.Write(req); err != nil {
		return time.Time{}, err
	}

	resp := make([]byte, 48)
	if _, err := conn.Read(resp); err != nil {
		return time.Time{}, err
	}

	secs := binary.BigEndian.Uint32(resp[40:44])
	return time.Unix(int64(secs-ntpDelta), 0).UTC(), nil
}

func getHTTPTime(rawURL string, timeout time.Duration) (time.Time, error) {
	client := &http.Client{Timeout: timeout}
	req, _ := http.NewRequest("HEAD", rawURL, nil)
	resp, err := client.Do(req)
	if err != nil {
		return time.Time{}, err
	}
	defer resp.Body.Close()
	return http.ParseTime(resp.Header.Get("Date"))
}

func getNetworkTime() (time.Time, error) {
	ntpHosts := []string{
		"pool.ntp.org",
		"time.google.com",
		"time.cloudflare.com",
		"time.windows.com",
	}
	for _, host := range ntpHosts {
		if t, err := getNTPTime(host, 5*time.Second); err == nil {
			return t, nil
		}
	}
	// HTTP 폴백
	for _, u := range []string{"https://www.google.com", "https://www.cloudflare.com"} {
		if t, err := getHTTPTime(u, 7*time.Second); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("모든 시간 서버 연결 실패")
}

func checkExpiry() {
	if EXPIRE_DATE == "" {
		fmt.Println("[agent] 만료일 미설정 — 개발 모드로 실행 (만료 검사 생략)")
		return
	}

	expire, err := time.Parse("2006-01-02", EXPIRE_DATE)
	if err != nil {
		fmt.Printf("[오류] 만료일 형식 오류: %v\n", err)
		os.Exit(1)
	}

	fmt.Print("[agent] 시간 서버 확인 중...")
	now, err := getNetworkTime()
	if err != nil {
		fmt.Printf("\n[오류] 시간 서버에 연결할 수 없습니다: %v\n", err)
		os.Exit(1)
	}
	fmt.Println()

	today := now.Truncate(24 * time.Hour)
	expireDay := expire.Truncate(24 * time.Hour)
	remaining := int(expireDay.Sub(today).Hours() / 24)

	if today.After(expireDay) {
		fmt.Printf("[오류] 이 버전은 %s에 만료되었습니다.\n", EXPIRE_DATE)
		fmt.Println("       새 버전을 다운로드하세요.")
		os.Exit(1)
	}

	if remaining <= 30 {
		fmt.Printf("[agent] 현재 날짜  : %s  /  사용 만료일: %s  ※ %d일 후 만료됩니다.\n",
			now.Format("2006-01-02"), EXPIRE_DATE, remaining)
	} else {
		fmt.Printf("[agent] 현재 날짜  : %s  /  사용 만료일: %s\n",
			now.Format("2006-01-02"), EXPIRE_DATE)
	}
}
