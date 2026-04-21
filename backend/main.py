"""
Pipeline Orchestrator — 獨立後端
啟動：uvicorn main:app --host 0.0.0.0 --port 8000
"""
import asyncio
import json
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import check_config
from scheduler.manager import start as sched_start, shutdown as sched_shutdown

app = FastAPI(title="Pipeline Orchestrator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3002", "http://127.0.0.1:3002",
                   "http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    from db import init_db
    init_db()
    print("✅ SQLite 資料庫已初始化")
    # 自動安裝 skill_packages.txt 中缺少的套件
    from skill_pkg_manager import auto_install_packages
    auto_install_packages()
    await sched_start()
    print("✅ Pipeline Scheduler 已啟動")
    from telegram_handler import start_polling as tg_start
    await tg_start()
    print("✅ Telegram callback polling 已啟動")


@app.on_event("shutdown")
async def shutdown():
    await sched_shutdown()
    from telegram_handler import stop_polling as tg_stop
    await tg_stop()


# ── Health ───────────────────────────────────────────────────
@app.get("/health")
async def health():
    missing = check_config()
    return {"status": "ok", "warnings": [f"{k} 未設定" for k in missing]}


# ── Settings（模型選擇）─────────────────────────────────────
# 排除的 Groq 模型（非文字生成用途）
_GROQ_EXCLUDE_PREFIXES = ("whisper-", "llama-prompt-guard", "canopylabs/orpheus")

# Gemini 可用於文字生成的模型前綴（排除 embedding, tts, robotics, audio 等）
_GEMINI_TEXT_PREFIXES = ("gemini-2.5-", "gemini-2.0-", "gemini-3-", "gemini-3.", "gemma-")
_GEMINI_EXCLUDE_KEYWORDS = ("tts", "audio", "embedding", "robotics", "image", "live", "customtools", "computer-use")

# 支援思考模式的 Gemini 模型前綴
_GEMINI_THINKING_PREFIXES = ("gemini-2.5-", "gemini-3-", "gemini-3.")


@app.get("/settings/model")
async def get_model_settings():
    from settings import get_settings
    return get_settings()


class ModelSettingsRequest(BaseModel):
    provider: str
    model: str
    ollama_base_url: Optional[str] = None
    ollama_thinking: Optional[str] = None   # "auto" | "on" | "off"
    ollama_num_ctx: Optional[int] = None
    gemini_thinking: Optional[str] = None   # "off" | "auto" | "low" | "medium" | "high"
    openrouter_thinking: Optional[str] = None  # "off" | "on"


@app.put("/settings/model")
async def put_model_settings(req: ModelSettingsRequest):
    from settings import update_settings
    try:
        return update_settings(
            req.provider, req.model, req.ollama_base_url, req.ollama_thinking, req.ollama_num_ctx,
            req.gemini_thinking, req.openrouter_thinking,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── models/available 快取：4 個外部 API 每次都打太慢，5 分鐘記憶體快取 ──
_MODELS_CACHE: dict = {"ts": 0.0, "data": None}
_MODELS_CACHE_TTL = 300.0  # 秒


@app.get("/settings/models/available")
async def get_available_models(refresh: bool = False):
    """動態列出各 provider 可用模型。有 5 分鐘快取，加 ?refresh=true 強制更新。"""
    import time as _time
    import asyncio as _asyncio
    import httpx
    from config import GROQ_API_KEY as _groq_key, GEMINI_API_KEY as _gemini_key, OPENROUTER_API_KEY as _or_key

    # 命中快取直接回，~5ms
    if not refresh and _MODELS_CACHE["data"] and (_time.time() - _MODELS_CACHE["ts"]) < _MODELS_CACHE_TTL:
        return _MODELS_CACHE["data"]

    ollama_models: list[dict] = []
    ollama_error: Optional[str] = None
    groq_models: list[dict] = []
    groq_error: Optional[str] = None
    gemini_models: list[dict] = []
    gemini_error: Optional[str] = None
    openrouter_models: list[dict] = []
    openrouter_error: Optional[str] = None

    base_url = "http://localhost:11434"
    try:
        from settings import get_settings as _gs
        base_url = _gs().get("ollama_base_url") or base_url
    except Exception:
        pass

    async with httpx.AsyncClient(timeout=8.0) as client:
        # ── 每個 provider 包成獨立 coroutine，用 asyncio.gather 併發 ──
        async def fetch_groq() -> tuple[list[dict], Optional[str]]:
            if not _groq_key:
                return [], "未設定 GROQ_API_KEY"
            try:
                r = await client.get(
                    "https://api.groq.com/openai/v1/models",
                    headers={"Authorization": f"Bearer {_groq_key}"},
                )
                r.raise_for_status()
                models = []
                for m in r.json().get("data", []):
                    mid = m.get("id", "")
                    if not m.get("active", True):
                        continue
                    if any(mid.startswith(p) for p in _GROQ_EXCLUDE_PREFIXES):
                        continue
                    ctx = m.get("context_window", 0)
                    owner = m.get("owned_by", "")
                    label = mid
                    if owner:
                        label += f"（{owner}"
                        if ctx:
                            label += f", ctx={ctx // 1024}K"
                        label += "）"
                    models.append({"id": mid, "label": label})
                models.sort(key=lambda x: x["id"])
                return models, None
            except Exception as e:
                return [], f"Groq API 錯誤：{e}"

        async def fetch_gemini() -> tuple[list[dict], Optional[str]]:
            if not _gemini_key:
                return [], "未設定 GEMINI_API_KEY"
            try:
                r = await client.get(
                    f"https://generativelanguage.googleapis.com/v1beta/models?key={_gemini_key}",
                )
                r.raise_for_status()
                models = []
                for m in r.json().get("models", []):
                    mid = m.get("name", "").replace("models/", "")
                    if not any(mid.startswith(p) for p in _GEMINI_TEXT_PREFIXES):
                        continue
                    if any(kw in mid for kw in _GEMINI_EXCLUDE_KEYWORDS):
                        continue
                    display = m.get("displayName", mid)
                    supports_thinking = any(mid.startswith(p) for p in _GEMINI_THINKING_PREFIXES)
                    label = display
                    if supports_thinking:
                        label += "（支援思考）"
                    models.append({"id": mid, "label": label, "supports_thinking": supports_thinking})
                models.sort(key=lambda x: x["id"])
                return models, None
            except Exception as e:
                return [], f"Gemini API 錯誤：{e}"

        async def fetch_openrouter() -> tuple[list[dict], Optional[str]]:
            try:
                r = await client.get("https://openrouter.ai/api/v1/models")
                r.raise_for_status()
                models = []
                for m in r.json().get("data", []):
                    pricing = m.get("pricing", {})
                    if str(pricing.get("prompt", "1")) != "0" or str(pricing.get("completion", "1")) != "0":
                        continue
                    mid = m.get("id", "")
                    ctx = m.get("context_length", 0)
                    name = m.get("name", mid)
                    label = name
                    if ctx:
                        label += f"（ctx={ctx // 1024}K）"
                    models.append({"id": mid, "label": label, "context_length": ctx})
                models.sort(key=lambda x: x["id"])
                return models, None
            except Exception as e:
                return [], f"OpenRouter API 錯誤：{e}"

        async def fetch_ollama() -> tuple[list[dict], Optional[str]]:
            try:
                r = await client.get(f"{base_url.rstrip('/')}/api/tags", timeout=2.0)
                r.raise_for_status()
                models = []
                for m in r.json().get("models", []):
                    name = m.get("name") or m.get("model")
                    if not name:
                        continue
                    size = m.get("size", 0)
                    size_gb = f"{size / 1024 / 1024 / 1024:.1f} GB" if size else ""
                    models.append({"id": name, "label": f"{name}" + (f"（{size_gb}）" if size_gb else "")})
                return models, None
            except Exception as e:
                return [], f"無法連線 Ollama（{base_url}）：{e}"

        # 四條 coroutine 一口氣併發執行，總時間 ≈ max 而不是 sum
        (groq_models, groq_error), (gemini_models, gemini_error), \
        (openrouter_models, openrouter_error), (ollama_models, ollama_error) = \
            await _asyncio.gather(fetch_groq(), fetch_gemini(), fetch_openrouter(), fetch_ollama())

    payload = {
        "groq": groq_models,
        "groq_error": groq_error,
        "gemini": gemini_models,
        "gemini_error": gemini_error,
        "openrouter": openrouter_models,
        "openrouter_error": openrouter_error,
        "ollama": ollama_models,
        "ollama_base_url": base_url,
        "ollama_error": ollama_error,
    }
    _MODELS_CACHE["ts"] = _time.time()
    _MODELS_CACHE["data"] = payload
    return payload


# ── 專案環境路徑（給前端 AI 助手生成真實可用的範例）────────────
@app.get("/env/paths")
async def get_env_paths():
    """回傳使用者目前專案的關鍵絕對路徑，讓前端範例能顯示真實可貼上執行的指令。"""
    import os as _os
    from pathlib import Path as _P
    project_root = _P(__file__).parent.parent.absolute()
    test_workflows = project_root / "test-workflows"
    finance_dir = test_workflows / "finance"
    return {
        "project_root": str(project_root),
        "test_workflows_dir": str(test_workflows) if test_workflows.is_dir() else None,
        "has_finance_example": finance_dir.is_dir() and (finance_dir / "stage1_generate_transactions.py").is_file(),
        "finance_example_dir": str(finance_dir) if finance_dir.is_dir() else None,
        "path_sep": _os.sep,
    }


# ── Node.js 環境檢測 ────────────────────────────────────────
_NODE_CACHE: dict = {"ts": 0.0, "data": None}
_NODE_CACHE_TTL = 60.0


@app.get("/settings/node-status")
async def get_node_status():
    """檢查系統是否安裝 Node.js / npm，含版本號。有 60s 快取。"""
    import time as _time
    import subprocess
    import shutil as _shutil
    if _NODE_CACHE["data"] and (_time.time() - _NODE_CACHE["ts"]) < _NODE_CACHE_TTL:
        return _NODE_CACHE["data"]

    def _probe(cmd: str) -> tuple[bool, str]:
        exe = _shutil.which(cmd)
        if not exe:
            return False, ""
        try:
            r = subprocess.run([exe, "-v"], capture_output=True, text=True, timeout=5)
            return (r.returncode == 0), (r.stdout or "").strip()
        except Exception:
            return False, ""

    node_ok, node_ver = _probe("node")
    npm_ok, npm_ver = _probe("npm")
    payload = {
        "node_installed": node_ok,
        "node_version": node_ver,
        "npm_installed": npm_ok,
        "npm_version": npm_ver,
        "install_hint": "https://nodejs.org/ 下載 LTS 版本；或執行 `winget install OpenJS.NodeJS.LTS`（Windows）",
    }
    _NODE_CACHE["ts"] = _time.time()
    _NODE_CACHE["data"] = payload
    return payload


# ── Skill Packages ──────────────────────────────────────────
@app.get("/settings/skill-packages")
async def get_skill_packages():
    from skill_pkg_manager import list_packages
    return {"packages": list_packages()}


class SkillPackageRequest(BaseModel):
    name: str


@app.post("/settings/skill-packages")
async def add_skill_package(req: SkillPackageRequest):
    from skill_pkg_manager import add_package
    ok, msg = add_package(req.name)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"message": msg}


@app.delete("/settings/skill-packages/{pkg_name}")
async def remove_skill_package(pkg_name: str):
    from skill_pkg_manager import remove_package
    ok, msg = remove_package(pkg_name)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"message": msg}


