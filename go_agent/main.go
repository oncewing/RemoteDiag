package main

import (
	"bufio"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// ── 빌드 시 ldflags로 주입 ────────────────────────────────────────────
var (
	VERSION     = "1.0.0" // -ldflags "-X 'main.VERSION=1.0.0'"
	EXPIRE_DATE = ""      // -ldflags "-X 'main.EXPIRE_DATE=2026-07-05'"
)

// ── 빌드 시 설정값 ───────────────────────────────────────────────────
const (
	SERVER_URL         = "wss://support.woori-net.com"
	SERVER_SOCKET_PATH = "/remotediag/socket.io"
)

var (
	accessCode string
	shutdown   = make(chan struct{})
)

func main() {
	// 종료 시그널 처리
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\n[agent] 종료 신호 수신. 종료 중...")
		close(shutdown)
	}()

	// 만료일 검사
	checkExpiry()

	fmt.Println("==================================================")
	fmt.Printf("  RemoteDiag Agent  v%s  (Go)\n", VERSION)
	fmt.Println("==================================================")
	fmt.Println()
	fmt.Println("  관리자에게 발급받은 접속 코드를 입력하세요.")
	fmt.Println("  예) AB12-CD34-EF56")
	fmt.Println()

	reader := bufio.NewReader(os.Stdin)
	fmt.Print("  접속 코드: ")
	input, err := reader.ReadString('\n')
	if err != nil {
		return
	}
	accessCode = strings.TrimSpace(strings.ToUpper(input))
	if accessCode == "" {
		fmt.Println("\n[agent] 접속 코드가 입력되지 않았습니다. 종료합니다.")
		return
	}
	fmt.Println()

	// 연결 루프
	for {
		select {
		case <-shutdown:
			fmt.Println("[agent] 종료.")
			return
		default:
		}

		fmt.Printf("[agent] 서버 연결 중: %s\n", SERVER_URL)

		sio := NewSocketIO()
		setupHandlers(sio)

		if err := sio.Connect(SERVER_URL, SERVER_SOCKET_PATH); err != nil {
			fmt.Printf("[agent] 연결 실패: %v. 3초 후 재시도...\n", err)
			select {
			case <-shutdown:
				return
			case <-time.After(3 * time.Second):
			}
			continue
		}

		sio.Wait()

		select {
		case <-shutdown:
			return
		case <-time.After(3 * time.Second):
			fmt.Println("[agent] 3초 후 재시도...")
		}
	}
}
