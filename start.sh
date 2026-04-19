#!/bin/bash
# Pipeline Orchestrator 啟動腳本
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

echo "🚀 啟動 Pipeline Orchestrator..."

# ── 後端 ─────────────────────────────────────────────────────────
echo "▶ 啟動後端 (port 8000)..."
cd "$BACKEND"

if [ ! -d ".venv" ]; then
  echo "  建立虛擬環境..."
  if command -v uv &> /dev/null; then
    echo "  (使用 uv)"
    uv venv .venv
    uv pip install -r requirements.txt
  else
    python3 -m venv .venv
    .venv/bin/pip install -q -r requirements.txt
  fi
fi

.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
echo "  後端 PID: $BACKEND_PID"

# 等後端就緒
sleep 2

# ── 前端 ─────────────────────────────────────────────────────────
echo "▶ 啟動前端 (port 3002)..."
cd "$FRONTEND"
if [ ! -d "node_modules" ]; then
  echo "  安裝前端依賴（首次需要較長時間）..."
  npm install --silent
fi
npm run dev -- --port 3002 &
FRONTEND_PID=$!
echo "  前端 PID: $FRONTEND_PID"

echo ""
echo "✅ Pipeline Orchestrator 已啟動"
echo "   前端：http://localhost:3002"
echo "   後端：http://localhost:8000"
echo ""
echo "按 Ctrl+C 停止所有服務"

# 捕捉 Ctrl+C 清理子進程
trap "echo '停止中...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
