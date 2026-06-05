@echo off
title RemoteDiag Agent Builder [DEV]
cd /d "%~dp0"

echo ============================================
echo   DEV BUILD - PyInstaller (fast build)
echo   For development and testing only
echo ============================================
echo.

echo [1/4] Stopping woorinet_remote_diag_agent.exe...
taskkill /f /im woorinet_remote_diag_agent.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Installing packages...
pip install -q pyinstaller "python-socketio[client]" pyserial
if %errorlevel% neq 0 (
    echo FAILED: pip install
    pause
    exit /b 1
)

echo [3/4] Preparing build source (EXPIRE_DATE injection)...
python _build_inject.py
if %errorlevel% neq 0 (
    if exist _build_agent.py del /f /q _build_agent.py
    echo FAILED: EXPIRE_DATE injection
    pause
    exit /b 1
)

echo [4/4] Building with PyInstaller...
if exist build rmdir /s /q build
pyinstaller --onefile --name woorinet_remote_diag_agent ^
    --distpath dev --workpath build --specpath build ^
    --hidden-import serial ^
    --hidden-import serial.tools.list_ports ^
    --hidden-import socketio ^
    --hidden-import engineio ^
    --hidden-import engineio.async_drivers.threading ^
    _build_agent.py
if %errorlevel% neq 0 (
    if exist _build_agent.py del /f /q _build_agent.py
    if exist build rmdir /s /q build
    echo FAILED: pyinstaller
    pause
    exit /b 1
)

if exist build rmdir /s /q build
if exist _build_agent.py del /f /q _build_agent.py

echo.
echo Build complete!
if exist dev\woorinet_remote_diag_agent.exe (
    echo   %~dp0dev\woorinet_remote_diag_agent.exe
) else (
    echo Build failed.
)
pause
