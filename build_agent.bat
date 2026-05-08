@echo off
title RemoteDiag Agent Builder
cd /d "%~dp0"

echo [1/4] Stopping running woorinet_remote_diag_agent.exe...
taskkill /f /im woorinet_remote_diag_agent.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Installing packages...
pip install -q pyinstaller "python-socketio[client]" pyserial
if errorlevel 1 (
    echo FAILED: pip install
    pause
    exit /b 1
)

echo [3/4] Building woorinet_remote_diag_agent.exe...
pyinstaller --onefile --name woorinet_remote_diag_agent --distpath dist --workpath build --specpath build woorinet_remote_diag_agent.py
if errorlevel 1 (
    echo FAILED: pyinstaller
    pause
    exit /b 1
)

echo [4/4] Done!
if exist dist\woorinet_remote_diag_agent.exe (
    echo.
    echo woorinet_remote_diag_agent.exe: %~dp0dist\woorinet_remote_diag_agent.exe
) else (
    echo Build failed.
)
pause
