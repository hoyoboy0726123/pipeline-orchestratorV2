"""
Skill 套件管理器 — 管理 AI技能節點可用的 Python 第三方套件
"""
import subprocess
import sys
import time
import json as _json
from pathlib import Path
from threading import Lock

_PKG_FILE = Path(__file__).parent / "skill_packages.txt"

# ── pip list 快取（一次抓全部，避免對每個套件各呼叫 pip show）──
_PIP_CACHE: dict = {"ts": 0.0, "data": {}}  # {"pandas": {"version": "2.0", "installed": True}, ...}
_PIP_CACHE_TTL = 60.0  # 秒
_PIP_CACHE_LOCK = Lock()


def _pip_snapshot(force_refresh: bool = False) -> dict[str, dict]:
    """用單次 `pip list --format=json` 取得所有已安裝套件（名稱小寫 → {version}）。
    有 60s 快取，大幅避免 Windows 上 subprocess spawn 的開銷。"""
    with _PIP_CACHE_LOCK:
        if not force_refresh and (time.time() - _PIP_CACHE["ts"]) < _PIP_CACHE_TTL and _PIP_CACHE["data"]:
            return _PIP_CACHE["data"]
        snapshot: dict[str, dict] = {}
        try:
            r = subprocess.run(
                [sys.executable, "-m", "pip", "list", "--format=json"],
                capture_output=True, text=True, timeout=20,
            )
            if r.returncode == 0:
                for item in _json.loads(r.stdout or "[]"):
                    name = str(item.get("name") or "").lower()
                    if name:
                        snapshot[name] = {"version": str(item.get("version") or "")}
        except Exception:
            pass
        _PIP_CACHE["ts"] = time.time()
        _PIP_CACHE["data"] = snapshot
        return snapshot


def _invalidate_pip_cache() -> None:
    """安裝/移除套件後呼叫，確保下次讀到最新狀態。"""
    with _PIP_CACHE_LOCK:
        _PIP_CACHE["ts"] = 0.0
        _PIP_CACHE["data"] = {}


def _read_packages() -> list[str]:
    """讀取 skill_packages.txt，回傳套件名清單（忽略空行和註解）"""
    if not _PKG_FILE.exists():
        return []
    lines = _PKG_FILE.read_text(encoding="utf-8").splitlines()
    return [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]


def _write_packages(packages: list[str]) -> None:
    """寫入套件清單到 skill_packages.txt（保留 header 註解）"""
    header = (
        "# AI技能節點可用的 Python 套件\n"
        "# 後端啟動時自動安裝缺少的套件到本專案 venv\n"
        "# 可透過管理介面新增或移除\n\n"
    )
    _PKG_FILE.write_text(header + "\n".join(packages) + "\n", encoding="utf-8")


def _is_installed(pkg_name: str) -> bool:
    """檢查套件是否已安裝（走快照，不呼叫 subprocess）"""
    base = pkg_name.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip().lower()
    return base in _pip_snapshot()


def _pip_install(pkg_name: str) -> tuple[bool, str]:
    """安裝單一套件，回傳 (成功, 訊息)"""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", pkg_name, "-q"],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0:
            return True, f"✅ {pkg_name} 安裝成功"
        return False, f"❌ {pkg_name} 安裝失敗：{result.stderr.strip()}"
    except subprocess.TimeoutExpired:
        return False, f"❌ {pkg_name} 安裝逾時"
    except Exception as e:
        return False, f"❌ {pkg_name} 安裝錯誤：{e}"


def _pip_uninstall(pkg_name: str) -> tuple[bool, str]:
    """移除單一套件"""
    base = pkg_name.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip()
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "uninstall", base, "-y", "-q"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            return True, f"✅ {base} 已移除"
        return False, f"❌ {base} 移除失敗：{result.stderr.strip()}"
    except Exception as e:
        return False, f"❌ {base} 移除錯誤：{e}"


def auto_install_packages() -> None:
    """後端啟動時自動安裝缺少的套件"""
    packages = _read_packages()
    if not packages:
        return
    missing = [p for p in packages if not _is_installed(p)]
    if not missing:
        print(f"✅ Skill 套件全部已安裝（{len(packages)} 個）")
        return
    print(f"📦 正在安裝缺少的 Skill 套件：{', '.join(missing)}")
    for pkg in missing:
        ok, msg = _pip_install(pkg)
        print(f"  {msg}")


