@echo off
title RemoteDiag Agent Builder
cd /d "%~dp0"

echo [1/3] Installing packages...
pip install -q pyinstaller "python-socketio[client]" pyserial
if errorlevel 1 (
    echo FAILED: pip install
    pause
    exit /b 1
)

echo [2/3] Building agent.exe...
pyinstaller --onefile --name agent --distpath dist --workpath build --specpath build agent.py
if errorlevel 1 (
    echo FAILED: pyinstaller
    pause
    exit /b 1
)

echo [3/3] Done!
if exist dist\agent.exe (
    echo.
    echo agent.exe: %~dp0dist\agent.exe
) else (
    echo Build failed.
)
pause
