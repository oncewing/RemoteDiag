@echo off
chcp 65001 >nul
title RemoteDiag Agent Builder [GO - RELEASE]
cd /d "%~dp0"

echo ============================================
echo   GO RELEASE BUILD
echo   Native binary - Anti-AV false positive
echo ============================================
echo.

echo [1/4] Checking Go installation...
go version
if %errorlevel% neq 0 (
    echo FAILED: Go not installed. Download from https://go.dev/dl/
    pause
    exit /b 1
)

echo [2/4] Installing dependencies...
cd go_agent
go mod tidy
if %errorlevel% neq 0 (
    echo FAILED: go mod tidy
    cd ..
    pause
    exit /b 1
)

echo [3/4] Setting EXPIRE_DATE...
cd ..

:: 만료일 직접 입력 (공백이면 자동: 빌드일 +1개월)
set INPUT_EXPIRE=
set /p INPUT_EXPIRE="  만료일 입력 (YYYY-MM-DD, 공백=자동+1개월): "

if "%INPUT_EXPIRE%"=="" (
    python _build_inject.py
) else (
    python _build_inject.py --expire "%INPUT_EXPIRE%"
)
if %errorlevel% neq 0 (
    echo FAILED: _build_inject.py
    pause
    exit /b 1
)
set /p EXPIRE_DATE=<_build_version_expire.txt
set /p VERSION=<_build_version.txt
cd go_agent

echo [4/4] Building...
set GOOS=windows
set GOARCH=amd64
if not exist ..\dist_go mkdir ..\dist_go
go build -ldflags="-X 'main.VERSION=%VERSION%' -X 'main.EXPIRE_DATE=%EXPIRE_DATE%' -s -w" -o ..\dist_go\woorinet_remote_diag_agent.exe .
if %errorlevel% neq 0 (
    cd ..
    echo FAILED: go build
    pause
    exit /b 1
)

cd ..

echo.
echo Build complete!
echo   VERSION     : %VERSION%
echo   EXPIRE_DATE : %EXPIRE_DATE%
if exist dist_go\woorinet_remote_diag_agent.exe (
    echo   Output: %~dp0dist_go\woorinet_remote_diag_agent.exe
) else (
    echo Build failed.
)
pause
