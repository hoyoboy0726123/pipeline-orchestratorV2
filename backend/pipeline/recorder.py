"""
桌面自動化錄製器（computer_use 節點的錄製功能）。

錄製邏輯：
- pynput 監聽滑鼠/鍵盤事件
- 每次滑鼠點擊 → 用 mss 擷取點擊位置周圍 80×80 px 的小圖作為錨點
  輸出 click_image 動作（回放時用 cv2 找這張小圖 → 點中心）
- 鍵盤輸入 → 暫存在 buffer，enter/tab 或 > 1 秒沒按鍵就 flush 成 type_text
- 特殊鍵（Ctrl/Alt/Shift + 字母）→ 直接輸出 hotkey
- 連續動作間隔 > 0.5s → 自動插入 wait

在 process-global singleton（一次只能一個錄製 session）。
錄製產物寫到指定目錄：
  recordings/<session_id>/
    ├─ actions.json       （動作序列）
    ├─ img_001.png        （錨點圖）
    ├─ img_002.png
    └─ meta.json          （螢幕解析度、DPI、錄製時間等）
"""
from __future__ import annotations
import json
import logging
import threading
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


# 點擊時擷取的錨點小圖邊長（px）— 80 是經驗值，夠大能辨識按鈕、夠小不受背景干擾
ANCHOR_SIZE = 80


@dataclass
class _KeyBuffer:
    """累積中的一般文字輸入，達到 flush 條件才轉成 type_text action"""
    text: str = ""
    last_time: float = 0.0

    def flush(self) -> Optional[dict]:
        if not self.text:
            return None
        act = {
            "type": "type_text",
            "text": self.text,
            "description": f'輸入 "{self.text[:20]}"' + ("…" if len(self.text) > 20 else ""),
        }
        self.text = ""
        self.last_time = 0.0
        return act


@dataclass
class RecordingSession:
    session_id: str
    output_dir: Path
    actions: list[dict] = field(default_factory=list)
    anchor_counter: int = 0
    last_event_time: float = 0.0
    key_buf: _KeyBuffer = field(default_factory=_KeyBuffer)
    stopped: bool = False
    started_at: float = 0.0

    # pynput listeners
    mouse_listener: object = None
    keyboard_listener: object = None

    def summary(self) -> dict:
        return {
            "session_id": self.session_id,
            "output_dir": str(self.output_dir),
            "action_count": len(self.actions),
            "started_at": self.started_at,
            "duration_sec": (time.time() - self.started_at) if self.started_at else 0,
            "stopped": self.stopped,
        }


# ── 單一 process 只能有一個 session ────────────────────────────
_current: Optional[RecordingSession] = None
_lock = threading.Lock()


def _maybe_insert_wait(session: RecordingSession) -> None:
    """若距上次事件 > 0.5 秒，插入一個 wait action 保留節奏"""
    now = time.time()
    if session.last_event_time and (now - session.last_event_time) > 0.5:
        gap = round(now - session.last_event_time, 2)
        session.actions.append({
            "type": "wait",
            "seconds": gap,
            "description": f"等待 {gap}s",
        })
    session.last_event_time = now


def _grab_anchor(session: RecordingSession, x: int, y: int) -> Optional[str]:
    """擷取 (x, y) 周圍 ANCHOR_SIZE 小圖存檔，回傳相對 output_dir 的檔名。

    注意：Windows 上 cv2.imwrite 對非 ASCII（中文）路徑會靜默失敗，
    改用 cv2.imencode + Python 原生寫檔 bypass 此 bug。
    """
    try:
        import mss
        import cv2
        import numpy as np
        half = ANCHOR_SIZE // 2
        left = max(0, x - half)
        top = max(0, y - half)
        region = {"left": left, "top": top, "width": ANCHOR_SIZE, "height": ANCHOR_SIZE}
        with mss.mss() as sct:
            img = np.array(sct.grab(region))
        img_bgr = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        session.anchor_counter += 1
        fname = f"img_{session.anchor_counter:03d}.png"
        out_path = session.output_dir / fname
        ok, buf = cv2.imencode(".png", img_bgr)
        if not ok:
            log.warning(f"cv2.imencode 失敗 for {fname}")
            return None
        out_path.write_bytes(buf.tobytes())
        if not out_path.is_file() or out_path.stat().st_size == 0:
            log.warning(f"錨點寫檔後檢查失敗：{out_path}")
            return None
        return fname
    except Exception as e:
        import traceback
        log.warning(f"擷取錨點失敗：{e}\n{traceback.format_exc()}")
        return None


