"""
Pipeline 專用 file logger。

每次 run 建立獨立的 .log 檔，記錄完整 subprocess 輸出與驗證結果。
Telegram 只推送摘要，詳細過程全在 log 檔。
"""
import logging
from datetime import datetime
from pathlib import Path

from config import OUTPUT_BASE_PATH

LOG_DIR = OUTPUT_BASE_PATH / "pipeline_logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)


def create_run_logger(run_id: str, pipeline_name: str) -> tuple[logging.Logger, str]:
    """
    建立此 run 的 file logger。

    Returns:
        (logger, log_path_str)
    """
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in pipeline_name)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = LOG_DIR / f"{ts}_{safe_name}_{run_id[:8]}.log"

    logger = logging.getLogger(f"pipeline.{run_id}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    # 徹底清除舊的 handlers，避免在 Windows spawn 模式或恢復執行時重複輸出
    if logger.handlers:
        for h in logger.handlers[:]:
            logger.removeHandler(h)

    fh = logging.FileHandler(str(log_path), encoding="utf-8")
    fh.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)-8s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    logger.addHandler(fh)

    return logger, str(log_path)


def get_run_logger(run_id: str) -> logging.Logger:
    """回傳已存在的 logger（不保證有 handler，恢復 run 時用）"""
    return logging.getLogger(f"pipeline.{run_id}")


def resume_run_logger(run_id: str, log_path: str) -> logging.Logger:
    """
    恢復執行時，附加到現有的 log 檔案（不建立新檔）。
    用於 resume_pipeline 與 run_pipeline 恢復路徑，確保前端讀到的
    log_path 始終是同一個檔案。
    """
    logger = logging.getLogger(f"pipeline.{run_id}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    if logger.handlers:
        for h in logger.handlers[:]:
            logger.removeHandler(h)
    fh = logging.FileHandler(log_path, mode='a', encoding='utf-8')
    fh.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)-8s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    logger.addHandler(fh)
    return logger
