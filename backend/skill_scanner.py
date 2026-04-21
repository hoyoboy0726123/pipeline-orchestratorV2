"""
掃描使用者的 Claude Code skill 目錄（~/.agents/skills/），
列出可用的 skill 名稱、描述與子資源。
"""
from pathlib import Path
from typing import Optional
import re
import ast
import json


SKILLS_ROOT = Path.home() / ".agents" / "skills"

# Python 內建模組（不需要 pip install）— 動態用 sys.stdlib_module_names 取得，
# 相容 Python 3.10+；失敗時 fallback 到寫死清單
try:
    import sys as _sys
    _STDLIB_MODULES = set(_sys.stdlib_module_names)  # Python 3.10+
except AttributeError:
    _STDLIB_MODULES = {
        "os", "sys", "re", "json", "math", "random", "time", "datetime", "pathlib",
        "subprocess", "shutil", "glob", "io", "csv", "hashlib", "urllib", "http",
        "collections", "itertools", "functools", "typing", "dataclasses", "enum",
        "abc", "argparse", "asyncio", "logging", "traceback", "threading", "queue",
        "multiprocessing", "concurrent", "socket", "struct", "copy", "pickle",
        "base64", "uuid", "tempfile", "warnings", "inspect", "textwrap", "string",
        "unicodedata", "zipfile", "tarfile", "gzip", "bz2", "sqlite3", "xml", "html",
        "email", "mimetypes", "platform", "operator", "contextlib", "types",
        "weakref", "gc", "atexit", "signal", "fnmatch", "select", "webbrowser",
    }

# 常見 import 名稱 → pip 套件名稱的對應（名稱不一致的情況）
_PIP_NAME_MAP = {
    "PIL": "Pillow",
    "cv2": "opencv-python",
    "bs4": "beautifulsoup4",
    "sklearn": "scikit-learn",
    "yaml": "PyYAML",
    "dotenv": "python-dotenv",
    "docx": "python-docx",
    "pptx": "python-pptx",
    "magic": "python-magic",
    "fitz": "PyMuPDF",
    "win32gui": "pywin32",
    "win32con": "pywin32",
    "win32api": "pywin32",
}


def _parse_frontmatter(skill_md_path: Path) -> dict:
    """從 SKILL.md 讀取 YAML frontmatter 的 name / description。"""
    result = {"name": "", "description": ""}
    try:
        text = skill_md_path.read_text(encoding="utf-8")
    except Exception:
        return result
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not m:
        return result
    fm = m.group(1)
    # 優先用 PyYAML 解析（穩，能處理 block scalar / 引號）
    try:
        import yaml as _yaml
        parsed = _yaml.safe_load(fm) or {}
        if isinstance(parsed, dict):
            result["name"] = str(parsed.get("name", "")).strip()
            desc = str(parsed.get("description", "")).strip()
            # 多行描述壓成單行
            desc = re.sub(r"\s+", " ", desc)
            result["description"] = desc
            return result
    except Exception:
        pass
    # Fallback：regex（YAML 不可用時的備援）
    name_m = re.search(r"^name:\s*(.+)$", fm, re.MULTILINE)
    desc_m = re.search(r"^description:\s*(.+?)(?=\n[a-zA-Z_]+:|\Z)", fm, re.MULTILINE | re.DOTALL)
    if name_m:
        result["name"] = name_m.group(1).strip().strip('"\'')
    if desc_m:
        desc = desc_m.group(1).strip().strip('"\'')
        desc = re.sub(r"\s+", " ", desc)
        result["description"] = desc
    return result


def list_available_skills() -> list[dict]:
    """
    掃 ~/.agents/skills/ 下每個子資料夾，回傳 skill 清單。

    每筆格式：
    {
        "name": "skill-creator",
        "display_name": "Skill Creator",
        "description": "Create new skills...",
        "path": "C:/Users/.../skill-creator",
        "has_scripts": True,
        "has_references": True,
        "has_assets": False,
    }
    """
    if not SKILLS_ROOT.exists():
        return []

    skills = []
    for entry in sorted(SKILLS_ROOT.iterdir()):
        if not entry.is_dir():
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.exists():
            continue
        meta = _parse_frontmatter(skill_md)
        skills.append({
            "name": meta["name"] or entry.name,
            "display_name": entry.name,
            "description": meta["description"],
            "path": str(entry.absolute()),
            "has_scripts": (entry / "scripts").is_dir(),
            "has_references": (entry / "references").is_dir(),
            "has_assets": (entry / "assets").is_dir(),
            "has_package_json": (entry / "package.json").is_file(),
            "has_requirements": (entry / "requirements.txt").is_file(),
        })
    return skills


