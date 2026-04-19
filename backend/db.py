"""
統一 SQLite 資料庫：workflows、recipes、pipeline_runs。

DB 路徑：~/ai_output/pipeline.db
"""
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from config import OUTPUT_BASE_PATH

DB_PATH = str(OUTPUT_BASE_PATH / "pipeline.db")
_local = threading.local()


def get_conn() -> sqlite3.Connection:
    """每個 thread 一個 connection（SQLite thread-safety）。"""
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
    return _local.conn


def init_db():
    """建立所有表格（冪等）。"""
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS workflows (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL DEFAULT '新工作流',
            yaml       TEXT NOT NULL DEFAULT '',
            canvas     TEXT NOT NULL DEFAULT '{}',
            validate   INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recipes (
            id                 TEXT PRIMARY KEY,
            workflow_id        TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
            step_name          TEXT NOT NULL,
            task_hash          TEXT NOT NULL,
            input_fingerprints TEXT NOT NULL DEFAULT '{}',
            output_path        TEXT,
            code               TEXT NOT NULL DEFAULT '',
            python_version     TEXT NOT NULL DEFAULT '',
            success_count      INTEGER NOT NULL DEFAULT 0,
            fail_count         INTEGER NOT NULL DEFAULT 0,
            created_at         REAL NOT NULL,
            last_success_at    REAL NOT NULL DEFAULT 0,
            last_fail_at       REAL NOT NULL DEFAULT 0,
            avg_runtime_sec    REAL NOT NULL DEFAULT 0,
            disabled           INTEGER NOT NULL DEFAULT 0,
            was_interactive    INTEGER NOT NULL DEFAULT 0,
            UNIQUE(workflow_id, step_name)
        );

        CREATE TABLE IF NOT EXISTS runs (
            run_id      TEXT PRIMARY KEY,
            workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
            data        TEXT NOT NULL
        );
    """)
    conn.commit()

    # 遷移：如果舊 pipeline_runs.db 存在，匯入 runs 資料
    _migrate_old_runs(conn)
    # 遷移：如果舊 recipe JSON 檔案存在，匯入 recipes
    _migrate_old_recipes(conn)
    # 欄位遷移：舊版 recipes 表缺 was_interactive 欄位
    _add_column_if_missing(conn, "recipes", "was_interactive", "INTEGER NOT NULL DEFAULT 0")


def _add_column_if_missing(conn: sqlite3.Connection, table: str, col: str, col_def: str):
    try:
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        if col not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_def}")
            conn.commit()
    except Exception:
        pass


def _migrate_old_runs(conn: sqlite3.Connection):
    """從舊 pipeline_runs.db 匯入（一次性遷移）。"""
    old_db = OUTPUT_BASE_PATH / "pipeline_runs.db"
    if not old_db.exists():
        return
    try:
        old_conn = sqlite3.connect(str(old_db))
        rows = old_conn.execute("SELECT run_id, data FROM pipeline_runs").fetchall()
        old_conn.close()
        if not rows:
            return
        for run_id, data in rows:
            existing = conn.execute("SELECT 1 FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not existing:
                conn.execute(
                    "INSERT OR IGNORE INTO runs (run_id, workflow_id, data) VALUES (?, NULL, ?)",
                    (run_id, data),
                )
        conn.commit()
        # 遷移完成，重命名舊 DB
        old_db.rename(old_db.with_suffix(".db.migrated"))
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"遷移舊 runs 失敗：{e}")


def _migrate_old_recipes(conn: sqlite3.Connection):
    """從舊 recipe JSON 檔案匯入（一次性遷移）。"""
    recipe_root = OUTPUT_BASE_PATH / "pipeline_recipes"
    if not recipe_root.exists():
        return
    try:
        count = 0
        for sub in recipe_root.iterdir():
            if not sub.is_dir():
                continue
            for f in sub.glob("*.json"):
                try:
                    with open(f, "r", encoding="utf-8") as fh:
                        r = json.load(fh)
                    # 舊 recipe 用 pipeline_name，遷移時先放 workflow_id=NULL
                    # 後續由 workflow 建立時關聯
                    existing = conn.execute(
                        "SELECT 1 FROM recipes WHERE id=?", (r["recipe_id"],)
                    ).fetchone()
                    if not existing:
                        conn.execute("""
                            INSERT OR IGNORE INTO recipes
                            (id, workflow_id, step_name, task_hash, input_fingerprints,
                             output_path, code, python_version, success_count, fail_count,
                             created_at, last_success_at, last_fail_at, avg_runtime_sec, disabled)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            r["recipe_id"],
                            "__legacy__" + r.get("pipeline_id", ""),  # 暫存舊 pipeline_name
                            r["step_name"],
                            r["task_hash"],
                            json.dumps(r.get("input_fingerprints", {}), ensure_ascii=False),
                            r.get("output_path"),
                            r.get("code", ""),
                            r.get("python_version", ""),
                            r.get("success_count", 0),
                            r.get("fail_count", 0),
                            r.get("created_at", time.time()),
                            r.get("last_success_at", 0),
                            r.get("last_fail_at", 0),
                            r.get("avg_runtime_sec", 0),
                            1 if r.get("disabled") else 0,
                        ))
                        count += 1
                except Exception:
                    pass
        if count > 0:
            conn.commit()
            # 遷移完成，重命名舊目錄
            recipe_root.rename(recipe_root.with_suffix(".migrated"))
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"遷移舊 recipes 失敗：{e}")


