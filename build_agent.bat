@echo off
title RemoteDiag Agent Builder
cd /d "%~dp0"

echo [1/6] Stopping running woorinet_remote_diag_agent.exe...
taskkill /f /im woorinet_remote_diag_agent.exe >/dev/null 2>&1
timeout /t 1 /nobreak >nul

echo [2/6] Installing packages...
pip install -q pyinstaller "pyarmor==9.2.4" "python-socketio[client]" pyserial
if errorlevel 1 (echo FAILED: pip install & pause & exit /b 1)

echo [3/6] Obfuscating with PyArmor...
if exist obf rmdir /s /q obf
pyarmor gen --output obf woorinet_remote_diag_agent.py
if errorlevel 1 (echo FAILED: pyarmor gen & pause & exit /b 1)

echo [4/6] Building exe with PyInstaller...
if exist build rmdir /s /q build
pyinstaller --onefile --name woorinet_remote_diag_agent --distpath dist --workpath build --specpath build --hidden-import serial --hidden-import serial.tools.list_ports --hidden-import socketio --hidden-import engineio --hidden-import engineio.async_drivers.threading --paths obf obf\woorinet_remote_diag_agent.py
if errorlevel 1 (echo FAILED: pyinstaller & pause & exit /b 1)

echo [5/6] Cleaning up...
if exist build rmdir /s /q build
if exist obf rmdir /s /q obf

echo [6/6] Done!
if exist dist\woorinet_remote_diag_agent.exe (echo. & echo   %~dp0dist\woorinet_remote_diag_agent.exe) else (echo Build failed.)
pause
