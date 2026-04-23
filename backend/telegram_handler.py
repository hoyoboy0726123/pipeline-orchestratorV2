"""
Telegram Bot callback handler — 處理 inline keyboard 按鈕回調。

在後端啟動時以背景 task 運行，持續 polling Telegram 更新。
當收到 pipe_retry / pipe_hint / pipe_log / pipe_abort / pipe_continue 回調時，
呼叫 resume_pipeline() 繼續或中止 pipeline。

pipe_hint 流程：
1. 用戶點擊「💬 補充指示」按鈕
2. Bot 回覆「請輸入補充指示：」
3. 用戶發送文字訊息
4. Bot 呼叫 resume_pipeline(run_id, "retry_with_hint", hint=text)

── 多實例協調 ─────────────────────────────────────────────────────────────
Telegram Bot API 同一 token 同時間只允許一個 getUpdates long-poll session；
多個 backend 同時 poll 會收到 409 Conflict、callback 被亂搶、按鈕按了沒人回。
為避免這種情況，啟動前先用 PID lock 檢查：
  - Lock 路徑：%LOCALAPPDATA%/pipeline_orchestrator/telegram.lock（Windows）
              ~/.cache/pipeline_orchestrator/telegram.lock（Unix）
  - 內容：JSON {pid, project, started_at}
  - 若 lock 被另一個還活著的 process 持有 → 本實例跳過 polling，log 清楚說明
  - 持有 process 死掉（stale lock）→ 覆蓋接管
"""
import asyncio
import html
import json
import logging
import os
import sys
import time
from pathlib import Path

logger = logging.getLogger("telegram_handler")


def _lock_path() -> Path:
    """全機共用 lock 位置。Windows 用 %LOCALAPPDATA%，Unix 用 ~/.cache。"""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    d = base / "pipeline_orchestrator"
    d.mkdir(parents=True, exist_ok=True)
    return d / "telegram.lock"


def _pid_alive(pid: int) -> bool:
    """跨平台檢查 pid 是否真的還在跑（不靠 psutil）。
    Windows 坑：OpenProcess 對「已結束但 handle 還沒清完」的 process 也會成功，
    所以光靠 OpenProcess 會把 stale PID 誤判成 alive → lock 永遠釋不掉。
    改用 GetExitCodeProcess：exit_code == STILL_ACTIVE(259) 才算真活著。
    """
    if pid <= 0:
        return False
    try:
        if sys.platform == "win32":
            import ctypes
            kernel32 = ctypes.windll.kernel32
            PROCESS_QUERY_LIMITED = 0x1000
            STILL_ACTIVE = 259
            h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED, False, pid)
            if not h:
                return False
            try:
                exit_code = ctypes.c_ulong()
                ok = kernel32.GetExitCodeProcess(h, ctypes.byref(exit_code))
                if not ok:
                    return False
                return exit_code.value == STILL_ACTIVE
            finally:
                kernel32.CloseHandle(h)
        else:
            os.kill(pid, 0)
            return True
    except Exception:
        return False


def _try_acquire_lock() -> bool:
    """嘗試拿下 telegram polling 的機器級 lock。
    回傳 True = 拿到、可以 poll；False = 別人還活著在 poll，本實例不 poll。
    """
    path = _lock_path()
    try:
        if path.exists():
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
            holder_pid = int(meta.get("pid", 0) or 0)
            holder_proj = meta.get("project", "unknown")
            if holder_pid and holder_pid != os.getpid() and _pid_alive(holder_pid):
                logger.warning(
                    f"Telegram polling 被另一實例持有 (pid={holder_pid}, project={holder_proj})。"
                    f" 本實例跳過 polling — Telegram 按鈕/截圖/補充指示將由該實例處理。"
                    f" 若要本實例處理，請先關閉 pid {holder_pid} 或刪掉 lock：{path}"
                )
                return False
        # 寫入自己的 meta 接管 lock
        meta = {
            "pid": os.getpid(),
            "project": _detect_project_tag(),
            "started_at": time.time(),
        }
        path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        logger.info(f"Telegram polling lock 取得：{path} (pid={os.getpid()})")
        return True
    except Exception as e:
        # lock 檔出問題別擋啟動、照常 poll；最差就退回舊行為
        logger.warning(f"Telegram lock 操作失敗（忽略、繼續 poll）：{e}")
        return True