def _resolve_skill_dir(skill_name: str) -> Optional[Path]:
    """從 skill_name（資料夾名或 frontmatter 的 name）找到 skill 資料夾。"""
    if not SKILLS_ROOT.exists():
        return None
    for entry in SKILLS_ROOT.iterdir():
        if not entry.is_dir():
            continue
        if entry.name == skill_name:
            return entry
    for entry in SKILLS_ROOT.iterdir():
        if not entry.is_dir():
            continue
        meta = _parse_frontmatter(entry / "SKILL.md")
        if meta["name"] == skill_name:
            return entry
    return None


def _extract_py_imports(py_file: Path) -> set[str]:
    """用 AST 解析 .py 檔抽出所有 top-level import 模組名。"""
    names: set[str] = set()
    try:
        src = py_file.read_text(encoding="utf-8")
    except Exception:
        return names
    try:
        tree = ast.parse(src)
    except Exception:
        return names
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                names.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                names.add(node.module.split(".")[0])
    return names


# 常見系統 CLI 工具：被提及在 SKILL.md 即認定為外部依賴（使用者需自行安裝）
_KNOWN_SYSTEM_TOOLS = {
    "soffice": "LibreOffice",
    "libreoffice": "LibreOffice",
    "pdftoppm": "Poppler",
    "pdftocairo": "Poppler",
    "pdfinfo": "Poppler",
    "ffmpeg": "FFmpeg",
    "ffprobe": "FFmpeg",
    "imagemagick": "ImageMagick",
    "convert": "ImageMagick",
    "magick": "ImageMagick",
    "tesseract": "Tesseract OCR",
    "wkhtmltopdf": "wkhtmltopdf",
    "pandoc": "Pandoc",
    "git": "Git",
    "node": "Node.js",
    "npm": "Node.js/npm",
    "npx": "Node.js/npm",
    "docker": "Docker",
}


_NPM_CACHE: dict = {"ts": 0.0, "data": set()}
_NPM_CACHE_TTL = 60.0


def list_global_npm_packages(force_refresh: bool = False) -> set[str]:
    """跑 `npm list -g --depth=0 --json` 取得目前全域安裝的 npm 套件名（小寫）。
    有 60 秒記憶體快取；找不到 npm 或執行失敗時回傳空集合。"""
    import time as _time
    import subprocess
    import shutil as _shutil

    if not force_refresh and (_time.time() - _NPM_CACHE["ts"]) < _NPM_CACHE_TTL and _NPM_CACHE["data"]:
        return _NPM_CACHE["data"]

    npm_cmd = _shutil.which("npm")
    if not npm_cmd:
        _NPM_CACHE["ts"] = _time.time()
        _NPM_CACHE["data"] = set()
        return set()
    try:
        proc = subprocess.run(
            [npm_cmd, "list", "-g", "--depth=0", "--json"],
            capture_output=True, text=True, timeout=10, encoding="utf-8", errors="ignore",
        )
        data = json.loads(proc.stdout or "{}")
        deps = data.get("dependencies") or {}
        result = {name.lower() for name in deps.keys()}
    except Exception:
        result = set()
    _NPM_CACHE["ts"] = _time.time()
    _NPM_CACHE["data"] = result
    return result


