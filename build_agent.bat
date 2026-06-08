@echo off
title RemoteDiag Agent Builder [RELEASE]
cd /d "%~dp0"

echo ============================================
echo   RELEASE BUILD - Nuitka (C compile)
echo   Anti-reverse-engineering / For distribution
echo ============================================
echo.

echo [1/5] Stopping woorinet_remote_diag_agent.exe...
taskkill /f /im woorinet_remote_diag_agent.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/5] Installing packages...
pip install -q nuitka ordered-set zstandard "python-socketio[client]" pyserial
if %errorlevel% neq 0 (
    echo FAILED: pip install
    pause
    exit /b 1
)

echo [3/5] Preparing build source (EXPIRE_DATE injection)...
python _build_inject.py
if %errorlevel% neq 0 (
    if exist _build_agent.py     del /f /q _build_agent.py
    if exist _build_version.txt  del /f /q _build_version.txt
    echo FAILED: EXPIRE_DATE injection
    pause
    exit /b 1
)
set /p BUILD_VERSION=<_build_version.txt
del /f /q _build_version.txt
echo [inject] Output filename: woorinet_remote_diag_agent_v%BUILD_VERSION%.exe

echo [4/5] Building with Nuitka...
if exist dist\woorinet_remote_diag_agent_v%BUILD_VERSION%.exe del /f /q dist\woorinet_remote_diag_agent_v%BUILD_VERSION%.exe
python -m nuitka --onefile --output-filename=woorinet_remote_diag_agent_v%BUILD_VERSION%.exe --output-dir=dist --windows-console-mode=force --assume-yes-for-downloads --include-package=serial --include-package=socketio --include-package=engineio _build_agent.py
if %errorlevel% neq 0 (
    if exist _build_agent.py del /f /q _build_agent.py
    echo FAILED: nuitka
    pause
    exit /b 1
)

echo [5/5] Cleaning up...
if exist _build_agent.py                     del /f /q _build_agent.py
if exist dist\_build_agent.build             rmdir /s /q dist\_build_agent.build
if exist dist\_build_agent.onefile-build     rmdir /s /q dist\_build_agent.onefile-build

echo.
echo Build complete!
if exist dist\woorinet_remote_diag_agent_v%BUILD_VERSION%.exe (
    echo   %~dp0dist\woorinet_remote_diag_agent_v%BUILD_VERSION%.exe
) else (
    echo Build failed.
)
pause
