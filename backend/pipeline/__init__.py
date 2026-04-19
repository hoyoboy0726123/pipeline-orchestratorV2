"""
Pipeline Orchestration Agent

智慧化 Pipeline 執行引擎：
- YAML 定義多步驟 pipeline（最多 5 步）
- 每步以子 process 執行 shell 命令
- LLM 語意驗證 log + 輸出檔案
- 自動重試（依設定）
- 失敗時 Telegram inline keyboard 詢問用戶（重試 / 跳過 / 中止）
- 完整 log 記錄，Telegram 只推送結果與決策通知
"""
from .models import PipelineConfig, PipelineStep, StepOutput
from .runner import run_pipeline, resume_pipeline
from .store import get_store, PipelineRun

__all__ = [
    "PipelineConfig",
    "PipelineStep",
    "StepOutput",
    "run_pipeline",
    "resume_pipeline",
    "get_store",
    "PipelineRun",
]
