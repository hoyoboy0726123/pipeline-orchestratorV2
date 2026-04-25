"""
Windows 內建 OCR (Windows.Media.Ocr) 整合。

computer_use 節點的 click_image 動作若填了 ocr_text，就走這裡：
  1. 在錄製座標附近或整個桌面擷取螢幕
  2. 跑 Windows OCR 取得 [(文字, bbox)]
  3. 找到含目標文字的 bbox → 回傳該 bbox 中心作為點擊座標

WinRT 的 OCR API 本身是 async，對外提供同步 `find_text_on_screen()` 呼叫，
內部用 asyncio.run() 封裝，讓 computer_use.execute_action（同步）能直接用。

設計目標：
  - 0 外部 binary 依賴（Windows 自帶）
  - 支援 zh-Hant-TW + en-US（你的系統已安裝）
  - 跟 find_template 並列：回傳 OcrMatch 結構 ≈ CV 的 MatchResult
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)


@dataclass
class OcrMatch:
    """OCR 結果，結構對齊 CV 的 MatchResult 以便上層統一處理。"""
    found: bool
    center: tuple[int, int] = (0, 0)            # 絕對桌面座標
    bbox: tuple[int, int, int, int] = (0, 0, 0, 0)  # (left, top, width, height) in screen coord
    text: str = ""                              # 實際 OCR 到的文字（可能含目標的 superset）
    confidence: float = 0.0                     # 匹配信心：1.0=精確、0.8=包含、0.6=模糊
    reason: str = ""                            # 失敗時的訊息
    ocr_words_count: int = 0                    # OCR 總共讀到多少詞（debug 用）


# ── WinRT async 封裝 ─────────────────────────────────────────────────────────

async def _encode_to_bitmap(img_bgr: np.ndarray):
    """BGR numpy array → WinRT SoftwareBitmap（經由 PNG in-memory stream）"""
    import cv2
    from winrt.windows.graphics.imaging import BitmapDecoder
    from winrt.windows.storage.streams import (
        InMemoryRandomAccessStream,
        DataWriter,
    )

    # Python bytes → WinRT stream
    ok, buf = cv2.imencode(".png", img_bgr)
    if not ok:
        raise RuntimeError("cv2.imencode 失敗")
    png_bytes = bytes(buf.tobytes())

    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(png_bytes)
    await writer.store_async()
    await writer.flush_async()
    writer.detach_stream()
    stream.seek(0)

    decoder = await BitmapDecoder.create_async(stream)
    return await decoder.get_software_bitmap_async()


def _get_engine(lang_tag: Optional[str] = None):
    """取得 OcrEngine；優先指定語言、找不到就 fallback 到使用者設定的語言清單。"""
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.globalization import Language

    engine = None
    if lang_tag:
        try:
            engine = OcrEngine.try_create_from_language(Language(lang_tag))
        except Exception as e:
            log.debug(f"[ocr] try_create_from_language({lang_tag}) 失敗：{e}")
    if engine is None:
        engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise RuntimeError("無法建立任何 OcrEngine（可能未安裝 OCR 語言包）")
    return engine


async def _recognize(img_bgr: np.ndarray, lang_tag: Optional[str] = None) -> list[dict]:
    """對圖片跑 OCR 並攤平成 [{text, x, y, w, h, line_text, line_index}]。"""
    bitmap = await _encode_to_bitmap(img_bgr)
    engine = _get_engine(lang_tag)
    result = await engine.recognize_async(bitmap)

    items: list[dict] = []
    for i, line in enumerate(result.lines):
        line_text = line.text or ""
        for word in line.words:
            r = word.bounding_rect
            items.append({
                "text": word.text or "",
                "x": int(r.x),
                "y": int(r.y),
                "w": int(r.width),
                "h": int(r.height),
                "line_text": line_text,
                "line_index": i,
            })
    return items


# ── 文字匹配邏輯 ───────────────────────────────────────────────────────────

def _find_target_in_words(words: list[dict], target: str) -> Optional[tuple[dict, float]]:
    """依序嘗試匹配等級，回傳 (最佳 word dict, confidence) 或 None。
    只允許「目標 ⊆ word/line」方向（不接受反向、否則 target='File' 會匹到單獨的 'L'）。

    匹配等級：
      1. 字對字精確相等 → conf 1.0
      2. 目標為 word 的子字串（target in word）→ conf 0.9
         例：target='File' 匹到 word='FileExplorer'
      3. 跨詞：一行內所有 word 拼起來（去空白）含目標 → conf 0.8
         例：target='我是誰' 匹到 line words=['我','是','誰']（CJK 常見情況）
             target='File Edit' 匹到 line words=['File','Edit','View']
      4. 模糊：小寫 + 去空白後 target in word → conf 0.6
         例：target='File' 匹到 word='FILE.EXE'
    """
    t = target.strip()
    if not t:
        return None

    # 1. 精確匹配
    for w in words:
        if w["text"] == t:
            return w, 1.0

    # 2. 目標是 word 的子字串（單向）
    for w in words:
        wt = w["text"]
        if wt and t in wt:
            return w, 0.9

    # 3. 跨詞匹配 — 把一行所有 word 拼起來（去空白）再比對，可抓到 CJK 被 OCR 拆字
    by_line: dict[int, list[dict]] = {}
    for w in words:
        by_line.setdefault(w["line_index"], []).append(w)
    t_nospace = "".join(t.split())
    for idx, line_words in by_line.items():
        # 忽略 line.text（可能 CJK 字間有空格），改用 word.text 直接拼接
        joined_nospace = "".join(w["text"] for w in line_words).replace(" ", "")
        if t_nospace and t_nospace in joined_nospace:
            # 找出覆蓋目標起始位置的 words（保守：回整行合併 bbox）
            xs = [w["x"] for w in line_words]
            ys = [w["y"] for w in line_words]
            rights = [w["x"] + w["w"] for w in line_words]
            bots = [w["y"] + w["h"] for w in line_words]
            merged = {
                "text": joined_nospace,
                "x": min(xs),
                "y": min(ys),
                "w": max(rights) - min(xs),
                "h": max(bots) - min(ys),
                "line_text": joined_nospace,
                "line_index": idx,
            }
            return merged, 0.8

    # 4. 模糊（忽略大小寫 + 去空白；單向：target 是 word 的子字）
    t_norm = "".join(t.split()).lower()
    if t_norm:
        for w in words:
            wn = "".join(w["text"].split()).lower()
            if wn and t_norm in wn:
                return w, 0.6

    return None


# ── 對外 API ───────────────────────────────────────────────────────────────

def _ocr_one_pass(
    screen_bgr: np.ndarray,
    target: str,
    clip_x: int, clip_y: int,
    lang_tag: Optional[str],
    threshold: float,
) -> OcrMatch:
    """跑一次 OCR：對給定的（已裁切）影像找 target，回 OcrMatch。
    座標換算用 clip_x/clip_y（被裁掉的左上偏移）轉回絕對桌面座標。"""
    try:
        words = asyncio.run(_recognize(screen_bgr, lang_tag))
    except RuntimeError as e:
        # 已有 event loop 的 thread 跑 asyncio.run 會丟例外；computer_use 走 run_in_executor
        # 進來的 worker thread 不該有 loop，但保險起見補一條 fallback 路徑
        if "running event loop" in str(e).lower() or "asyncio.run" in str(e).lower():
            new_loop = asyncio.new_event_loop()
            try:
                words = new_loop.run_until_complete(_recognize(screen_bgr, lang_tag))
            finally:
                new_loop.close()
        else:
            return OcrMatch(False, reason=f"OCR 失敗：{e}")
    except Exception as e:
        return OcrMatch(False, reason=f"OCR 例外：{type(e).__name__}: {e}")

    hit = _find_target_in_words(words, target)
    if hit is not None:
        _, conf = hit
        if conf < threshold:
            return OcrMatch(
                False,
                reason=f"OCR 找到 '{target}' 但 conf={conf:.2f} 低於門檻 {threshold}（1.0 精確/0.9 word/0.8 line/0.6 模糊）",
                ocr_words_count=len(words),
                confidence=conf,
            )
    if hit is None:
        by_line: dict[int, list[dict]] = {}
        for w in words:
            by_line.setdefault(w["line_index"], []).append(w)
        line_samples = []
        for idx in sorted(by_line.keys())[:6]:
            joined = "".join(w["text"] for w in by_line[idx]).replace(" ", "")
            if joined:
                line_samples.append(f"'{joined[:40]}'")
        return OcrMatch(
            False,
            reason=f"OCR 沒找到 '{target}'（讀到 {len(words)} 個詞 / {len(by_line)} 行，前幾行：{', '.join(line_samples)}）",
            ocr_words_count=len(words),
        )

    word, conf = hit
    cx = clip_x + word["x"] + word["w"] // 2
    cy = clip_y + word["y"] + word["h"] // 2
    return OcrMatch(
        found=True,
        center=(cx, cy),
        bbox=(clip_x + word["x"], clip_y + word["y"], word["w"], word["h"]),
        text=word["text"],
        confidence=conf,
        ocr_words_count=len(words),
    )


def find_text_on_screen(
    screen_bgr: np.ndarray,
    target: str,
    origin_x: int = 0,
    origin_y: int = 0,
    lang_tag: Optional[str] = "zh-Hant-TW",
    near_xy: Optional[tuple[int, int]] = None,
    search_radius: int = 400,
    threshold: float = 0.6,
    region: Optional[tuple[int, int, int, int]] = None,
    strict_region: bool = False,
) -> OcrMatch:
    """在螢幕截圖裡找目標文字。座標體系：絕對虛擬桌面。

    搜尋順序（找到就 return，找不到自動試下一階段）：
      Phase 1: region（藍框）給定 → 先在框內找（速度快、避開跨螢幕誤判）
      Phase 2: near_xy 給定 → 在「錄製座標 ± search_radius」附近找
      Phase 3: 還是沒找到 → 擴大到全螢幕再找一次（最後保險）

    嚴格模式（strict_region=True）：
      只跑 Phase 1，框內 miss 就立即 fail。Phase 2/3 全部 skip。
      適合「目標必須在固定位置才合法」的場景（例：通知必須在右下角，
      在別處出現 = 別的東西，不能誤點）。多數情況保持預設 False。

    為什麼預設要寬容（strict=False）：
      原本 region 失敗就直接回 fail，使用者「框 Excel → 下次播放開始選單
      飄位 → 框內變成 PowerPoint」就一直失敗。實務上「框是優先位置、不是
      排他位置」才是符合直覺的行為。三階段每個階段都會 log，方便事後 debug。

    參數：
      screen_bgr: cv2 擷取的 BGR ndarray（來自 mss 再 cvtColor）
      origin_x/y: 截圖的桌面原點（mss.monitors[0] 的 left/top；多螢幕可能負值）
      region: 顯式裁切區域（絕對桌面座標 left, top, width, height）
      near_xy: 「附近搜尋」中心座標（通常是錄製時的點擊位置）
      search_radius: near_xy 模式下的半徑
      strict_region: True = 只認 region，框內 miss 立即 fail
    回傳 OcrMatch.center 是絕對桌面座標。
    """
    if not target or not target.strip():
        return OcrMatch(False, reason="ocr_text 為空")

    H, W = screen_bgr.shape[:2]
    log = logging.getLogger("pipeline")

    # ── Phase 1: region（藍框）─────────────────────────────────────
    if region is not None and region[2] > 0 and region[3] > 0:
        rl, rt, rw, rh = region
        rel_left = max(0, rl - origin_x)
        rel_top = max(0, rt - origin_y)
        rel_right = min(W, rl - origin_x + rw)
        rel_bottom = min(H, rt - origin_y + rh)
        if rel_right - rel_left >= 20 and rel_bottom - rel_top >= 20:
            res = _ocr_one_pass(
                screen_bgr[rel_top:rel_bottom, rel_left:rel_right],
                target,
                clip_x=origin_x + rel_left,
                clip_y=origin_y + rel_top,
                lang_tag=lang_tag,
                threshold=threshold,
            )
            if res.found:
                return res
            if strict_region:
                # 嚴格模式：框內 miss 立即 fail，不退 phase2/3
                log.info(f"[ocr] phase1 框內沒找到 '{target}'，strict_region=on → 立即 FAIL")
                res.reason = f"嚴格鎖定範圍：框內找不到 '{target}'（{res.reason[:120]}）"
                return res
            log.info(f"[ocr] phase1 框內沒找到 '{target}' → 試 phase2/3（{res.reason[:120]}）")
        else:
            log.info(f"[ocr] phase1 region 太小或超出螢幕，跳過（{(rl, rt, rw, rh)}）")
            if strict_region:
                return OcrMatch(False, reason=f"嚴格鎖定範圍：region {(rl, rt, rw, rh)} 無效")

    # ── Phase 2: near_xy + radius（附近搜尋，避開跨螢幕誤判）──────────
    if near_xy is not None:
        nx, ny = near_xy
        rel_x = nx - origin_x
        rel_y = ny - origin_y
        nleft = max(0, rel_x - search_radius)
        ntop = max(0, rel_y - search_radius)
        nright = min(W, rel_x + search_radius)
        nbottom = min(H, rel_y + search_radius)
        if nright - nleft >= 20 and nbottom - ntop >= 20:
            res = _ocr_one_pass(
                screen_bgr[ntop:nbottom, nleft:nright],
                target,
                clip_x=origin_x + nleft,
                clip_y=origin_y + ntop,
                lang_tag=lang_tag,
                threshold=threshold,
            )
            if res.found:
                if region is not None and region[2] > 0:
                    res.reason = f"phase1 框內 miss、phase2 附近找到（{res.text}，conf={res.confidence:.2f}）"
                return res
            log.info(f"[ocr] phase2 附近沒找到 '{target}' → 擴大全螢幕（{res.reason[:120]}）")
        else:
            log.info(f"[ocr] phase2 near_xy 區太小或超出螢幕，跳過（{(nx, ny)}±{search_radius}）")

    # ── Phase 3: 全螢幕（最後保險）─────────────────────────────────
    res3 = _ocr_one_pass(
        screen_bgr,
        target,
        clip_x=origin_x,
        clip_y=origin_y,
        lang_tag=lang_tag,
        threshold=threshold,
    )
    if res3.found and (region is not None and region[2] > 0 or near_xy is not None):
        res3.reason = f"phase1/2 miss、phase3 全螢幕找到（{res3.text}，conf={res3.confidence:.2f}）"
    return res3


# ── 啟動自檢 ───────────────────────────────────────────────────────────────

def probe() -> dict:
    """Backend 啟動時呼叫，檢查 OCR 是否可用。回傳給 UI 當 status。"""
    try:
        from winrt.windows.media.ocr import OcrEngine
        langs = list(OcrEngine.available_recognizer_languages)
        tags = [l.language_tag for l in langs]
        return {
            "available": True,
            "languages": tags,
        }
    except Exception as e:
        return {
            "available": False,
            "languages": [],
            "error": f"{type(e).__name__}: {e}",
        }