_DOUBLE_CLICK_WINDOW_SEC = 0.5   # 連續點擊間隔 < 0.5s
_DOUBLE_CLICK_MAX_PX = 5          # 且位置差 < 5px → 合併為 double-click
_DRAG_MIN_PX = 10                 # 按下到放開的位移 > 10px → 視為拖曳
_DRAG_MIN_SEC = 0.15              # 且持續 > 150ms → 視為拖曳（排除手震）

# 記住最近一次 press 的狀態，用於辨識拖曳
_last_press: dict = {"x": 0, "y": 0, "t": 0.0, "button": "", "anchor": None}


def _on_click(x: int, y: int, button, pressed: bool) -> None:
    """滑鼠點擊事件 handler。
    - 按下瞬間：擷取錨點、暫存 press 狀態，不立即 emit
    - 放開瞬間：若位移/時間超過閾值 → emit 拖曳；否則 emit click（合併連點邏輯不變）
    """
    global _current, _last_press
    if _current is None or _current.stopped:
        return
    session = _current
    btn_name = str(button).replace("Button.", "")
    now = time.time()

    if pressed:
        # 記錄 press 狀態 + 先擷取錨點（被拖動的目標圖）
        _last_press = {
            "x": x, "y": y, "t": now, "button": btn_name,
            "anchor": _grab_anchor(session, x, y),
        }
        return

    # release: 判斷是 click 還是 drag
    px, py = _last_press.get("x", 0), _last_press.get("y", 0)
    pt = _last_press.get("t", 0.0)
    pbtn = _last_press.get("button", "")
    panchor = _last_press.get("anchor")
    dist = abs(x - px) + abs(y - py)   # L1 distance 就夠
    duration = now - pt
    is_drag = (pbtn == btn_name) and (dist > _DRAG_MIN_PX) and (duration > _DRAG_MIN_SEC)

    # 用「release 的時間點」當作事件時間戳
    # （下面走到 click/drag 分支）
    if is_drag:
        # flush 文字 buffer、插入 wait、輸出 drag
        flushed = session.key_buf.flush()
        if flushed:
            session.actions.append(flushed)
        _maybe_insert_wait(session)
        # 記下當下修飾鍵（Shift+drag=移動、Ctrl+drag=複製 等）
        drag_mods = sorted(_active_modifiers) if _active_modifiers else []
        drag_mods_desc = f"[{'+'.join(drag_mods)}] " if drag_mods else ""
        if panchor:
            session.actions.append({
                "type": "drag",
                "image": panchor,
                "x": px, "y": py,
                "x2": x, "y2": y,
                "button": btn_name,
                "modifiers": drag_mods,
                "description": f"{drag_mods_desc}{btn_name} 拖曳 ({px},{py}) → ({x},{y})（錨點 {panchor}）",
            })
        else:
            session.actions.append({
                "type": "drag",
                "x": px, "y": py, "x2": x, "y2": y,
                "button": btn_name,
                "modifiers": drag_mods,
                "description": f"{drag_mods_desc}{btn_name} 拖曳 ({px},{py}) → ({x},{y})",
            })
        return

    # 非拖曳：以 press 座標當點擊位置（x 可能因手震有 1-2px 差，取 press 更準確）
    x, y = px, py
    # 按住不放時間（一般點擊 < 100ms；長按會明顯拉長）
    hold_sec = round(duration, 2) if duration > 0.3 else 0.0

    # 連續點擊偵測：前一個 action 是同位置、同按鈕、最近 500ms 內的 click
    if session.actions:
        last = session.actions[-1]
        if (last.get("type") in ("click_image", "click_at")
                and last.get("button") == btn_name
                and isinstance(last.get("x"), (int, float))
                and isinstance(last.get("y"), (int, float))
                and abs(last["x"] - x) <= _DOUBLE_CLICK_MAX_PX
                and abs(last["y"] - y) <= _DOUBLE_CLICK_MAX_PX
                and (now - session.last_event_time) <= _DOUBLE_CLICK_WINDOW_SEC):
            # 合併：把前一個 action 的 clicks 加 1，不擷取新錨點、不插入 wait
            last["clicks"] = int(last.get("clicks", 1)) + 1
            last["description"] = f"{btn_name} 連點 {last['clicks']} 下 @ ({x},{y})"
            if last.get("image"):
                last["description"] += f"（{last['image']}）"
            session.last_event_time = now
            return

    # 一般單擊：先 flush 文字 buffer、插入 wait
    # 錨點已在 press 時擷取（panchor），重用避免重複截圖 + 抓到更貼近原始畫面
    flushed = session.key_buf.flush()
    if flushed:
        session.actions.append(flushed)
    _maybe_insert_wait(session)
    hold_desc = f"（按住 {hold_sec}s）" if hold_sec > 0 else ""
    # 當下有按著修飾鍵就記進 action，回放時會 keyDown → click → keyUp
    mods = sorted(_active_modifiers) if _active_modifiers else []
    mods_desc = f"[{'+'.join(mods)}] " if mods else ""
    if panchor:
        session.actions.append({
            "type": "click_image",
            "image": panchor,
            "x": x,
            "y": y,
            "button": btn_name,
            "clicks": 1,
            "hold_sec": hold_sec,
            "modifiers": mods,
            "description": f"{mods_desc}{btn_name} 點擊 @ {panchor}{hold_desc}（錄製座標 {x},{y}）",
        })
    else:
        session.actions.append({
            "type": "click_at",
            "x": x, "y": y, "button": btn_name, "clicks": 1,
            "hold_sec": hold_sec,
            "modifiers": mods,
            "description": f"{mods_desc}{btn_name} 點擊絕對座標 ({x},{y}){hold_desc}",
        })


