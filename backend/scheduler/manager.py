"""
Scheduler Manager：使用 APScheduler 管理定時任務。
任務資料持久化存在 SQLite，重啟後自動恢復。
"""
import uuid
from datetime import datetime
from typing import Optional
from dataclasses import dataclass, asdict

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.date import DateTrigger

from config import SCHEDULER_DB_PATH, TIMEZONE


@dataclass
class TaskInfo:
    id: str
    name: str
    task_prompt: str
    output_format: str
    save_path: Optional[str]
    schedule_type: str      # cron | interval | once
    schedule_expr: str      # cron 表達式 | "30m" | "2026-03-20 15:00"
    next_run: Optional[str]
    last_run: Optional[str]
    enabled: bool


# 全局 Scheduler 單例
_scheduler: Optional[AsyncIOScheduler] = None
# 任務元資料（存在記憶體，重啟後由 APScheduler 恢復觸發器）
_task_meta: dict[str, TaskInfo] = {}


def get_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is None:
        jobstore = SQLAlchemyJobStore(url=f"sqlite:///{SCHEDULER_DB_PATH}")
        _scheduler = AsyncIOScheduler(
            jobstores={"default": jobstore},
            timezone=TIMEZONE,
            job_defaults={
                "misfire_grace_time": 3600,  # 錯過 1 小時內仍補跑
                "coalesce": True,            # 多次 misfire 只補跑一次
            },
        )
    return _scheduler


async def _execute_task(task_id: str, task_prompt: str, output_format: str, save_path: Optional[str]):
    """實際執行任務的函式"""
    try:
        from agent.graph import run_task
        result = await run_task(task_prompt, output_format, save_path)
        if task_id in _task_meta:
            _task_meta[task_id].last_run = datetime.now().isoformat()
        return result
    except Exception as e:
        print(f"[Scheduler] 任務 {task_id} 執行失敗：{e}")


async def _execute_pipeline_task(task_id: str, yaml_path: str, chat_id: int):
    """執行 pipeline YAML 的排程入口"""
    try:
        import yaml as _yaml
        from pipeline.models import PipelineConfig
        from pipeline.runner import run_pipeline
        with open(yaml_path, encoding="utf-8") as f:
            raw = _yaml.safe_load(f)
        raw_dict = raw.get("pipeline", raw)
        use_recipe = raw_dict.get("_use_recipe", False)
        workflow_id = raw_dict.get("_workflow_id")
        config = PipelineConfig.from_yaml(yaml_path)
        config_d = config.model_dump()
        config_d["_use_recipe"] = use_recipe
        if workflow_id:
            config_d["_workflow_id"] = workflow_id
        config_d["_no_save_recipe"] = True  # 排程模式預設不覆蓋 recipe
        await run_pipeline(config_dict=config_d, chat_id=chat_id)
        if task_id in _task_meta:
            _task_meta[task_id].last_run = datetime.now().isoformat()
    except Exception as e:
        print(f"[Scheduler] Pipeline 任務 {task_id} 執行失敗：{e}")


def _parse_interval(expr: str) -> dict:
    """解析間隔表達式，如 '30m', '2h', '1d'"""
    units = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}
    unit = expr[-1].lower()
    value = int(expr[:-1])
    return {units.get(unit, "minutes"): value}


def add_task(
    name: str,
    task_prompt: str,
    output_format: str = "md",
    save_path: Optional[str] = None,
    schedule_type: str = "cron",
    schedule_expr: str = "0 9 * * *",
) -> TaskInfo:
    """
    新增定時任務。

    Args:
        name: 任務名稱
        task_prompt: 任務描述（傳給 LangGraph agent）
        output_format: 輸出格式
        save_path: 儲存路徑（None = 不存檔）
        schedule_type: cron | interval | once
        schedule_expr: cron 表達式 / 間隔（如 '1h'）/ 時間字串

    Returns:
        TaskInfo
    """
    task_id = str(uuid.uuid4())[:8]
    scheduler = get_scheduler()

    if schedule_type == "cron":
        trigger = CronTrigger.from_crontab(schedule_expr, timezone=TIMEZONE)
    elif schedule_type == "interval":
        trigger = IntervalTrigger(**_parse_interval(schedule_expr), timezone=TIMEZONE)
    elif schedule_type == "once":
        run_time = datetime.fromisoformat(schedule_expr)
        trigger = DateTrigger(run_date=run_time, timezone=TIMEZONE)
    else:
        raise ValueError(f"不支援的排程類型：{schedule_type}")

    scheduler.add_job(
        _execute_task,
        trigger=trigger,
        args=[task_id, task_prompt, output_format, save_path],
        id=task_id,
        name=name,
        replace_existing=True,
    )

    job = scheduler.get_job(task_id)
    next_run = job.next_run_time.isoformat() if job and job.next_run_time else None

    info = TaskInfo(
        id=task_id,
        name=name,
        task_prompt=task_prompt,
        output_format=output_format,
        save_path=save_path,
        schedule_type=schedule_type,
        schedule_expr=schedule_expr,
        next_run=next_run,
        last_run=None,
        enabled=True,
    )
    _task_meta[task_id] = info
    return info


