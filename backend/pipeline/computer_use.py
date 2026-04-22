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


def _point_in_any_screen(x: int, y: int) -> tuple[bool, str]:
    """檢查 (x, y) 是否落在目前任一螢幕可見範圍內（支援多螢幕負座標）。
    用途：scroll / click 前避免把滑鼠拉到超出桌面範圍的座標。
    回傳 (是否在範圍內, 目前螢幕配置描述)。"""
    import mss
    try:
        with mss.mss() as sct:
            for mon in sct.monitors[1:]:
                left = mon["left"]
                top = mon["top"]
                if left <= x < left + mon["width"] and top <= y < top + mon["height"]:
                    return True, ""
            layout = "; ".join(
                f"{m['width']}×{m['height']} @ ({m['left']},{m['top']})"
                for m in sct.monitors[1:]
            )
            return False, f"目前螢幕：{layout}"
    except Exception:
        return True, ""  # 抓不到資訊就寬容處理


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


def _do_click(pg, x: int, y: int, button: str, clicks: int, hold_sec: float, modifiers: list) -> None:
    """統一的點擊執行器：處理長按 + 修飾鍵。
    modifiers: ["ctrl"], ["ctrl","shift"] 等 — 按下→click→放開。"""
    # 按下修飾鍵
    for mod in (modifiers or []):
        pg.keyDown(mod)
    try:
        if hold_sec > 0.1:
            pg.moveTo(x, y)
            pg.mouseDown(button=button)
            time.sleep(hold_sec)
            pg.mouseUp(button=button)
        else:
            pg.click(x=x, y=y, button=button, clicks=clicks)
    finally:
        # 反序放開修飾鍵，即使 click 拋例外也確保按鍵會放
        for mod in reversed(modifiers or []):
            pg.keyUp(mod)