_SPECIAL_KEYS = {
    "Key.enter": "enter", "Key.tab": "tab", "Key.esc": "esc",
    "Key.space": "space", "Key.backspace": "backspace", "Key.delete": "delete",
    "Key.up": "up", "Key.down": "down", "Key.left": "left", "Key.right": "right",
    "Key.home": "home", "Key.end": "end",
    "Key.page_up": "pageup", "Key.page_down": "pagedown",
    "Key.insert": "insert", "Key.caps_lock": "capslock",
    "Key.f1": "f1", "Key.f2": "f2", "Key.f3": "f3", "Key.f4": "f4",
    "Key.f5": "f5", "Key.f6": "f6", "Key.f7": "f7", "Key.f8": "f8",
    "Key.f10": "f10", "Key.f11": "f11", "Key.f12": "f12",  # f9 是停止錄製熱鍵不錄
    "Key.print_screen": "printscreen", "Key.pause": "pause",
    "Key.num_lock": "numlock", "Key.scroll_lock": "scrolllock",
}

# 修飾鍵：按住期間影響後續的 click / char 輸入，映射到 pyautogui 的按鍵名
_MODIFIER_KEYS = {
    "Key.shift": "shift", "Key.shift_l": "shift", "Key.shift_r": "shift",
    "Key.ctrl": "ctrl", "Key.ctrl_l": "ctrl", "Key.ctrl_r": "ctrl",
    "Key.alt": "alt", "Key.alt_l": "alt", "Key.alt_r": "alt", "Key.alt_gr": "alt",
    "Key.cmd": "win", "Key.cmd_l": "win", "Key.cmd_r": "win",  # Windows 鍵在 pynput 叫 cmd
}

# 目前按下中的修飾鍵集合（set[str]，例如 {"ctrl", "shift"}）
_active_modifiers: set[str] = set()


