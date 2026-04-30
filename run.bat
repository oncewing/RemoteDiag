@echo off
chcp 65001 > nul
title RemoteDiag Server

cd /d "%~dp0"

echo [RemoteDiag] 패키지 설치 확인 중...
pip install -q -r requirements.txt

echo [RemoteDiag] 서버 시작...
python server.py
pause
