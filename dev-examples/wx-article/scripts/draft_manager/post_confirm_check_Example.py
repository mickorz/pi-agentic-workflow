#!/usr/bin/env python3
"""post_confirm_check_Example.py —— 确认点 2 标准检查脚本测试（零 LLM，可重复）。

覆盖分支：
- FIRST_RUN + FRESH   -> READY（记录 sha 基准）
- UNCHANGED + FRESH   -> READY
- CHANGED + FRESH     -> READY + [WARN] 提醒 check_state/humanizer 缓存
- CHANGED + STALE     -> NEED ACTION（退出码 1）
- UNCHANGED + MISSING -> NEED ACTION（退出码 1）
- state 文件损坏      -> 按 FIRST_RUN 处理不崩溃

运行：python post_confirm_check_Example.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def run_check(article_dir: Path) -> tuple[int, str]:
    r = subprocess.run(
        [sys.executable, str(HERE / "post_confirm_check.py"), "--article-dir", str(article_dir)],
        capture_output=True, text=True, encoding="utf-8",
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def make_dir(tmp: Path) -> Path:
    adir = tmp / "article"
    (adir / "imgs").mkdir(parents=True)
    md = adir / "Claude 测试文章.md"
    md.write_text("第一段正文。\n\n## 章题一\n\n内容。\n", encoding="utf-8")
    return adir, md


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="pcc-example-"))

    # 分支 1：FIRST_RUN + FRESH（先写正文，后写 layout -> 天然比正文新）
    adir, md = make_dir(tmp / "t1")
    (adir / "layout.html").write_text("<html>new</html>", encoding="utf-8")
    code, out = run_check(adir)
    check("1 FIRST_RUN+FRESH 退出码0", code == 0, out)
    check("1 输出 READY", "=== READY TO PUBLISH ===" in out, out)
    check("1 记录 state", (adir / ".post-confirm-state.json").exists())
    state = json.loads((adir / ".post-confirm-state.json").read_text(encoding="utf-8"))

    # 分支 2：UNCHANGED + FRESH（不动正文和 layout，直接重跑）
    code, out = run_check(adir)
    check("2 UNCHANGED+FRESH 退出码0", code == 0, out)
    check("2 正文 UNCHANGED", "[CHECK] 正文: UNCHANGED" in out, out)

    # 分支 3：CHANGED + FRESH（改正文后重写 layout，mtime 重新超过正文）
    md.write_text("第一段正文。\n\n## 章题一（改）\n\n内容改了。\n", encoding="utf-8")
    (adir / "layout.html").write_text("<html>new2</html>", encoding="utf-8")
    code, out = run_check(adir)
    check("3 CHANGED+FRESH 退出码0", code == 0, out)
    check("3 正文 CHANGED", "[CHECK] 正文: CHANGED" in out, out)
    check("3 有 WARN 提醒", "[WARN]" in out and "check_state" in out, out)

    # 分支 4：CHANGED + STALE（再改正文，layout 不动 -> mtime 落后于正文）
    md.write_text("第一段正文。\n\n## 章题一（再改）\n\n又改了。\n", encoding="utf-8")
    code, out = run_check(adir)
    check("4 CHANGED+STALE 退出码1", code == 1, out)
    check("4 输出 NEED ACTION", "=== NEED ACTION ===" in out, out)
    check("4 layout STALE", "[CHECK] layout.html: STALE" in out, out)

    # 分支 5：UNCHANGED + MISSING（删 layout，重跑）
    (adir / "layout.html").unlink()
    code, out = run_check(adir)
    check("5 MISSING 退出码1", code == 1, out)
    check("5 layout MISSING", "[CHECK] layout.html: MISSING" in out, out)

    # 分支 6：state 文件损坏 -> 按 FIRST_RUN 处理不崩溃
    (adir / ".post-confirm-state.json").write_text("{broken json", encoding="utf-8")
    (adir / "layout.html").write_text("<html>new3</html>", encoding="utf-8")
    code, out = run_check(adir)
    check("6 state 损坏不崩溃", code == 0 and "=== READY TO PUBLISH ===" in out, out)

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n汇总 PASS={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        sys.exit(1)
    print("=== ALL DONE ===")


if __name__ == "__main__":
    main()