@app.get("/settings/skill-packages/unlisted")
async def scan_unlisted_skill_packages():
    """掃 venv 中已安裝但不在 skill_packages.txt 也不在 requirements.txt 的套件。"""
    from skill_pkg_manager import scan_unlisted_packages
    return {"packages": scan_unlisted_packages()}


class AdoptPackageRequest(BaseModel):
    name: str


@app.post("/settings/skill-packages/adopt")
async def adopt_existing_package(req: AdoptPackageRequest):
    """把已安裝的套件加入 skill_packages.txt（不再重新 install）。"""
    from skill_pkg_manager import add_to_list_only
    ok, msg = add_to_list_only(req.name)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"message": msg}


# ── Computer Use 錄製器 ──────────────────────────────────────
class RecordingStartRequest(BaseModel):
    session_id: str
    # 相對路徑 → 解析到專案根；絕對路徑直接用
    output_dir: str


@app.post("/computer-use/recording/start")
async def start_computer_use_recording(req: RecordingStartRequest):
    """開始錄製一個 computer_use session（鎖定單一進程）。"""
    from pipeline.recorder import start_recording
    from pathlib import Path as _P
    out_path = _P(req.output_dir).expanduser()
    if not out_path.is_absolute():
        _PROJ = _P(__file__).parent.parent.absolute()
        out_path = _PROJ / out_path
    try:
        return start_recording(session_id=req.session_id, output_dir=str(out_path))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/computer-use/recording/stop")
async def stop_computer_use_recording():
    """停止目前錄製中的 session，flush actions.json + meta.json。"""
    from pipeline.recorder import stop_recording
    return stop_recording()


@app.get("/computer-use/recording/status")
async def get_computer_use_recording_status():
    """查詢目前錄製中 session 的即時狀態（前端 polling 用）。"""
    from pipeline.recorder import get_recording_status
    return get_recording_status()


