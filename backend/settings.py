"""使用者可調設定（模型選擇等）— 持久化到 JSON 檔案。"""
import json
import threading
from pathlib import Path
from typing import Optional

from config import OUTPUT_BASE_PATH, GROQ_MODEL_MAIN

_SETTINGS_PATH = OUTPUT_BASE_PATH / "pipeline_settings.json"
_lock = threading.Lock()

# 預設：沿用環境變數 / config.py 預設的 Groq 模型
_DEFAULT = {
    "provider": "groq",           # "groq" | "ollama"
    "model": GROQ_MODEL_MAIN,      # e.g. "meta-llama/llama-4-scout-17b-16e-instruct" or "qwen3:8b"
    "ollama_base_url": "http://localhost:11434",
    "ollama_thinking": "off",      # "auto" | "on" | "off" — 預���關閉，避免 thinking 模式 rambling 卡��
    "ollama_num_ctx": 16384,       # Ollama context window tokens（僅 Ollama）
    "gemini_thinking": "off",      # "off" | "auto" | "low" | "medium" | "high"
    "openrouter_thinking": "off",  # "off" | "on" — DeepSeek R1 等模型的思考模式
    # 通知設定
    "telegram_bot_token": "",
    "telegram_chat_id": "",
    "line_notify_token": "",       # LINE Notify（預留）
}

_cache: Optional[dict] = None


def _load_from_disk() -> dict:
    if _SETTINGS_PATH.exists():
        try:
            with open(_SETTINGS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            merged = dict(_DEFAULT)
            merged.update({k: v for k, v in data.items() if k in _DEFAULT})
            return merged
        except Exception:
            pass
    return dict(_DEFAULT)


def get_settings() -> dict:
    """取得當前設定（含快取）。"""
    global _cache
    with _lock:
        if _cache is None:
            _cache = _load_from_disk()
        return dict(_cache)


def update_settings(
    provider: str,
    model: str,
    ollama_base_url: Optional[str] = None,
    ollama_thinking: Optional[str] = None,
    ollama_num_ctx: Optional[int] = None,
    gemini_thinking: Optional[str] = None,
    openrouter_thinking: Optional[str] = None,
) -> dict:
    """更新並寫入磁碟。"""
    global _cache
    if provider not in ("groq", "ollama", "gemini", "openrouter"):
        raise ValueError(f"unsupported provider: {provider}")
    if not model or not isinstance(model, str):
        raise ValueError("model is required")
    thinking = (ollama_thinking or "off").strip()
    if thinking not in ("auto", "on", "off"):
        raise ValueError(f"invalid ollama_thinking: {thinking}")
    gem_thinking = (gemini_thinking or "off").strip()
    if gem_thinking not in ("off", "auto", "low", "medium", "high"):
        raise ValueError(f"invalid gemini_thinking: {gem_thinking}")
    or_thinking = (openrouter_thinking or "off").strip()
    if or_thinking not in ("off", "on"):
        raise ValueError(f"invalid openrouter_thinking: {or_thinking}")
    num_ctx = ollama_num_ctx if ollama_num_ctx is not None else _DEFAULT["ollama_num_ctx"]
    if not isinstance(num_ctx, int) or num_ctx < 2048 or num_ctx > 262144:
        raise ValueError(f"invalid ollama_num_ctx: {num_ctx}（需介於 2048~262144）")

    with _lock:
        # 先讀取現有設定（保留通知等其他欄位）
        existing = _cache if _cache else _load_from_disk()
        existing.update({
            "provider": provider,
            "model": model.strip(),
            "ollama_base_url": (ollama_base_url or _DEFAULT["ollama_base_url"]).strip(),
            "ollama_thinking": thinking,
            "ollama_num_ctx": num_ctx,
            "gemini_thinking": gem_thinking,
            "openrouter_thinking": or_thinking,
        })
        _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(existing, f, ensure_ascii=False, indent=2)
        _cache = existing
    return dict(existing)


def settings_signature() -> str:
    """回傳一個代表當前設定的簡易字串，用於 LLM 快取失效判斷。"""
    s = get_settings()
    return f"{s['provider']}::{s['model']}::{s['ollama_base_url']}::{s.get('ollama_thinking', 'off')}::{s.get('ollama_num_ctx', 16384)}"
