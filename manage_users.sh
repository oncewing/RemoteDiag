#!/bin/bash
# RemoteDiag 계정 관리 실행 스크립트
# 사용법: ./manage_users.sh

CONTAINER="remotediag"
SCRIPT="/app/manage_users.py"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    docker exec -it ${CONTAINER} python3 ${SCRIPT}
else
    DIR="$(cd "$(dirname "$0")" && pwd)"
    python3 "${DIR}/manage_users.py"
fi
