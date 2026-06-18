#!/bin/bash
# RemoteDiag 연결 상태 확인 스크립트
# 사용법:
#   ./check_connections.sh          # 1회 조회
#   ./check_connections.sh -w       # 5초마다 자동 갱신

CONTAINER="remotediag"
SCRIPT="/app/check_connections.py"
DIR="$(cd "$(dirname "$0")" && pwd)"
ARGS="$*"

# Docker 컨테이너 실행 중 확인
if sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    # Docker 환경: 컨테이너 안에서 실행 (API는 컨테이너 내부 127.0.0.1로 자동 접근)
    if [[ "$ARGS" == *"-w"* ]] || [[ "$ARGS" == *"--watch"* ]]; then
        sudo docker exec -it ${CONTAINER} python3 ${SCRIPT} --watch
    else
        sudo docker exec -it ${CONTAINER} python3 ${SCRIPT}
    fi
else
    # 직접 실행 환경
    python3 "${DIR}/check_connections.py" ${ARGS}
fi