def list_packages() -> list[dict]:
    """列出所有 skill 套件及安裝狀態（全部走一次 pip list 快照，~200ms 內完成）"""
    packages = _read_packages()
    snapshot = _pip_snapshot()
    result = []
    for pkg in packages:
        base = pkg.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip().lower()
        info = snapshot.get(base)
        installed = info is not None
        version = info.get("version", "") if info else ""
        result.append({
            "name": pkg,
            "installed": installed,
            "version": version,
        })
    return result


def add_package(pkg_name: str) -> tuple[bool, str]:
    """新增套件：安裝 + 寫入清單"""
    pkg_name = pkg_name.strip()
    if not pkg_name:
        return False, "套件名稱不能為空"

    packages = _read_packages()
    base = pkg_name.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip().lower()

    # 檢查是否已在清單中
    for p in packages:
        existing_base = p.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip().lower()
        if existing_base == base:
            return False, f"{pkg_name} 已在清單中"

    # 先安裝
    ok, msg = _pip_install(pkg_name)
    if not ok:
        return False, msg

    # 寫入清單 + 讓快取失效
    packages.append(pkg_name)
    _write_packages(packages)
    _invalidate_pip_cache()
    return True, msg


def remove_package(pkg_name: str) -> tuple[bool, str]:
    """移除套件：從清單移除 + 解除安裝"""
    pkg_name = pkg_name.strip()
    packages = _read_packages()
    base = pkg_name.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip().lower()

    # 從清單中移除
    new_packages = []
    found = False
    for p in packages:
        existing_base = p.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip().lower()
        if existing_base == base:
            found = True
        else:
            new_packages.append(p)

    if not found:
        return False, f"{pkg_name} 不在清單中"

    # 解除安裝
    _pip_uninstall(pkg_name)

    # 更新清單 + 讓快取失效
    _write_packages(new_packages)
    _invalidate_pip_cache()
    return True, f"✅ {pkg_name} 已從清單移除並解除安裝"


# ── venv 同步：找出已裝但不在清單中的套件 ────────────────────────────────────
def _base_name(pkg: str) -> str:
    """取得套件基礎名（去除 extras 與版本號）"""
    return pkg.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip().lower()


_BOOTSTRAP_EXCLUDES = {"pip", "setuptools", "wheel"}


def scan_unlisted_packages() -> list[dict]:
    """
    掃 venv 中**已安裝但不在 skill_packages.txt 也不在 requirements.txt** 的套件。
    只列出頂層套件（非其他套件的依賴），避免列出一堆傳遞依賴。

    回傳 list[{name, version}]。
    """
    # 1. 讀出 skill_packages.txt 和 requirements.txt 的 base names
    skill_bases = {_base_name(p) for p in _read_packages()}

    req_file = Path(__file__).parent / "requirements.txt"
    req_bases: set[str] = set()
    if req_file.exists():
        for line in req_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                req_bases.add(_base_name(line))

    # 2. 用 pip list --not-required 取得頂層套件
    import json as _json
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pip", "list", "--not-required", "--format=json"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return []
        installed = _json.loads(r.stdout)
    except Exception:
        return []

    # 3. 過濾：排除 bootstrap、已在 skill 清單、已在 requirements
    unlisted = []
    for pkg in installed:
        name = pkg.get("name", "")
        if not name:
            continue
        base = name.lower()
        if base in _BOOTSTRAP_EXCLUDES:
            continue
        if base in skill_bases:
            continue
        if base in req_bases:
            continue
        unlisted.append({"name": name, "version": pkg.get("version", "")})
    unlisted.sort(key=lambda x: x["name"].lower())
    return unlisted


def add_to_list_only(pkg_name: str) -> tuple[bool, str]:
    """
    只把套件名加到 skill_packages.txt，不再跑 pip install
    （用於已手動安裝、只需納管的情境）。
    """
    pkg_name = pkg_name.strip()
    if not pkg_name:
        return False, "套件名稱不能為空"
    packages = _read_packages()
    base = _base_name(pkg_name)
    for p in packages:
        if _base_name(p) == base:
            return False, f"{pkg_name} 已在清單中"
    packages.append(pkg_name)
    _write_packages(packages)
    return True, f"✅ {pkg_name} 已加入 skill_packages.txt"
