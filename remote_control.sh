#!/bin/bash
# Docker 내부에서 실행 (로컬 직접 연결, 인증 불필요)
sudo docker exec -it remotediag python3 /app/remote_control.py --local
