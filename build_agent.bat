@echo off
title RemoteDiag Agent Builder [RELEASE]
cd /d "%~dp0"

echo ============================================
echo   RELEASE BUILD (Nuitka / C 컴파일)
echo   * 역컴파일 불가 - 외부 배포용
echo   * 최초 실행 시 MinGW 다운로드 될 수 있음
echo ============================================
echo.

echo [1/4] Stopping running woorinet_remote_diag_agent.exe...
taskkill /f /im woorinet_remote_diag_agent.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Installing packages...
pip install -q nuitka ordered-set zstandard "python-socketio[client]" pyserial
if %errorlevel% neq 0 (
    echo FAILED: pip install
    pause
    exit /b 1
)

echo [3/4] Building exe with Nuitka...
if exist dist\woorinet_remote_diag_agent.exe del /f /q dist\woorinet_remote_diag_agent.exe
python -m nuitka ^
    --onefile ^
    --output-filename=woorinet_remote_diag_agent.exe ^
    --output-dir=dist ^
    --windows-console-mode=force ^
    --assume-yes-for-downloads ^
    --include-package=serial ^
    --include-package=socketio ^
    --include-package=engineio ^
    woorinet_remote_diag_agent.py
if %errorlevel% neq 0 (
    echo FAILED: nuitka
    pause
    exit /b 1
)

echo [4/4] Cleaning up build artifacts...
if exist dist\woorinet_remote_diag_agent.build     rmdir /s /q dist\woorinet_remote_diag_agent.build
if exist dist\woorinet_remote_diag_agent.onefile-build rmdir /s /q dist\woorinet_remote_diag_agent.onefile-build

echo.
echo Build complete!
if exist dist\woorinet_remote_diag_agent.exe (
    echo   %~dp0dist\woorinet_remote_diag_agent.exe
) else (
    echo Build failed.
)
pause
