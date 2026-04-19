"""
【工具 A】Q1 原始財務交易資料產生器
製作者：財務部門 (Finance Team)

用途：模擬科技公司 2024 Q1 的原始帳務資料，
      包含收入（訂閱、授權、服務）與支出（雲端、授權、差旅等），
      刻意摻入 4 筆髒資料，供後續清洗階段使用。

輸入：無（資料由程式隨機產生）
輸出：~/ai_output/finance/raw_transactions.xlsx
"""
import os
import random
from datetime import datetime, timedelta

import pandas as pd
from dotenv import load_dotenv
from pathlib import Path

# 載入 .env 設定
load_dotenv(Path(__file__).parent.parent.parent / "backend" / ".env")

# ── 輸出路徑 ────────────────────────────────────────────────────────────────
def get_output_path():
    # 1. 優先使用主程式動態注入的路徑 (包含工作流名稱)
    env_run_dir = os.getenv("PIPELINE_OUTPUT_DIR")
    if env_run_dir:
        return os.path.join(env_run_dir, "raw_transactions.xlsx")

    # 2. 次優先從環境變數讀取全局輸出根目錄
    base_path = os.getenv("OUTPUT_BASE_PATH")
    if base_path:
        if not os.path.isabs(base_path):
             base_path = os.path.join(Path(__file__).parent.parent.parent, base_path)
        return os.path.join(base_path, "finance", "raw_transactions.xlsx")
    
    # 3. 預設：專案根目錄/ai_output/finance
    project_root = Path(__file__).parent.parent.parent
    return os.path.join(project_root, "ai_output", "finance", "raw_transactions.xlsx")

OUTPUT = get_output_path()
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

random.seed(42)

DEPTS    = ["Engineering", "Sales", "Marketing", "HR", "Finance", "Operations"]
EXP_CAT  = ["Cloud Services", "Software License", "Hardware", "Travel",
             "Office Supplies", "Training", "Consulting", "Marketing Campaign"]
REV_TYPE = ["Product License", "SaaS Subscription", "Professional Services",
             "Support Contract", "Custom Development"]
VENDORS  = ["AWS", "Microsoft Azure", "Google Cloud", "Salesforce", "Oracle",
             "Adobe", "Zoom", "Slack", "Atlassian", "HubSpot", "DataDog", "GitHub"]
CLIENTS  = ["Acme Corp", "TechStart Inc", "GlobalTrade Co", "NexaMedia",
             "FinEdge Ltd", "SmartLogistics", "HealthBridge", "EduCloud"]

START = datetime(2024, 1, 1)
rows = []

# 支出 300 筆
for i in range(300):
    cat  = random.choice(EXP_CAT)
    dept = random.choice(DEPTS)
    date = START + timedelta(days=random.randint(0, 90))
    amt_map = {
        "Cloud Services": (500, 80000),
        "Software License": (1000, 50000),
        "Marketing Campaign": (10000, 150000),
        "Consulting": (5000, 50000),
    }
    lo, hi = amt_map.get(cat, (100, 15000))
    rows.append({
        "Transaction_ID": f"EXP{i+1:04d}",
        "Date":           date.strftime("%Y-%m-%d"),
        "Department":     dept,
        "Type":           "Expense",
        "Category":       cat,
        "Amount":         -round(random.uniform(lo, hi), 2),
        "Vendor":         random.choice(VENDORS),
        "Customer":       "",
        "Status":         random.choices(["Approved","Pending","Rejected"], weights=[78,17,5])[0],
        "Description":    f"{cat} – {dept}",
    })

# 收入 200 筆
for i in range(200):
    rev  = random.choice(REV_TYPE)
    date = START + timedelta(days=random.randint(0, 90))
    amt_map = {
        "SaaS Subscription": (2000, 30000),
        "Custom Development": (50000, 300000),
        "Product License": (10000, 200000),
    }
    lo, hi = amt_map.get(rev, (5000, 80000))
    rows.append({
        "Transaction_ID": f"REV{i+1:04d}",
        "Date":           date.strftime("%Y-%m-%d"),
        "Department":     "Sales",
        "Type":           "Revenue",
        "Category":       rev,
        "Amount":         round(random.uniform(lo, hi), 2),
        "Vendor":         "",
        "Customer":       random.choice(CLIENTS),
        "Status":         random.choices(["Approved","Pending"], weights=[90,10])[0],
        "Description":    f"{rev} – {random.choice(CLIENTS)}",
    })

# ── 髒資料（供 Stage 2 清洗用）──────────────────────────────────────────────
rows += [
    {"Transaction_ID":"ERR001","Date":"2024-13-01","Department":"Finance",
     "Type":"Expense","Category":"Cloud Services","Amount":-1200,
     "Vendor":"AWS","Customer":"","Status":"Approved","Description":"無效日期"},
    {"Transaction_ID":"ERR002","Date":"2024-02-20","Department":None,
     "Type":"Expense","Category":"Travel","Amount":-800,
     "Vendor":"","Customer":"","Status":"Approved","Description":"缺失部門"},
    {"Transaction_ID":"EXP0001","Date":"2024-01-05","Department":"Engineering",
     "Type":"Expense","Category":"Cloud Services","Amount":-5000,
     "Vendor":"AWS","Customer":"","Status":"Approved","Description":"重複 ID"},
    {"Transaction_ID":"ERR003","Date":"2024-03-10","Department":"HR",
     "Type":"Expense","Category":"Training","Amount":0,
     "Vendor":"Coursera","Customer":"","Status":"Approved","Description":"金額為零"},
]

df = pd.DataFrame(rows)
df.to_excel(OUTPUT, index=False)

print("=" * 55)
print("Stage 1：原始財務資料產生完成")
print("=" * 55)
print(f"  總筆數      : {len(df)}")
print(f"  收入交易    : {(df['Type']=='Revenue').sum()} 筆")
print(f"  支出交易    : {(df['Type']=='Expense').sum()} 筆")
print(f"  含髒資料    : 4 筆（無效日期/缺失部門/重複ID/零金額）")
print(f"  輸出路徑    : {OUTPUT}")