# ── Workflow CRUD ────────────────────────────────────────────────────────────

def create_workflow(name: str = "新工作流", canvas: dict = None, validate: bool = False) -> dict:
    conn = get_conn()
    
    # ── 自動避重名邏輯 ──
    existing_names = {row[0] for row in conn.execute("SELECT name FROM workflows").fetchall()}
    final_name = name
    counter = 1
    while final_name in existing_names:
        final_name = f"{name}({counter})"
        counter += 1
    
    wf_id = f"wf-{uuid.uuid4().hex[:12]}"
    now = time.time()
    canvas_json = json.dumps(canvas or {"nodes": [], "edges": []}, ensure_ascii=False)
    conn.execute(
        "INSERT INTO workflows (id, name, yaml, canvas, validate, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (wf_id, final_name, "", canvas_json, 1 if validate else 0, now, now),
    )
    conn.commit()
    return {"id": wf_id, "name": final_name, "canvas": canvas or {"nodes": [], "edges": []},
            "validate": validate, "created_at": now, "updated_at": now}


def get_workflow(wf_id: str) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute("SELECT id, name, yaml, canvas, validate, created_at, updated_at FROM workflows WHERE id=?", (wf_id,)).fetchone()
    if not row:
        return None
    return _row_to_workflow(row)


def list_workflows() -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT id, name, yaml, canvas, validate, created_at, updated_at FROM workflows ORDER BY updated_at DESC").fetchall()
    return [_row_to_workflow(r) for r in rows]


