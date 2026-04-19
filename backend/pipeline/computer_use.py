"""
桌面自動化引擎（computer_use 節點專用）。

核心能力：
- L1 basic template matching（cv2.matchTemplate + TM_CCOEFF_NORMED）
- L2 multi-scale matching（對 template 做 ±15% 縮放，解決 DPI/視窗大小差異）
- 動作執行：click_image / click_at / type_text / hotkey / wait / wait_image / screenshot
- Emergency abort：pyautogui.FAILSAFE（滑鼠移到左上角 0,0 立即觸發）+ run_id 中止訊號

不與 skill / recipe 系統共用 — 純 pyautogui + opencv 執行，無 LLM 參與。
"""
from __future__ import annotations
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np


# ── Emergency abort signal（執行中可從外部 set，立即中斷）────────
_abort_flags: dict[str, bool] = {}


def request_abort(run_id: str) -> None:
    """標記此 run 需立即中止；computer_use 引擎會在每個動作間檢查"""
    _abort_flags[run_id] = True


def clear_abort(run_id: str) -> None:
    _abort_flags.pop(run_id, None)


def _should_abort(run_id: Optional[str]) -> bool:
    return bool(run_id) and _abort_flags.get(run_id, False)


# ── 螢幕擷取與圖像比對 ──────────────────────────────────────────

def _capture_screen() -> tuple[np.ndarray, int, int]:
    """抓所有螢幕聯集的完整截圖，回傳 (BGR ndarray, 原點 x, 原點 y)。

    關鍵：用 monitors[0]（虛擬桌面聯集）而非 monitors[1]（主螢幕），
    讓 cv2 template matching 能在多螢幕環境下找到任意螢幕上的目標；
    多螢幕時主螢幕左上不一定是 (0,0)，回傳的 origin 用來把比對到的
    相對座標轉回絕對桌面座標（pyautogui.click 接受的就是絕對座標）。
    """
    import mss
    import cv2
    with mss.mss() as sct:
        mon = sct.monitors[0]      # 所有螢幕聯集
        img = np.array(sct.grab(mon))
    bgr = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return bgr, mon["left"], mon["top"]


@dataclass
class MatchResult:
    found: bool
    center: tuple[int, int] = (0, 0)   # (x, y) 螢幕座標
    confidence: float = 0.0
    scale: float = 1.0                  # 命中的縮放比例
    reason: str = ""


def find_template(
    template_path: str,
    threshold: float = 0.85,
    multi_scale: bool = True,
    near_xy: Optional[tuple[int, int]] = None,
    search_radius: int = 400,
) -> MatchResult:
    """在當前螢幕找指定模板圖，回傳中心座標與相似度。

    L1: 單一尺度 matchTemplate（快，~5ms）
    L2: multi_scale=True 時額外跑 0.85/0.9/0.95/1.05/1.1/1.15 倍縮放，
        取最高相似度（~30ms，吸收 DPI 125%/150% 縮放差異）

    near_xy: 若給，只在該絕對桌面座標 ±search_radius px 的範圍內搜尋。
             避免 80×80 小錨點在多螢幕大畫面上找到錯位置的假陽性。
             搜尋不到會回傳 found=False（呼叫端可決定是否退回全畫面搜尋）。
    """
    import cv2

    tpl_path = Path(template_path)
    if not tpl_path.is_file():
        return MatchResult(False, reason=f"模板不存在：{template_path}")

    # Windows 上 cv2.imread 對中文路徑會失敗，改讀 bytes 再 imdecode
    try:
        buf = np.frombuffer(tpl_path.read_bytes(), dtype=np.uint8)
        tpl_color = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except Exception as e:
        return MatchResult(False, reason=f"模板讀取例外：{e}")
    if tpl_color is None:
        return MatchResult(False, reason=f"模板解碼失敗（格式錯誤？）：{template_path}")
    tpl_gray = cv2.cvtColor(tpl_color, cv2.COLOR_BGR2GRAY)

    screen_color, origin_x, origin_y = _capture_screen()
    screen_gray_full = cv2.cvtColor(screen_color, cv2.COLOR_BGR2GRAY)

    # 若有 near_xy 就先裁切出該區域，只在其中找，避免跨螢幕誤匹配
    clip_offset_x, clip_offset_y = origin_x, origin_y
    if near_xy is not None:
        nx, ny = near_xy
        # 絕對座標 → 相對截圖的座標
        rel_x = nx - origin_x
        rel_y = ny - origin_y
        H, W = screen_gray_full.shape
        left = max(0, rel_x - search_radius)
        top = max(0, rel_y - search_radius)
        right = min(W, rel_x + search_radius)
        bottom = min(H, rel_y + search_radius)
        if right - left < 20 or bottom - top < 20:
            # 範圍超出螢幕太多（錄製座標根本不在目前桌面範圍內）
            return MatchResult(False, reason=f"錄製座標 ({nx},{ny}) 超出目前桌面範圍")
        screen_gray = screen_gray_full[top:bottom, left:right]
        clip_offset_x = origin_x + left
        clip_offset_y = origin_y + top
    else:
        screen_gray = screen_gray_full

    scales = [1.0]
    if multi_scale:
        # L2：涵蓋常見 DPI 差（100%/125%/150%）
        scales = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15]

    best = MatchResult(False)
    for s in scales:
        if abs(s - 1.0) < 1e-6:
            tpl_scaled = tpl_gray
        else:
            new_w = max(1, int(tpl_gray.shape[1] * s))
            new_h = max(1, int(tpl_gray.shape[0] * s))
            if new_w >= screen_gray.shape[1] or new_h >= screen_gray.shape[0]:
                continue
            tpl_scaled = cv2.resize(tpl_gray, (new_w, new_h), interpolation=cv2.INTER_AREA)
        try:
            res = cv2.matchTemplate(screen_gray, tpl_scaled, cv2.TM_CCOEFF_NORMED)
        except cv2.error:
            continue
        _, max_val, _, max_loc = cv2.minMaxLoc(res)
        if max_val > best.confidence:
            h, w = tpl_scaled.shape
            # 比對結果是相對於裁切區域的座標；加上裁切原點換算成桌面絕對座標
            cx = max_loc[0] + w // 2 + clip_offset_x
            cy = max_loc[1] + h // 2 + clip_offset_y
            best = MatchResult(
                found=max_val >= threshold,
                center=(cx, cy),
                confidence=float(max_val),
                scale=s,
            )
    if not best.found:
        area = "附近範圍" if near_xy else "整個桌面"
        best.reason = f"最佳相似度 {best.confidence:.3f} 低於門檻 {threshold}（搜尋{area}）"
    return best