@app.get("/computer-use/recording/load")
async def load_computer_use_recording(output_dir: str):
    """讀回已錄好的 session（actions + meta），供前端編輯器載入。"""
    from pipeline.recorder import load_recording
    from pathlib import Path as _P
    out_path = _P(output_dir).expanduser()
    if not out_path.is_absolute():
        _PROJ = _P(__file__).parent.parent.absolute()
        out_path = _PROJ / out_path
    result = load_recording(str(out_path))
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


def _validate_assets_path(path_str: str) -> "Path":
    """把 assets 相關路徑解析成絕對 Path，並強制限制在 ai_output/ 內（安全防呆）。"""
    from pathlib import Path as _P
    _PROJ = _P(__file__).parent.parent.absolute()
    _ALLOWED_PREFIXES = [
        (_PROJ / "ai_output").resolve(),
        (_PROJ / "backend" / "ai_output").resolve(),
    ]
    target = _P(path_str).expanduser()
    if not target.is_absolute():
        target = _PROJ / target
    try:
        target_resolved = target.resolve()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"路徑解析失敗：{e}")
    is_allowed = any(
        str(target_resolved).startswith(str(pfx) + os.sep) or str(target_resolved) == str(pfx)
        for pfx in _ALLOWED_PREFIXES
    )
    if not is_allowed:
        raise HTTPException(status_code=403,
            detail=f"拒絕存取：路徑不在允許範圍內（只能動 ai_output/ 下的檔案）。")
    return target_resolved


@app.get("/computer-use/assets/image")
async def get_assets_image(dir: str, name: str):
    """提供單一錨點/全螢幕 PNG 檔供前端顯示（Modal 編輯錨點時用）。
    Query：dir=assets 資料夾（相對或絕對）、name=檔名"""
    from fastapi.responses import FileResponse
    target_dir = _validate_assets_path(dir)
    target_file = target_dir / name
    # 二次防呆：確保 file 也在 target_dir 內（防 name 含 ..）
    try:
        rf = target_file.resolve()
        if not str(rf).startswith(str(target_dir) + os.sep):
            raise HTTPException(status_code=403, detail="檔名不合法")
    except Exception:
        raise HTTPException(status_code=403, detail="檔名不合法")
    if not target_file.is_file():
        raise HTTPException(status_code=404, detail=f"檔案不存在：{name}")
    return FileResponse(str(target_file), media_type="image/png")


class CropRequest(BaseModel):
    dir: str                # assets 資料夾
    full_image: str         # 來源全螢幕截圖檔名（full_NNN.png）
    click_x: int            # 點擊的虛擬桌面絕對座標 X
    click_y: int            # 點擊的虛擬桌面絕對座標 Y
    full_left: int = 0      # 全螢幕截圖對應的虛擬桌面原點 X（可能是負值）
    full_top: int = 0       # 全螢幕截圖對應的虛擬桌面原點 Y
    # 使用者選的裁切區域（虛擬桌面絕對座標系）
    crop_left: int
    crop_top: int
    crop_width: int
    crop_height: int
    save_as: str            # 輸出檔名（例如 img_003_manual.png）


@app.post("/computer-use/assets/crop")
async def crop_anchor_from_full(req: CropRequest):
    """從全螢幕截圖裁出新錨點。
    - 回傳新錨點檔名 + anchor_off_x/y（點擊相對新錨點中心的偏移）+ variance
    - 支援多螢幕負座標（full_left/top 可以是負的）"""
    import cv2
    import numpy as np
    target_dir = _validate_assets_path(req.dir)
    full_path = target_dir / req.full_image
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail=f"全螢幕截圖不存在：{req.full_image}")

    # 讀 full 圖（支援中文路徑 → 走 read_bytes + imdecode）
    try:
        buf = np.frombuffer(full_path.read_bytes(), dtype=np.uint8)
        full_img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"讀取全螢幕截圖失敗：{e}")
    if full_img is None:
        raise HTTPException(status_code=500, detail=f"全螢幕截圖解碼失敗：{req.full_image}")

    H, W = full_img.shape[:2]
    # 絕對座標 → full 圖的相對座標
    rel_left = req.crop_left - req.full_left
    rel_top = req.crop_top - req.full_top
    rel_right = rel_left + req.crop_width
    rel_bottom = rel_top + req.crop_height
    # 邊界 clamp
    rel_left = max(0, min(rel_left, W))
    rel_top = max(0, min(rel_top, H))
    rel_right = max(0, min(rel_right, W))
    rel_bottom = max(0, min(rel_bottom, H))
    if rel_right - rel_left < 20 or rel_bottom - rel_top < 20:
        raise HTTPException(status_code=400,
            detail=f"裁切範圍太小（{rel_right-rel_left}×{rel_bottom-rel_top}，最小 20×20）")

    cropped = full_img[rel_top:rel_bottom, rel_left:rel_right]
    # 點擊位置相對裁切圖的偏移（依絕對座標計算）
    actual_crop_abs_left = rel_left + req.full_left
    actual_crop_abs_top = rel_top + req.full_top
    actual_w = rel_right - rel_left
    actual_h = rel_bottom - rel_top
    click_dx = req.click_x - actual_crop_abs_left
    click_dy = req.click_y - actual_crop_abs_top
    anchor_off_x = click_dx - actual_w // 2
    anchor_off_y = click_dy - actual_h // 2

    # 特徵豐富度（variance）
    try:
        gray = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)
        variance = float(np.var(gray))
    except Exception:
        variance = 0.0

    # 存檔
    save_name = req.save_as
    if not save_name.endswith(".png"):
        save_name += ".png"
    out_path = target_dir / save_name
    try:
        ok, enc = cv2.imencode(".png", cropped)
        if not ok:
            raise HTTPException(status_code=500, detail="imencode 失敗")
        out_path.write_bytes(enc.tobytes())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"寫檔失敗：{e}")

    return {
        "image": save_name,
        "anchor_off_x": anchor_off_x,
        "anchor_off_y": anchor_off_y,
        "width": actual_w,
        "height": actual_h,
        "variance": round(variance, 1),
    }


