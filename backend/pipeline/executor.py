"""
非同步子 process 執行器。

使用 asyncio.create_subprocess_shell，即時串流輸出到 logger，
支援 timeout 強制終止。

Skill 模式：LLM 解讀自然語言任務描述，自主撰寫並執行程式碼完成任務。
"""
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage, SystemMessage

from config import GROQ_API_KEY, GROQ_MODEL_MAIN

SKILL_TOOL_TIMEOUT = 60
SKILL_MAX_ITERATIONS = 15
ASK_USER_MAX = 3          # 一個 skill 節點最多 ask_user 次數
ASK_USER_TIMEOUT = 3600   # 單次等待使用者回答的逾時（秒）


# ── ask_user 進行中的問題：run_id -> {question, options, context, event, answer} ──
# In-memory：後端重啟會清空，使用者需重新觸發
_pending_questions: dict[str, dict] = {}


def deliver_ask_user_answer(run_id: str, answer: str) -> bool:
    """外部（resume_pipeline）呼叫：把答案送給正在等待的 skill agent。"""
    pending = _pending_questions.get(run_id)
    if not pending:
        return False
    pending["answer"] = answer
    pending["event"].set()
    return True


def get_pending_question(run_id: str) -> Optional[dict]:
    """查詢某 run 目前是否正在等 ask_user 答案。"""
    pending = _pending_questions.get(run_id)
    if not pending:
        return None
    return {
        "question": pending["question"],
        "options": pending["options"],
        "context": pending["context"],
    }

# ── Per-run subprocess tracking（for immediate abort）─────────────────────────
import threading

_proc_lock = threading.Lock()
_running_procs: dict[str, list] = {}  # run_id → list of (subprocess.Popen | asyncio.subprocess.Process)


def register_proc(run_id: str, proc):
    """註冊一個正在執行的子進程，供 abort 時立即 kill"""
    with _proc_lock:
        _running_procs.setdefault(run_id, []).append(proc)


def unregister_proc(run_id: str, proc):
    """反註冊子進程"""
    with _proc_lock:
        if run_id in _running_procs:
            try:
                _running_procs[run_id].remove(proc)
            except ValueError:
                pass
            if not _running_procs[run_id]:
                del _running_procs[run_id]


def kill_run_processes(run_id: str):
    """立即終止指定 run 的所有子進程"""
    with _proc_lock:
        procs = _running_procs.pop(run_id, [])
    for proc in procs:
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass

# Skill 模式需要的核心套件（探測用，從 skill_packages.txt 讀取）
def _load_skill_required_pkgs() -> tuple[str, ...]:
    pkg_file = Path(__file__).parent.parent / "skill_packages.txt"
    if pkg_file.exists():
        lines = pkg_file.read_text(encoding="utf-8").splitlines()
        pkgs = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]
        if pkgs:
            return tuple(pkgs[:3])  # 取前 3 個作為探測用
    return ("matplotlib", "pandas", "openpyxl")

_SKILL_REQUIRED_PKGS = _load_skill_required_pkgs()