# ── 動作執行 ────────────────────────────────────────────────────

@dataclass
class ActionResult:
    ok: bool
    action_index: int
    action_type: str
    message: str = ""
    duration_ms: int = 0


def _check_abort(run_id: Optional[str]) -> None:
    if _should_abort(run_id):
        raise RuntimeError("使用者中止（emergency abort）")


def _pyautogui_with_failsafe():
    """lazy import pyautogui 並設好 failsafe / 節流"""
    import pyautogui
    pyautogui.FAILSAFE = True  # 滑鼠甩到左上角 (0,0) 立即 FailSafeException
    pyautogui.PAUSE = 0.15     # 每個 pyautogui 呼叫後自動等 150ms，防過快
    return pyautogui


def execute_action(
    action: dict,
    assets_dir: Path,
    index: int,
    logger: logging.Logger,
    run_id: Optional[str] = None,
    allow_coord_fallback: bool = True,
) -> ActionResult:
    """執行單一 action。action 是 ComputerUseAction.model_dump() 結果的 dict。"""
    t0 = time.time()
    atype = action.get("type", "")
    desc = action.get("description") or atype
    logger.info(f"[computer_use] 動作 #{index + 1} ({atype})：{desc}")

    _check_abort(run_id)

    try:
        pg = _pyautogui_with_failsafe()

        if atype == "click_image":
            img_name = action.get("image", "")
            if not img_name:
                return ActionResult(False, index, atype, "click_image 缺 image 欄位")
            tpl_path = assets_dir / img_name
            # 門檻預設降到 0.65：0.85 太嚴、0.7 仍會卡（實測 0.697 剛好失敗）
            # 0.65 以下通常代表真的對不上，會觸發座標 fallback
            threshold = float(action.get("confidence", 0.65))
            button = action.get("button", "left")
            clicks = int(action.get("clicks", 1))
            # 若有錄製座標，先在附近 ±400px 範圍搜尋（防假陽性跨螢幕誤匹配）；
            # 找不到才擴大到整個桌面；最後才退回絕對座標 fallback
            fx = action.get("x")
            fy = action.get("y")
            has_coord = isinstance(fx, (int, float)) and isinstance(fy, (int, float))
            if has_coord:
                m = find_template(str(tpl_path), threshold=threshold, multi_scale=True,
                                  near_xy=(int(fx), int(fy)), search_radius=400)
                if not m.found:
                    m = find_template(str(tpl_path), threshold=threshold, multi_scale=True)
            else:
                m = find_template(str(tpl_path), threshold=threshold, multi_scale=True)
            if m.found:
                pg.click(x=m.center[0], y=m.center[1], button=button, clicks=clicks)
                msg = f"點擊 {img_name} @ {m.center} (conf={m.confidence:.2f}, scale={m.scale})"
            else:
                # Fallback：錄製時有存絕對座標就退回用座標點擊，否則才算失敗
                # fx/fy/has_coord 已在前面計算過
                if has_coord and allow_coord_fallback:
                    logger.warning(f"[computer_use]   ⚠ 圖像比對失敗（{m.reason}），退回絕對座標 ({fx},{fy})")
                    pg.click(x=int(fx), y=int(fy), button=button, clicks=clicks)
                    msg = f"[fallback] 點擊絕對座標 ({fx},{fy})（原圖 {img_name} 找不到，最佳 conf={m.confidence:.2f}）"
                elif has_coord and not allow_coord_fallback:
                    return ActionResult(False, index, atype,
                        f"找不到錨點圖 {img_name}（{m.reason}），且目前螢幕解析度與錄製時不同，"
                        f"絕對座標 ({fx},{fy}) 不可信，請重錄或調整到原螢幕布局")
                else:
                    return ActionResult(False, index, atype,
                        f"找不到錨點圖 {img_name}（{m.reason}），且無 fallback 座標可用")

        elif atype == "click_at":
            x, y = int(action.get("x", 0)), int(action.get("y", 0))
            button = action.get("button", "left")
            clicks = int(action.get("clicks", 1))
            pg.click(x=x, y=y, button=button, clicks=clicks)
            msg = f"點擊絕對座標 ({x}, {y})"

        elif atype == "type_text":
            text = action.get("text", "")
            if not text:
                return ActionResult(False, index, atype, "type_text 缺 text 欄位")
            # interval 控制打字節奏（每個字之間的間隔秒數）；中文用 write 可能失效，改 copy-paste
            if any(ord(c) > 127 for c in text):
                import pyperclip
                try:
                    pyperclip.copy(text)
                    pg.hotkey("ctrl", "v")
                    msg = f"輸入非 ASCII 文字（clipboard）：{text[:30]}"
                except Exception:
                    # 沒 pyperclip 就 fallback
                    pg.write(text, interval=0.03)
                    msg = f"輸入文字（逐字）：{text[:30]}"
            else:
                pg.write(text, interval=0.03)
                msg = f"輸入文字：{text[:30]}"

        elif atype == "hotkey":
            keys = action.get("keys", [])
            if not keys:
                return ActionResult(False, index, atype, "hotkey 缺 keys 欄位")
            pg.hotkey(*keys)
            msg = f"熱鍵：{'+'.join(keys)}"

        elif atype == "wait":
            sec = float(action.get("seconds", 0.0))
            # 分段 sleep，中間可以 abort
            total, step = sec, 0.2
            while total > 0:
                _check_abort(run_id)
                time.sleep(min(step, total))
                total -= step
            msg = f"等待 {sec}s"

        elif atype == "wait_image":
            img_name = action.get("image", "")
            if not img_name:
                return ActionResult(False, index, atype, "wait_image 缺 image 欄位")
            tpl_path = assets_dir / img_name
            timeout = float(action.get("timeout_sec", 10.0))
            threshold = float(action.get("confidence", 0.85))
            deadline = time.time() + timeout
            last_conf = 0.0
            while time.time() < deadline:
                _check_abort(run_id)
                m = find_template(str(tpl_path), threshold=threshold, multi_scale=True)
                if m.found:
                    msg = f"{img_name} 出現（conf={m.confidence:.2f}）"
                    break
                last_conf = max(last_conf, m.confidence)
                time.sleep(0.3)
            else:
                return ActionResult(False, index, atype,
                    f"等待 {timeout}s 仍未出現 {img_name}（最佳 {last_conf:.2f} < {threshold}）")

        elif atype == "screenshot":
            import cv2
            img, _ox, _oy = _capture_screen()
            ts = int(time.time())
            out = assets_dir / f"debug_screenshot_{ts}.png"
            # 用 imencode + write_bytes 避免中文路徑問題
            ok, buf = cv2.imencode(".png", img)
            if ok:
                out.write_bytes(buf.tobytes())
                msg = f"已存 screenshot：{out.name}"
            else:
                msg = "screenshot imencode 失敗"

        else:
            return ActionResult(False, index, atype, f"未知動作類型：{atype}")

        duration = int((time.time() - t0) * 1000)
        logger.info(f"[computer_use]   ✓ {msg}（{duration}ms）")
        return ActionResult(True, index, atype, msg, duration)

    except RuntimeError as e:
        # abort signal
        raise
    except Exception as e:
        # pyautogui.FailSafeException / 其他意外
        import traceback
        logger.error(f"[computer_use]   ✗ {atype} 失敗：{e}")
        logger.debug(traceback.format_exc())
        return ActionResult(False, index, atype, f"{type(e).__name__}: {e}",
                            int((time.time() - t0) * 1000))


