#!/bin/bash
# RemoteDiag 접속 코드 관리 실행 스크립트
# 사용법: ./manage_tokens.sh

CONTAINER="remotediag"
SCRIPT="/app/manage_tokens.py"

if sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    sudo docker exec -it -e TERM=xterm ${CONTAINER} sh -c "stty sane; python3 ${SCRIPT}"
else
    DIR="$(cd "$(dirname "$0")" && pwd)"
    python3 "${DIR}/manage_tokens.py"
fi
