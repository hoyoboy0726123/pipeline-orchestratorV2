import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY   = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL_MAIN = os.getenv("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL_MAIN = os.getenv("GEMINI_MODEL", "gemma-4-31b-it")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

TIMEZONE           = os.getenv("TIMEZONE", "Asia/Taipei")
OUTPUT_BASE_PATH   = Path(os.getenv("OUTPUT_BASE_PATH", "~/ai_output")).expanduser()
SCHEDULER_DB_PATH  = OUTPUT_BASE_PATH / "pipeline_scheduler.db"
PIPELINE_DIR       = Path(os.getenv("PIPELINE_DIR", "~/pipelines")).expanduser()

OUTPUT_BASE_PATH.mkdir(parents=True, exist_ok=True)
PIPELINE_DIR.mkdir(parents=True, exist_ok=True)

def check_config() -> list[str]:
    missing = []
    if not GROQ_API_KEY:
        missing.append("GROQ_API_KEY（AI 驗證與 YAML 助手需要）")
    return missing
