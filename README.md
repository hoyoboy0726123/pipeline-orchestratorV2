# Pipeline Orchestrator

**視覺化 Pipeline 編排器** — 透過拖拉式介面設計自動化工作流程，結合 AI 驅動的腳本生成、智慧驗證與排程執行。

![Python](https://img.shields.io/badge/Python-3.10+-blue)
![Next.js](https://img.shields.io/badge/Next.js-14-black)
![License](https://img.shields.io/badge/License-MIT-green)

## 功能特色

### 視覺化流程編輯器
- **拖拉式節點編排**：透過 React Flow 畫布自由排列與連接節點
- **三種節點類型**：
  - **腳本節點 (Script)**：執行自訂 Python / Shell 腳本
  - **AI 技能節點 (Skill)**：用自然語言描述任務，AI 自動產生並執行程式碼
  - **人工確認節點 (Human Confirm)**：在任意步驟之間暫停，等待人工審核

### AI 驅動
- **智慧驗證 (AI Validator)**：每一步執行完畢後，AI 自動檢查輸出是否符合預期
- **AI 助手**：用自然語言描述需求，AI 自動將其拆解為 Pipeline 步驟
- **Recipe 快取**：成功的 AI 技能執行結果會被快取，下次直接重播，跳過 LLM 呼叫

### 多 LLM 支援
- **Groq**（雲端，預設）：Llama 4 Scout / Llama 3 等
- **Google Gemini**（雲端）：Gemma 4 系列
- **Ollama**（本地）：支援任意本地模型，含 thinking 模式切換

### 排程與通知
- **排程執行**：Cron 式排程，支援一次性或週期性執行
- **Telegram 通知**：Pipeline 完成或失敗時推送通知，人工確認節點可直接在 Telegram 操作（繼續 / 中止 / 補充指示 / 查看 Log）

### 其他
- **YAML 匯入匯出**：Pipeline 可序列化為 YAML，便於版本控制
- **AI 技能套件管理**：透過 Web UI 管理 Python 套件（pandas、matplotlib 等）
- **虛擬環境偵測**：腳本節點自動偵測專案的 `.venv`，確保在正確環境中執行
- **Log 即時串流**：執行過程中即時查看完整日誌，支援自動捲動控制

---

## 系統需求

| 項目 | 最低版本 |
|------|---------|
| Python | 3.10+ |
| Node.js | 18+ |
| npm | 9+ |

選用：
- [uv](https://docs.astral.sh/uv/) — 更快的 Python 套件管理工具（可取代 pip + venv）
- Telegram Bot — 用於遠端通知與人工確認操作

---

## 安裝步驟

### 1. 取得原始碼

```bash
git clone https://github.com/hoyoboy0726123/pipeline-orchestratorV1.git
cd pipeline-orchestratorV1
```

### 2. 設定環境變數

複製範本並編輯：

**Windows (CMD)：**
```cmd
copy backend\.env.example backend\.env
```

**Windows (PowerShell) / macOS / Linux：**
```bash
cp backend/.env.example backend/.env
```

編輯 `backend/.env`，填入你的 API Key：

```env
# 至少填一個 LLM provider（Groq 或 Gemini）
GROQ_API_KEY=your_groq_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here

# Telegram 通知（選填，也可在 Web UI 設定）
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# 輸出與排程路徑
TIMEZONE=Asia/Taipei
OUTPUT_BASE_PATH=~/ai_output
PIPELINE_DIR=~/pipelines
```

> **API Key 取得方式：**
> - Groq：https://console.groq.com/keys
> - Gemini：https://aistudio.google.com/apikey

### 3. 安裝後端依賴

<details>
<summary><b>方法 A：使用 uv（推薦，速度快）</b></summary>

**安裝 uv（如果尚未安裝）：**

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**建立虛擬環境並安裝依賴：**

```bash
cd backend
uv venv .venv
uv pip install -r requirements.txt
```

</details>

<details>
<summary><b>方法 B：使用 pip + venv（傳統方式）</b></summary>

```bash
cd backend
python -m venv .venv

# Windows (CMD)
.venv\Scripts\activate

# Windows (PowerShell)
.venv\Scripts\Activate.ps1

# macOS / Linux
source .venv/bin/activate

# 安裝依賴
pip install -r requirements.txt
```

> **Windows PowerShell 注意事項：** 若出現「無法執行指令碼」的錯誤，請先執行：
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```

</details>

### 4. 安裝前端依賴

```bash
cd frontend
npm install
```

### 5. 啟動服務

#### 一鍵啟動（macOS / Linux）

```bash
# 回到專案根目錄
chmod +x start.sh
./start.sh
```

腳本會自動偵測是否安裝了 `uv`，優先使用 uv 建立虛擬環境。

#### 手動啟動（Windows / macOS / Linux）

開啟兩個終端機視窗：

**終端機 1 — 後端：**
```bash
cd backend

# 啟用虛擬環境（擇一）
.venv\Scripts\activate          # Windows CMD
.venv\Scripts\Activate.ps1      # Windows PowerShell
source .venv/bin/activate       # macOS / Linux

# 啟動後端
uvicorn main:app --host 0.0.0.0 --port 8000
```

**終端機 2 — 前端：**
```bash
cd frontend
npm run dev -- --port 3002
```

### 6. 開始使用

瀏覽器開啟 **http://localhost:3002** 即可進入視覺化 Pipeline 編輯器。

---

## 專案結構

```
pipeline-orchestratorV1/
├── backend/                  # FastAPI 後端
│   ├── main.py               # API 入口
│   ├── config.py             # 環境變數設定
│   ├── llm_factory.py        # LLM 多 provider 工廠
│   ├── db.py                 # SQLite 資料層
│   ├── settings.py           # 使用者設定持久化
│   ├── telegram_handler.py   # Telegram Bot 通知
│   ├── skill_pkg_manager.py  # AI 技能套件管理
│   ├── skill_packages.txt    # 預設 AI 技能套件清單
│   ├── requirements.txt      # Python 依賴
│   ├── .env.example          # 環境變數範本
│   ├── pipeline/             # Pipeline 核心邏輯
│   │   ├── runner.py         # Pipeline 執行引擎
│   │   ├── executor.py       # 單步驟執行器（含 AI 技能）
│   │   ├── validator.py      # AI 驗證器
│   │   ├── recipe.py         # Recipe 快取系統
│   │   ├── store.py          # Pipeline Run 持久化
│   │   ├── models.py         # 資料模型
│   │   └── logger.py         # 執行日誌
│   └── scheduler/            # 排程管理
│       └── manager.py        # APScheduler 整合
├── frontend/                 # Next.js 14 前端
│   ├── app/
│   │   ├── pipeline/         # Pipeline 編輯器頁面
│   │   ├── settings/         # 設定頁面
│   │   └── recipes/          # Recipe 管理頁面
│   ├── lib/
│   │   ├── api.ts            # 後端 API 封裝
│   │   └── types.ts          # TypeScript 型別定義
│   └── package.json
├── test-workflows/           # 範例工作流程
│   └── finance/              # 財務報表自動化範例（5 步驟）
├── start.sh                  # 一鍵啟動腳本
└── README.md
```

---

## 預設 AI 技能套件

後端啟動時會自動安裝以下套件到虛擬環境（可在 **設定 > AI 技能套件** 頁面管理）：

| 套件 | 用途 |
|------|------|
| `pandas` | 資料處理與分析 |
| `openpyxl` | Excel 讀寫 |
| `matplotlib` | 圖表繪製 |
| `requests` | HTTP 請求 |
| `beautifulsoup4` | 網頁解析 |
| `Pillow` | 圖片處理 |
| `python-docx` | Word 文件操作 |

---

## 設定說明

### LLM Provider 設定

在 Web UI **設定** 頁面可切換 LLM provider：

| Provider | 設定方式 | 備註 |
|----------|---------|------|
| Groq | `.env` 設定 `GROQ_API_KEY` | 免費額度，速度快 |
| Gemini | `.env` 設定 `GEMINI_API_KEY` | Google AI Studio |
| Ollama | Web UI 設定 Base URL | 本地部署，無需 API Key |

### Telegram 通知設定

1. 向 [@BotFather](https://t.me/BotFather) 建立 Bot，取得 Token
2. 取得你的 Chat ID（向 [@userinfobot](https://t.me/userinfobot) 發送訊息）
3. 在 **設定** 頁面填入 Bot Token 和 Chat ID，或寫入 `.env`

---

## 範例工作流程

專案內含一組 **財務報表自動化** 範例（`test-workflows/finance/`），演示完整的 5 步驟 Pipeline：

1. **產生交易資料** — 模擬 500+ 筆含髒資料的財務交易
2. **清洗資料** — 移除無效 / 重複 / 未核准記錄
3. **財務分析** — 計算 KPI、部門收支、月份趨勢
4. **產生報告** — 輸出格式化的 Excel 財務報表
5. **人工確認** — 暫停等待管理層審核

---

## License

MIT
