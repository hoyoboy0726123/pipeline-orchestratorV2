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


def _on_click(x: int, y: int, button, pressed: bool) -> None:
    """滑鼠點擊事件 handler（只處理按下那一刻，放開忽略）"""
    global _current
    if not pressed or _current is None or _current.stopped:
        return
    session = _current
    # 先 flush 可能累積的鍵盤文字
    flushed = session.key_buf.flush()
    if flushed:
        session.actions.append(flushed)
    _maybe_insert_wait(session)
    anchor = _grab_anchor(session, x, y)
    btn_name = str(button).replace("Button.", "")  # left/right/middle
    if anchor:
        # 同時記錄 x,y 當 fallback：若回放時圖像比對失敗就改用絕對座標
        session.actions.append({
            "type": "click_image",
            "image": anchor,
            "x": x,
            "y": y,
            "button": btn_name,
            "clicks": 1,
            "description": f"{btn_name} 點擊 @ {anchor}（錄製座標 {x},{y}）",
        })
    else:
        # 錨點擷取失敗就 fallback 用絕對座標（不建議，但保本）
        session.actions.append({
            "type": "click_at",
            "x": x, "y": y, "button": btn_name, "clicks": 1,
            "description": f"{btn_name} 點擊絕對座標 ({x},{y})",
        })


_SPECIAL_KEYS = {
    "Key.enter": "enter", "Key.tab": "tab", "Key.esc": "esc",
    "Key.space": " ", "Key.backspace": "backspace", "Key.delete": "delete",
    "Key.up": "up", "Key.down": "down", "Key.left": "left", "Key.right": "right",
    "Key.home": "home", "Key.end": "end",
}

# 錄製期間自動忽略的 emergency keys（不列入 actions）
_IGNORED_KEYS = {"Key.f9"}  # F9 將作為「停止錄製」熱鍵


def _on_press(key) -> None:
    """鍵盤按下 handler：純字符進 buffer，特殊鍵 flush 後輸出"""
    global _current
    if _current is None or _current.stopped:
        return
    session = _current

    key_str = str(key)
    # F9 = 立即停止錄製（不列入 actions）
    if key_str == "Key.f9":
        log.info("[recorder] F9 熱鍵觸發，停止錄製")
        # stop_recording 自己會取鎖，這裡不能直接叫（會 deadlock）
        # 改用 thread 非同步呼叫
        threading.Thread(target=stop_recording, daemon=True).start()
        return
    if key_str in _IGNORED_KEYS:
        return

    # 純字符（key.char 會是字串，如 "a"）
    char = getattr(key, "char", None)
    if char is not None:
        session.key_buf.text += char
        session.key_buf.last_time = time.time()
        return

    # 特殊鍵：先 flush 文字，再輸出對應動作
    flushed = session.key_buf.flush()
    if flushed:
        session.actions.append(flushed)

    _maybe_insert_wait(session)

    if key_str in ("Key.enter", "Key.tab", "Key.esc"):
        session.actions.append({
            "type": "hotkey",
            "keys": [_SPECIAL_KEYS[key_str]],
            "description": f"按 {_SPECIAL_KEYS[key_str]}",
        })
    elif key_str == "Key.backspace":
        session.actions.append({
            "type": "hotkey",
            "keys": ["backspace"],
            "description": "按 backspace",
        })
    # 其他特殊鍵略過（避免錄到 shift/ctrl 狀態鍵本身）


# ── 對外 API ──────────────────────────────────────────────────

def start_recording(session_id: str, output_dir: str) -> dict:
    """開始錄製。若已有 session 則先停止它再新開一個。"""
    global _current
    with _lock:
        if _current and not _current.stopped:
            stop_recording()  # 自動停止舊 session
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
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

        session.mouse_listener = mouse.Listener(on_click=_on_click)
        session.keyboard_listener = keyboard.Listener(on_press=_on_press)
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