@app.delete("/computer-use/assets")
async def delete_computer_use_assets(dir: str):
    """刪除指定的錨點資料夾（含 PNG、actions.json、meta.json）。
    用於：Panel 清除全部、刪除節點時的清理。
    安全限制：只允許刪除專案根目錄下 ai_output/ 或 backend/ai_output/ 內的路徑，
    避免誤刪系統檔案。"""
    import shutil
    from pathlib import Path as _P
    _PROJ = _P(__file__).parent.parent.absolute()
    _ALLOWED_PREFIXES = [
        (_PROJ / "ai_output").resolve(),
        (_PROJ / "backend" / "ai_output").resolve(),
    ]
    target = _P(dir).expanduser()
    if not target.is_absolute():
        target = _PROJ / target
    try:
        target_resolved = target.resolve()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"路徑解析失敗：{e}")
    # 必須在允許的資料夾內
    is_allowed = any(
        str(target_resolved).startswith(str(pfx) + os.sep) or str(target_resolved) == str(pfx)
        for pfx in _ALLOWED_PREFIXES
    )
    if not is_allowed:
        raise HTTPException(status_code=403,
            detail=f"拒絕刪除：路徑不在允許範圍內（只能刪 ai_output/ 下的子資料夾）。"
                   f"target={target_resolved}")
    if not target_resolved.exists():
        return {"deleted": False, "reason": "資料夾不存在", "path": str(target_resolved)}
    if not target_resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"路徑不是資料夾：{target_resolved}")
    try:
        shutil.rmtree(target_resolved)
        return {"deleted": True, "path": str(target_resolved)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"刪除失敗：{e}")


# ── Claude Code Skills（從 ~/.agents/skills/ 掃描）──────────
@app.get("/skills/available")
async def get_available_skills():
    """列出使用者安裝的 Claude Code skills（掃 ~/.agents/skills/）。"""
    from skill_scanner import list_available_skills, SKILLS_ROOT
    return {
        "skills_root": str(SKILLS_ROOT),
        "exists": SKILLS_ROOT.exists(),
        "skills": list_available_skills(),
    }


@app.get("/skills/{skill_name}/dependencies")
async def scan_skill_deps(skill_name: str):
    """掃描指定 skill 的 Python / Node.js 依賴。"""
    from skill_scanner import scan_skill_dependencies
    result = scan_skill_dependencies(skill_name)
    if not result.get("found"):
        raise HTTPException(status_code=404, detail=f"找不到 skill：{skill_name}")
    # 加上目前已安裝的 pip 套件，前端可對照
    # list_packages() 回傳 list[dict]，每個 dict 有 {name, installed, version}
    import re as _re
    from skill_pkg_manager import list_packages

    def _base_name(pkg: str) -> str:
        # 去掉版本指定與 extras：`markitdown[pptx]>=1.0` → `markitdown`
        return _re.split(r"[<>=!~\[]", pkg)[0].strip().lower()

    # 兩邊都 normalize 成 base name 再比對
    installed_bases = {_base_name(p["name"]) for p in list_packages() if p.get("installed")}
    suggested = result["python"]["suggested_pip"]

    result["python"]["installed"] = sorted(s for s in suggested if _base_name(s) in installed_bases)
    result["python"]["missing"] = [s for s in suggested if _base_name(s) not in installed_bases]

    # npm 套件也做已安裝對比（跑 `npm list -g`）
    from skill_scanner import list_global_npm_packages
    suggested_npm = result.get("node", {}).get("suggested_npm") or []
    if suggested_npm:
        global_npm = list_global_npm_packages()
        if global_npm:
            result["node"]["installed_npm"] = sorted(p for p in suggested_npm if p.lower() in global_npm)
            result["node"]["missing_npm"] = [p for p in suggested_npm if p.lower() not in global_npm]
            result["node"]["npm_available"] = True
        else:
            # 沒抓到任何全域套件 → npm 不存在或掃描失敗，無法判斷
            result["node"]["installed_npm"] = []
            result["node"]["missing_npm"] = []
            result["node"]["npm_available"] = False
    return result


# ── Notification Settings ──────────────────────────────────
class NotificationSettingsRequest(BaseModel):
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    line_notify_token: Optional[str] = None


@app.get("/settings/notifications")
async def get_notification_settings():
    from settings import get_settings
    s = get_settings()
    return {
        "telegram_bot_token": s.get("telegram_bot_token", ""),
        "telegram_chat_id": s.get("telegram_chat_id", ""),
        "line_notify_token": s.get("line_notify_token", ""),
    }


@app.put("/settings/notifications")
async def put_notification_settings(req: NotificationSettingsRequest):
    from settings import get_settings, _SETTINGS_PATH, _lock
    import json as _json
    import settings as _settings_mod
    s = get_settings()
    if req.telegram_bot_token is not None:
        s["telegram_bot_token"] = req.telegram_bot_token.strip()
    if req.telegram_chat_id is not None:
        s["telegram_chat_id"] = req.telegram_chat_id.strip()
    if req.line_notify_token is not None:
        s["line_notify_token"] = req.line_notify_token.strip()
    with _lock:
        _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_SETTINGS_PATH, "w", encoding="utf-8") as f:
            _json.dump(s, f, ensure_ascii=False, indent=2)
        _settings_mod._cache = s
    return {
        "telegram_bot_token": s.get("telegram_bot_token", ""),
        "telegram_chat_id": s.get("telegram_chat_id", ""),
        "line_notify_token": s.get("line_notify_token", ""),
    }


# ── Workflows CRUD ──────────────────────────────────────────
class WorkflowRequest(BaseModel):
    name: str = "新工作流"
    canvas: Optional[dict] = None
    validate: bool = False


class WorkflowUpdateRequest(BaseModel):
    name: Optional[str] = None
    canvas: Optional[dict] = None
    validate: Optional[bool] = None
    yaml: Optional[str] = None


@app.get("/workflows")
async def api_list_workflows():
    from db import list_workflows
    return list_workflows()


@app.post("/workflows")
async def api_create_workflow(req: WorkflowRequest):
    from db import create_workflow
    return create_workflow(name=req.name, canvas=req.canvas, validate=req.validate)


@app.get("/workflows/{wf_id}")
async def api_get_workflow(wf_id: str):
    from db import get_workflow
    wf = get_workflow(wf_id)
    if not wf:
        raise HTTPException(status_code=404, detail="找不到工作流")
    return wf


@app.put("/workflows/{wf_id}")
async def api_update_workflow(wf_id: str, req: WorkflowUpdateRequest):
    from db import update_workflow
    patch = {k: v for k, v in req.model_dump().items() if v is not None}
    wf = update_workflow(wf_id, patch)
    if not wf:
        raise HTTPException(status_code=404, detail="找不到工作流")
    return wf


@app.delete("/workflows/{wf_id}")
async def api_delete_workflow(wf_id: str, cascade: bool = True):
    from db import delete_workflow
    delete_workflow(wf_id, cascade=cascade)
    return {"deleted": True, "cascade": cascade}


# ── Workflow Export / Import ─────────────────────────────────