def _detect_python_interpreter() -> str:
    """
    跨平台偵測最適合 Skill 模式的 Python 直譯器：
    1. 優先鎖定專案目錄下的 .venv (確保 AI 能看到 UI 安裝的套件)
    2. 其次使用環境變數 SKILL_PYTHON 指定的路徑
    3.Fallback 到系統路徑或其他位置
    """
    import sys
    from pathlib import Path
    
    # 強制優先檢查專案內的 .venv (backend/.venv)
    proj_venv = Path(__file__).parent.parent / ".venv"
    if os.name == "nt":
        venv_exe = proj_venv / "Scripts" / "python.exe"
    else:
        venv_exe = proj_venv / "bin" / "python"
        
    if venv_exe.exists():
        return str(venv_exe.absolute())

    override = os.getenv("SKILL_PYTHON")
    if override and Path(override).exists():
        return override

    candidates: list[str] = []
    is_windows = os.name == "nt"
    # Windows: python, py.exe, python.exe；Unix: python3, python
    probe_names = ("python", "py", "python.exe", "py.exe") if is_windows else ("python3", "python")
    for name in probe_names:
        p = shutil.which(name)
        if p and p not in candidates:
            candidates.append(p)
    # Unix 常見路徑（Windows 會自動 skip 因為 os.path.exists 回 False）
    if not is_windows:
        for p in ("/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"):
            if os.path.exists(p) and p not in candidates:
                candidates.append(p)
    if sys.executable and sys.executable not in candidates:
        candidates.append(sys.executable)

    test_code = "import " + ", ".join(_SKILL_REQUIRED_PKGS)
    for py in candidates:
        try:
            r = subprocess.run(
                [py, "-c", test_code],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0:
                return py
        except Exception:
            continue

    # 都不完整 → 退回第一個可用的；使用者會看到 ModuleNotFoundError，可自行 pip install
    if candidates:
        return candidates[0]
    return "python" if is_windows else "python3"


_SKILL_PYTHON = _detect_python_interpreter()
# Groq Free tier: 30 RPM → 每次 LLM 呼叫間隔至少 2 秒
SKILL_REQUEST_INTERVAL = 2.0
# 每 N 次 LLM 呼叫後強制冷卻（避免撞 TPM 上限）
SKILL_COOLDOWN_EVERY = 14
SKILL_COOLDOWN_SECONDS = 60


def _clean_env() -> dict:
    """移除 venv 對 PATH 的影響，並把 _SKILL_PYTHON 的目錄插到 PATH 最前面，
    確保 subprocess 內的 `python`/`python3` 都解析到有必要套件的 interpreter。
    """
    env = os.environ.copy()
    venv = env.pop("VIRTUAL_ENV", None)
    env.pop("PYTHONHOME", None)
    paths = env.get("PATH", "").split(os.pathsep)
    if venv:
        venv_bin = os.path.join(venv, "Scripts" if os.name == "nt" else "bin")
        paths = [p for p in paths if p != venv_bin]
    # 把 _SKILL_PYTHON 所在目錄放到 PATH 最前面
    global _SKILL_PYTHON
    skill_py = globals().get("_SKILL_PYTHON")
    if skill_py:
        skill_dir = os.path.dirname(skill_py)
        if skill_dir:
            paths = [p for p in paths if p != skill_dir]
            paths.insert(0, skill_dir)
    env["PATH"] = os.pathsep.join(paths)
    # 強制 stdout/stderr 用 UTF-8 編碼，避免 Windows cp1252/cp950 遇到中文 print() 炸出 UnicodeEncodeError
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"  # Python 3.7+ UTF-8 mode 全域啟用
    return env


import re as _re


_PY_CMD_RE = _re.compile(
    r'^(\s*)(python3|python|py)(\.exe)?(\s|$)',
    _re.IGNORECASE if os.name == "nt" else 0,
)


def _quote_path(path: str) -> str:
    """跨平台為含空格的路徑加引號。"""
    if os.name == "nt":
        return f'"{path}"' if (" " in path or "\t" in path) else path
    import shlex as _shlex
    return _shlex.quote(path)


def _rewrite_python_cmd(command: str) -> str:
    """把指令開頭的 python / python3 / py 換成 _SKILL_PYTHON（驗證過套件可用的 interpreter）。

    - 跨平台：Windows 用 py.exe/python.exe、Unix 用 python3/python
    - 只改最前面那顆，不動 pipe、&&、; 之後的
    - 不 re-tokenize 整個命令（避免反斜線路徑被破壞）
    """
    if not _SKILL_PYTHON:
        return command
    m = _PY_CMD_RE.match(command)
    if not m:
        return command
    prefix = m.group(1)
    trailing = m.group(4)
    rest = command[m.end():]
    return f"{prefix}{_quote_path(_SKILL_PYTHON)}{trailing}{rest}"


@dataclass
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str
    pending_recipe: Optional[dict] = None  # 延遲儲存的 recipe 資料
    missing_packages: list = None          # LLM 回報缺少的套件（供 runner 產生安裝建議）


async def execute_step(
    command: str,
    timeout: int,
    logger: logging.Logger,
    step_name: str,
    run_id: str = "",
    working_dir: Optional[str] = None,
) -> ExecResult:
    """
    執行 shell 命令，串流輸出到 logger，回傳完整結果。

    Args:
        command:     shell 命令字串
        timeout:     最大執行秒數
        logger:      file logger（記錄完整輸出）
        step_name:   用於 log 標籤
        run_id:      pipeline run id（用於立即中止追蹤）
        working_dir: 當前工作目錄（會注入 PIPELINE_OUTPUT_DIR）

    Returns:
        ExecResult(exit_code, stdout, stderr)
    """
    # 把指令開頭的 python / python3 / py 換成偵測到的可用 interpreter
    # （避免 shell 解析到 PATH 上沒裝必要套件的那顆 python）
    command = _rewrite_python_cmd(command)

    logger.info(f"[{step_name}] ▶ 開始執行：{command}")

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    # 準備環境變數
    env = _clean_env()
    if working_dir:
        # 強制將工作目錄注入環境變數，供腳本讀取
        env["PIPELINE_OUTPUT_DIR"] = str(Path(working_dir).absolute())

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        if run_id:
            register_proc(run_id, proc)

        async def _drain(stream: asyncio.StreamReader, buf: list[str], tag: str):
            while True:
                raw = await stream.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip()
                buf.append(line)
                logger.debug(f"[{step_name}][{tag}] {line}")

        try:
            await asyncio.wait_for(
                asyncio.gather(
                    _drain(proc.stdout, stdout_lines, "out"),
                    _drain(proc.stderr, stderr_lines, "err"),
                    proc.wait(),
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            logger.error(f"[{step_name}] ⏱ 執行超時（>{timeout}s），已強制終止")
            if run_id:
                unregister_proc(run_id, proc)
            return ExecResult(
                exit_code=-1,
                stdout="\n".join(stdout_lines),
                stderr=f"執行超時（>{timeout}s）",
            )

        if run_id:
            unregister_proc(run_id, proc)

        exit_code = proc.returncode if proc.returncode is not None else -99
        level = logging.INFO if exit_code == 0 else logging.WARNING
        logger.log(level, f"[{step_name}] ■ 結束，exit code: {exit_code}")

        return ExecResult(
            exit_code=exit_code,
            stdout="\n".join(stdout_lines),
            stderr="\n".join(stderr_lines),
        )

    except FileNotFoundError as e:
        logger.error(f"[{step_name}] 命令找不到：{e}")
        return ExecResult(exit_code=-2, stdout="", stderr=f"命令找不到：{e}")

    except Exception as e:
        logger.error(f"[{step_name}] 執行異常：{e}")
        return ExecResult(exit_code=-3, stdout="", stderr=str(e))


# ── Skill 模式執行器 ─────────────────────────────────────────────────────────

_DANGEROUS_COMMANDS = {'rm', 'rmdir', 'del', 'format', 'mkfs', 'dd', 'kill', 'shutdown', 'reboot'}

_skill_llm = None
_skill_llm_sig: Optional[str] = None


def _get_skill_llm():
    global _skill_llm, _skill_llm_sig
    from settings import settings_signature
    from llm_factory import build_llm
    sig = settings_signature()
    if _skill_llm is None or _skill_llm_sig != sig:
        _skill_llm = build_llm(temperature=0)
        _skill_llm_sig = sig
    return _skill_llm


def _skill_run_python(code: str, cwd: Optional[str] = None, run_id: str = "") -> str:
    """在 subprocess 中執行 Python 程式碼。"""
    # 截斷混入程式碼中的 <tool> 標籤（LLM 有時在 run_python 輸入末尾附加 <tool>done</tool>）
    tool_tag_pos = code.find('<tool>')
    if tool_tag_pos > 0:
        code = code[:tool_tag_pos].rstrip()
    # 注入 done / view_image / read_file 的 no-op stub，避免 LLM 把工具名當 Python 函式呼叫而崩潰
    # 另外抑制所有 warnings，避免 pandas FutureWarning 等雜訊污染 stderr 害 LLM 誤以為失敗
    # 第一行必須是 UTF-8 encoding 宣告（PEP 263）：即使我們用 UTF-8 寫檔，也保險讓 Python 明確識別
    preamble = (
        "# -*- coding: utf-8 -*-\n"
        "import warnings\n"
        "warnings.filterwarnings('ignore')\n"
        "def done(*args, **kwargs):\n"
        "    print('[info] done() is a tool, not a Python function - ignored in script context')\n"
        "def view_image(*args, **kwargs):\n"
        "    print('[info] view_image() is a tool, not a Python function - ignored')\n"
        "def read_file(*args, **kwargs):\n"
        "    print('[info] read_file() is a tool, not a Python function - ignored')\n"
    )
    code = preamble + code
    tmp_path = None
    proc = None
    try:
        # 必須明確指定 UTF-8 編碼，否則 Windows 會用系統 locale（cp950/cp1252）寫檔，
        # LLM 的程式碼只要含任何非該 locale 的字元（中文註解、em dash 等）就會產生
        # "Non-UTF-8 code starting with '\\xXX'" SyntaxError
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, encoding='utf-8') as f:
            f.write(code)
            tmp_path = f.name
        proc = subprocess.Popen(
            [_SKILL_PYTHON, tmp_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
            env=_clean_env(),
            cwd=cwd,
        )
        if run_id:
            register_proc(run_id, proc)
        try:
            stdout, stderr = proc.communicate(timeout=SKILL_TOOL_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return f"[錯誤] Python 執行超時（>{SKILL_TOOL_TIMEOUT}秒）"
        finally:
            if run_id and proc:
                unregister_proc(run_id, proc)
        output = ""
        if stdout:
            output += stdout
        if stderr:
            # 區分錯誤 vs 警告：exit code 0 + stderr 只有警告不該讓 LLM 以為失敗
            tag = "stderr" if proc.returncode != 0 else "warnings"
            output += f"\n[{tag}]\n{stderr}"
        if proc.returncode != 0:
            output += f"\n[exit code: {proc.returncode}]"
        elif not stdout:
            # 成功執行但沒輸出 → 明確告訴 LLM 任務已完成，避免誤以為失敗
            output += "\n[執行成功，程式無 stdout 輸出]"
        return output.strip() or "(無輸出)"
    except Exception as e:
        return f"[錯誤] Python 執行失敗：{e}"
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


def _skill_run_shell(cmd: str, cwd: Optional[str] = None, run_id: str = "") -> str:
    """執行 shell 命令。"""
    first_word = cmd.strip().split()[0] if cmd.strip() else ""
    if first_word in _DANGEROUS_COMMANDS:
        return f"[拒絕] 命令 '{first_word}' 被安全策略封鎖"
    # 把 python/python3/py 開頭的指令改用 _SKILL_PYTHON（有 pandas 等套件的 interpreter）
    cmd = _rewrite_python_cmd(cmd)
    proc = None
    try:
        proc = subprocess.Popen(
            cmd, shell=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
            env=_clean_env(),
            cwd=cwd,
        )
        if run_id:
            register_proc(run_id, proc)
        try:
            stdout, stderr = proc.communicate(timeout=SKILL_TOOL_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return f"[錯誤] 命令執行超時（>{SKILL_TOOL_TIMEOUT}秒）"
        finally:
            if run_id and proc:
                unregister_proc(run_id, proc)
        output = ""
        if stdout:
            output += stdout
        if stderr:
            output += f"\n[stderr]\n{stderr}"
        return output.strip()[:5000] or "(無輸出)"
    except Exception as e:
        return f"[錯誤] 命令執行失敗：{e}"


def _skill_read_file(path: str, max_lines: int = 100) -> str:
    """讀取檔案內容。"""
    try:
        # 清理 LLM 常見的錯誤格式：read_file("path"), 引號, 空白
        cleaned = path.strip()
        import re as _re
        m = _re.match(r'read_file\(["\']?(.+?)["\']?\)\s*$', cleaned)
        if m:
            cleaned = m.group(1)
        cleaned = cleaned.strip().strip('"').strip("'")
        p = Path(cleaned).expanduser()
        if not p.exists():
            return f"[錯誤] 檔案不存在：{path}"
        if p.is_dir():
            files = sorted(p.iterdir())[:30]
            listing = "\n".join(f"  {'📁' if f.is_dir() else '📄'} {f.name} ({f.stat().st_size:,} B)" for f in files)
            return f"目錄內容：\n{listing}"
        # 偵測二進制檔案，避免汙染 LLM context
        binary_exts = {'.xlsx', '.xls', '.docx', '.pptx', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.gz', '.tar', '.pkl', '.npy', '.parquet'}
        if p.suffix.lower() in binary_exts:
            size = p.stat().st_size
            return (f"[提示] {p.name} 是二進制檔案（{size:,} bytes），無法用 read_file 讀取。\n"
                    f"請改用 run_python 搭配適當的套件讀取：\n"
                    f"- .xlsx/.xls → pandas.read_excel() 或 openpyxl\n"
                    f"- .docx → python-docx\n"
                    f"- .png/.jpg → PIL 或 view_image 工具\n"
                    f"- .pdf → PyPDF2")
        with open(p, 'r', encoding='utf-8', errors='replace') as f:
            lines = []
            for i, line in enumerate(f):
                if i >= max_lines:
                    lines.append(f"... (截斷，超過 {max_lines} 行)")
                    break
                lines.append(line.rstrip())
        return "\n".join(lines) or "(空檔案)"
    except Exception as e:
        return f"[錯誤] 讀取失敗：{e}"


def _extract_code_block(text: str) -> Optional[str]:
    """從 markdown code block 中提取程式碼內容。"""
    m = re.search(r'```(?:python|json|bash|sh)?\s*\n(.*?)```', text, re.DOTALL)
    return m.group(1).strip() if m else None


def _sanitize_code(code: str) -> str:
    """清除混入程式碼中的 LLM 解釋文字（非 Python/Shell 語法的行）。"""
    lines = code.split('\n')
    # 找到第一行有效程式碼（import, from, def, class, #, 變量賦值, 函式呼叫等）
    code_pattern = re.compile(
        r'^(\s*(import |from |def |class |if |for |while |with |try:|except |'
        r'return |print|#|[a-zA-Z_]\w*\s*[=(]|plt\.|df\.|pd\.|np\.|sns\.|'
        r'\[|{|}|\]|\)|"|\'|$))'
    )
    start_idx = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if code_pattern.match(stripped):
            start_idx = i
            break
    # 從第一行有效程式碼開始，過濾掉純中文解釋行（不在字串內的非 ASCII 開頭行）
    result = []
    for line in lines[start_idx:]:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue
        # 如果整行以中文/全形字元開頭且不是 Python 字串或註解
        first_char = stripped[0]
        if ord(first_char) > 0x2E00 and not stripped.startswith('#') and not stripped.startswith(("'", '"')):
            continue  # 跳過純中文解釋行
        result.append(line)
    return '\n'.join(result).strip()


def _parse_skill_tool_calls(text: str) -> list[dict]:
    """
    解析 LLM 回覆中的工具呼叫。

    LLM 常見輸出格式：
    1. <tool>name</tool> <input>content</input>                     （標準）
    2. <tool>name</tool> ```python\ncode```                          （code block）
    3. <tool>name</tool> ```json\n{"key":"val"}```                   （json block）
    4. <tool>name</tool>\n直接跟隨程式碼或JSON                        （無標籤無block）
    5. ```python\n<tool>name</tool>\n<input>content</input>\n```     （整體在block內）

    關鍵：run_python/run_shell 的 input 只應包含可執行程式碼，
    不能混入 LLM 的解釋文字（會導致 SyntaxError）。
    """
    calls = []

    # ── Step 1：嘗試標準 <input>...</input> 格式 ──
    pattern_std = re.compile(r'<tool>(.*?)</tool>\s*<input>(.*?)</input>', re.DOTALL)
    for m in pattern_std.finditer(text):
        calls.append({"tool": m.group(1).strip(), "input": m.group(2).strip()})
    if calls:
        return calls

    # ── Step 2：找所有 code blocks，再找離 <tool> 最近的那個 ──
    # 先提取所有 code blocks 及其位置
    code_blocks = list(re.finditer(r'```(?:python|json|bash|sh)?\s*\n(.*?)```', text, re.DOTALL))
    # 找所有 <tool> 標籤
    tool_tags = list(re.finditer(r'<tool>(.*?)</tool>', text))

    for tag in tool_tags:
        tool_name = tag.group(1).strip()
        tag_start = tag.start()
        tag_end = tag.end()

        # 先找 tag 之後最近的 code block
        best_block = None
        for block in code_blocks:
            if block.start() >= tag_end:
                best_block = block
                break

        # 如果 tag 之後沒有 code block，往前找最近的（LLM 先放 code 再放 tag）
        if not best_block:
            for block in reversed(code_blocks):
                if block.end() <= tag_start:
                    best_block = block
                    break

        if best_block:
            content = best_block.group(1).strip()
            # 對 run_python 清洗混入的中文解釋
            if tool_name in ('run_python', 'run_shell'):
                content = _sanitize_code(content)
            if content and len(content) > 2:
                calls.append({"tool": tool_name, "input": content})
                return calls  # 一次只處理一個工具呼叫

    # ── Step 3：done 工具 — 找 JSON ──
    done_match = re.search(r'<tool>done</tool>', text)
    if done_match:
        # 在 done 標籤後找 JSON
        after_done = text[done_match.end():]
        json_match = re.search(r'\{.*?\}', after_done, re.DOTALL)
        if json_match:
            return [{"tool": "done", "input": json_match.group(0).strip()}]

    # ── Step 4：沒有 <tool> 標籤，但有 code block（LLM 忘記加標籤）──
    if not tool_tags and code_blocks:
        content = code_blocks[-1].group(1).strip()  # 取最後一個 code block
        # 猜測工具類型
        if content.startswith('{') and 'success' in content:
            return [{"tool": "done", "input": content}]
        elif content.startswith('{') and 'status' in content:
            return [{"tool": "done", "input": content}]

    # ── Step 5：fallback — 清除 code block 標記後找 raw content ──
    cleaned = re.sub(r'```(?:python|json|bash|sh)?\s*\n?', '', text)
    cleaned = cleaned.replace('```', '')

    pattern_raw = re.compile(r'<tool>(.*?)</tool>\s*(.+?)(?=<tool>|$)', re.DOTALL)
    for m in pattern_raw.finditer(cleaned):
        tool_name = m.group(1).strip()
        content = m.group(2).strip()
        if tool_name in ('run_python', 'run_shell'):
            content = _sanitize_code(content)
        if content and len(content) > 2:
            calls.append({"tool": tool_name, "input": content})
            break

    return calls


def _execute_skill_tool(tool_name: str, tool_input: str, cwd: Optional[str] = None, run_id: str = "") -> str:
    """執行單一工具。"""
    if tool_name == "run_python":
        return _skill_run_python(tool_input, cwd=cwd, run_id=run_id)
    elif tool_name == "run_shell":
        return _skill_run_shell(tool_input, cwd=cwd, run_id=run_id)
    elif tool_name == "read_file":
        return _skill_read_file(tool_input)
    elif tool_name == "done":
        return "__DONE__"
    else:
        return f"[錯誤] 未知工具：{tool_name}"


async def _wait_for_ask_user(
    run_id: str,
    question: str,
    options: list,
    context: str,
    logger: logging.Logger,
    step_name: str,
) -> Optional[str]:
    """
    把問題送出去（Pipeline 進 awaiting_human + Telegram/前端 推問題），
    in-memory 等待答案送達（asyncio.Event），或 timeout 回 None。
    """
    from pipeline.store import get_store
    store = get_store()
    run = store.load(run_id)
    if not run:
        logger.warning(f"[{step_name}] ask_user 失敗：找不到 run {run_id}")
        return None

    event = asyncio.Event()
    _pending_questions[run_id] = {
        "question": question,
        "options": options,
        "context": context,
        "event": event,
        "answer": None,
    }

    # 更新 run 狀態：進入 awaiting_human
    run.status = "awaiting_human"
    run.awaiting_type = "ask_user"
    run.awaiting_message = question
    run.awaiting_suggestion = json.dumps({"options": options, "context": context}, ensure_ascii=False)
    store.save(run)

    # 發通知（Telegram + 前端會 poll 到狀態變化）
    try:
        from pipeline.runner import _send_ask_user_notification
        await _send_ask_user_notification(run, question, options, context, step_name)
    except Exception as e:
        logger.warning(f"[{step_name}] ask_user 通知發送失敗：{e}")

    # 等待答案或 timeout
    logger.info(f"[{step_name}] ⏸ ask_user 等待中：{question}")
    try:
        await asyncio.wait_for(event.wait(), timeout=ASK_USER_TIMEOUT)
    except asyncio.TimeoutError:
        logger.warning(f"[{step_name}] ask_user 逾時（{ASK_USER_TIMEOUT}s）")
        _pending_questions.pop(run_id, None)
        # 恢復狀態（注意：可能其他邏輯已接手改狀態，這裡僅在仍為 ask_user 時清除）
        run2 = store.load(run_id)
        if run2 and run2.awaiting_type == "ask_user":
            run2.status = "running"
            run2.awaiting_type = ""
            run2.awaiting_message = ""
            run2.awaiting_suggestion = ""
            store.save(run2)
        return None

    answer = _pending_questions[run_id]["answer"]
    _pending_questions.pop(run_id, None)

    # 恢復 running 狀態
    run3 = store.load(run_id)
    if run3:
        run3.status = "running"
        run3.awaiting_type = ""
        run3.awaiting_message = ""
        run3.awaiting_suggestion = ""
        store.save(run3)

    logger.info(f"[{step_name}] ▶ ask_user 收到答案：{answer}")
    return answer


async def execute_step_with_skill(
    task_description: str,
    timeout: int,
    logger: logging.Logger,
    step_name: str,
    output_path: Optional[str] = None,
    working_dir: Optional[str] = None,
    prev_outputs: Optional[list] = None,
    pipeline_id: Optional[str] = None,
    use_recipe: bool = True,
    no_save_recipe: bool = False,
    readonly: bool = False,
    run_id: str = "",
    previous_failures: Optional[list] = None,
    recipe_step_key: Optional[str] = None,
    skill_name: str = "",
) -> ExecResult:
    """
    Skill 模式執行器：LLM 解讀自然語言任務描述，自主撰寫並執行程式碼。

    Args:
        task_description: 自然語言任務描述（取代 shell 命令）
        timeout:          最大執行秒數（整體 agent 迴圈）
        logger:           file logger
        step_name:        步驟名稱
        output_path:      預期輸出路徑（可選，讓 agent 知道要把結果存在哪）
        prev_outputs:     前幾步的輸出檔案資訊列表，格式 [{"path": "...", "schema": "..."}]
    """
    # 展開 ~ 為完整路徑
    if output_path:
        output_path = str(Path(output_path).expanduser())
    # 自動建立輸出路徑的父目錄和工作目錄
    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        # 刪除舊的 output 檔案，避免 done guard 被上次執行的殘留檔案騙過
        # Windows 上使用者若開著 Excel 檢視輸出，unlink 會 PermissionError
        # → 改成 rename 成 .stale-<timestamp>.bak 繞過鎖，並用 try/except 確保整個 step 不會因此卡死
        _out = Path(output_path)
        if _out.exists():
            logger.info(f"[{step_name}] 刪除舊輸出檔案：{output_path}")
            try:
                _out.unlink()
            except PermissionError as _e:
                import time as _t
                _bak = _out.with_suffix(_out.suffix + f".stale-{int(_t.time())}.bak")
                try:
                    _out.rename(_bak)
                    logger.warning(
                        f"[{step_name}] 舊輸出檔案被佔用（可能你在 Excel 開著），"
                        f"已改名為 {_bak.name} 讓這次執行繼續。請關閉 Excel 後手動清掉 .bak 檔。"
                    )
                except Exception as _e2:
                    # rename 也失敗（極少見，通常是檔案被獨佔）→ 讓使用者知道但不中斷
                    logger.warning(
                        f"[{step_name}] 無法刪除或改名舊輸出檔案（{_out.name}）：{_e2.__class__.__name__}。"
                        f"通常是 Excel / 其他程式正打開此檔。LLM 寫入時可能也會失敗，請先關閉該檔案再重跑。"
                    )
            except Exception as _e:
                logger.warning(f"[{step_name}] 刪除舊輸出檔案時發生錯誤：{_e}")
    if working_dir:
        Path(working_dir).mkdir(parents=True, exist_ok=True)

    logger.info(f"[{step_name}] 🔬 Skill 模式啟動：{task_description}")

    # ── Recipe Book：檢查是否有可重用的成功快取 ────────────────────────────
    _rkey = recipe_step_key or step_name  # recipe DB key（含索引，避免同名覆蓋）
    input_paths = [po["path"] for po in (prev_outputs or []) if po.get("path")]
    if pipeline_id and use_recipe:
        try:
            from db import get_recipe, match_recipe, save_recipe, mark_recipe_failed
            from pipeline.recipe import _sha1 as _recipe_sha1, _fingerprint_input as _recipe_fp
            # Debug: 先載入 recipe 看詳細匹配狀況
            _raw = get_recipe(pipeline_id, _rkey)
            if _raw:
                _cur_hash = _recipe_sha1(task_description)
                _cur_fps = {p: _recipe_fp(p) for p in input_paths}
                saved_fps = _raw["input_fingerprints"]
                if isinstance(saved_fps, str):
                    import json as _json
                    saved_fps = _json.loads(saved_fps)
                if _raw["disabled"]:
                    logger.info(f"[{step_name}] 📖 Recipe 存在但已停用")
                elif _raw["task_hash"] != _cur_hash:
                    logger.info(f"[{step_name}] 📖 Recipe 存在但 task_hash 不符（saved={_raw['task_hash']}, current={_cur_hash}）")
                elif _cur_fps != saved_fps:
                    logger.info(f"[{step_name}] 📖 Recipe 存在但輸入指紋不符")
                    for k in set(list(_cur_fps.keys()) + list(saved_fps.keys())):
                        sv = saved_fps.get(k, '(無)')
                        cv = _cur_fps.get(k, '(無)')
                        if sv != cv:
                            logger.info(f"[{step_name}]   {k}: saved={sv} → current={cv}")
            else:
                logger.debug(f"[{step_name}] 📖 無 Recipe 紀錄")
            _fp = {p: _recipe_fp(p) for p in input_paths}
            cached = match_recipe(pipeline_id, _rkey, _recipe_sha1(task_description), _fp)
            if cached:
                logger.info(
                    f"[{step_name}] 📖 找到快取 recipe (成功 {cached['success_count']} 次, "
                    f"平均 {cached['avg_runtime_sec']:.1f}s)，跳過 LLM 直接執行"
                )
                import time as _time
                t0 = _time.time()
                loop = asyncio.get_event_loop()
                tool_result = await loop.run_in_executor(
                    None, lambda: _skill_run_python(cached["code"], cwd=working_dir, run_id=run_id)
                )
                runtime = _time.time() - t0
                # 成功條件：輸出檔存在（若有指定）且無 [exit code: X]
                ok = "[exit code:" not in tool_result
                if ok and output_path:
                    ok = Path(output_path).exists()
                if ok:
                    import sys as _sys
                    save_recipe(pipeline_id, _rkey, _recipe_sha1(task_description),
                                _fp, output_path, cached["code"],
                                f"{_sys.version_info.major}.{_sys.version_info.minor}", runtime)
                    logger.info(f"[{step_name}] ✅ Recipe 重跑成功（{runtime:.1f}s）")
                    return ExecResult(exit_code=0, stdout=tool_result, stderr="__RECIPE_HIT__")
                else:
                    logger.warning(f"[{step_name}] Recipe 重跑失敗，改用 LLM 重新學習。輸出：{tool_result[:300]}")
                    mark_recipe_failed(pipeline_id, _rkey)
        except Exception as e:
            logger.warning(f"[{step_name}] Recipe 檢查失敗：{e}")
    # ───────────────────────────────────────────────────────────────────────

    system_prompt = """你是一個 pipeline 步驟的 Skill 執行 agent。
你的任務是根據使用者的自然語言描述，自主撰寫並執行程式碼來完成任務。

你有以下工具可用：

1. run_python — 執行 Python 程式碼（在工作目錄下執行）
   用法：<tool>run_python</tool>
   <input>
   import csv, random
   rows = [["date","amount","region"]]
   for i in range(120):
       rows.append([f"2024-{(i%12)+1:02d}-{(i%28)+1:02d}", round(random.uniform(10,500),2), ["北","中","南"][i%3]])
   with open("output.csv","w",newline="") as f:
       csv.writer(f).writerows(rows)
   print("完成")
   </input>

2. run_shell — 執行系統命令（在工作目錄下執行）
   用法：<tool>run_shell</tool>
   <input>wc -l output.csv</input>
   注意：盡量用 run_python 代替 run_shell，因為 Python 是跨平台的，Shell 命令在不同系統上可能不同。

3. read_file — 讀取檔案內容（路徑不要加引號）
   用法：<tool>read_file</tool>
   <input>path/to/some_file.txt</input>

4. done — 任務完成，回報結果
   用法：<tool>done</tool>
   <input>{"success": true, "summary": "簡述完成了什麼"}</input>
   
   如果失敗（僅在**已窮盡所有可用工具與方法**後才呼叫）：
   <tool>done</tool>
   <input>{
     "success": false,
     "error": "說明所有已嘗試的方法及各自失敗的原因，以及為什麼現有套件無法完成任務。",
     "missing_packages": ["可能解決問題但尚未安裝的套件A", "套件B"]
   }</input>
   注意：
   - **必須先在已安裝套件中嘗試所有可行的替代方案，確認全部失敗後，才能呼叫 done(success=false)**
   - missing_packages 只填入**目前未安裝**、但安裝後有合理機率解決問題的套件
   - 不要因為第一個方案失敗就放棄，要主動切換工具或策略繼續嘗試

【可用 Python 套件】
標準庫：csv, json, random, os, pathlib, re, math, datetime, io, collections, itertools, functools, glob, shutil, hashlib, urllib
已安裝的第三方套件：{installed_packages}

以上套件可直接 import 使用。如果任務需要其他未列出的套件，也可以直接 import，系統會自動偵測並提示用戶安裝。

【matplotlib 繪圖注意事項】
- 使用 matplotlib.pyplot 時，務必在最前面加 `import matplotlib; matplotlib.use('Agg')` 以避免 GUI 問題
- boxplot 的 `labels` 參數已在新版棄用，請改用 `tick_labels`
- 繪製分組箱形圖時，需要先將資料按分組欄位 pivot/reshape，再分別傳入各組資料
- 中文顯示：macOS 使用 'PingFang HK' 或 'Arial Unicode MS'；Windows 使用 'Microsoft JhengHei'（微軟正黑體）或 'SimHei'
  跨平台安全寫法：
  ```
  import matplotlib
  for font in ['PingFang HK', 'Microsoft JhengHei', 'SimHei', 'Arial Unicode MS']:
      try:
          matplotlib.font_manager.findfont(font, fallback_to_default=False)
          matplotlib.rcParams['font.family'] = font
          break
      except: pass
  ```
- 繪圖完成後務必呼叫 `plt.savefig(路徑, dpi=150, bbox_inches='tight')` 並 `plt.close()`

【重要規則】
- **嚴格遵守任務描述中指定的欄位名稱、檔案路徑、數值範圍等具體要求，不得自行更改**
- **所有檔案一律使用絕對路徑存取（根據工作目錄和輸出路徑提示）**
- **路徑處理：一律使用 `pathlib.Path` 或 `os.path.join` 組合路徑，不要用字串拼接 `/`**
- **只使用上方列出的已安裝套件，不要安裝新套件**
- **絕對不要執行 sudo、pip install、apt 等安裝命令**
- **要執行其他 Python 腳本時，必須用 `sys.executable` 而非寫死 `python3` 或 `python`，避免 PATH 解析到錯誤的 interpreter**
  正確：`subprocess.run([sys.executable, "script.py"], ...)`
  錯誤：`subprocess.run(["python3", "script.py"], ...)` 或 `subprocess.run(["python", "script.py"], ...)`
- **產生隨機資料時，確保需要唯一的欄位（如姓名）不會重複。正確做法：先用集合或列表生成所有不重複的組合，再用 random.sample 取出所需數量。錯誤做法：在迴圈中用 random.choice 逐一組合（會產生重複）**

【執行策略】
- **如果任務需要讀取其他檔案（CSV、Excel 等），第一步先用 run_python 讀取檔案的前幾行，確認實際欄位名稱**
- **確認欄位名稱後，再寫完整的處理程式碼**
- **不要猜測欄位名稱，一定要先確認**

【非互動式執行（重要）】
- **嚴禁在程式碼中使用 `input()`、`getpass()`、`sys.stdin.read()` 或任何會等待使用者輸入的函式 — Pipeline 是非互動環境，這些呼叫會造成永久卡死**
- 若任務需要做選擇，優先以任務描述中的指定為準；若無指定，選擇**最合理的預設值**並在 summary 中說明假設
- 只有當選擇會嚴重影響結果（例如會覆蓋重要檔案、無法回復的操作）才呼叫 `done(success=false)` 讓使用者補充後重跑

【重試策略（重要）】
- **如果上一次嘗試失敗，絕對不要用相同的方法重試**
- **每次重試前，先回顧對話歷史中已嘗試過的所有方法，選擇一個尚未使用過的不同套件或策略**
- **利用已安裝套件清單，系統性地找出所有能完成此任務的替代方案並逐一嘗試**
  - 例如：若 requests + beautifulsoup4 失敗，改試 urllib；若需要試不同的解析/處理策略，也要切換
  - 例如：若某種資料格式的讀取方法失敗，改試其他已安裝的相容套件
- **只有當已安裝的所有可行方案都已嘗試並全部失敗後，才呼叫 done(success=false)**
- **在呼叫 done(success=false) 時，missing_packages 填入安裝後可能解決問題的套件（必須是目前未安裝的）**

【最重要：正確的工具呼叫格式】
- **每次回覆只能包含一個工具呼叫，且所有程式碼必須完整放在 <tool> 和 <input> 標籤內**
- **絕對禁止在 markdown ``` 區塊展示程式碼後再用 <tool> 呼叫。你的回覆中不應包含 ``` 符號。**
- **正確做法：直接用 <tool>run_python</tool> 然後 <input>完整程式碼</input>**
- **錯誤做法：先用 ```python 展示程式碼，再用 <tool> 呼叫其他程式碼**
- **一個回覆中只能有一個 <tool>，後面跟一個 <input>**
- **把所有邏輯寫在一個 run_python 呼叫中，不要分成「先讀取再處理」兩個步驟**
- 如果執行結果有錯誤，嘗試修正並重試
- **絕對不要在 Python 程式碼裡呼叫 done(...)、view_image(...)、read_file(...) — 這些是工具名稱，不是 Python 函式！**
- **工具只能透過 <tool>工具名</tool><input>參數</input> 的格式呼叫，不能寫在 Python 程式碼中**
- **程式碼執行成功後，下一回覆直接用 <tool>done</tool><input>{"success": true, "summary": "..."}</input> 結束**
- 最後一定要呼叫 done 工具回報結果
- 用中文回覆 summary / error"""

    # 唯讀模式：注入禁止修改的約束
    if readonly:
        system_prompt += """

【🔒 唯讀驗證模式】
此步驟為「唯讀深度驗證」，你的職責是：
- **只能讀取、分析、檢查檔案內容**
- **嚴禁修改、覆寫、重新命名任何檔案或欄位**
- **嚴禁用程式碼「修正」資料來通過驗證**
- 如果檢查結果不符合預期 → 直接用 done 回報 success=false 並說明哪裡不符
- 如果檢查結果符合預期 → 用 done 回報 success=true 並說明驗證通過的理由
- **你只是驗證者，不是修復者**"""
        logger.info(f"[{step_name}] 🔒 唯讀驗證模式已啟用")

    # 掛載 skill：注入 SKILL.md 內容與子資源清單
    if skill_name:
        try:
            from skill_scanner import get_skill_prompt_injection
            skill_injection = get_skill_prompt_injection(skill_name)
            if skill_injection:
                system_prompt += skill_injection
                logger.info(f"[{step_name}] ✨ 已掛載 Skill：{skill_name}")
            else:
                logger.warning(f"[{step_name}] ⚠️ 找不到 Skill：{skill_name}（已略過）")
        except Exception as e:
            logger.warning(f"[{step_name}] ⚠️ 載入 Skill {skill_name} 失敗：{e}")

    output_hint = f"\n輸出路徑提示：請將結果存到 {output_path}" if output_path else ""
    wd_hint = f"\n工作目錄：{working_dir}（所有相對路徑都相對於此目錄，請使用絕對路徑存取檔案）" if working_dir else ""

    # 組合前步驟的輸出資訊
    prev_hint = ""
    if prev_outputs:
        lines = ["\n【前步驟產生的檔案（可直接讀取使用）】"]
        for po in prev_outputs:
            lines.append(f"- {po['path']}")
            if po.get("schema"):
                lines.append(f"  欄位/結構：{po['schema']}")
        prev_hint = "\n".join(lines)

    # ── 動態注入已安裝的第三方套件清單 ──
    pkg_file = Path(__file__).parent.parent / "skill_packages.txt"
    if pkg_file.exists():
        pkg_lines = [l.strip() for l in pkg_file.read_text(encoding="utf-8").splitlines()
                     if l.strip() and not l.strip().startswith("#")]
        system_prompt = system_prompt.replace("{installed_packages}", ", ".join(pkg_lines))
    else:
        system_prompt = system_prompt.replace("{installed_packages}", "pandas, openpyxl, matplotlib, requests, beautifulsoup4, Pillow, python-docx")

    # ── 注入前次失敗歷史（重試時） ──
    failures_hint = ""
    if previous_failures:
        logger.info(f"[{step_name}] 🔄 重試：注入 {len(previous_failures)} 條失敗歷史到 user_prompt")
        lines = ["\n\n【⚠️ 前次嘗試失敗記錄 — 本次必須改用不同方法】"]
        for f in previous_failures:
            lines.append(f"\n第 {f['attempt']} 次嘗試失敗：")
            lines.append(f"  失敗原因：{f['reason']}")
            if f.get("suggestion"):
                lines.append(f"  驗證建議：{f['suggestion']}")
            if f.get("stdout_tail"):
                lines.append(f"  程式輸出（尾段）：{f['stdout_tail'][:400]}")
            if f.get("stderr_tail"):
                lines.append(f"  錯誤訊息：{f['stderr_tail'][:200]}")
        lines.append("\n→ 請分析上方失敗原因，改用已安裝套件中尚未嘗試過的不同方法或套件來完成任務。")
        failures_hint = "\n".join(lines)
    else:
        logger.debug(f"[{step_name}] 初次執行（無失敗歷史）")

    user_prompt = f"""請完成以下任務：

{task_description}{output_hint}{wd_hint}{prev_hint}{failures_hint}

請直接使用 <tool>run_python</tool> 執行完整程式碼，不要用 markdown 展示。"""

    all_stdout: list[str] = []

    try:
        llm = _get_skill_llm()
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ]

        short_code_streak = 0  # 連續短程式碼計數器（偵測迴圈）
        last_error_sig = ""    # 上次錯誤簽名（偵測重複錯誤）
        same_error_count = 0   # 連續相同錯誤計數
        import time as _time
        skill_start_time = _time.time()
        last_successful_code: Optional[str] = None  # 供 Recipe Book 儲存：只記最後一段成功的 run_python
        ask_user_count = 0               # ask_user 呼叫次數（上限 ASK_USER_MAX）
        was_interactive = False          # 首次互動標記（給 recipe）

        for iteration in range(SKILL_MAX_ITERATIONS):
            logger.info(f"[{step_name}] Skill 執行迭代 {iteration + 1}/{SKILL_MAX_ITERATIONS}")

            # 冷卻機制：每 SKILL_COOLDOWN_EVERY 次呼叫後暫停
            if iteration > 0 and iteration % SKILL_COOLDOWN_EVERY == 0:
                logger.info(f"[{step_name}] ⏸ 達到 {SKILL_COOLDOWN_EVERY} 次呼叫，冷卻 {SKILL_COOLDOWN_SECONDS} 秒...")
                await asyncio.sleep(SKILL_COOLDOWN_SECONDS)

            # 每次 LLM 呼叫間隔（避免撞 RPM 上限）
            if iteration > 0:
                await asyncio.sleep(SKILL_REQUEST_INTERVAL)

            from llm_factory import invoke_with_streaming
            reply = (await invoke_with_streaming(
                llm, messages, label=step_name, timeout=600.0, logger=logger
            )).strip()
            # 完整記錄 LLM 回覆（含程式碼），避免 log 截斷讓後續分析誤判
            _reply_preview = reply if len(reply) <= 4000 else reply[:4000] + f"...[已截斷，完整長度 {len(reply)} 字]"
            logger.debug(f"[{step_name}] Agent 回覆：\n{_reply_preview}")

            # 偵錯：如果 reply 包含 done，印出 done 附近的文字
            if 'done' in reply.lower():
                idx = reply.lower().index('done')
                snippet = reply[max(0, idx-80):idx+80]
                logger.info(f"[{step_name}] reply 含 'done'，上下文：…{snippet}…")

            tool_calls = _parse_skill_tool_calls(reply)

            if not tool_calls:
                # 沒有工具呼叫，提示 agent
                messages.append(HumanMessage(content=reply))
                messages.append(HumanMessage(content="請使用工具來執行任務，或呼叫 done 回報結果。"))
                continue

            call = tool_calls[0]
            tool_name = call["tool"]
            tool_input = call["input"]
            logger.info(f"[{step_name}] 解析結果：tool={tool_name}, input_len={len(tool_input)}")

            # done → 結束（但先驗證 output 檔案是否存在）
            if tool_name == "done":
                try:
                    data = json.loads(tool_input)
                    success = data.get("success", False)
                    summary = data.get("summary", data.get("error", ""))

                    # 如果宣稱成功但 output 檔案不存在，拒絕 done 並要求實際執行
                    logger.debug(f"[{step_name}] done 檢查：success={success}, output_path={output_path}, exists={Path(output_path).exists() if output_path else 'N/A'}")
                    if success and output_path and not Path(output_path).exists():
                        logger.warning(f"[{step_name}] Agent 宣稱成功但輸出檔案 {output_path} 不存在，要求重新執行")
                        messages.append(HumanMessage(content=reply))
                        messages.append(HumanMessage(
                            content=f"[系統] 你宣稱成功但輸出檔案 {output_path} 不存在。"
                                    f"你必須使用 run_python 工具實際執行程式碼來產生檔案，"
                                    f"不能只展示程式碼。請使用 <tool>run_python</tool> 執行。"
                        ))
                        continue

                    all_stdout.append(f"[Skill 完成] {summary}")
                    logger.info(f"[{step_name}] Skill 執行完成：{'成功' if success else '失敗'} — {summary}")
                    # 成功 → 儲存 recipe 供下次快速重跑
                    _pending_recipe = None
                    if success and pipeline_id and last_successful_code:
                        try:
                            import sys as _sys2
                            from pipeline.recipe import _sha1 as _recipe_sha1, _fingerprint_input as _recipe_fp
                            runtime = _time.time() - skill_start_time
                            _fp = {}
                            for p in (input_paths or []):
                                _fp[str(p)] = _recipe_fp(p)
                            recipe_data = {
                                "pipeline_id": pipeline_id,
                                "step_name": _rkey,
                                "task_hash": _recipe_sha1(task_description),
                                "input_fingerprints": _fp,
                                "output_path": output_path,
                                "code": last_successful_code,
                                "python_version": f"{_sys2.version_info.major}.{_sys2.version_info.minor}",
                                "runtime_sec": runtime,
                                "was_interactive": was_interactive,
                            }
                            if no_save_recipe:
                                # 延遲模式：檢查是否已有 recipe
                                from db import get_recipe as _get_recipe, save_recipe as _db_save_recipe
                                existing = _get_recipe(pipeline_id, _rkey)
                                if existing:
                                    # 已有 recipe → 延遲儲存等用戶確認（避免覆蓋）
                                    _pending_recipe = recipe_data
                                    logger.info(f"[{step_name}] Recipe 已存在，延遲儲存等待確認")
                                else:
                                    # 無 recipe → 直接儲存（建立新的不算覆蓋）
                                    _db_save_recipe(
                                        pipeline_id, _rkey, recipe_data["task_hash"],
                                        _fp, output_path, last_successful_code,
                                        recipe_data["python_version"], runtime,
                                        was_interactive=was_interactive,
                                    )
                                    logger.info(f"[{step_name}] 首次建立 Recipe")
                            else:
                                from db import save_recipe as _db_save_recipe
                                _db_save_recipe(
                                    pipeline_id, _rkey, recipe_data["task_hash"],
                                    _fp, output_path, last_successful_code,
                                    recipe_data["python_version"], runtime,
                                    was_interactive=was_interactive,
                                )
                        except Exception as e:
                            logger.warning(f"[{step_name}] Recipe 儲存失敗：{e}")
                    pkgs = data.get("missing_packages", []) if not success else []
                    if pkgs:
                        logger.info(f"[{step_name}] LLM 回報缺少套件：{pkgs}")
                    return ExecResult(
                        exit_code=0 if success else 1,
                        stdout="\n".join(all_stdout),
                        stderr="" if success else summary,
                        pending_recipe=_pending_recipe,
                        missing_packages=pkgs or None,
                    )
                except json.JSONDecodeError:
                    messages.append(HumanMessage(content=reply))
                    messages.append(HumanMessage(content="[系統] done 的 input 必須是有效 JSON，請重試。"))
                    continue

            # ask_user → 暫停 pipeline，等待使用者回答（僅掛載 skill 時允許）
            if tool_name == "ask_user":
                if not skill_name:
                    tool_result = "[錯誤] ask_user 僅在掛載 skill 時可用。請自行以合理預設完成任務。"
                    messages.append(HumanMessage(content=reply))
                    messages.append(HumanMessage(content=f"[工具結果 — ask_user]\n{tool_result}"))
                    continue
                ask_user_count += 1
                if ask_user_count > ASK_USER_MAX:
                    tool_result = f"[錯誤] ask_user 已達上限 {ASK_USER_MAX} 次。請以預設值完成或呼叫 done(success=false)。"
                    messages.append(HumanMessage(content=reply))
                    messages.append(HumanMessage(content=f"[工具結果 — ask_user]\n{tool_result}"))
                    continue
                try:
                    q_data = json.loads(tool_input)
                    question = (q_data.get("question") or "").strip()
                    options = q_data.get("options") or []
                    context = (q_data.get("context") or "").strip()
                    if not question:
                        raise ValueError("question 不可為空")
                    if not isinstance(options, list):
                        options = []
                except Exception as e:
                    messages.append(HumanMessage(content=reply))
                    messages.append(HumanMessage(
                        content=f"[系統] ask_user input 格式錯誤：{e}。正確格式：{{\"question\":\"...\", \"options\":[...], \"context\":\"...\"}}"
                    ))
                    continue

                answer = await _wait_for_ask_user(run_id, question, options, context, logger, step_name)
                if answer is None:
                    tool_result = "[錯誤] 等待使用者回答逾時或被取消，請以合理預設完成或呼叫 done(success=false)。"
                else:
                    was_interactive = True  # 標記 recipe「首次有人工回答」
                    tool_result = f"使用者回答：{answer}"
                messages.append(HumanMessage(content=reply))
                messages.append(HumanMessage(content=f"[工具結果 — ask_user]\n{tool_result}"))
                continue

            # 執行工具
            logger.info(f"[{step_name}] 工具呼叫：{tool_name}")
            tool_result = await asyncio.get_event_loop().run_in_executor(
                None, lambda tn=tool_name, ti=tool_input: _execute_skill_tool(tn, ti, cwd=working_dir, run_id=run_id)
            )
            # 完整記錄工具結果（錯誤訊息如 ModuleNotFoundError 常超過 300 字）
            _tr_preview = tool_result if len(tool_result) <= 3000 else tool_result[:3000] + f"...[已截斷，完整長度 {len(tool_result)} 字]"
            logger.debug(f"[{step_name}] 工具結果：\n{_tr_preview}")
            all_stdout.append(f"[{tool_name}] {tool_result}")
            # 記錄成功的 run_python 供 Recipe Book 快取
            if tool_name == "run_python" and "[exit code:" not in tool_result:
                last_successful_code = tool_input

            messages.append(HumanMessage(content=reply))
            messages.append(HumanMessage(content=f"[工具結果 — {tool_name}]\n{tool_result}"))

            # 迴圈偵測：連續多次只執行短程式碼，注入提示打破迴圈
            if tool_name == "run_python" and len(tool_input) < 200:
                short_code_streak += 1
                if short_code_streak >= 3:
                    logger.warning(f"[{step_name}] 偵測到連續 {short_code_streak} 次短程式碼，注入提示打破迴圈")
                    messages.append(HumanMessage(
                        content="[系統警告] 你已經連續多次只執行讀取資料的小段程式碼，但任務尚未完成。"
                                "請立即在一個 <tool>run_python</tool> 呼叫中寫出完整的程式碼來產生輸出檔案。"
                                "不要再分步驟讀取資料，直接把讀取、處理、寫入都放在同一段程式碼中執行。"
                    ))
                    short_code_streak = 0
            else:
                short_code_streak = 0

            # 錯誤重複偵測：連續出現相同錯誤時，注入修正提示
            if tool_name == "run_python" and "[stderr]" in tool_result:
                # 取錯誤的關鍵行作為簽名（最後一行 traceback）
                err_lines = [l for l in tool_result.split("\n") if l.strip() and not l.startswith("[")]
                error_sig = err_lines[-1].strip() if err_lines else ""
                if error_sig and error_sig == last_error_sig:
                    same_error_count += 1
                    if same_error_count >= 2:
                        logger.warning(f"[{step_name}] 相同錯誤連續出現 {same_error_count + 1} 次，注入修正提示")
                        messages.append(HumanMessage(
                            content=f"[系統警告] 你已經連續 {same_error_count + 1} 次遇到相同錯誤：{error_sig}\n"
                                    "你不能重複提交相同的程式碼。請換一個完全不同的方法。\n"
                                    "建議：先用 read_file 或 run_python 讀取輸入檔的前幾行，確認實際的欄位名稱和資料格式，"
                                    "然後根據實際欄位名稱重寫程式碼。"
                        ))
                        same_error_count = 0
                else:
                    last_error_sig = error_sig
                    same_error_count = 1
            else:
                last_error_sig = ""
                same_error_count = 0

        # 超過最大迭代
        logger.warning(f"[{step_name}] Skill agent 達到最大迭代次數")
        return ExecResult(
            exit_code=1,
            stdout="\n".join(all_stdout),
            stderr=f"Skill agent 在 {SKILL_MAX_ITERATIONS} 次迭代內未完成任務",
        )

    except Exception as e:
        logger.error(f"[{step_name}] Skill 執行異常：{e}")
        return ExecResult(
            exit_code=-3,
            stdout="\n".join(all_stdout),
            stderr=f"Skill 執行異常：{e}",
        )
