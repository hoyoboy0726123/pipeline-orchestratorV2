"""
【工具 C】財務分析與彙總
製作者：財務分析師 (Finance Analyst)

用途：對清洗後的帳務資料進行多維度彙總分析：
      - 部門別收支彙總
      - 月份別收支趨勢
      - 費用類別排名
      - 收入來源結構
      - 關鍵 KPI 計算（總收入、總支出、淨利、費用率）

輸入：~/ai_output/finance/cleaned_transactions.xlsx
輸出：~/ai_output/finance/financial_summary.xlsx（多工作表）
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
            os.path.join(env_run_dir, "cleaned_transactions.xlsx"),
            os.path.join(env_run_dir, "financial_summary.xlsx")
        )

    # 2. 次優先從環境變數讀取全局輸出根目錄
    base_path = os.getenv("OUTPUT_BASE_PATH")
    if base_path:
        if not os.path.isabs(base_path):
             base_path = os.path.join(Path(__file__).parent.parent.parent, base_path)
        return (
            os.path.join(base_path, "finance", "cleaned_transactions.xlsx"),
            os.path.join(base_path, "finance", "financial_summary.xlsx")
        )
    
    # 3. 預設：專案根目錄/ai_output/finance
    project_root = Path(__file__).parent.parent.parent
    return (
        os.path.join(project_root, "ai_output", "finance", "cleaned_transactions.xlsx"),
        os.path.join(project_root, "ai_output", "finance", "financial_summary.xlsx")
    )

INPUT, OUTPUT = get_paths()

if not os.path.exists(INPUT):
    print(f"[ERROR] 找不到輸入檔案：{INPUT}")
    print("        請先執行 stage2_clean_data.py")
    sys.exit(1)

df = pd.read_excel(INPUT)
df["Amount"] = pd.to_numeric(df["Amount"], errors="coerce")

expenses = df[df["Type"] == "Expense"].copy()
revenues = df[df["Type"] == "Revenue"].copy()

# ── 1. KPI 總覽 ─────────────────────────────────────────────────────────────
total_rev  = revenues["Amount"].sum()
total_exp  = expenses["Amount"].abs().sum()
net_income = total_rev - total_exp
exp_ratio  = total_exp / total_rev * 100 if total_rev else 0

kpi_df = pd.DataFrame([
    {"指標": "Q1 總收入",    "金額 (USD)": round(total_rev, 2),  "說明": "所有 Revenue 交易合計"},
    {"指標": "Q1 總支出",    "金額 (USD)": round(total_exp, 2),  "說明": "所有 Expense 交易合計（絕對值）"},
    {"指標": "Q1 淨利",      "金額 (USD)": round(net_income, 2), "說明": "總收入 – 總支出"},
    {"指標": "費用率",        "金額 (USD)": round(exp_ratio, 2),  "說明": "總支出 / 總收入 × 100%"},
    {"指標": "收入交易筆數",  "金額 (USD)": len(revenues),        "說明": ""},
    {"指標": "支出交易筆數",  "金額 (USD)": len(expenses),        "說明": ""},
])

# ── 2. 部門別收支 ────────────────────────────────────────────────────────────
exp_by_dept = (
    expenses.groupby("Department")["Amount"]
    .apply(lambda x: x.abs().sum())
    .reset_index()
    .rename(columns={"Amount": "支出合計 (USD)"})
    .sort_values("支出合計 (USD)", ascending=False)
)

rev_by_dept = (
    revenues.groupby("Department")["Amount"]
    .sum()
    .reset_index()
    .rename(columns={"Amount": "收入合計 (USD)"})
)

dept_df = pd.merge(exp_by_dept, rev_by_dept, on="Department", how="outer").fillna(0)
dept_df["淨收支 (USD)"] = dept_df.get("收入合計 (USD)", 0) - dept_df["支出合計 (USD)"]
dept_df = dept_df.round(2)

# ── 3. 月份別趨勢 ────────────────────────────────────────────────────────────
exp_monthly = (
    expenses.groupby("Month")["Amount"]
    .apply(lambda x: x.abs().sum())
    .reset_index()
    .rename(columns={"Amount": "支出 (USD)"})
)
rev_monthly = (
    revenues.groupby("Month")["Amount"]
    .sum()
    .reset_index()
    .rename(columns={"Amount": "收入 (USD)"})
)
monthly_df = pd.merge(rev_monthly, exp_monthly, on="Month", how="outer").fillna(0)
monthly_df["淨利 (USD)"] = monthly_df["收入 (USD)"] - monthly_df["支出 (USD)"]
monthly_df = monthly_df.sort_values("Month").round(2)

# ── 4. 費用類別排名 ──────────────────────────────────────────────────────────
cat_df = (
    expenses.groupby("Category")["Amount"]
    .apply(lambda x: x.abs().sum())
    .reset_index()
    .rename(columns={"Amount": "支出合計 (USD)"})
    .sort_values("支出合計 (USD)", ascending=False)
    .reset_index(drop=True)
)
cat_df.index += 1
cat_df["佔總支出 %"] = (cat_df["支出合計 (USD)"] / total_exp * 100).round(2)

# ── 5. 收入來源結構 ──────────────────────────────────────────────────────────
rev_cat_df = (
    revenues.groupby("Category")["Amount"]
    .sum()
    .reset_index()
    .rename(columns={"Amount": "收入合計 (USD)"})
    .sort_values("收入合計 (USD)", ascending=False)
    .reset_index(drop=True)
)
rev_cat_df.index += 1
rev_cat_df["佔總收入 %"] = (rev_cat_df["收入合計 (USD)"] / total_rev * 100).round(2)

# ── 寫出多工作表 Excel ───────────────────────────────────────────────────────
with pd.ExcelWriter(OUTPUT, engine="openpyxl") as writer:
    kpi_df.to_excel(writer,     sheet_name="KPI 總覽",    index=False)
    dept_df.to_excel(writer,    sheet_name="部門別收支",  index=False)
    monthly_df.to_excel(writer, sheet_name="月份別趨勢",  index=False)
    cat_df.to_excel(writer,     sheet_name="費用類別排名", index=True, index_label="排名")
    rev_cat_df.to_excel(writer, sheet_name="收入來源結構", index=True, index_label="排名")

print("=" * 55)
print("Stage 3：財務分析完成")
print("=" * 55)
print(f"  Q1 總收入   : USD {total_rev:>15,.2f}")
print(f"  Q1 總支出   : USD {total_exp:>15,.2f}")
print(f"  Q1 淨利     : USD {net_income:>15,.2f}")
print(f"  費用率      : {exp_ratio:.1f}%")
print(f"  分析工作表  : KPI總覽 / 部門別收支 / 月份別趨勢 / 費用類別 / 收入來源")
print(f"  輸出路徑    : {OUTPUT}")
