@echo off
setlocal
set PYTHONUTF8=1
title Pipeline Orchestrator Launcher

echo 🚀 Starting Pipeline Orchestrator in separate windows...

echo [1/2] Starting Backend (Port 8000)...
:: 移除 /B，讓它彈出新視窗
start "PO_Backend" cmd /c "cd /d "%~dp0backend" && .venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8000"

echo [2/2] Starting Frontend (Port 3002)...
:: 移除 /B，讓它彈出新視窗
start "PO_Frontend" cmd /c "cd /d "%~dp0frontend" && npx next dev --port 3002"

echo.
echo ✅ Project startup commands issued.
echo Frontend: http://localhost:3002
echo Backend:  http://localhost:8000
echo.
echo Please check the newly opened windows for logs.
pause