@app.get("/workflows/{wf_id}/export")
async def api_export_workflow(wf_id: str):
    import io
    import zipfile
    from db import get_workflow, list_recipes
    from fastapi.responses import StreamingResponse

    wf = get_workflow(wf_id)
    if not wf:
        raise HTTPException(status_code=404, detail="找不到工作流")

    recipes = list_recipes(wf_id)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        # workflow.json
        wf_export = {
            "name": wf["name"],
            "canvas": wf["canvas"],
            "validate": wf["validate"],
            "yaml": wf.get("yaml", ""),
        }
        zf.writestr("workflow.json", json.dumps(wf_export, ensure_ascii=False, indent=2))

        # recipes/
        for r in recipes:
            recipe_data = {
                "step_name": r["step_name"],
                "task_hash": r["task_hash"],
                "input_fingerprints": r["input_fingerprints"],
                "output_path": r.get("output_path"),
                "code": r["code"],
                "python_version": r["python_version"],
                "success_count": r["success_count"],
                "avg_runtime_sec": r["avg_runtime_sec"],
            }
            safe_name = r["step_name"].replace("/", "_").replace("\\", "_")
            zf.writestr(f"recipes/{safe_name}.json", json.dumps(recipe_data, ensure_ascii=False, indent=2))

    buf.seek(0)
    from urllib.parse import quote
    safe_wf_name = wf["name"].replace(" ", "_").replace("/", "_")
    encoded_name = quote(safe_wf_name)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=\"workflow.zip\"; filename*=UTF-8''{encoded_name}.zip"},
    )


@app.post("/workflows/import")
async def api_import_workflow(file: UploadFile = File(...)):
    import io
    import zipfile
    from db import create_workflow, save_recipe

    content = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="無效的 ZIP 檔案")

    # 讀取 workflow.json
    if "workflow.json" not in zf.namelist():
        raise HTTPException(status_code=400, detail="ZIP 中找不到 workflow.json")

    wf_data = json.loads(zf.read("workflow.json"))

    # 自動避免重名：若已存在相同名稱則加 (1), (2)...
    from db import list_workflows
    existing_names = {w["name"] for w in list_workflows()}
    base_name = wf_data.get("name", "匯入的工作流")
    final_name = base_name
    counter = 1
    while final_name in existing_names:
        final_name = f"{base_name}({counter})"
        counter += 1

    wf = create_workflow(
        name=final_name,
        canvas=wf_data.get("canvas"),
        validate=wf_data.get("validate", False),
    )

    # 匯入 recipes
    recipe_count = 0
    for name in zf.namelist():
        if name.startswith("recipes/") and name.endswith(".json"):
            r = json.loads(zf.read(name))
            try:
                save_recipe(
                    workflow_id=wf["id"],
                    step_name=r["step_name"],
                    task_hash=r["task_hash"],
                    input_fingerprints=r.get("input_fingerprints", {}),
                    output_path=r.get("output_path"),
                    code=r.get("code", ""),
                    python_version=r.get("python_version", ""),
                    runtime_sec=r.get("avg_runtime_sec", 0),
                )
                recipe_count += 1
            except Exception:
                pass

    # 檢查是否有非 Skill 步驟（需要本地腳本）
    has_local_scripts = False
    nodes = wf_data.get("canvas", {}).get("nodes", [])
    for node in nodes:
        data = node.get("data", {})
        if not data.get("skillMode", False) and data.get("batch", "").strip():
            has_local_scripts = True
            break

    return {
        "workflow": wf,
        "recipe_count": recipe_count,
        "has_local_scripts": has_local_scripts,
    }


# ── Recipe Book ──────────────────────────────────────────────
@app.get("/recipes")
async def api_list_recipes(workflow_id: Optional[str] = None):
    from db import list_recipes
    return list_recipes(workflow_id)


@app.get("/recipes/status/{workflow_id}")
async def api_recipe_status(workflow_id: str, steps: str = ""):
    from db import get_recipe_status
    step_names = [s.strip() for s in steps.split(",") if s.strip()] if steps else []
    return get_recipe_status(workflow_id, step_names)


@app.delete("/recipes/{workflow_id}/{step_name}")
async def api_delete_recipe(workflow_id: str, step_name: str):
    from db import delete_recipe
    ok = delete_recipe(workflow_id, step_name)
    return {"deleted": ok}


@app.delete("/recipes/{workflow_id}")
async def api_delete_workflow_recipes(workflow_id: str):
    from db import delete_workflow_recipes
    count = delete_workflow_recipes(workflow_id)
    return {"deleted_count": count}


# ── File System Browser ──────────────────────────────────────
@app.get("/fs/browse")
async def fs_browse(path: str = ""):
    home = Path.home()
    target = Path(path).expanduser() if path else home
    try:
        target.resolve().relative_to(home.resolve())
    except ValueError:
        target = home
    if not target.exists() or not target.is_dir():
        target = home

    items = []
    try:
        for item in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            if item.name.startswith('.'):
                continue
            items.append({"name": item.name, "path": str(item), "is_dir": item.is_dir(), "ext": item.suffix.lower() if item.is_file() else ""})
    except PermissionError:
        pass

    parent = str(target.parent) if target != home else None
    return {"path": str(target), "parent": parent, "items": items}


@app.get("/fs/check-venv")
async def fs_check_venv(dir: str):
    """檢測腳本目錄下是否有可用的 Python 虛擬環境。
    支援兩種常見命名：`venv/`（Windows 慣例）與 `.venv/`（Unix/macOS 慣例），
    回傳第一個找到的 python 可執行檔路徑，讓使用者不用管到底叫哪個名字。"""
    target = Path(dir).expanduser().resolve()
    try:
        target.relative_to(Path.home().resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="只允許在 home 目錄下操作")
    import os as _os
    is_win = _os.name == "nt"
    venv_subdir = "Scripts" if is_win else "bin"
    py_name = "python.exe" if is_win else "python"
    # 兩種慣例都檢查一次，誰先找到用誰（venv 先，因為 Windows 使用者比較常這樣命名）
    for venv_dir_name in ("venv", ".venv"):
        venv_python = target / venv_dir_name / venv_subdir / py_name
        if venv_python.exists():
            return {
                "has_venv": True,
                "python_path": str(venv_python),
                "venv_dir_name": venv_dir_name,
            }
    return {"has_venv": False, "python_path": None, "venv_dir_name": None}


# ── Log Analysis ──────────────────────────────────────────────
# 常見 module → pip 套件名稱對映（module 名與 pip 名不同的情況）
_MODULE_TO_PIP = {
    "cv2": "opencv-python", "PIL": "Pillow", "bs4": "beautifulsoup4",
    "sklearn": "scikit-learn", "yaml": "pyyaml", "docx": "python-docx",
    "pptx": "python-pptx", "dotenv": "python-dotenv", "jwt": "pyjwt",
    "gi": "pygobject", "Crypto": "pycryptodome", "serial": "pyserial",
    "usb": "pyusb", "magic": "python-magic", "dateutil": "python-dateutil",
    "attr": "attrs", "lxml": "lxml", "wx": "wxPython",
}


