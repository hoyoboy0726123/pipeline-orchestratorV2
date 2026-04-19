"""
Pipeline Run 狀態持久化（使用統一 SQLite DB）。

每次 pipeline 執行建立一個 PipelineRun 記錄，
包含每步的執行結果與驗證結論，支援暫停後恢復。
"""
import json
import sqlite3
from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Optional

from db import get_conn


@dataclass
class StepResult:
    step_index: int
    step_name: str
    exit_code: int
    stdout_tail: str        # 最後 ~500 字（完整輸出在 log 檔）
    stderr_tail: str        # 最後 ~200 字
    validation_status: str  # "ok" | "warning" | "failed"
    validation_reason: str
    validation_suggestion: str
    retries_used: int = 0


@dataclass
class PipelineRun:
    run_id: str
    pipeline_name: str
    config_dict: dict
    current_step: int = 0
    step_results: list = field(default_factory=list)  # list[StepResult]
    status: str = "running"   # running | awaiting_human | completed | failed | aborted
    telegram_chat_id: Optional[int] = None
    log_path: str = ""
    started_at: str = field(default_factory=lambda: datetime.now().isoformat())
    ended_at: Optional[str] = None
    workflow_id: Optional[str] = None
    pending_recipes: list = field(default_factory=list)  # list[dict] — 延遲儲存的 recipes
    awaiting_type: str = ""       # "" | "failure" | "human_confirm"
    awaiting_message: str = ""    # 人工確認節點的自訂訊息 / 失敗原因
    awaiting_suggestion: str = "" # 失敗時的解決建議（套件安裝、工具選擇等）


class RunStore:
    def save(self, run: PipelineRun):
        conn = get_conn()
        raw = asdict(run)
        raw["step_results"] = [
            asdict(s) if isinstance(s, StepResult) else s
            for s in run.step_results
        ]
        workflow_id = raw.pop("workflow_id", None)
        conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, workflow_id, data) VALUES (?, ?, ?)",
            (run.run_id, workflow_id, json.dumps(raw, ensure_ascii=False)),
        )
        conn.commit()

    def load(self, run_id: str) -> Optional[PipelineRun]:
        conn = get_conn()
        row = conn.execute(
            "SELECT data, workflow_id FROM runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if not row:
            return None
        d = json.loads(row[0])
        d["step_results"] = [StepResult(**s) for s in d.get("step_results", [])]
        d["workflow_id"] = row[1]
        return PipelineRun(**d)

    def list_recent(self, limit: int = 10) -> list[PipelineRun]:
        conn = get_conn()
        rows = conn.execute(
            "SELECT data, workflow_id FROM runs ORDER BY rowid DESC LIMIT ?", (limit,)
        ).fetchall()
        result = []
        for data, wid in rows:
            d = json.loads(data)
            d["step_results"] = [StepResult(**s) for s in d.get("step_results", [])]
            d["workflow_id"] = wid
            result.append(PipelineRun(**d))
        return result

    def delete(self, run_id: str) -> bool:
        conn = get_conn()
        cursor = conn.execute(
            "DELETE FROM runs WHERE run_id=?", (run_id,)
        )
        conn.commit()
        return cursor.rowcount > 0

    def list_awaiting(self) -> list[PipelineRun]:
        """回傳所有正在等待人為決策的 run"""
        conn = get_conn()
        rows = conn.execute("SELECT data, workflow_id FROM runs").fetchall()
        result = []
        for data, wid in rows:
            d = json.loads(data)
            if d.get("status") == "awaiting_human":
                d["step_results"] = [StepResult(**s) for s in d.get("step_results", [])]
                d["workflow_id"] = wid
                result.append(PipelineRun(**d))
        return result


_store: Optional[RunStore] = None


def get_store() -> RunStore:
    global _store
    if _store is None:
        _store = RunStore()
    return _store
