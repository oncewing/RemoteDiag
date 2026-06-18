# RemoteDiag 프로젝트

단말기 원격 진단 시스템. 브라우저 UI ↔ Flask/SocketIO 서버 ↔ Windows 에이전트(Go) 구조.

## 프로젝트 구조

```
RemoteDiag/
├── server.py              # Flask/SocketIO 서버 (메인)
├── config.py              # 서버 설정 (포트, 인증서 경로 등)
├── manage_tokens.py       # 접속 토큰 관리 CLI
├── remote_control.py      # 원격 제어 컨트롤러 (현재 미사용 — 다중 브라우저로 대체)
├── go_agent/              # Windows 에이전트 (Go)
│   ├── main.go            # 진입점, 연결 루프, allow_multi 프롬프트
│   ├── agent.go           # 서버 이벤트 핸들러
│   ├── secrets.go         # 서버 URL XOR 난독화, VERSION 정의
│   └── ...
├── static/
│   ├── index.html         # 브라우저 UI
│   ├── js/app.js          # 소켓 통신, UI 로직
│   └── css/style.css
├── dist_go/               # 빌드된 Windows exe (Docker 볼륨 마운트)
├── tokens.json            # 발급된 토큰 저장
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
- 원격 제어 탭은 applyPermissions()에서 목록에서 제외되어 항상 숨김

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
# 재빌드 필요한 경우: server.py, Dockerfile, requirements.txt, static/ 변경 시
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
python3 manage_tokens.py
```
- 토큰 생성/조회/삭제/권한 변경
- `tokens.json`에 저장 (Docker 볼륨 마운트로 컨테이너 재시작 시에도 유지)

## 서버 설정
- 내부 포트: 3004
- 외부 포트: 443 (nginx 리버스 프록시)
- URL: https://support.woori-net.com/remotediag/

## 에이전트 버전
- 현재: v2.0.0
- `go_agent/secrets.go`의 `VERSION` 변수에서 관리