def _parse_install_commands(text: str) -> tuple[list[str], list[str], list[str]]:
    """
    掃描 markdown 文字裡的依賴提示，回傳：
    - pip 套件（來自 `pip install X` / `pip install "X[extra]"` 等）
    - npm 套件（來自 `npm install X` / `npm install -g X`）
    - 系統工具（來自反引號包住的 CLI 名稱 + 已知工具清單比對）
    """
    pip_pkgs: list[str] = []
    npm_pkgs: list[str] = []
    system_tools: set[str] = set()

    # pip install：抓每條 install 指令後面的所有套件名（允許引號、extras、版本）
    # 範例匹配："pip install pandas", 'pip install "markitdown[pptx]"', "pip install -U foo bar"
    for m in re.finditer(r"\bpip\s+install\s+([^\n`]+)", text, re.IGNORECASE):
        args = m.group(1)
        for tok in re.findall(r'"([^"]+)"|\'([^\']+)\'|(\S+)', args):
            pkg = next(filter(None, tok), "")
            if not pkg or pkg.startswith("-"):
                continue
            # 略過 install 自己的子命令/路徑（--user, -U, requirements.txt 等）
            if pkg in ("install", "pip") or pkg.startswith("."):
                continue
            if pkg.endswith(".txt"):
                continue
            pip_pkgs.append(pkg)

    # npm install：同上
    for m in re.finditer(r"\bnpm\s+install\s+([^\n`]+)", text, re.IGNORECASE):
        args = m.group(1)
        for tok in re.findall(r'"([^"]+)"|\'([^\']+)\'|(\S+)', args):
            pkg = next(filter(None, tok), "")
            if not pkg or pkg.startswith("-"):
                continue
            if pkg in ("install", "npm"):
                continue
            npm_pkgs.append(pkg)

    # 系統工具：只認反引號包住的（`soffice`、`pdftoppm`）或括號內的（(`magick`)）
    # 避免匹配到英文敘述裡的普通單字（例如 "Convert slides" 不該認作 ImageMagick）
    for tool_name, display in _KNOWN_SYSTEM_TOOLS.items():
        if re.search(rf"`{re.escape(tool_name)}`", text, re.IGNORECASE):
            system_tools.add(display)

    # 去重但保留順序
    pip_pkgs = list(dict.fromkeys(pip_pkgs))
    npm_pkgs = list(dict.fromkeys(npm_pkgs))
    return pip_pkgs, npm_pkgs, sorted(system_tools)


def _scan_markdown_dependencies(skill_dir: Path) -> tuple[list[str], list[str], list[str]]:
    """讀 skill 根目錄的所有 .md 檔（SKILL.md + references/），合併依賴提示。"""
    all_pip: list[str] = []
    all_npm: list[str] = []
    all_sys: set[str] = set()
    md_files = list(skill_dir.glob("*.md"))
    ref_dir = skill_dir / "references"
    if ref_dir.is_dir():
        md_files.extend(ref_dir.glob("*.md"))
    for md in md_files:
        try:
            text = md.read_text(encoding="utf-8")
        except Exception:
            continue
        pip_pkgs, npm_pkgs, sys_tools = _parse_install_commands(text)
        all_pip.extend(pip_pkgs)
        all_npm.extend(npm_pkgs)
        all_sys.update(sys_tools)
    return (
        list(dict.fromkeys(all_pip)),
        list(dict.fromkeys(all_npm)),
        sorted(all_sys),
    )


