@echo off
title RemoteDiag Agent Builder
cd /d "%~dp0"

echo [1/4] Stopping running woorinet_remote_diag_agent.exe...
taskkill /f /im woorinet_remote_diag_agent.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Installing packages...
pip install -q pyinstaller "python-socketio[client]" pyserial
if %errorlevel% neq 0 (
    echo FAILED: pip install
    pause
    exit /b 1
)

echo [3/4] Building exe with PyInstaller...
if exist build rmdir /s /q build
pyinstaller --onefile --name woorinet_remote_diag_agent ^
    --distpath dist --workpath build --specpath build ^
    --hidden-import serial ^
    --hidden-import serial.tools.list_ports ^
    --hidden-import socketio ^
    --hidden-import engineio ^
    --hidden-import engineio.async_drivers.threading ^
    woorinet_remote_diag_agent.py
if %errorlevel% neq 0 (
    echo FAILED: pyinstaller
    pause
    exit /b 1
)

echo [4/4] Cleaning up...
if exist build rmdir /s /q build

echo.
echo Build complete!
if exist dist\woorinet_remote_diag_agent.exe (
    echo   %~dp0dist\woorinet_remote_diag_agent.exe
) else (
    echo Build failed.
)
pause
