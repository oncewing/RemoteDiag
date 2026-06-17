package main

import (
	"bufio"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	accessCode  string
	shutdown    = make(chan struct{})
	shutdownMu  sync.Once
	retryDelay  time.Duration // 다음 재연결까지 대기 시간 (차단 시 설정)
)

func closeShutdown() {
	shutdownMu.Do(func() { close(shutdown) })
}

// enterCh 는 사용자가 Enter를 누를 때 신호를 전달하는 채널.
// stdin 읽기는 블로킹이므로 goroutine으로 분리해 프로그램 시작 시 한 번만 실행.
var enterCh = make(chan struct{}, 1)

func listenEnter() {
	buf := make([]byte, 1)
	for {
		os.Stdin.Read(buf)
		select {
		case enterCh <- struct{}{}:
		default:
		}
	}
}

func waitEnter() {
	fmt.Print("\n  Enter 키를 누르면 닫힙니다.")
	<-enterCh
}

func main() {
	// 종료 시그널 처리
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\n[agent] 종료 신호 수신. 종료 중...")
		closeShutdown()
		if currentSIO != nil {
			currentSIO.Disconnect()
		}
	}()

	// 만료일 검사
	checkExpiry()

	fmt.Println("==================================================")
	fmt.Printf("  RemoteDiag Agent  v%s  (Go)\n", VERSION)
	fmt.Println("==================================================")
	fmt.Println()
	fmt.Println("  관리자에게 발급받은 접속 코드를 입력하세요.")
//	fmt.Println("  예) 123456")
	fmt.Println()

	reader := bufio.NewReader(os.Stdin)
	fmt.Print("  접속 코드: ")
	input, err := reader.ReadString('\n')
	if err != nil {
		return
	}
	accessCode = strings.TrimSpace(input)
	if accessCode == "" {
		fmt.Println("\n[agent] 접속 코드가 입력되지 않았습니다. 종료합니다.")
		waitEnter()
		return
	}
	fmt.Println()

	// 접속 코드 입력 후 stdin을 Enter 감지 goroutine에 넘김
	go listenEnter()

	// 연결 루프
	for {
		select {
		case <-shutdown:
			fmt.Println("[agent] 종료.")
			waitEnter()
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
				fmt.Println("[agent] 종료.")
				waitEnter()
				return
			case <-time.After(3 * time.Second):
			}
			continue
		}

		sio.Wait()

		// kicked / fatalReject / shutdown → 재시도 없이 종료
		select {
		case <-shutdown:
			fmt.Println("[agent] 종료.")
			waitEnter()
			return
		default:
		}
		if fatalReject {
			fmt.Println("[agent] 종료.")
			waitEnter()
			return
		}

		delay := retryDelay
		retryDelay = 0
		if delay > 0 {
			// 차단 상태 — 자동 재시도 없이 안내만 표시
			fmt.Printf("[agent] %.0f초 후 프로그램을 다시 실행하여 재시도하세요.\n", delay.Seconds())
			fmt.Println("[agent] 종료.")
			waitEnter()
			return
		}
		fmt.Println("[agent] 3초 후 재시도...")
		select {
		case <-shutdown:
			fmt.Println("[agent] 종료.")
			waitEnter()
			return
		case <-time.After(3 * time.Second):
		}
	}
}