def scan_skill_dependencies(skill_name: str) -> dict:
    """
    掃描指定 skill 的依賴，回傳：
    {
        "skill_name": "...",
        "found": true,
        "python": {
            "requirements_txt": ["pandas>=1.0", ...],       # requirements.txt 原文
            "imports_detected": ["pandas", "openpyxl", ...], # 從 .py 檔靜態分析
            "suggested_pip": ["pandas", "openpyxl", ...],    # 推薦安裝的 pip 套件（排除 stdlib）
        },
        "node": {
            "package_json": {"dependencies": {...}, "devDependencies": {...}} or null,
            "needs_npm_install": true/false,
        },
    }
    """
    skill_dir = _resolve_skill_dir(skill_name)
    if skill_dir is None:
        return {"skill_name": skill_name, "found": False}

    # ── Python 依賴 ──────────────────────────────────────
    requirements_txt: list[str] = []
    req_file = skill_dir / "requirements.txt"
    if req_file.is_file():
        try:
            for line in req_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    requirements_txt.append(line)
        except Exception:
            pass

    # 靜態分析所有 .py 檔的 import
    imports_detected: set[str] = set()
    for py_file in skill_dir.rglob("*.py"):
        imports_detected.update(_extract_py_imports(py_file))

    # 排除 stdlib + skill 自家模組（所有 .py 檔名 + skill 底下所有層級的資料夾名）
    local_module_names = {f.stem for f in skill_dir.rglob("*.py")}
    for d in skill_dir.rglob("*"):
        if d.is_dir() and not d.name.startswith(".") and d.name != "__pycache__":
            local_module_names.add(d.name)
    third_party = sorted(
        imp for imp in imports_detected
        if imp not in _STDLIB_MODULES and imp not in local_module_names and not imp.startswith("_")
    )
    suggested_pip_from_imports = [_PIP_NAME_MAP.get(m, m) for m in third_party]

    # ── 從 SKILL.md 與參考 .md 文字中抽出 pip / npm / 系統工具 ──
    md_pip, md_npm, system_tools = _scan_markdown_dependencies(skill_dir)

    # 合併 pip：優先 requirements.txt → 程式 import → markdown
    suggested_pip: list[str] = []
    for pkg in requirements_txt + suggested_pip_from_imports + md_pip:
        base = re.split(r"[<>=!~\[]", pkg)[0].strip()
        if base and pkg not in suggested_pip:
            suggested_pip.append(pkg)

    # ── Node.js 依賴 ─────────────────────────────────────
    package_json = None
    pkg_file = skill_dir / "package.json"
    if pkg_file.is_file():
        try:
            package_json = json.loads(pkg_file.read_text(encoding="utf-8"))
        except Exception:
            package_json = None

    # 合併 npm：package.json 的 dependencies + markdown 提示
    suggested_npm: list[str] = list(md_npm)
    if isinstance(package_json, dict):
        for key in ("dependencies", "devDependencies"):
            deps = package_json.get(key) or {}
            if isinstance(deps, dict):
                for name in deps:
                    if name not in suggested_npm:
                        suggested_npm.append(name)

    return {
        "skill_name": skill_name,
        "found": True,
        "path": str(skill_dir.absolute()),
        "python": {
            "requirements_txt": requirements_txt,
            "imports_detected": sorted(imports_detected),
            "suggested_pip": suggested_pip,
        },
        "node": {
            "package_json": package_json,
            "needs_npm_install": package_json is not None or bool(md_npm),
            "suggested_npm": suggested_npm,
        },
        "system_tools": system_tools,
    }