def _release_lock() -> None:
    """停止 polling 時釋放 lock（只有自己持有才刪）。"""
    path = _lock_path()
    try:
        if not path.exists():
            return
        meta = json.loads(path.read_text(encoding="utf-8"))
        if int(meta.get("pid", 0) or 0) == os.getpid():
            path.unlink()
    except Exception:
        pass


def _detect_project_tag() -> str:
    """從 cwd 推個專案標籤寫進 lock，方便 debug 知道是誰持有。"""
    cwd = str(Path.cwd()).lower()
    for tag in ("pipeline-orchestratorv3", "pipeline-orchestratorv2", "pipeline-orchestratorv1"):
        if tag in cwd:
            return tag
    return "unknown"

# 等待用戶輸入補充指示的狀態：chat_id → run_id
_pending_hints: dict[int, str] = {}

# 等待用戶輸入 ask_user 自由回答的狀態：chat_id → run_id
_pending_answers: dict[int, str] = {}


async def _poll_loop():
    """長輪詢 Telegram updates，處理 callback_query 和文字訊息"""
    from telegram import Bot
    from telegram.error import RetryAfter, TimedOut, NetworkError, Conflict

    last_offset = 0
    _bot_instance = None
    _current_token = ""

    while True:
        try:
            from settings import get_settings
            s = get_settings()
            token = s.get("telegram_bot_token", "")
            # Fallback 順序：pipeline_settings.json → .env TELEGRAM_BOT_TOKEN
            # 後端 outbound 通知是讀 env var，有些人只設 env 沒存到 settings UI，
            # polling loop 若只讀 settings 會永遠 sleep 導致 callback 收不到
            if not token:
                token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
            if not token:
                await asyncio.sleep(15)
                continue

            # token 變更時重建 bot
            if token != _current_token:
                if _bot_instance:
                    try:
                        await _bot_instance.close()
                    except Exception:
                        pass
                _bot_instance = Bot(token=token)
                _current_token = token
                last_offset = 0  # 重置 offset
                # 清除舊 session，避免 Conflict
                try:
                    await _bot_instance.delete_webhook(drop_pending_updates=False)
                    # 短 timeout getUpdates 搶佔 session
                    stale = await _bot_instance.get_updates(timeout=1)
                    if stale:
                        last_offset = stale[-1].update_id + 1
                except Exception:
                    pass
                logger.info("Telegram bot 已連線（session 已重置）")

            updates = await _bot_instance.get_updates(
                offset=last_offset,
                timeout=30,
                allowed_updates=["callback_query", "message"],
            )

            for update in updates:
                last_offset = update.update_id + 1

                # ── 文字訊息：檢查是否有等待中的補充指示或 ask_user 答案 ──
                if update.message and update.message.text:
                    chat_id = update.message.chat_id
                    if chat_id in _pending_answers:
                        run_id = _pending_answers.pop(chat_id)
                        answer = update.message.text.strip()
                        logger.info(f"收到 ask_user 答案 for run {run_id}: {answer[:100]}")
                        try:
                            from pipeline.runner import resume_pipeline
                            msg = await resume_pipeline(run_id, "answer", hint=answer)
                            await _bot_instance.send_message(
                                chat_id=chat_id,
                                text=f"✅ {msg}",
                            )
                        except Exception as e:
                            logger.error(f"ask_user answer failed: {e}")
                            await _bot_instance.send_message(
                                chat_id=chat_id,
                                text=f"❌ 送出失敗：{str(e)[:200]}",
                            )
                        continue
                    if chat_id in _pending_hints:
                        run_id = _pending_hints.pop(chat_id)
                        hint_text = update.message.text.strip()
                        logger.info(f"收到補充指示 for run {run_id}: {hint_text[:100]}")
                        try:
                            from pipeline.runner import resume_pipeline
                            msg = await resume_pipeline(run_id, "retry_with_hint", hint=hint_text)
                            await _bot_instance.send_message(
                                chat_id=chat_id,
                                text=f"💬 已收到指示，正在重試…\n\n{msg}",
                            )
                        except Exception as e:
                            logger.error(f"Hint resume failed: {e}")
                            await _bot_instance.send_message(
                                chat_id=chat_id,
                                text=f"❌ 重試失敗：{str(e)[:200]}",
                            )
                    continue

                if not update.callback_query:
                    continue

                cb = update.callback_query
                data = cb.data or ""

                # 解析 callback_data: pipe_{action}:{run_id} 或 pipe_answer:{run_id}:{idx}
                if not data.startswith("pipe_"):
                    continue

                parts = data.split(":", 2)
                if len(parts) < 2:
                    continue

                action = parts[0].replace("pipe_", "")
                run_id = parts[1]
                extra = parts[2] if len(parts) >= 3 else ""

                # ── 查看 Log ──
                if action == "log":
                    logger.info(f"Telegram: 查看 log for run {run_id}")
                    try:
                        from pipeline.runner import get_run_log_tail
                        log_text = get_run_log_tail(run_id, lines=25)
                        # Telegram 訊息上限 4096 字元
                        if len(log_text) > 3800:
                            log_text = "…（前面省略）\n" + log_text[-3800:]
                        safe_log = html.escape(log_text)
                        await cb.answer("📋 Log 已發送")
                        await _bot_instance.send_message(
                            chat_id=cb.message.chat_id,
                            text=f"📋 <b>Pipeline Log（最近 25 行）</b>\n\n<pre>{safe_log}</pre>",
                            parse_mode="HTML",
                        )
                    except Exception as e:
                        await cb.answer(f"❌ {str(e)[:150]}")
                    continue

                # ── 截圖 ── 逐螢幕截（1 螢幕 1 張、N 螢幕 N 張）
                # 委託給 runner._tg_send_photos，行為跟自動截圖一致，並含 photo→document fallback
                # （4K 螢幕 PNG 常 >5MB、send_photo 會被拒；send_document 不受尺寸/壓縮限制）
                if action == "screenshot":
                    logger.info(f"Telegram: 截圖 for run {run_id}")
                    try:
                        from pipeline.store import get_store
                        from pipeline.runner import take_screenshots, _tg_send_photos
                        store = get_store()
                        run = store.load(run_id)
                        if not run:
                            await cb.answer("❌ 找不到此 run")
                            continue
                        steps = run.config_dict.get("steps", [])
                        step_idx = run.current_step
                        step_name = steps[step_idx]["name"] if step_idx < len(steps) else "unknown"
                        await cb.answer("📸 正在截圖…")
                        ss_paths = take_screenshots(run.pipeline_name, step_name)
                        if ss_paths:
                            await _tg_send_photos(
                                cb.message.chat_id,
                                ss_paths,
                                caption_prefix=f"📸 {run.pipeline_name} / {step_name}",
                            )
                        else:
                            await _bot_instance.send_message(
                                chat_id=cb.message.chat_id,
                                text="❌ 截圖失敗，請確認後端主機是否有螢幕",
                            )
                    except Exception as e:
                        logger.error(f"Screenshot failed: {e}")
                        try:
                            await cb.answer(f"❌ {str(e)[:150]}")
                        except Exception:
                            pass
                    continue

                # ── ask_user 按選項回答 ──
                if action == "answer":
                    # extra 是 option index
                    try:
                        opt_idx = int(extra)
                    except Exception:
                        await cb.answer("❌ 選項索引錯誤")
                        continue
                    # 從 run 狀態取出原 options
                    from pipeline.store import get_store
                    import json as _json
                    store = get_store()
                    run = store.load(run_id)
                    if not run or run.awaiting_type != "ask_user":
                        await cb.answer("⚠️ 已非等待狀態")
                        continue
                    try:
                        meta = _json.loads(run.awaiting_suggestion or "{}")
                        options = meta.get("options") or []
                    except Exception:
                        options = []
                    if opt_idx < 0 or opt_idx >= len(options):
                        await cb.answer("❌ 選項索引越界")
                        continue
                    chosen = str(options[opt_idx])
                    logger.info(f"Telegram: ask_user 選項 {chosen} for run {run_id}")
                    try:
                        from pipeline.runner import resume_pipeline
                        msg = await resume_pipeline(run_id, "answer", hint=chosen)
                        await cb.answer(f"已選：{chosen[:50]}")
                        try:
                            await cb.edit_message_text(
                                text=(cb.message.text or "") + f"\n\n✅ 已選擇：{chosen}",
                            )
                        except Exception:
                            pass
                    except Exception as e:
                        await cb.answer(f"❌ {str(e)[:150]}")
                    continue

                # ── ask_user 自由輸入：設定等待狀態，改走文字訊息 ──
                if action == "answer_free":
                    logger.info(f"Telegram: 等待 ask_user 自由輸入 for run {run_id}")
                    _pending_answers[cb.message.chat_id] = run_id
                    await cb.answer("請輸入答案")
                    await _bot_instance.send_message(
                        chat_id=cb.message.chat_id,
                        text=(
                            "✍ <b>請輸入你的答案</b>\n\n"
                            "直接回覆文字訊息即可。AI 會根據你的回答繼續任務。"
                        ),
                        parse_mode="HTML",
                    )
                    continue

                # ── 補充指示：設定等待狀態 ──
                if action == "hint":
                    logger.info(f"Telegram: 等待補充指示 for run {run_id}")
                    _pending_hints[cb.message.chat_id] = run_id
                    await cb.answer("請輸入補充指示")
                    await _bot_instance.send_message(
                        chat_id=cb.message.chat_id,
                        text=(
                            "💬 <b>請輸入補充指示</b>\n\n"
                            "AI 會根據你的指示重新嘗試此步驟。\n"
                            "例如：「改用 selenium」「檢查 CSS selector 是否正確」「用另一個 API」"
                        ),
                        parse_mode="HTML",
                    )
                    continue

                if action not in ("retry", "skip", "abort", "continue"):
                    await cb.answer("❓ 未知操作")
                    continue

                logger.info(f"Telegram callback: {action} for run {run_id}")

                try:
                    from pipeline.runner import resume_pipeline
                    msg = await resume_pipeline(run_id, action)
                    await cb.answer(msg[:200])
                    # 更新原訊息，標記已處理
                    action_labels = {
                        "retry": "🔄 已選擇重試",
                        "skip": "⏩ 已選擇跳過",
                        "abort": "🛑 已選擇中止",
                        "continue": "✅ 已確認繼續",
                    }
                    try:
                        original_text = cb.message.text or ""
                        await cb.edit_message_text(
                            text=original_text + f"\n\n{action_labels.get(action, action)}",
                        )
                    except Exception:
                        pass
                except Exception as e:
                    logger.error(f"Resume failed: {e}")
                    try:
                        await cb.answer(f"❌ {str(e)[:150]}")
                    except Exception:
                        pass

        except asyncio.CancelledError:
            logger.info("Telegram polling stopped")
            if _bot_instance:
                try:
                    await _bot_instance.close()
                except Exception:
                    pass
            break
        except RetryAfter as e:
            wait = e.retry_after + 1
            logger.warning(f"Telegram flood control, waiting {wait}s")
            await asyncio.sleep(wait)
        except Conflict:
            # 409 Conflict = 有別人（同機別 backend / 別台機器的 bot）在 poll 同一 token。
            # 不再悶頭重試：大聲 log、等久一點（30s），避免跟對方亂搶亂吃 callback。
            logger.warning(
                "Telegram 409 Conflict — 另一個 bot 實例正在 poll 同一 token。"
                " 這代表有別的 backend（本機或其他機器）在用同一個 token，"
                " 會造成按鈕 callback 被亂搶。請確認只開一個 backend，或為每個版本用不同 bot token。"
            )
            await asyncio.sleep(30)
        except (TimedOut, NetworkError):
            # 正常的 long-poll 超時或網路問題
            await asyncio.sleep(1)
        except Exception as e:
            logger.warning(f"Telegram poll error: {e}")
            await asyncio.sleep(10)


_poll_task = None


async def start_polling():
    """啟動 Telegram callback polling（背景 task）
    啟動前先試著拿機器級 lock；拿不到代表已有實例在 poll，本實例就不啟 task
    （避免同機多 backend 互搶 Telegram getUpdates session）。
    """
    global _poll_task
    if _poll_task and not _poll_task.done():
        return
    if not _try_acquire_lock():
        return  # 另一實例持有 — 本實例只做 outbound 通知
    _poll_task = asyncio.create_task(_poll_loop())
    logger.info("Telegram callback polling 已啟動")


async def stop_polling():
    """停止 polling"""
    global _poll_task
    if _poll_task and not _poll_task.done():
        _poll_task.cancel()
        try:
            await _poll_task
        except asyncio.CancelledError:
            pass
    _poll_task = None
    _release_lock()