def update_workflow(wf_id: str, patch: dict) -> Optional[dict]:
    conn = get_conn()
    existing = get_workflow(wf_id)
    if not existing:
        return None
    sets = []
    vals = []
    if "name" in patch:
        sets.append("name=?"); vals.append(patch["name"])
    if "yaml" in patch:
        sets.append("yaml=?"); vals.append(patch["yaml"])
    if "canvas" in patch:
        sets.append("canvas=?"); vals.append(json.dumps(patch["canvas"], ensure_ascii=False))
    if "validate" in patch:
        sets.append("validate=?"); vals.append(1 if patch["validate"] else 0)
    if not sets:
        return existing
    sets.append("updated_at=?"); vals.append(time.time())
    vals.append(wf_id)
    conn.execute(f"UPDATE workflows SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()
    return get_workflow(wf_id)


def delete_workflow(wf_id: str, cascade: bool = True) -> bool:
    """刪除工作流。cascade=True 時一併刪除 recipes 和 runs。"""
    conn = get_conn()
    if cascade:
        conn.execute("DELETE FROM recipes WHERE workflow_id=?", (wf_id,))
        conn.execute("UPDATE runs SET workflow_id=NULL WHERE workflow_id=?", (wf_id,))
    conn.execute("DELETE FROM workflows WHERE id=?", (wf_id,))
    conn.commit()
    return True


def _row_to_workflow(row) -> dict:
    return {
        "id": row[0],
        "name": row[1],
        "yaml": row[2],
        "canvas": json.loads(row[3]) if row[3] else {"nodes": [], "edges": []},
        "validate": bool(row[4]),
        "created_at": row[5],
        "updated_at": row[6],
    }


# ── Recipe CRUD（改為 workflow_id 關聯）───────────────────────────────────────

def save_recipe(workflow_id: str, step_name: str, task_hash: str,
                input_fingerprints: dict, output_path: Optional[str],
                code: str, python_version: str, runtime_sec: float,
                was_interactive: bool = False) -> dict:
    import hashlib
    conn = get_conn()
    rid = hashlib.sha1(f"{workflow_id}:{step_name}:{task_hash}".encode()).hexdigest()[:16]
    now = time.time()

    existing = conn.execute(
        "SELECT id, success_count, avg_runtime_sec FROM recipes WHERE workflow_id=? AND step_name=?",
        (workflow_id, step_name),
    ).fetchone()

    fps_json = json.dumps(input_fingerprints, ensure_ascii=False)
    wi = 1 if was_interactive else 0

    if existing:
        old_count = existing[1]
        old_avg = existing[2]
        new_count = old_count + 1
        new_avg = (old_avg * old_count + runtime_sec) / new_count
        conn.execute("""
            UPDATE recipes SET task_hash=?, input_fingerprints=?, output_path=?, code=?,
            python_version=?, success_count=?, last_success_at=?, avg_runtime_sec=?, disabled=0,
            was_interactive=?
            WHERE workflow_id=? AND step_name=?
        """, (task_hash, fps_json, output_path, code, python_version,
              new_count, now, new_avg, wi, workflow_id, step_name))
    else:
        conn.execute("""
            INSERT INTO recipes (id, workflow_id, step_name, task_hash, input_fingerprints,
            output_path, code, python_version, success_count, fail_count,
            created_at, last_success_at, avg_runtime_sec, was_interactive)
            VALUES (?,?,?,?,?,?,?,?,1,0,?,?,?,?)
        """, (rid, workflow_id, step_name, task_hash, fps_json,
              output_path, code, python_version, now, now, runtime_sec, wi))
    conn.commit()
    return get_recipe(workflow_id, step_name)


def get_recipe(workflow_id: str, step_name: str) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM recipes WHERE workflow_id=? AND step_name=?",
        (workflow_id, step_name),
    ).fetchone()
    if not row:
        return None
    return _row_to_recipe(row)


def match_recipe(workflow_id: str, step_name: str, task_hash: str,
                 input_fingerprints: dict) -> Optional[dict]:
    """檢查是否有可重用 recipe：task_hash + input_fingerprints 吻合且未停用。"""
    r = get_recipe(workflow_id, step_name)
    if not r or r["disabled"]:
        return None
    if r["task_hash"] != task_hash:
        return None
    if json.loads(r["input_fingerprints"]) if isinstance(r["input_fingerprints"], str) else r["input_fingerprints"] != input_fingerprints:
        return None
    return r


def mark_recipe_failed(workflow_id: str, step_name: str):
    conn = get_conn()
    conn.execute("""
        UPDATE recipes SET fail_count = fail_count + 1, last_fail_at = ?,
        disabled = CASE WHEN fail_count >= 2 THEN 1 ELSE 0 END
        WHERE workflow_id=? AND step_name=?
    """, (time.time(), workflow_id, step_name))
    conn.commit()


