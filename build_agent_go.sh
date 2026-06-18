#!/bin/bash
# RemoteDiag Go Agent 빌드 스크립트 (Linux 서버용)
# 사용법:
#   ./build_agent_go.sh                      # 만료일 대화형 입력
#   ./build_agent_go.sh --expire 2026-12-31  # 만료일 직접 지정
#   ./build_agent_go.sh --expire auto        # 자동 (+1개월)

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "============================================"
echo "  GO RELEASE BUILD (Linux)"
echo "============================================"
echo ""

# Go 설치 확인
if ! command -v go &>/dev/null; then
    echo "FAILED: Go not installed. Run: sudo apt install golang-go"
    exit 1
fi
echo "[1/4] Go version: $(go version)"

# 의존성 설치
echo "[2/4] Installing dependencies..."
cd go_agent && go mod tidy && cd ..

# 만료일 결정
EXPIRE_ARG=""
if [[ "$1" == "--expire" && -n "$2" ]]; then
    if [[ "$2" == "auto" ]]; then
        EXPIRE_ARG=""
    else
        EXPIRE_ARG="--expire $2"
    fi
else
    echo ""
    read -rp "  만료일 입력 (YYYY-MM-DD, 공백=자동+1개월): " INPUT_EXPIRE
    if [[ -n "$INPUT_EXPIRE" ]]; then
        EXPIRE_ARG="--expire $INPUT_EXPIRE"
    fi
fi

# 버전/만료일 계산
echo "[3/4] Computing VERSION and EXPIRE_DATE..."
python3 _build_inject.py $EXPIRE_ARG
EXPIRE_DATE=$(cat _build_version_expire.txt)
VERSION=$(cat _build_version.txt)

# 빌드
echo "[4/4] Building (GOOS=windows GOARCH=amd64)..."
mkdir -p dist_go
cd go_agent
GOOS=windows GOARCH=amd64 go build \
    -ldflags="-X 'main.VERSION=${VERSION}' -X 'main.EXPIRE_DATE=${EXPIRE_DATE}' -s -w" \
    -o ../dist_go/woorinet_remote_diag_agent.exe .
cd ..

echo ""
echo "Build complete!"
echo "  VERSION     : ${VERSION}"
echo "  EXPIRE_DATE : ${EXPIRE_DATE}"
echo "  Output      : ${DIR}/dist_go/woorinet_remote_diag_agent.exe"
