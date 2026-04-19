# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Pipeline Orchestrator** is a visual workflow automation system with a drag-and-drop canvas (React Flow) for designing multi-step pipelines. It supports **four node types**: shell script steps, AI-generated skill steps (LLM writes and executes Python code), human confirmation gates, and **desktop automation (computer_use) nodes** — record-and-replay mouse/keyboard operations with image-anchored stability. The backend uses FastAPI + SQLite; the frontend uses Next.js 14 App Router.

> **V2 新增**：`computer_use` 節點是純 Python 桌面自動化（pyautogui + OpenCV template matching），不依賴 LLM，不進 recipe 系統，錄製一次即可重複回放。

## Running the Project

### Backend
```bash
cd backend
# Activate venv first
source .venv/bin/activate          # macOS/Linux
.venv\Scripts\activate             # Windows CMD
.venv\Scripts\Activate.ps1        # Windows PowerShell

uvicorn main:app --host 0.0.0.0 --port 8000
```

### Frontend
```bash
cd frontend
npm run dev -- --port 3002
```

### One-click (Windows)
```bash
launch_full_project.bat
```

### One-click (Unix/macOS)
```bash
./start.sh
```

Access points:
- Frontend: http://localhost:3002
- Backend API: http://localhost:8000
- Swagger UI: http://localhost:8000/docs

### Frontend build/lint
```bash
cd frontend
npm run build
npm run lint
```

## Architecture

### Backend (`backend/`)

| File | Role |
|------|------|
| `main.py` | All REST API endpoints (FastAPI); ~830 lines |
| `config.py` | Env vars, output/pipeline directory setup, SQLite WAL mode |
| `llm_factory.py` | Multi-provider LLM client (Groq / Gemini / Ollama); streaming + timeout |
| `db.py` | Raw SQLite layer for workflows, recipes, and runs |
| `settings.py` | Persisted user settings (model choice, notification config) |
| `telegram_handler.py` | Telegram notifications + inline-keyboard polling for human confirm |
| `skill_pkg_manager.py` | Install/remove Python packages into the venv at runtime |
| `pipeline/runner.py` | State-machine orchestrator; drives per-step execution, retry, pause |
| `pipeline/executor.py` | Executes shell commands or AI-generated Python; handles skill code gen |
| `pipeline/computer_use.py` | **V2 新增**：桌面自動化引擎（L1+L2 image matching + pyautogui 動作執行 + FAILSAFE） |
| `pipeline/recorder.py` | **V2 新增**：`pynput` 監聽錄製使用者滑鼠/鍵盤，擷取點擊錨點圖 |
| `pipeline/validator.py` | AI-driven output validation after each step |
| `pipeline/recipe.py` | Recipe cache — if identical task + inputs, skip LLM and replay code |
| `pipeline/store.py` | Serialize/deserialize `PipelineRun` objects to/from SQLite |
| `pipeline/models.py` | `PipelineConfig`, `PipelineStep`, `PipelineRun`, `StepResult` dataclasses |
| `scheduler/manager.py` | APScheduler (cron/interval) backed by SQLite job store |

### Frontend (`frontend/`)

| Path | Role |
|------|------|
| `app/pipeline/page.tsx` | Main pipeline canvas editor (~1232 lines); React Flow wrapper |
| `app/pipeline/_store.ts` | Zustand store for canvas/pipeline state |
| `app/pipeline/_sidebar.tsx` | Node control panel (add/configure nodes) |
| `app/pipeline/_scriptPanel.tsx` | Script node config panel |
| `app/pipeline/_skillPanel.tsx` | Skill node config panel |
| `app/pipeline/_humanConfirmPanel.tsx` | Human confirm node panel |
| `app/settings/page.tsx` | LLM model selection, package management, Telegram settings |
| `app/recipes/page.tsx` | Browse and manage recipe cache |
| `lib/api.ts` | All backend API calls; single source of truth for HTTP communication |
| `lib/types.ts` | Shared TypeScript interfaces |

### Pipeline Execution Flow

```
POST /pipeline/run (YAML payload)
  → Parse PipelineConfig
  → PipelineRunner.run_pipeline()
    → For each step:
        Script step  → shell command via subprocess
        Skill step   → check recipe cache → (miss) LLM generates Python → exec
        Human confirm → send Telegram → poll for user response
        → validate_step() if AI validation enabled
        → retry or pause on failure
  → PipelineRun persisted; frontend polls GET /pipeline/runs/{run_id}
```

### Four Node Types (YAML)

```yaml
# Script node — run a shell command
- name: step1
  batch: "python script.py --input data.csv"

# Skill node — LLM generates code from description
- name: step2
  skill_mode: true
  batch: "Read data.csv and compute monthly averages, save to output.xlsx"

# Human confirm node — pause and wait for Telegram approval
- name: step3
  human_confirm: true
  batch: "Please review the output before continuing"

# Computer use node — desktop automation (recorded clicks/typing)
- name: step4
  computer_use: true
  assets_dir: ai_output/<pipeline>/step4_assets   # 錨點圖片資料夾
  fail_fast: true
  actions:
    - { "type": "click_image", "image": "img_001.png", "description": "點開始按鈕" }
    - { "type": "type_text", "text": "hello world" }
    - { "type": "hotkey", "keys": ["ctrl", "s"] }
    - { "type": "wait", "seconds": 1.5 }
    - { "type": "wait_image", "image": "img_002.png", "timeout_sec": 10 }
```