@app.get("/pipeline/logs/analyze")
async def analyze_logs(count: int = 5):
    """掃描最近 N 筆 pipeline log，找出 ModuleNotFoundError / ImportError 並建議套件"""
    from pipeline.logger import LOG_DIR
    import re

    log_files = sorted(Path(LOG_DIR).glob("*.log"), key=lambda f: f.stat().st_mtime, reverse=True)[:count]

    missing: dict[str, dict] = {}  # module_name → { pip, files }
    # 用 [^'\"\n] 阻止跨行貪婪匹配（避免 log 截斷造成的誤判：
    # 例如 `No module named 'p...\n...next-line-has-quote` 不該匹配出 `p`）
    pattern = re.compile(
        r"(?:ModuleNotFoundError:\s*No module named\s*['\"]([^'\"\n]+)['\"]"
        r"|ImportError:\s*cannot import name\s*['\"]?\w+['\"]?\s*from\s*['\"]([^'\"\n]+)['\"]"
        r"|ImportError:\s*No module named\s*['\"]([^'\"\n]+)['\"])"
    )

    analyzed_files = []
    for lf in log_files:
        text = lf.read_text(encoding="utf-8", errors="ignore")
        found_in_file = False
        for m in pattern.finditer(text):
            raw = m.group(1) or m.group(2) or m.group(3)
            top_module = raw.split(".")[0]
            # 過濾無效結果：太短、非 identifier、以 "..." 結尾（log 截斷殘跡）
            if (
                len(top_module) < 3
                or not top_module.isidentifier()
                or raw.endswith("...")
            ):
                continue
            pip_name = _MODULE_TO_PIP.get(top_module, top_module)
            if top_module not in missing:
                missing[top_module] = {"pip": pip_name, "files": []}
            if lf.name not in missing[top_module]["files"]:
                missing[top_module]["files"].append(lf.name)
            found_in_file = True
        analyzed_files.append({
            "name": lf.name,
            "size": lf.stat().st_size,
            "has_errors": found_in_file,
        })

    suggestions = [
        {"module": mod, "pip_name": info["pip"], "found_in": info["files"]}
        for mod, info in sorted(missing.items())
    ]

    return {"analyzed": len(log_files), "files": analyzed_files, "suggestions": suggestions}


# ── Pipeline Run ─────────────────────────────────────────────
class PipelineRunRequest(BaseModel):
    yaml_content: str
    validate: bool = True
    use_recipe: bool = False  # True = 快速模式：recipe 命中時跳過 LLM 驗證
    workflow_id: Optional[str] = None  # 關聯工作流 ID
    no_save_recipe: bool = False  # True = 延遲 recipe 儲存，等用戶確認


class PipelineDecisionRequest(BaseModel):
    decision: str  # retry | skip | abort | continue | retry_with_hint
    hint: Optional[str] = None  # 補充指示（retry_with_hint 時使用）


