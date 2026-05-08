@echo off
title RemoteDiag Controller Builder
cd /d "%~dp0"

echo [1/4] Stopping running remote_control.exe...
taskkill /f /im remote_control.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Installing packages...
pip install -q pyinstaller "python-socketio[client]" websocket-client requests
if errorlevel 1 (
    echo FAILED: pip install
    pause
    exit /b 1
)

echo [3/4] Building remote_control.exe...
pyinstaller --onefile --name remote_control --distpath dist --workpath build --specpath build --hidden-import websocket --hidden-import engineio.async_drivers.threading remote_control.py
if errorlevel 1 (
    echo FAILED: pyinstaller
    pause
    exit /b 1
)

echo [4/4] Done!
if exist dist\remote_control.exe (
    echo.
    echo Output: %~dp0dist\remote_control.exe
) else (
    echo Build failed.
)
pause