def list_recipes(workflow_id: Optional[str] = None) -> list[dict]:
    conn = get_conn()
    if workflow_id:
        rows = conn.execute("SELECT * FROM recipes WHERE workflow_id=?", (workflow_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM recipes").fetchall()
    return [_row_to_recipe(r) for r in rows]


def delete_recipe(workflow_id: str, step_name: str) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM recipes WHERE workflow_id=? AND step_name=?", (workflow_id, step_name))
    conn.commit()
    return cur.rowcount > 0


def delete_workflow_recipes(workflow_id: str) -> int:
    conn = get_conn()
    cur = conn.execute("DELETE FROM recipes WHERE workflow_id=?", (workflow_id,))
    conn.commit()
    return cur.rowcount


def _find_recipe(workflow_id: str, step_name: str) -> Optional[dict]:
    """查找 recipe：先精確匹配，再嘗試「N:name」索引格式（相容新舊 key）。"""
    r = get_recipe(workflow_id, step_name)
    if r:
        return r
    # 新格式：step_name 存為 "1:AI技能 1"，前端傳 "AI技能 1"
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM recipes WHERE workflow_id=? AND step_name LIKE ?",
        (workflow_id, f"%:{step_name}"),
    ).fetchone()
    return _row_to_recipe(row) if row else None


def get_recipe_status(workflow_id: str, step_names: list[str]) -> dict:
    steps_info = {}
    covered = 0
    for name in step_names:
        r = _find_recipe(workflow_id, name)
        if r and not r["disabled"]:
            steps_info[name] = {"has_recipe": True, "success_count": r["success_count"],
                                "avg_runtime_sec": round(r["avg_runtime_sec"], 1)}
            covered += 1
        else:
            steps_info[name] = {"has_recipe": False, "success_count": 0, "avg_runtime_sec": 0}
    return {"has_recipes": covered > 0, "total_skill_steps": len(step_names),
            "covered_steps": covered, "steps": steps_info}


def _row_to_recipe(row) -> dict:
    # row schema: id(0) wf(1) step(2) hash(3) fps(4) out(5) code(6) ver(7)
    #             scnt(8) fcnt(9) created(10) succ_at(11) fail_at(12) runtime(13)
    #             disabled(14) was_interactive(15)
    return {
        "recipe_id": row[0], "workflow_id": row[1], "step_name": row[2],
        "task_hash": row[3],
        "input_fingerprints": json.loads(row[4]) if isinstance(row[4], str) else row[4],
        "output_path": row[5], "code": row[6], "python_version": row[7],
        "success_count": row[8], "fail_count": row[9],
        "created_at": row[10], "last_success_at": row[11], "last_fail_at": row[12],
        "avg_runtime_sec": row[13], "disabled": bool(row[14]),
        "was_interactive": bool(row[15]) if len(row) > 15 else False,
    }


# ── Run CRUD（保持與舊 store.py 相容）──────────────────────────────────────

def save_run(run_data: dict, workflow_id: Optional[str] = None):
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO runs (run_id, workflow_id, data) VALUES (?,?,?)",
        (run_data["run_id"], workflow_id, json.dumps(run_data, ensure_ascii=False)),
    )
    conn.commit()


def load_run(run_id: str) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute("SELECT data, workflow_id FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if not row:
        return None
    d = json.loads(row[0])
    d["_workflow_id"] = row[1]
    return d


def list_runs(limit: int = 20, workflow_id: Optional[str] = None) -> list[dict]:
    conn = get_conn()
    if workflow_id:
        rows = conn.execute(
            "SELECT data, workflow_id FROM runs WHERE workflow_id=? ORDER BY rowid DESC LIMIT ?",
            (workflow_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT data, workflow_id FROM runs ORDER BY rowid DESC LIMIT ?", (limit,)
        ).fetchall()
    result = []
    for data, wid in rows:
        d = json.loads(data)
        d["_workflow_id"] = wid
        result.append(d)
    return result


def delete_run(run_id: str) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM runs WHERE run_id=?", (run_id,))
    conn.commit()
    return cur.rowcount > 0
