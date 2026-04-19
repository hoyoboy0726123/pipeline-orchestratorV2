"""
【工具 B】財務資料驗證與清洗
製作者：IT / 資料工程部門 (Data Engineering)

用途：讀取原始帳務資料，執行以下清洗邏輯：
      1. 移除無效日期
      2. 移除缺失部門
      3. 移除重複 Transaction_ID（保留第一筆）
      4. 移除金額為零的記錄
      5. 只保留 Approved 狀態的交易
      6. 新增 Month、Quarter 欄位供分析使用

輸入：~/ai_output/finance/raw_transactions.xlsx
輸出：~/ai_output/finance/cleaned_transactions.xlsx
"""
import os
import sys
import pandas as pd
from dotenv import load_dotenv
from pathlib import Path

# 載入 .env 設定
load_dotenv(Path(__file__).parent.parent.parent / "backend" / ".env")

# ── 路徑設定 ────────────────────────────────────────────────────────────────
def get_paths():
    # 1. 優先使用主程式動態注入的路徑 (包含工作流名稱)
    env_run_dir = os.getenv("PIPELINE_OUTPUT_DIR")
    if env_run_dir:
        return (
            os.path.join(env_run_dir, "raw_transactions.xlsx"),
            os.path.join(env_run_dir, "cleaned_transactions.xlsx")
        )

    # 2. 次優先從環境變數讀取全局輸出根目錄
    base_path = os.getenv("OUTPUT_BASE_PATH")
    if base_path:
        if not os.path.isabs(base_path):
             base_path = os.path.join(Path(__file__).parent.parent.parent, base_path)
        return (
            os.path.join(base_path, "finance", "raw_transactions.xlsx"),
            os.path.join(base_path, "finance", "cleaned_transactions.xlsx")
        )
    
    # 3. 預設：專案根目錄/ai_output/finance
    project_root = Path(__file__).parent.parent.parent
    return (
        os.path.join(project_root, "ai_output", "finance", "raw_transactions.xlsx"),
        os.path.join(project_root, "ai_output", "finance", "cleaned_transactions.xlsx")
    )

INPUT, OUTPUT = get_paths()

if not os.path.exists(INPUT):
    print(f"[ERROR] 找不到輸入檔案：{INPUT}")
    print("        請先執行 stage1_generate_transactions.py")
    sys.exit(1)

df = pd.read_excel(INPUT)
original = len(df)
log = []

# 1. 無效日期
df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
n = df["Date"].isna().sum()
df = df.dropna(subset=["Date"])
log.append(f"  移除無效日期    : {n} 筆")

# 2. 缺失部門
n = df["Department"].isna().sum()
df = df.dropna(subset=["Department"])
log.append(f"  移除缺失部門    : {n} 筆")

# 3. 重複 Transaction_ID
n = df.duplicated(subset=["Transaction_ID"]).sum()
df = df.drop_duplicates(subset=["Transaction_ID"], keep="first")
log.append(f"  移除重複 ID     : {n} 筆")

# 4. 金額為零
n = (df["Amount"] == 0).sum()
df = df[df["Amount"] != 0]
log.append(f"  移除零金額      : {n} 筆")

# 5. 只保留 Approved
n = (df["Status"] != "Approved").sum()
df = df[df["Status"] == "Approved"]
log.append(f"  移除非 Approved : {n} 筆（Pending/Rejected）")

# 6. 補充欄位
df["Month"]   = df["Date"].dt.strftime("%Y-%m")
df["Quarter"] = "Q1 2024"
df["Date"]    = df["Date"].dt.strftime("%Y-%m-%d")

df.to_excel(OUTPUT, index=False)

print("=" * 55)
print("Stage 2：資料清洗完成")
print("=" * 55)
print(f"  原始筆數        : {original}")
for line in log:
    print(line)
print(f"  清洗後筆數      : {len(df)}")
print(f"  輸出路徑        : {OUTPUT}")
