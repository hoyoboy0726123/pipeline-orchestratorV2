@echo off
setlocal
title PipelineOrchestrator_Backend Launcher
cd /d "%~dp0"

set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
chcp 65001 >nul

echo ============================================
echo Starting PipelineOrchestrator_Backend...
echo Target: "%~dp0main.py"
echo ============================================

"%~dp0.venv\Scripts\python.exe" "%~dp0main.py"

echo.
echo ============================================
echo Execution finished.
echo ============================================
pause
exit /b