def _on_scroll(x: int, y: int, dx: int, dy: int) -> None:
    """滑鼠滾輪事件：dy>0 向上、dy<0 向下；pyautogui.scroll 正負同向"""
    global _current
    if _current is None or _current.stopped:
        return
    session = _current
    flushed = session.key_buf.flush()
    if flushed:
        session.actions.append(flushed)
    _maybe_insert_wait(session)
    # pynput 的 dy 單位是「缺口數」（一次滾輪大多是 ±1），轉成 pyautogui 的 clicks
    direction = "上" if dy > 0 else "下"
    # 記下當下修飾鍵（例如 Ctrl+滾輪 做縮放）
    mods = sorted(_active_modifiers) if _active_modifiers else []
    mods_desc = f"[{'+'.join(mods)}] " if mods else ""
    session.actions.append({
        "type": "scroll",
        "x": x,
        "y": y,
        "dy": int(dy),
        "modifiers": mods,
        "description": f"{mods_desc}在 ({x},{y}) 向{direction}捲 {abs(dy)} 格",
    })

# 錄製期間自動忽略的 emergency keys（不列入 actions）
_IGNORED_KEYS = {"Key.f9"}  # F9 將作為「停止錄製」熱鍵


def _on_press(key) -> None:
    """鍵盤按下 handler。
    - 修飾鍵（Ctrl/Shift/Alt/Win）：更新 _active_modifiers，不輸出動作
    - 一般字元 + 修飾鍵 → 輸出 hotkey（如 ctrl+c）
    - 一般字元無修飾 → 累積進 key_buf 成 type_text
    - 特殊鍵（Enter/Delete/方向鍵/F 鍵等） → 輸出 hotkey，包含當下修飾鍵
    """
    global _current, _active_modifiers
    if _current is None or _current.stopped:
        return
    session = _current

    key_str = str(key)
    # F9 = 立即停止錄製（不列入 actions）
    if key_str == "Key.f9":
        log.info("[recorder] F9 熱鍵觸發，停止錄製")
        threading.Thread(target=stop_recording, daemon=True).start()
        return
    if key_str in _IGNORED_KEYS:
        return

    # 修飾鍵：記住狀態不輸出動作
    if key_str in _MODIFIER_KEYS:
        _active_modifiers.add(_MODIFIER_KEYS[key_str])
        return

    # 一般字元
    char = getattr(key, "char", None)
    # Windows 上 Ctrl+字母 會變成控制字元（Ctrl+C = '\x03'、Ctrl+V = '\x16'），
    # 轉回對應字母（0x01→a, 0x02→b, ... 0x1A→z）
    if char is not None and len(char) == 1 and 1 <= ord(char) <= 26:
        char = chr(ord(char) + ord('a') - 1)
    if char is not None:
        # 有修飾鍵 → 組合鍵 hotkey（不進 text buffer）
        if _active_modifiers:
            # flush 可能累積的純文字
            flushed = session.key_buf.flush()
            if flushed:
                session.actions.append(flushed)
            _maybe_insert_wait(session)
            keys = sorted(_active_modifiers) + [char.lower()]
            session.actions.append({
                "type": "hotkey",
                "keys": keys,
                "description": f"快捷鍵：{'+'.join(keys)}",
            })
            return
        # 一般字元累積
        session.key_buf.text += char
        session.key_buf.last_time = time.time()
        return

    # 特殊鍵：先 flush 文字，再輸出 hotkey（含當下修飾鍵）
    special = _SPECIAL_KEYS.get(key_str)
    if special is None:
        return  # 不認識的鍵就略過

    flushed = session.key_buf.flush()
    if flushed:
        session.actions.append(flushed)
    _maybe_insert_wait(session)
    keys = sorted(_active_modifiers) + [special]
    session.actions.append({
        "type": "hotkey",
        "keys": keys,
        "description": f"按 {'+'.join(keys)}" if len(keys) > 1 else f"按 {special}",
    })


def _on_release(key) -> None:
    """鍵盤放開 handler：只追蹤修飾鍵的釋放"""
    global _active_modifiers
    if _current is None or _current.stopped:
        return
    key_str = str(key)
    if key_str in _MODIFIER_KEYS:
        _active_modifiers.discard(_MODIFIER_KEYS[key_str])


# ── 對外 API ──────────────────────────────────────────────────

