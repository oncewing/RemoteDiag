#!/bin/bash
# RemoteDiag 원격 제어 CLI 실행 스크립트
# 사용법: ./remote_control.sh [--server URL] [--user 사용자명]
#
#   Docker 컨테이너 실행 중 → 컨테이너 내부에서 --local 모드로 실행
#   Docker 컨테이너 없음   → 로컬에서 직접 실행 (서버 URL·로그인 필요)

CONTAINER="remotediag"
SCRIPT="/app/remote_control.py"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    docker exec -it ${CONTAINER} python3 ${SCRIPT} --local "$@"
else
    DIR="$(cd "$(dirname "$0")" && pwd)"
    python3 "${DIR}/remote_control.py" "$@"
fi