### Computer Use Node（V2 新增）

**執行特性**：
- **純 Python**（pyautogui + mss + opencv-python），不叫 LLM、不進 recipe
- 每個 `click_image` 動作都會用 `cv2.matchTemplate` + multi-scale 比對找到錨點圖中心再點擊，解決 DPI / 視窗縮放問題
- 不需要 `ai_output/` 輸出檔（沒有 output.path）；驗證完全由動作執行結果決定（exit code = 失敗數）

**錄製流程**：
- 前端桌面自動化節點 Panel → 按「開始錄製」→ 在螢幕任意操作（點擊、輸入、快捷鍵）
- 系統用 `pynput` 監聽，點擊時擷取點擊位置周圍 80×80 px 當錨點圖存入 `assets_dir`
- 按 F9 或 Panel 的「停止錄製」→ 產出 `actions.json` + `meta.json`
- Panel 自動載入錄好的動作序列，可拖曳重排、刪除

**動作類型**（`ComputerUseAction.type`）：
| type | 用途 |
|---|---|
| `click_image` | 找到 `image` 指定的錨點圖，點中心 |
| `click_at` | 絕對座標點擊（fallback） |
| `type_text` | 輸入文字（中文自動走 clipboard paste） |
| `hotkey` | 組合鍵（`["ctrl", "c"]`） |
| `wait` | 靜態等待 `seconds` |
| `wait_image` | 等某圖出現（含 `timeout_sec`） |
| `screenshot` | 存一張除錯截圖到 assets_dir |

**安全機制**：
- `pyautogui.FAILSAFE = True`：滑鼠甩到螢幕左上角 (0,0) 立即觸發 abort
- 每個動作間 `PAUSE = 0.15`，防止過快
- 單步動作數上限 `MAX_ACTIONS_PER_STEP = 500`
- 支援執行中 `force_abort()`：後端 `/pipeline/runs/<id>/abort` 會呼叫 `computer_use.request_abort()` 讓引擎在下個 action 間隙中斷

**依賴**（預載於 `backend/skill_packages.txt`）：
- `pyautogui` — 滑鼠/鍵盤驅動
- `opencv-python` — template matching
- `pygetwindow` — 視窗切換/定位（保留未來擴充）
- `pynput` — 錄製監聽

**REST API**：
- `POST /computer-use/recording/start` body `{session_id, output_dir}` 開始錄製
- `POST /computer-use/recording/stop` 結束錄製並寫出產物
- `GET /computer-use/recording/status` 查詢進行中狀態（前端 polling）
- `GET /computer-use/recording/load?output_dir=...` 重新載入已錄好的 actions

### Recipe Caching

Recipes are stored in `ai_output/pipeline.db` (`recipes` table). A recipe matches when:
1. The task description hash matches
2. Input file fingerprints (hashes) match

On a cache hit, the stored Python code is executed directly — no LLM call. Recipes track `success_count`, `fail_count`, and `avg_runtime_sec`.

### LLM Providers

Configured via `backend/.env` (copy from `.env.example`):
- **Groq** — `GROQ_API_KEY` (Llama 4 Scout, Llama 3.3 70B, DeepSeek R1, etc.)
- **Gemini** — `GEMINI_API_KEY` (Gemma 4 31B)
- **Ollama** — No key; local model; supports reasoning/thinking mode

Switch provider at runtime via `PUT /settings/model`.

### Database

SQLite at `~/ai_output/pipeline.db` (WAL mode). Three application tables:
- `workflows` — canvas JSON + YAML per workflow
- `recipes` — cached AI-generated code per workflow step
- `runs` — full JSON-serialized `PipelineRun` history

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `GROQ_API_KEY` | For Groq | — | Groq API access |
| `GEMINI_API_KEY` | For Gemini | — | Gemini API access |
| `TELEGRAM_BOT_TOKEN` | Optional | — | Human confirm notifications |
| `TELEGRAM_CHAT_ID` | Optional | — | Telegram target chat |
| `TIMEZONE` | No | `Asia/Taipei` | Cron scheduler timezone |
| `OUTPUT_BASE_PATH` | No | `~/ai_output` | Workflow output directory |
| `PIPELINE_DIR` | No | `~/pipelines` | Workflow definition directory |

## Key Conventions

- Frontend components internal to a page are prefixed with `_` (e.g., `_sidebar.tsx`, `_store.ts`).
- All backend HTTP calls go through `frontend/lib/api.ts` — add new calls there.
- The frontend proxies `/api/backend/*` to `http://localhost:8000` (configured in `next.config.mjs`).
- Default skill packages installed to venv: `pandas`, `openpyxl`, `matplotlib`, `requests`, `beautifulsoup4`, `Pillow`, `python-docx` (see `backend/skill_packages.txt`).
- UI and comments are predominantly in Chinese (Traditional, Taiwan locale).