def remove_task(task_id: str) -> bool:
    """刪除任務"""
    scheduler = get_scheduler()
    try:
        scheduler.remove_job(task_id)
        _task_meta.pop(task_id, None)
        return True
    except Exception:
        return False


def remove_task_by_name(name: str) -> bool:
    """透過名稱刪除任務（畫布端常用）"""
    scheduler = get_scheduler()
    found = False
    for job in scheduler.get_jobs():
        if job.name == name:
            try:
                scheduler.remove_job(job.id)
                _task_meta.pop(job.id, None)
                found = True
            except Exception:
                pass
    return found


def list_tasks() -> list[dict]:
    """列出所有任務"""
    scheduler = get_scheduler()
    result = []
    for job in scheduler.get_jobs():
        meta = _task_meta.get(job.id, TaskInfo(
            id=job.id, name=job.name, task_prompt="",
            output_format="md", save_path=None,
            schedule_type="cron", schedule_expr="",
            next_run=None, last_run=None, enabled=True,
        ))
        # 確保回傳帶有時區資訊的 ISO 字串
        if job.next_run_time:
            meta.next_run = job.next_run_time.isoformat()
        else:
            meta.next_run = None
        result.append(asdict(meta))
    return result


def add_pipeline_task(
    name: str,
    schedule_type: str = "cron",   # "cron" | "once"
    schedule_expr: str = "0 8 * * *",  # cron: "H M * * *" | once: "2026-03-23T15:30:00"
    yaml_path: Optional[str] = None,
    yaml_content: Optional[str] = None,
    chat_id: int = 0,
) -> TaskInfo:
    """
    新增 pipeline YAML 定時執行任務。
    schedule_type="cron"  → 週期性，schedule_expr 為 cron 表達式
    schedule_type="once"  → 單次，schedule_expr 為 ISO datetime 字串
    """
    from config import PIPELINE_DIR
    import re

    if yaml_content and not yaml_path:
        safe_name = re.sub(r"[^\w\-]", "_", name)[:40]
        task_id = str(uuid.uuid4())[:8]
        yaml_path = str(PIPELINE_DIR / f"{safe_name}_{task_id}.yaml")
        with open(yaml_path, "w", encoding="utf-8") as f:
            f.write(yaml_content)
    elif not yaml_path:
        raise ValueError("yaml_path 或 yaml_content 必須提供一個")
    else:
        task_id = str(uuid.uuid4())[:8]

    scheduler = get_scheduler()

    if schedule_type == "once":
        run_dt = datetime.fromisoformat(schedule_expr)
        trigger = DateTrigger(run_date=run_dt, timezone=TIMEZONE)
    else:
        trigger = CronTrigger.from_crontab(schedule_expr, timezone=TIMEZONE)

    scheduler.add_job(
        _execute_pipeline_task,
        trigger=trigger,
        args=[task_id, yaml_path, chat_id],
        id=task_id,
        name=name,
        replace_existing=True,
    )

    job = scheduler.get_job(task_id)
    next_run = job.next_run_time.isoformat() if job and job.next_run_time else None

    info = TaskInfo(
        id=task_id,
        name=name,
        task_prompt=f"[pipeline] {yaml_path}",
        output_format="pipeline",
        save_path=yaml_path,
        schedule_type=schedule_type,
        schedule_expr=schedule_expr,
        next_run=next_run,
        last_run=None,
        enabled=True,
    )
    _task_meta[task_id] = info
    return info


async def start():
    """啟動 Scheduler，並從 APScheduler 恢復 _task_meta"""
    sched = get_scheduler()
    if not sched.running:
        sched.start()

    # 從已持久化的 jobs 重建 _task_meta（避免重啟後前端看不到排程）
    for job in sched.get_jobs():
        if job.id in _task_meta:
            continue  # 已有的不覆蓋
        next_run = job.next_run_time.isoformat() if job.next_run_time else None
        args = job.args or []
        # pipeline task: args = [task_id, yaml_path, chat_id]
        # normal task:   args = [task_id, prompt, format, save_path]
        is_pipeline = len(args) == 3 and isinstance(args[1], str) and args[1].endswith(".yaml")
        _task_meta[job.id] = TaskInfo(
            id=job.id,
            name=job.name,
            task_prompt=f"[pipeline] {args[1]}" if is_pipeline else (args[1] if len(args) > 1 else ""),
            output_format="pipeline" if is_pipeline else (args[2] if len(args) > 2 else "md"),
            save_path=args[1] if is_pipeline else (args[3] if len(args) > 3 else None),
            schedule_type="cron",
            schedule_expr=str(job.trigger),
            next_run=next_run,
            last_run=None,
            enabled=True,
        )


async def shutdown():
    """關閉 Scheduler"""
    sched = get_scheduler()
    if sched.running:
        sched.shutdown(wait=False)