@app.post("/pipeline/run")
async def start_pipeline(req: PipelineRunRequest):
    import uuid, yaml
    from pipeline.models import PipelineConfig
    from pipeline.runner import run_pipeline
    from pipeline.store import PipelineRun as PRun, get_store
    from pipeline.logger import create_run_logger
    try:
        import logging as _logging
        _log = _logging.getLogger("pipeline")
        _log.debug(f"收到 YAML（{len(req.yaml_content)} 字元）:\n{req.yaml_content}")
        data = yaml.safe_load(req.yaml_content)
        config_dict = data.get("pipeline", data)
        config_dict["validate"] = req.validate
        config = PipelineConfig(**config_dict)
        for i, s in enumerate(config.steps):
            _log.debug(f"步驟[{i}] batch（{len(s.batch)} 字元）：{s.batch[:300]}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"YAML 解析失敗：{e}")

    # 先建立 run 並存入 store，確保前端立刻能查詢
    run_id = str(uuid.uuid4())[:12]
    _, log_path = create_run_logger(run_id, config.name)
    config_d = config.model_dump()
    config_d["_use_recipe"] = req.use_recipe  # 傳遞快速模式旗標
    config_d["_workflow_id"] = req.workflow_id  # 關聯工作流
    config_d["_no_save_recipe"] = req.no_save_recipe  # 延遲 recipe 儲存
    run = PRun(
        run_id=run_id,
        pipeline_name=config.name,
        config_dict=config_d,
        telegram_chat_id=0,
        log_path=log_path,
        workflow_id=req.workflow_id,
    )
    get_store().save(run)

    # 背景執行（runner 看到已存在的 run_id 會恢復執行）
    from pipeline.runner import register_task
    task = asyncio.create_task(run_pipeline(config_d, chat_id=0, run_id=run_id))
    register_task(run_id, task)

    return {"run_id": run_id, "message": f"Pipeline '{config.name}' 已啟動"}


@app.get("/pipeline/runs")
async def list_pipeline_runs():
    from pipeline.store import get_store
    runs = get_store().list_recent(20)
    return {"runs": [_run_to_dict(r) for r in runs]}


@app.get("/pipeline/runs/{run_id}")
async def get_pipeline_run(run_id: str):
    from pipeline.store import get_store
    run = get_store().load(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="找不到 pipeline run")
    return _run_to_dict(run)


@app.delete("/pipeline/runs/{run_id}")
async def delete_pipeline_run(run_id: str):
    from pipeline.store import get_store
    if get_store().delete(run_id):
        return {"message": f"Run {run_id} 已刪除"}
    raise HTTPException(status_code=404, detail="找不到該 run")


@app.post("/pipeline/runs/{run_id}/resume")
async def resume_pipeline_run(run_id: str, req: PipelineDecisionRequest):
    if req.decision not in ("retry", "skip", "abort", "continue", "retry_with_hint", "answer"):
        raise HTTPException(status_code=400, detail="decision 必須是 retry / skip / abort / continue / retry_with_hint / answer")
    from pipeline.runner import resume_pipeline
    msg = await resume_pipeline(run_id, req.decision, hint=req.hint or "")
    return {"message": msg}


@app.get("/pipeline/runs/{run_id}/ask-user")
async def get_pending_ask_user(run_id: str):
    """回傳 run 目前的 ask_user 問題（若無則 question 為空）。"""
    from pipeline.executor import get_pending_question
    q = get_pending_question(run_id)
    return {"pending": q is not None, "question": q}


@app.post("/pipeline/runs/{run_id}/abort")
async def abort_pipeline_run(run_id: str):
    """立即中止正在執行的 pipeline（kill 子進程 + cancel task）"""
    from pipeline.store import get_store
    from pipeline.runner import force_abort
    run = get_store().load(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="找不到 pipeline run")
    if run.status not in ("running", "awaiting_human"):
        raise HTTPException(status_code=400, detail=f"Pipeline 狀態為 {run.status}，無法中止")
    await force_abort(run_id)
    return {"message": "⛔ Pipeline 已立即中止"}


@app.post("/pipeline/runs/{run_id}/save-recipes")
async def save_pending_recipes(run_id: str):
    """用戶確認後，將延遲儲存的 recipes 寫入 DB"""
    from pipeline.store import get_store
    from db import save_recipe as _db_save_recipe
    store = get_store()
    run = store.load(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="找不到 pipeline run")
    if not run.pending_recipes:
        return {"saved": 0}
    saved = 0
    for r in run.pending_recipes:
        try:
            _db_save_recipe(
                r["pipeline_id"], r["step_name"], r["task_hash"],
                r["input_fingerprints"], r["output_path"], r["code"],
                r["python_version"], r["runtime_sec"],
            )
            saved += 1
        except Exception:
            pass
    run.pending_recipes = []
    store.save(run)
    return {"saved": saved}


@app.get("/pipeline/runs/{run_id}/log")
async def get_pipeline_log(run_id: str):
    from pipeline.store import get_store
    run = get_store().load(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="找不到 pipeline run")
    log_path = Path(run.log_path)
    if not log_path.exists():
        return {"log": "（尚無 log 檔案）"}
    content = log_path.read_text(encoding="utf-8")
    return {"log": content}


# ── Pipeline Schedule ────────────────────────────────────────
@app.get("/pipeline/scheduled")
async def list_pipeline_scheduled():
    from scheduler.manager import list_tasks
    tasks = list_tasks()
    return {"tasks": [t for t in tasks if t.get("output_format") == "pipeline"]}


@app.delete("/pipeline/scheduled/cancel-by-name/{name}")
async def cancel_pipeline_schedule(name: str):
    from scheduler.manager import remove_task_by_name
    success = remove_task_by_name(name)
    if not success:
        raise HTTPException(status_code=404, detail="找不到該名稱的排程任務")
    return {"status": "ok"}


class PipelineScheduleRequest(BaseModel):
    name: str
    yaml_content: str
    schedule_type: str = "cron"
    schedule_expr: str = "0 8 * * *"
    validate: bool = True
    use_recipe: bool = False
    workflow_id: Optional[str] = None


@app.post("/pipeline/scheduled")
async def create_pipeline_schedule(req: PipelineScheduleRequest):
    import yaml
    from pipeline.models import PipelineConfig
    from scheduler.manager import add_pipeline_task
    from dataclasses import asdict
    try:
        data = yaml.safe_load(req.yaml_content)
        config_dict = data.get("pipeline", data)
        config_dict["validate"] = req.validate
        PipelineConfig(**{k: v for k, v in config_dict.items() if not k.startswith("_")})
        config_dict["_use_recipe"] = req.use_recipe
        if req.workflow_id:
            config_dict["_workflow_id"] = req.workflow_id
        yaml_to_save = yaml.dump({"pipeline": config_dict}, allow_unicode=True, default_flow_style=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"YAML 格式錯誤：{e}")
    try:
        info = add_pipeline_task(name=req.name, schedule_type=req.schedule_type, schedule_expr=req.schedule_expr, yaml_content=yaml_to_save)
        return {"task": asdict(info)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/pipeline/scheduled/{task_id}")
async def delete_pipeline_schedule(task_id: str):
    from scheduler.manager import remove_task
    if remove_task(task_id):
        return {"message": f"排程 {task_id} 已刪除"}
    raise HTTPException(status_code=404, detail="找不到該排程")


# ── Pipeline YAML Chat Assistant ─────────────────────────────
_PIPELINE_SYSTEM_BASE = """你是 Pipeline YAML 設定助手。使用者會用自然語言描述他想自動化的工作流程，你要產生正確可執行的 YAML。

## 三種節點類型

本系統支援三種節點，依情境選用：

### 1. 腳本節點（script）
使用者已有寫好的腳本或指令 → `batch` 填指令字串。
```yaml
- name: 抓資料
  batch: python ~/scripts/fetch.py --date=today
  timeout: 300
  retry: 2
```

### 2. AI 技能節點（skill）
使用者沒有腳本，想請 AI 自動撰寫 Python 程式碼來完成任務 → `batch` 填自然語言任務描述，加 `skill_mode: true`。
（以下範例 pipeline name 假設為 `monthly_report`，實際請套用本次工作流的 name）
```yaml
- name: 分析並匯出報告
  skill_mode: true
  batch: |
    讀取 ai_output/monthly_report/raw.csv，依「部門」分組計算月均營收，
    產出長條圖 + 摘要表格，存成 Excel。
  timeout: 600
  retry: 1
  output:
    path: ai_output/monthly_report/report.xlsx
    ai_validation: true
    description: "Excel 含長條圖與部門別摘要表"
```

#### 2a. AI 技能節點掛載 Agent Skill（進階）
若使用者提及已安裝的 skill（例如 pptx、browser-automation），加 `skill: <name>` 把 SKILL.md 與子腳本注入 LLM prompt，顯著提升該任務的正確率。
```yaml
- name: 產出簡報
  skill_mode: true
  skill: pptx
  batch: 把 ai_output/monthly_report/report.xlsx 的每個分頁轉成 PPT 簡報
  timeout: 900
  output:
    path: ai_output/monthly_report/report.pptx
```

### 3. 人工確認節點（human_confirm）
Pipeline 暫停等待人工確認，可透過 Telegram 或網頁 UI 回應。常用於審核關鍵輸出後再續跑。
```yaml
- name: 審核報告
  human_confirm: true
  message: 請確認上一步產出的報表內容是否正確
  notify_telegram: true            # 預設 true
  screenshot: false                # true 則 Telegram 會多一個「📸 截圖」按鈕
  timeout: 3600                    # 等待秒數（預設 1 小時）
```

## 判斷節點類型的原則

- 使用者說「抓網站 / 生成檔案 / 處理資料」但**沒提現成腳本** → **skill 節點**
- 使用者說「我的 xxx.py 腳本」「執行 xxx 指令」 → **script 節點**
- 使用者說「要人工審核」「確認後再繼續」 → **human_confirm 節點**（通常放在兩個處理節點中間）
- 使用者提到特定檔案格式處理（PPT、PDF、瀏覽器自動化）且該 skill 已安裝 → skill 節點**加掛 `skill:`**

## 常見組合模式

### 純 AI 自動化：
```
skill(抓資料) → skill(處理) → skill(產出)
```

### 需人工審核：
```
skill(抓資料) → human_confirm(審核) → skill(處理) → skill(產出)
```

### 驗證模式（唯讀檢查）：
在某個 skill 節點加 `readonly: true` 代表「只能讀取、不能修改」，適合做深度資料驗證。

## YAML 欄位規則（所有節點共用）

- `name`：步驟名稱（中文 OK，盡量有意義）
- `timeout`：秒數。script 建議 300、skill 建議 600、human_confirm 建議 3600
- `retry`：失敗自動重試次數，skill 節點建議 1-2
- `working_dir`：可選。若 skill 要寫檔到特定目錄可指定；省略則用預設
- `output.path`：預期產出檔案路徑。**本系統的預設輸出目錄是專案根目錄下的 `ai_output/<pipeline name>/`**，請用**相對路徑**寫：
  * 正確：`ai_output/daily_news/tech_news.csv`（假設 pipeline name 是 `daily_news`）
  * 錯誤：`~/ai_output/daily_news/tech_news.csv`（會寫到使用者家目錄，跟系統預設位置不同）
  * 錯誤：`C:\\Users\\xxx\\...` 或 `/Users/xxx/...`（絕不寫絕對路徑或平台特定路徑）
  * 錯誤：`tech_news.csv`（少了工作流子資料夾，會和其他 pipeline 混在一起）
- 後續步驟讀取前一步產出的檔案時，也要用**同一個相對路徑**（`ai_output/<pipeline name>/xxx`）
- `output.ai_validation: true` + `output.description`：AI 會驗證產出是否符合描述
- `readonly: true`：唯讀驗證模式（skill 節點專用）

## 你的任務

1. 資訊不足時用**繁體中文**反問，一次只問最關鍵的一個問題
   - skill 節點：問任務目標、輸出檔案名/格式
   - human_confirm 節點：通常不用問，看流程中是否有需要人工把關的點
2. 資訊充足後輸出完整 YAML（**必須**包含 `YAML_READY` 標記）
3. **先決定 pipeline 的 `name`**（英數底線，例如 `yahoo_news_to_excel`），所有 `output.path` 一律用**相對路徑** `ai_output/<這個 name>/檔名`，**不可省略中間的工作流子資料夾**，**不可加 `~/` 前綴**
4. 後續步驟要讀取前一步檔案時，**用同一個相對路徑**（例如 step2 讀 step1 的 `ai_output/<name>/xxx`）
5. 絕對不要寫 `~/`、`/Users/xxx/` 或 `C:\\Users\\xxx\\` 等任何絕對路徑

## 回覆格式

好的，我已經整理好 Pipeline 設定：

YAML_READY
```yaml
pipeline:
  name: yahoo_news_to_excel
  steps:
    - name: 抓取並匯出
      skill_mode: true
      batch: |
        到 Yahoo 新聞首頁抓 10 則頭條，
        擷取標題、摘要、網址，輸出 Excel。
      timeout: 600
      retry: 2
      output:
        path: ai_output/yahoo_news_to_excel/yahoo_news.xlsx
        ai_validation: true
        description: "Excel 含 10 列、三欄：標題、摘要、網址"
```
"""


def _build_pipeline_system_prompt() -> str:
    """組裝 AI 助手 system prompt：底稿 + 動態注入已安裝的 Agent Skills 清單。"""
    base = _PIPELINE_SYSTEM_BASE
    try:
        from skill_scanner import list_available_skills
        skills = list_available_skills()
        if skills:
            lines = ["", "## 使用者已安裝的 Agent Skills（掛載時請用 display_name）：", ""]
            for s in skills:
                desc = (s.get("description") or "").strip()
                if len(desc) > 120:
                    desc = desc[:120] + "…"
                lines.append(f"- **{s['display_name']}**：{desc}")
            lines.append("")
            lines.append("使用者任務若與上述 skill 相關，**優先建議掛載對應 skill**（YAML 加 `skill: <display_name>`）。")
            return base + "\n".join(lines)
    except Exception:
        pass
    return base


class PipelineChatRequest(BaseModel):
    messages: list[dict]


@app.post("/pipeline/chat")
async def pipeline_chat(req: PipelineChatRequest):
    from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
    from llm_factory import build_llm
    import re

    llm = build_llm(temperature=0.3)
    lc_messages = [SystemMessage(content=_build_pipeline_system_prompt())]
    for m in req.messages:
        cls = HumanMessage if m["role"] == "user" else AIMessage
        lc_messages.append(cls(content=m["content"]))

    response = llm.invoke(lc_messages)
    raw = response.content
    # Gemini/Gemma 可能回傳 list of content blocks（含 thinking + text）→ 抽出 text
    if isinstance(raw, list):
        parts = []
        for block in raw:
            if isinstance(block, dict):
                if block.get("type") == "text" and block.get("text"):
                    parts.append(block["text"])
            elif isinstance(block, str):
                parts.append(block)
        content = "".join(parts)
    else:
        content = str(raw) if raw is not None else ""
    has_yaml = "YAML_READY" in content
    yaml_content = None
    yaml_error = None
    if has_yaml:
        match = re.search(r"```yaml\n([\s\S]+?)```", content)
        if match:
            yaml_content = match.group(1).strip()
            # ── 語法驗證：試跑 PipelineConfig.from_dict 檢查 schema ──
            try:
                import yaml as _yaml
                from pipeline.models import PipelineConfig
                parsed = _yaml.safe_load(yaml_content) or {}
                raw_cfg = parsed.get("pipeline", parsed)
                PipelineConfig.from_dict({k: v for k, v in raw_cfg.items() if not str(k).startswith("_")})
            except Exception as e:
                yaml_error = f"YAML 語法/結構錯誤：{type(e).__name__}：{str(e)[:300]}"

    return {"reply": content, "has_yaml": has_yaml, "yaml_content": yaml_content, "yaml_error": yaml_error}


# ── Helpers ──────────────────────────────────────────────────
def _run_to_dict(r):
    return {
        "run_id": r.run_id,
        "pipeline_name": r.pipeline_name,
        "status": r.status,
        "current_step": r.current_step,
        "total_steps": len(r.config_dict.get("steps", [])),
        "started_at": r.started_at,
        "ended_at": r.ended_at,
        "step_results": [
            {"step_index": s.step_index, "step_name": s.step_name, "exit_code": s.exit_code,
             "validation_status": s.validation_status, "validation_reason": s.validation_reason,
             "validation_suggestion": s.validation_suggestion, "retries_used": s.retries_used,
             "stdout_tail": s.stdout_tail, "stderr_tail": s.stderr_tail}
            for s in r.step_results
        ],
        "config_dict": r.config_dict,
        "log_path": r.log_path,
        "pending_recipes": getattr(r, 'pending_recipes', []) or [],
        "awaiting_type": getattr(r, 'awaiting_type', '') or '',
        "awaiting_message": getattr(r, 'awaiting_message', '') or '',
        "awaiting_suggestion": getattr(r, 'awaiting_suggestion', '') or '',
    }
