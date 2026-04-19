"""根據使用者設定建立 LLM client（支援 Groq / Gemini / Ollama / OpenRouter）。"""
import asyncio
import logging
import time
from typing import Any, Optional

from config import GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY
from settings import get_settings


# Gemini 2.5 系列使用 thinking_budget，3.x 系列使用 thinking_level
_GEMINI_3X_PREFIXES = ("gemini-3-", "gemini-3.", "gemini-3.1")


def _is_gemini_3x(model: str) -> bool:
    return any(model.startswith(p) for p in _GEMINI_3X_PREFIXES)


def build_llm(temperature: float = 0.0) -> Any:
    """依當前設定回傳一個 LangChain chat model 實例。"""
    s = get_settings()
    provider = s["provider"]
    model = s["model"]

    if provider == "groq":
        from langchain_groq import ChatGroq
        return ChatGroq(api_key=GROQ_API_KEY, model=model, temperature=temperature)

    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        gem_thinking = s.get("gemini_thinking", "off")
        kwargs: dict[str, Any] = {
            "model": model,
            "google_api_key": GEMINI_API_KEY,
            "temperature": temperature,
            "max_output_tokens": 8192,  # 防止 gemma 等模型無限生成
        }
        # 只有 gemini-2.5 和 gemini-3.x 系列支援思考模式，其他模型（gemma, gemini-2.0）靜默忽略
        supports_thinking = model.startswith("gemini-2.5-") or _is_gemini_3x(model)
        if gem_thinking != "off" and supports_thinking:
            if _is_gemini_3x(model):
                kwargs["thinking_level"] = gem_thinking if gem_thinking != "auto" else "medium"
            else:
                budget_map = {"auto": -1, "low": 1024, "medium": 4096, "high": 16384}
                kwargs["thinking_budget"] = budget_map.get(gem_thinking, -1)
        return ChatGoogleGenerativeAI(**kwargs)

    if provider == "openrouter":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model,
            api_key=OPENROUTER_API_KEY,
            base_url="https://openrouter.ai/api/v1",
            temperature=temperature,
            default_headers={
                "HTTP-Referer": "http://localhost:3002",
                "X-Title": "Pipeline Orchestrator",
            },
        )

    if provider == "ollama":
        from langchain_ollama import ChatOllama
        thinking = s.get("ollama_thinking", "off")
        num_ctx = s.get("ollama_num_ctx", 16384)
        kwargs = {
            "model": model,
            "base_url": s.get("ollama_base_url") or "http://localhost:11434",
            "temperature": temperature,
            "num_ctx": num_ctx,
        }
        # auto → 不傳，讓模型自行決定；on/off → 明確開關（對 qwen3 等思考型模型有效）
        if thinking == "on":
            kwargs["reasoning"] = True
        elif thinking == "off":
            kwargs["reasoning"] = False
        return ChatOllama(**kwargs)

    raise ValueError(f"unknown provider: {provider}")


async def invoke_with_streaming(
    llm: Any,
    messages: list,
    *,
    label: str = "LLM",
    timeout: float = 300.0,
    logger: Optional[logging.Logger] = None,
) -> str:
    """以串流方式呼叫 LLM，附帶進度記錄與硬性超時。

    - 用串流避免 Ollama thinking 模式整包 buffer 造成「看起來卡住」
    - 每 15 秒打一行 log 顯示目前進度（reasoning / content 累積字數）
    - 超過 timeout 秒直接拋 asyncio.TimeoutError
    - 回傳最終 content 字串（reasoning_content 僅消耗，不回傳）
    """
    log = logger or logging.getLogger(__name__)
    start = time.time()
    last_log = start
    content_parts: list[str] = []
    reasoning_len = 0
    chunk_count = 0

    async def _stream():
        nonlocal last_log, reasoning_len, chunk_count
        async for chunk in llm.astream(messages):
            chunk_count += 1
            c = getattr(chunk, "content", None)
            if c:
                if isinstance(c, list):
                    for block in c:
                        if isinstance(block, dict):
                            t = block.get("text") or ""
                            if t:
                                content_parts.append(t)
                        elif isinstance(block, str):
                            content_parts.append(block)
                else:
                    content_parts.append(str(c))
            extra = getattr(chunk, "additional_kwargs", None) or {}
            rc = extra.get("reasoning_content") or extra.get("reasoning") or ""
            if rc:
                reasoning_len += len(rc) if isinstance(rc, str) else 0
            now = time.time()
            if now - last_log >= 15.0:
                elapsed = now - start
                total = sum(len(p) for p in content_parts)
                if reasoning_len:
                    log.info(
                        f"[{label}] 🧠 思考中… {elapsed:.0f}s（reasoning {reasoning_len} 字, content {total} 字）"
                    )
                else:
                    log.info(
                        f"[{label}] ✍️ 產生中… {elapsed:.0f}s（content {total} 字）"
                    )
                last_log = now

    try:
        await asyncio.wait_for(_stream(), timeout=timeout)
    except asyncio.TimeoutError:
        total = sum(len(p) for p in content_parts)
        log.error(
            f"[{label}] LLM 串流逾時（>{timeout:.0f}s），已收集 reasoning {reasoning_len} 字 / content {total} 字"
        )
        raise

    elapsed = time.time() - start
    total = sum(len(p) for p in content_parts)
    if reasoning_len:
        log.info(
            f"[{label}] ✅ LLM 完成（{elapsed:.0f}s, reasoning {reasoning_len} 字, content {total} 字）"
        )
    return "".join(content_parts)