def start_recording(session_id: str, output_dir: str) -> dict:
    """開始錄製。若已有 session 則先停止它再新開一個。
    開始前會清空 output_dir 裡的舊 img_*.png / actions.json / meta.json，
    避免舊錄製的殘留檔跟新錄製混在一起造成 anchor_counter 覆寫舊檔但其他舊檔還在的情況。"""
    global _current, _active_modifiers
    _active_modifiers = set()  # 清掉上次遺留的修飾鍵狀態
    with _lock:
        if _current and not _current.stopped:
            stop_recording()  # 自動停止舊 session
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        # 清掉前一次錄製的所有檔案（僅限可辨識的錄製產物，避免誤刪使用者其他東西）
        _purged = 0
        for fname_patt in ("img_*.png", "actions.json", "meta.json", "debug_screenshot_*.png"):
            for f in out.glob(fname_patt):
                try:
                    f.unlink()
                    _purged += 1
                except Exception:
                    pass
        if _purged > 0:
            log.info(f"[recorder] 🧹 清除舊錄製檔案 {_purged} 個（{out}）")
        session = RecordingSession(
            session_id=session_id,
            output_dir=out,
            started_at=time.time(),
            last_event_time=time.time(),
        )
        # lazy import pynput（未安裝時才報錯）
        try:
            from pynput import mouse, keyboard
        except ImportError:
            raise RuntimeError("缺少 pynput 套件，請先安裝：pip install pynput")

        session.mouse_listener = mouse.Listener(on_click=_on_click, on_scroll=_on_scroll)
        session.keyboard_listener = keyboard.Listener(on_press=_on_press, on_release=_on_release)
        session.mouse_listener.start()
        session.keyboard_listener.start()
        _current = session
        log.info(f"[recorder] ▶ 開始錄製 session={session_id}, out={out}")
        return session.summary()


def stop_recording() -> dict:
    """停止錄製、flush 殘留 buffer、寫出 actions.json 與 meta.json。"""
    global _current
    with _lock:
        if _current is None:
            return {"error": "沒有進行中的錄製 session"}
        session = _current
        if session.stopped:
            return session.summary()
        # 停監聽
        if session.mouse_listener:
            session.mouse_listener.stop()
        if session.keyboard_listener:
            session.keyboard_listener.stop()
        # flush 最後的文字 buffer
        flushed = session.key_buf.flush()
        if flushed:
            session.actions.append(flushed)
        # 寫出產物
        actions_file = session.output_dir / "actions.json"
        meta_file = session.output_dir / "meta.json"
        actions_file.write_text(
            json.dumps(session.actions, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        meta = _gather_meta(session)
        meta_file.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        session.stopped = True
        log.info(f"[recorder] ■ 錄製結束 session={session.session_id}, "
                 f"{len(session.actions)} 個動作 → {actions_file}")
        return session.summary()


def get_recording_status() -> dict:
    """查詢目前錄製狀態（供前端 polling 顯示動作數量）"""
    global _current
    if _current is None:
        return {"recording": False}
    s = _current.summary()
    s["recording"] = not _current.stopped
    s["latest_actions"] = _current.actions[-5:]  # 最近 5 個動作預覽
    return s


def load_recording(output_dir: str) -> dict:
    """讀回已錄好的 session（actions + meta）"""
    out = Path(output_dir)
    actions_file = out / "actions.json"
    meta_file = out / "meta.json"
    if not actions_file.is_file():
        return {"error": "actions.json 不存在"}
    actions = json.loads(actions_file.read_text(encoding="utf-8"))
    meta = {}
    if meta_file.is_file():
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
    return {"actions": actions, "meta": meta, "output_dir": str(out)}


def _gather_meta(session: RecordingSession) -> dict:
    """收集錄製環境資訊（解析度、DPI）供回放時檢查"""
    info = {
        "session_id": session.session_id,
        "recorded_at": session.started_at,
        "duration_sec": round(time.time() - session.started_at, 2),
        "action_count": len(session.actions),
        "anchor_size": ANCHOR_SIZE,
    }
    try:
        import mss
        with mss.mss() as sct:
            mon = sct.monitors[1]
            info["screen_width"] = mon["width"]
            info["screen_height"] = mon["height"]
    except Exception:
        pass
    return info
