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
"""
import asyncio
import html
import logging

logger = logging.getLogger("telegram_handler")

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

                # ── 截圖 ──
                if action == "screenshot":
                    logger.info(f"Telegram: 截圖 for run {run_id}")
                    try:
                        from pipeline.store import get_store
                        from pipeline.runner import take_screenshot
                        store = get_store()
                        run = store.load(run_id)
                        if not run:
                            await cb.answer("❌ 找不到此 run")
                            continue
                        # 取得目前步驟名稱
                        steps = run.config_dict.get("steps", [])
                        step_idx = run.current_step
                        step_name = steps[step_idx]["name"] if step_idx < len(steps) else "unknown"
                        await cb.answer("📸 正在截圖…")
                        ss_path = take_screenshot(run.pipeline_name, step_name)
                        if ss_path:
                            with open(ss_path, "rb") as photo:
                                await _bot_instance.send_photo(
                                    chat_id=cb.message.chat_id,
                                    photo=photo,
                                    caption=f"📸 截圖 — {run.pipeline_name} / {step_name}",
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
            # 另一個 bot 實例在跑，等待後重試
            logger.warning("Telegram conflict (another instance?), waiting 10s")
            await asyncio.sleep(10)
        except (TimedOut, NetworkError):
            # 正常的 long-poll 超時或網路問題
            await asyncio.sleep(1)
        except Exception as e:
            logger.warning(f"Telegram poll error: {e}")
            await asyncio.sleep(10)


_poll_task = None


async def start_polling():
    """啟動 Telegram callback polling（背景 task）"""
    global _poll_task
    if _poll_task and not _poll_task.done():
        return
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
