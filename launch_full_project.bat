@echo off
setlocal
set PYTHONUTF8=1
title Pipeline Orchestrator Launcher

echo 🚀 Starting Pipeline Orchestrator in separate windows...

echo [1/2] Starting Backend (Port 8001)...
:: /D 設工作目錄（避開 cmd /c 內部的巢狀引號解析問題）
:: /k 跑完不自動關，啟動失敗時才看得到 traceback
:: port 8001 要跟 frontend/next.config.mjs 的 rewrites destination 一致，改 port 兩邊都要動
start "PO_Backend" /D "%~dp0backend" cmd /k .venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8001

echo [2/2] Starting Frontend (Port 3002)...
start "PO_Frontend" /D "%~dp0frontend" cmd /k npx next dev --port 3002

echo.
echo ✅ Project startup commands issued.
echo Frontend: http://localhost:3002
echo Backend:  http://localhost:8001
echo.
echo Please check the newly opened windows for logs.
pause
