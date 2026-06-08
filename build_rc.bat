@echo off
title RemoteDiag RC Builder
cd /d "%~dp0"

echo ============================================
echo   Remote Control CLI Builder - PyInstaller
echo ============================================
echo.

echo [1/3] Stopping remote_control.exe...
taskkill /f /im remote_control.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/3] Installing packages...
pip install -q pyinstaller "python-socketio[client]" requests
if %errorlevel% neq 0 (
    echo FAILED: pip install
    pause
    exit /b 1
)

echo [3/3] Building with PyInstaller...
if exist dist\remote_control.exe del /f /q dist\remote_control.exe
if exist build rmdir /s /q build
pyinstaller --onefile --name remote_control ^
    --distpath dist --workpath build --specpath build ^
    --hidden-import socketio ^
    --hidden-import engineio ^
    --hidden-import engineio.async_drivers.threading ^
    remote_control.py
if %errorlevel% neq 0 (
    if exist build rmdir /s /q build
    echo FAILED: pyinstaller
    pause
    exit /b 1
)

if exist build rmdir /s /q build

echo.
echo Build complete!
if exist dist\remote_control.exe (
    echo   %~dp0dist\remote_control.exe
) else (
    echo Build failed.
)
pause