def execute_action(
    action: dict,
    assets_dir: Path,
    index: int,
    logger: logging.Logger,
    run_id: Optional[str] = None,
    allow_coord_fallback: bool = True,
    cv_threshold: float = 0.65,
    cv_search_only_near: bool = False,
    cv_search_radius: int = 400,
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
            # 門檻：action-level confidence 覆蓋 step 層級 cv_threshold，皆缺就用 0.65
            threshold = float(action.get("confidence") or cv_threshold)
            button = action.get("button", "left")
            clicks = int(action.get("clicks", 1))
            fx = action.get("x")
            fy = action.get("y")
            has_coord = isinstance(fx, (int, float)) and isinstance(fy, (int, float))

            hold_sec = float(action.get("hold_sec", 0) or 0)
            modifiers = list(action.get("modifiers", []) or [])
            mods_tag = f"[{'+'.join(modifiers)}]" if modifiers else ""

            # 預設使用絕對座標（快速且穩定）；只有使用者主動切到圖像比對模式才跑 template matching
            # 注意：get 第二引數 True 表示若 action 根本沒 use_coord 欄位，也視為座標模式
            if action.get("use_coord", True) and has_coord:
                _do_click(pg, int(fx), int(fy), button, clicks, hold_sec, modifiers)
                hold_tag = f" hold={hold_sec}s" if hold_sec > 0.1 else ""
                msg = f"[強制座標]{mods_tag} 點擊 ({fx},{fy}) button={button} clicks={clicks}{hold_tag}"
                duration = int((time.time() - t0) * 1000)
                logger.info(f"[computer_use]   ✓ {msg}（{duration}ms）")
                return ActionResult(True, index, atype, msg, duration)

            # 搜尋策略：
            # 1. 有錄製座標 → 先在附近 ±cv_search_radius 範圍搜尋（防跨螢幕假陽性）
            # 2. 找不到：若 cv_search_only_near=True → 直接 FAIL，不退回全螢幕也不退回座標
            #           否則擴大到整個桌面
            # 3. 全螢幕也找不到 → 退回絕對座標 fallback（下方 else 分支）
            if has_coord:
                m = find_template(str(tpl_path), threshold=threshold, multi_scale=True,
                                  near_xy=(int(fx), int(fy)), search_radius=cv_search_radius)
                if not m.found and not cv_search_only_near:
                    logger.info(f"[computer_use]   附近 ±{cv_search_radius}px 找不到（best={m.confidence:.2f}），擴大到整個桌面")
                    m = find_template(str(tpl_path), threshold=threshold, multi_scale=True)
            else:
                m = find_template(str(tpl_path), threshold=threshold, multi_scale=True)

            # 若啟用「只搜附近」且找不到，直接失敗（不走下方 fallback 分支）
            if cv_search_only_near and not m.found and has_coord:
                return ActionResult(False, index, atype,
                    f"【只搜附近模式】在錄製座標 ({fx},{fy}) ±{cv_search_radius}px 內找不到錨點 "
                    f"{img_name}（best conf={m.confidence:.2f} < {threshold}）。若要放寬改去 panel 關閉「只搜附近」或提高搜尋半徑。")

            if m.found:
                # 螢幕邊緣擷取時，點擊位置不在錨點影像中心，加上偏移校正
                off_x = int(action.get("anchor_off_x", 0) or 0)
                off_y = int(action.get("anchor_off_y", 0) or 0)
                click_x = m.center[0] + int(off_x * m.scale)
                click_y = m.center[1] + int(off_y * m.scale)
                _do_click(pg, click_x, click_y, button, clicks, hold_sec, modifiers)
                hold_tag = f" hold={hold_sec}s" if hold_sec > 0.1 else ""
                off_tag = f" off=({off_x},{off_y})" if (off_x or off_y) else ""
                msg = f"{mods_tag} 點擊 {img_name} @ ({click_x},{click_y}) (conf={m.confidence:.2f}, scale={m.scale}){off_tag}{hold_tag}"
            else:
                # Fallback：錄製時有存絕對座標就退回用座標點擊，否則才算失敗
                if has_coord and allow_coord_fallback:
                    logger.warning(f"[computer_use]   ⚠ 圖像比對失敗（{m.reason}），退回絕對座標 ({fx},{fy})")
                    _do_click(pg, int(fx), int(fy), button, clicks, hold_sec, modifiers)
                    hold_tag = f" hold={hold_sec}s" if hold_sec > 0.1 else ""
                    msg = f"[fallback]{mods_tag} 點擊絕對座標 ({fx},{fy}){hold_tag}（原圖 {img_name} 找不到）"
                elif has_coord and not allow_coord_fallback:
                    return ActionResult(False, index, atype,
                        f"找不到錨點圖 {img_name}（{m.reason}），且目前螢幕解析度與錄製時不同，"
                        f"絕對座標 ({fx},{fy}) 不可信，請重錄或調整到原螢幕布局")
                else:
                    return ActionResult(False, index, atype,
                        f"找不到錨點圖 {img_name}（{m.reason}），且無 fallback 座標可用")

        elif atype == "click_at":
            x, y = int(action.get("x", 0)), int(action.get("y", 0))
            in_range, layout_info = _point_in_any_screen(x, y)
            if not in_range:
                return ActionResult(False, index, atype,
                    f"座標 ({x},{y}) 超出目前螢幕範圍（{layout_info}）")
            button = action.get("button", "left")
            clicks = int(action.get("clicks", 1))
            hold_sec = float(action.get("hold_sec", 0) or 0)
            modifiers = list(action.get("modifiers", []) or [])
            mods_tag = f"[{'+'.join(modifiers)}]" if modifiers else ""
            _do_click(pg, x, y, button, clicks, hold_sec, modifiers)
            hold_tag = f" hold={hold_sec}s" if hold_sec > 0.1 else ""
            msg = f"{mods_tag} 點擊絕對座標 ({x}, {y}){hold_tag}"

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
            # 單獨按修飾鍵（Shift / Ctrl / Alt / Win）要特別處理：
            # pyautogui.hotkey("shift") 底層用老 API keybd_event，Windows IME 的
            # 中英切換 hotkey 常常觸發不到。改用 pynput（SendInput）並明確拉長
            # press→release 間隔，讓 IME 有時間辨識為「獨立按 tap」。
            _MOD_TO_PYNPUT = {"shift": "shift", "ctrl": "ctrl", "alt": "alt",
                              "win": "cmd", "cmd": "cmd"}
            if len(keys) == 1 and keys[0].lower() in _MOD_TO_PYNPUT:
                from pynput.keyboard import Controller as _KC, Key as _K
                _kc = _KC()
                _pk = getattr(_K, _MOD_TO_PYNPUT[keys[0].lower()])
                _kc.press(_pk)
                time.sleep(0.12)
                _kc.release(_pk)
                msg = f"單按 {keys[0]}（pynput tap，IME-safe）"
            else:
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

        elif atype == "drag":
            x1 = int(action.get("x", 0))
            y1 = int(action.get("y", 0))
            x2 = int(action.get("x2", 0))
            y2 = int(action.get("y2", 0))
            button = action.get("button", "left")
            # 起點：預設使用絕對座標；只有使用者切到圖像模式（use_coord=False）才嘗試圖像定位校正
            img_name = action.get("image", "")
            if img_name and action.get("use_coord", True) is False:
                tpl_path = assets_dir / img_name
                # drag 也吃 step 層級 cv_threshold / cv_search_radius
                threshold = float(action.get("confidence") or cv_threshold)
                m = find_template(str(tpl_path), threshold=threshold, multi_scale=True,
                                  near_xy=(x1, y1), search_radius=cv_search_radius)
                if m.found:
                    dx = m.center[0] - x1
                    dy_shift = m.center[1] - y1
                    x1, y1 = m.center[0], m.center[1]
                    # 終點同步偏移，保持相對位移
                    x2 += dx
                    y2 += dy_shift
                elif cv_search_only_near:
                    return ActionResult(False, index, atype,
                        f"【只搜附近模式】drag 起點在 ({x1},{y1}) ±{cv_search_radius}px 內找不到錨點 {img_name}")
            # 座標防護：超出螢幕就拒絕執行
            for cx, cy, label in [(x1, y1, "起點"), (x2, y2, "終點")]:
                in_range, layout_info = _point_in_any_screen(cx, cy)
                if not in_range:
                    return ActionResult(False, index, atype,
                        f"拖曳{label}座標 ({cx},{cy}) 超出目前螢幕（{layout_info}）")
            # Windows 的 DragDetect 要求 mouseDown 後第一個 move 必須**嚴格超過 SM_CXDRAG (~4px)**
            # 才觸發真正的 OLE Drag-Drop。pyautogui.dragTo + 平順 lerp 常常第一步 < 4px 就被當
            # 普通點擊。解法：press 前從偏移位置抵達產生「pre-move delta」，press 後立刻做一個
            # 6px 的明顯跳躍突破閾值，再開始平滑 lerp。
            # 參考：https://devblogs.microsoft.com/oldnewthing/20100304-00/?p=14733
            from pynput.mouse import Controller as _MC, Button as _Btn
            _mc = _MC()
            _btn_map = {"left": _Btn.left, "right": _Btn.right, "middle": _Btn.middle}
            _btn = _btn_map.get(button, _Btn.left)
            drag_mods = list(action.get("modifiers", []) or [])
            # 修飾鍵在整個拖曳期間都要按著（Shift+drag=移動、Ctrl+drag=複製）
            for mod in drag_mods:
                pg.keyDown(mod)
            try:
                # 計算單位方向（用來做 6px 初始跨閾值跳躍；若起終點距離 < 6px 就固定往右跳）
                dx = x2 - x1
                dy = y2 - y1
                dist = max(1, (dx * dx + dy * dy) ** 0.5)
                nx, ny = dx / dist, dy / dist

                # 1. 先從偏移位置抵達起點，產生真實的 pre-move event
                _mc.position = (int(x1 - nx * 3), int(y1 - ny * 3))
                time.sleep(0.05)
                _mc.position = (x1, y1)
                time.sleep(0.08)
                # 2. 按下
                _mc.press(_btn)
                time.sleep(0.10)
                # 3. 關鍵：press 後第一個 move 必須 > 4px 突破 SM_CXDRAG
                _mc.position = (int(x1 + nx * 6), int(y1 + ny * 6))
                time.sleep(0.06)
                # 4. 剩餘距離分段平滑移動到終點
                steps = 25
                total_move_sec = 0.6
                for i in range(1, steps + 1):
                    t = i / steps
                    mx = int(x1 + nx * 6 + (x2 - (x1 + nx * 6)) * t)
                    my = int(y1 + ny * 6 + (y2 - (y1 + ny * 6)) * t)
                    _mc.position = (mx, my)
                    time.sleep(total_move_sec / steps)
                # 5. 在終點停頓，讓 drop target highlight 起來再放手
                time.sleep(0.25)
                _mc.release(_btn)
            finally:
                # 即使過程拋例外也要放開修飾鍵，避免使用者鍵盤卡在按下狀態
                for mod in reversed(drag_mods):
                    pg.keyUp(mod)
            mods_tag = f"[{'+'.join(drag_mods)}] " if drag_mods else ""
            msg = f"{mods_tag}拖曳 ({x1},{y1}) → ({x2},{y2}) button={button}"

        elif atype == "scroll":
            x = int(action.get("x", 0))
            y = int(action.get("y", 0))
            dy = int(action.get("dy", 0))
            if dy == 0:
                logger.warning(f"[computer_use]   ⚠ scroll action dy=0，略過（action={action}）")
                return ActionResult(False, index, atype, "scroll 缺 dy 欄位或為 0")
            modifiers = list(action.get("modifiers", []) or [])
            # 座標防護：超出螢幕時不移動滑鼠直接在當前位置捲
            in_range, _ = _point_in_any_screen(x, y)
            if in_range:
                pg.moveTo(x, y)
                # Windows 上滑鼠移入新視窗需要短時間觸發 hover，否則後續 scroll 會被吞掉
                time.sleep(0.15)
            # 用 pynput 取代 pyautogui.scroll（pyautogui 在 Windows 有 known bug）
            from pynput.mouse import Controller as _MC
            _mc = _MC()
            # 按下修飾鍵（Ctrl+滾輪 = 縮放）→ scroll → 放開
            for mod in modifiers:
                pg.keyDown(mod)
            try:
                _mc.scroll(0, dy)
            finally:
                for mod in reversed(modifiers):
                    pg.keyUp(mod)
            mods_tag = f"[{'+'.join(modifiers)}] " if modifiers else ""
            msg = f"{mods_tag}在 ({x},{y}) 捲動 dy={dy}"

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
    cv_threshold: float = 0.65,
    cv_search_only_near: bool = False,
    cv_search_radius: int = 400,
) -> StepResult:
    """執行一整個 computer_use 步驟。

    - actions: ComputerUseAction 物件的 list of dict
    - assets_dir: 錨點圖片資料夾（絕對路徑，通常是 ai_output/<name>/ 下的子資料夾）
    - fail_fast: True 則遇到失敗立刻中止；False 則繼續但記錄失敗數
    - cv_threshold: CV 比對門檻（0.65 寬鬆 / 0.80 標準 / 0.90 嚴格）
    - cv_search_only_near: True = 只搜錄製座標附近、找不到直接 FAIL（不退回全螢幕也不退回座標）
    - cv_search_radius: 附近搜尋半徑（像素）；實際搜尋範圍 (2r × 2r)
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
            res = execute_action(action, assets, i, logger, run_id,
                                 allow_coord_fallback=layout_ok,
                                 cv_threshold=cv_threshold,
                                 cv_search_only_near=cv_search_only_near,
                                 cv_search_radius=cv_search_radius)
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