def get_skill_prompt_injection(skill_name: str) -> Optional[str]:
    """
    給定 skill 名稱（資料夾名），回傳要注入 LLM system prompt 的文字：
    - SKILL.md 全文
    - 子資源清單（scripts/references/assets）

    找不到則回 None。
    """
    skill_dir = _resolve_skill_dir(skill_name)
    if skill_dir is None:
        return None

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return None

    md_text = skill_md.read_text(encoding="utf-8")

    # 列出可用腳本
    scripts_lines: list[str] = []
    scripts_dir = skill_dir / "scripts"
    if scripts_dir.is_dir():
        for f in sorted(scripts_dir.iterdir()):
            if f.is_file() and f.suffix in (".py", ".sh"):
                scripts_lines.append(f"  - scripts/{f.name}")

    references_lines: list[str] = []
    ref_dir = skill_dir / "references"
    if ref_dir.is_dir():
        for f in sorted(ref_dir.iterdir()):
            if f.is_file():
                references_lines.append(f"  - references/{f.name}")

    assets_lines: list[str] = []
    assets_dir = skill_dir / "assets"
    if assets_dir.is_dir():
        for f in sorted(assets_dir.iterdir()):
            if f.is_file():
                assets_lines.append(f"  - assets/{f.name}")

    # 用 forward slash 讓 LLM 寫 Python 時不用處理 Windows escape
    abs_path = str(skill_dir.absolute()).replace("\\", "/")

    parts = [
        f"\n\n【掛載 Skill：{skill_name}】",
        f"**Skill 根目錄**：`{abs_path}`",
        f"存取子資源時請使用絕對路徑（上方根目錄 + 子路徑）。",
    ]
    if scripts_lines:
        parts.append(f"\n**可執行腳本（scripts/）**：\n" + "\n".join(scripts_lines))
        parts.append(
            "呼叫方式：`subprocess.run([sys.executable, \"<scripts 絕對路徑>\", args...])` "
            "或 `sys.path.insert(0, \"<scripts 絕對路徑>\")` 再 import。"
        )
    if references_lines:
        parts.append(f"\n**參考文件（references/）**：\n" + "\n".join(references_lines))
        parts.append("需要更多資訊時用 read_file 工具讀取這些文件。")
    if assets_lines:
        parts.append(f"\n**資源檔案（assets/）**：\n" + "\n".join(assets_lines))

    parts.append(f"\n--- SKILL.md 內容開始 ---\n{md_text}\n--- SKILL.md 內容結束 ---")

    parts.append(
        "\n\n【Skill 使用原則】\n"
        "SKILL.md 是這個 skill 的**使用說明書與入口**。正確的使用流程：\n"
        "\n"
        "1. **先讀懂 SKILL.md 全文** — 理解這個 skill 設計來解決什麼問題、推薦的工作流程、有哪些步驟需要依序執行\n"
        "2. **依照 SKILL.md 的指引行動** — SKILL.md 會告訴你「什麼情境下讀哪個 references 文件」「什麼步驟要跑哪個 scripts 腳本」「哪些 assets 要引用」。你的決策應來自 SKILL.md，而非自己的猜測\n"
        "3. **按需讀取子資源** — 不用一次讀完所有 references / scripts，按 SKILL.md 的指引在**當下需要**時才用 read_file 讀\n"
        "\n"
        "**不要做這些事**：\n"
        "- 不要**憑 skill 名稱或描述猜測它的實作方式**。skill 可能用非直覺的技術路線完成任務（例如一個處理某格式的 skill，不一定使用該格式的同名 pip 套件；可能改用 CLI 工具、檔案解壓、API 呼叫等其他手段）\n"
        "- 不要**跳過 SKILL.md 直接自己寫程式碼** — 可能忽略了 skill 設計時納入的關鍵步驟、驗證邏輯、或錯誤處理\n"
        "- 不要**預期任何外部套件存在**。若 SKILL.md 或 scripts/ 未明示某套件是依賴，請以系統的「已安裝 Python 套件」清單為唯一根據\n"
        "\n"
        "**執行時的優先順序**（依序判斷）：\n"
        "1. 若 scripts/ 有合適的腳本 → 直接呼叫（已驗證過，比現場寫更可靠）\n"
        "2. 若 SKILL.md 或 references/ **指示使用特定工具或命令**（例如 Node.js、npm 套件、CLI 工具、其他語言的 subprocess 等非 Python 方案）→ **照 SKILL 推薦的方式執行，不要擅自改用 Python**。可用 `run_shell` 呼叫任何可執行指令\n"
        "3. 若 SKILL 沒指示特定工具 → 自行撰寫 Python，只用已安裝的套件\n"
        "4. 不確定工具或套件是否可用 → 先用 `run_shell` 檢查（如 `node -v`、`where <cmd>`、`pip show <pkg>`）後再決定，不要盲目嘗試\n"
        "\n"
        "**關於互動式指示**：\n"
        "若 SKILL.md 描述包含「詢問使用者」「讓使用者選擇」「ask the user」等互動步驟，\n"
        "可以呼叫 **ask_user 工具**（見下方），把問題丟給使用者回答。請遵守以下原則：\n"
        "- 任務描述已指定選項 → **不要問**，直接以任務描述為準\n"
        "- 選項是可推論的合理預設 → **不要問**，直接用預設並在 summary 說明假設\n"
        "- 只有在**會嚴重影響結果**且無法推論時才用 ask_user（例如「要以哪個使用者身份執行」「要處理哪份機密資料」）\n"
        "- ask_user 有次數上限，用完就不能再問。**請珍惜使用**\n"
        "\n"
        "【ask_user 工具】\n"
        "用法：\n"
        "<tool>ask_user</tool>\n"
        "<input>{\n"
        "  \"question\": \"要輸出哪種格式的報告？\",\n"
        "  \"options\": [\"PDF\", \"Word\", \"Markdown\"],\n"
        "  \"context\": \"資料共 120 筆，標題為中文\"\n"
        "}</input>\n"
        "\n"
        "- `question`（必填）：問題本身，用中文\n"
        "- `options`（選填）：選項陣列；若提供，使用者介面會顯示成按鈕。若為純文字回答則省略此欄\n"
        "- `context`（選填）：幫助使用者做決定的背景資訊\n"
        "\n"
        "使用者回答後，工具會回傳 `使用者回答：<答案>`，你再依答案繼續任務。若逾時或被取消則回傳錯誤提示，此時請以合理預設完成或呼叫 done(success=false)。"
    )

    return "\n".join(parts)
