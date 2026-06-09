@echo off
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

echo [3/4] Computing EXPIRE_DATE...
for /f "delims=" %%i in ('python -c "import datetime,calendar; d=datetime.date.today(); mn=d.month%%12+1; yr=d.year+d.month//12; print(datetime.date(yr,mn,min(d.day,calendar.monthrange(yr,mn)[1])).isoformat())"') do set EXPIRE_DATE=%%i
echo [inject] EXPIRE_DATE: %EXPIRE_DATE%

echo [4/4] Building...
set GOOS=windows
set GOARCH=amd64
if not exist ..\dist mkdir ..\dist
go build -ldflags="-X 'main.EXPIRE_DATE=%EXPIRE_DATE%' -X 'main.VERSION=1.0.0' -s -w" -o ..\dist\woorinet_remote_diag_agent.exe .
if %errorlevel% neq 0 (
    cd ..
    echo FAILED: go build
    pause
    exit /b 1
)

cd ..

echo.
echo Build complete! (EXPIRE_DATE: %EXPIRE_DATE%)
if exist dist\woorinet_remote_diag_agent.exe (
    echo   %~dp0dist\woorinet_remote_diag_agent.exe
) else (
    echo Build failed.
)
pause
