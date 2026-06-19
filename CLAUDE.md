# RemoteDiag 프로젝트

단말기 원격 진단 시스템. 브라우저 UI ↔ Flask/SocketIO 서버 ↔ Windows 에이전트(Go) 구조.

## 프로젝트 구조

```
RemoteDiag/
├── server.py              # Flask/SocketIO 서버 (메인)
├── config.py              # 서버 설정 (포트, 인증서 경로 등)
├── manage_tokens.py       # 접속 토큰 관리 CLI
├── manage_tokens.sh       # Docker 컨테이너 내 manage_tokens.py 실행 래퍼
├── manage_users.py        # 사용자 계정 관리 CLI
├── manage_users.sh        # Docker 컨테이너 내 manage_users.py 실행 래퍼
├── manage_rc_tokens.py    # 원격 제어 토큰 관리 CLI
├── manage_rc_tokens.sh    # Docker 컨테이너 내 manage_rc_tokens.py 실행 래퍼
├── check_connections.py   # 현재 연결 상태 확인 툴
├── check_connections.sh   # Docker 컨테이너 내 check_connections.py 실행 래퍼
├── remote_control.py      # 원격 제어 컨트롤러 (현재 미사용 — 다중 브라우저로 대체)
├── go_agent/              # Windows 에이전트 (Go)
│   ├── main.go            # 진입점, 연결 루프, allow_multi 프롬프트
│   ├── agent.go           # 서버 이벤트 핸들러
│   ├── secrets.go         # 서버 URL XOR 난독화, VERSION/EXPIRE_DATE 정의
│   ├── timesync.go        # NTP 시간 동기화, 만료일 검사
│   ├── socketio.go        # WebSocket/Socket.IO 클라이언트
│   ├── adb.go             # ADB 명령 실행
│   ├── commands.go        # 명령 디스패처
│   ├── log_stream.go      # 로그 스트리밍
│   ├── srsd.go            # SRSD 진단
│   ├── serial_port.go     # 시리얼 포트 제어
│   ├── upload.go          # 파일 업로드
│   ├── modem_windows.go   # Windows 모뎀 제어
│   ├── modem_other.go     # 비Windows 모뎀 제어
│   └── Makefile           # 빌드 스크립트 (만료일 자동 주입)
├── static/
│   ├── index.html         # 브라우저 UI
│   ├── js/app.js          # 소켓 통신, UI 로직
│   └── css/style.css
├── diag_profiles/         # 자동점검 프로파일
├── modules/               # 서버 모듈
├── dist_go/               # 빌드된 Windows exe (Docker 볼륨 마운트)
├── tokens.json            # 발급된 토큰 저장 (gitignore)
├── users.json             # 사용자 계정 저장 (gitignore)
├── rc_tokens.json         # 원격 제어 토큰 저장 (gitignore)
├── docker-compose.yml
└── Dockerfile
```

## 핵심 아키텍처

### 인증 흐름
1. 브라우저 → 접속 코드(7자리) 입력 → `browser_pair` 이벤트
2. 에이전트 → 접속 코드 입력 → 다중 브라우저 허용 여부(y/n) → `agent_hello` 이벤트
3. 서버가 코드를 기준으로 브라우저 ↔ 에이전트 페어링

### 서버 주요 자료구조 (server.py)
- `_agents`: agent_sid → 에이전트 정보
- `_browser_agent`: browser_sid → agent_sid
- `_agent_browser`: agent_sid → set[browser_sid] (1:N, 다중 브라우저)
- `_agent_tokens`: agent_sid → code
- `_agent_allow_multi`: agent_sid → bool
- `_pending_browser`: code → set[browser_sid] (에이전트 미연결 대기)

### 권한 (ALL_PERMISSIONS)
`adb-shell`, `adb-info`, `at`, `logs`, `kmsg`, `diag`, `guide`
- `remote` 권한은 제거됨 (다중 브라우저로 대체)
- 원격 제어 탭은 index.html에서 `style="display:none"` 으로 항상 숨김
- 토큰 페어링 시 서버에서도 `remote` 권한 자동 필터링

### 관리자 API (localhost 전용)
- `GET  /api/admin/connections` — 현재 연결 상태 조회
- `POST /api/admin/kick/<code>` — 특정 토큰 연결 강제 종료

## 빌드

### Go 에이전트 빌드 (Linux에서 Windows exe 크로스 컴파일)
```bash
# 기본: 빌드일로부터 1달 후 만료일 자동 설정
cd go_agent && make build

# 만료일 직접 지정
cd go_agent && make build EXPIRE_DATE=2026-12-31

# 만료일 없이 빌드 (개발 모드)
cd go_agent
GOOS=windows GOARCH=amd64 go build -o ../dist_go/woorinet_remote_diag_agent.exe .
```

### Docker
```bash
# 재빌드 필요한 경우: server.py, Dockerfile, requirements.txt 변경 시
docker-compose build && docker-compose up -d

# static/ 은 볼륨 마운트라 재빌드 없이 반영됨
# → 브라우저 새로고침만으로 적용
```

## Git 정책
- 작업 브랜치: `dev`
- 배포 브랜치: `master`
- 커밋 후 항상 `master`까지 merge/push

```bash
git add <파일들>
git commit -m "feat: ..."
git push origin dev
git checkout master && git merge dev && git push origin master && git checkout dev
```

## 토큰 관리
```bash
./manage_tokens.sh
```
- 메뉴: 생성 / 목록 / 권한 변경 / 폐기 / 삭제 / 일괄 삭제 / 전체 삭제 / 잠금 해제 / 연결 강제 종료
- `tokens.json`에 저장 (Docker 볼륨 마운트로 컨테이너 재시작 시에도 유지)

## 연결 상태 확인
```bash
./check_connections.sh
./check_connections.sh --watch   # 실시간 모니터링
```

## 서버 설정
- 내부 포트: 3004
- 외부 포트: 443 (nginx 리버스 프록시)
- URL: https://support.woori-net.com/remotediag/

## 에이전트 버전
- 현재: v2.1.0
- `go_agent/secrets.go`의 `VERSION` 변수에서 관리
- 만료일: `go_agent/secrets.go`의 `EXPIRE_DATE` (빌드 시 ldflags로 주입)