# ── 對外入口：執行一整個 computer_use 步驟 ─────────────────────────

@dataclass
class StepResult:
    success: bool
    total_actions: int
    succeeded: int
    failed_at: int = -1        # 首次失敗的 index；-1 = 全部成功
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0


MAX_ACTIONS_PER_STEP = 500  # 單步動作數上限，防止失控腳本無限循環


def _screen_layout_match(meta_path: Path, logger: logging.Logger) -> bool:
    """比對錄製時與回放時的螢幕解析度。
    True = 一致（絕對座標 fallback 仍可靠）；False = 已改變（座標 fallback 不可信，應禁用）"""
    if not meta_path.is_file():
        return True  # 沒 meta 就寬容處理
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        rec_w, rec_h = meta.get("screen_width"), meta.get("screen_height")
        if not rec_w or not rec_h:
            return True
        import mss
        with mss.mss() as sct:
            cur = sct.monitors[1]
        if cur["width"] == rec_w and cur["height"] == rec_h:
            return True
        logger.warning(
            f"[computer_use] ⚠ 螢幕解析度變了："
            f"錄製 {rec_w}×{rec_h} → 目前 {cur['width']}×{cur['height']}；"
            f"將禁用絕對座標 fallback，強制圖像比對（常見於接/拔外接螢幕後）"
        )
        return False
    except Exception as e:
        logger.warning(f"[computer_use] 讀 meta.json 失敗：{e}")
        return True


def execute_computer_use_step(
    actions: list[dict],
    assets_dir: str,
    logger: logging.Logger,
    run_id: Optional[str] = None,
    fail_fast: bool = True,
) -> StepResult:
    """執行一整個 computer_use 步驟。

    - actions: ComputerUseAction 物件的 list of dict
    - assets_dir: 錨點圖片資料夾（絕對路徑，通常是 ai_output/<name>/ 下的子資料夾）
    - fail_fast: True 則遇到失敗立刻中止；False 則繼續但記錄失敗數
    """
    import json  # 供 _screen_layout_match 讀 meta.json
    clear_abort(run_id or "")
    if len(actions) > MAX_ACTIONS_PER_STEP:
        return StepResult(
            success=False,
            total_actions=len(actions),
            succeeded=0,
            failed_at=-1,
            stdout="",
            stderr=f"動作數 {len(actions)} 超過安全上限 {MAX_ACTIONS_PER_STEP}，拒絕執行",
            exit_code=2,
        )
    assets = Path(assets_dir)
    if not assets.is_dir():
        # 沒有 assets 目錄也可能 OK（例如只有 type_text / wait），不直接失敗
        logger.warning(f"[computer_use] assets 目錄不存在：{assets_dir}")

    # 螢幕解析度比對：若改變（接/拔外接螢幕）就禁用座標 fallback
    layout_ok = _screen_layout_match(assets / "meta.json", logger) if assets.is_dir() else True

    logger.info(f"[computer_use] ▶ 開始執行 {len(actions)} 個動作 "
                f"（assets: {assets_dir}, fail_fast={fail_fast}）")
    logger.info(f"[computer_use] 🛡 Safety: 滑鼠移到螢幕左上角 (0,0) 可立即中止")

    succeeded = 0
    failed_at = -1
    messages: list[str] = []

    for i, action in enumerate(actions):
        try:
            res = execute_action(action, assets, i, logger, run_id, allow_coord_fallback=layout_ok)
        except RuntimeError as abort_err:
            logger.warning(f"[computer_use] {abort_err}")
            return StepResult(
                success=False,
                total_actions=len(actions),
                succeeded=succeeded,
                failed_at=i,
                stdout="\n".join(messages),
                stderr=str(abort_err),
                exit_code=130,  # SIGINT-ish
            )
        messages.append(f"#{i+1} [{res.action_type}] {'OK' if res.ok else 'FAIL'}: {res.message}")
        if res.ok:
            succeeded += 1
        else:
            if failed_at < 0:
                failed_at = i
            if fail_fast:
                return StepResult(
                    success=False,
                    total_actions=len(actions),
                    succeeded=succeeded,
                    failed_at=i,
                    stdout="\n".join(messages),
                    stderr=f"動作 #{i + 1} ({res.action_type}) 失敗：{res.message}",
                    exit_code=1,
                )

    all_ok = (failed_at < 0)
    logger.info(f"[computer_use] ■ 結束：{succeeded}/{len(actions)} 成功")
    return StepResult(
        success=all_ok,
        total_actions=len(actions),
        succeeded=succeeded,
        failed_at=failed_at,
        stdout="\n".join(messages),
        stderr="" if all_ok else f"失敗動作數：{len(actions) - succeeded}",
        exit_code=0 if all_ok else 1,
    )
