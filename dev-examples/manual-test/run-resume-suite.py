#!/usr/bin/env python3
"""G3/G4/G5 自动化测试：强杀 + resume 回放 + 哈希不匹配拒绝 + 副作用确认未决拒绝
顺序：kill 后 run 处于 interrupted，先测 G4（哈希拒绝）与 G5（未决确认拒绝），
      最后 G3 收尾回放（resume 后 run 变 completed，无法再测 G4/G5）。
用法：python3 run-resume-suite.py（在本目录执行；需要 pi-workflow 全局命令与可用凭证）
（自 run-resume-suite.sh 忠实移植：逐断言 PASS/FAIL + 结尾汇总计数）
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
os.chdir(HERE)

RUNS = HERE / ".pi-workflows" / "runs"
SCRIPT = "08-resume-three-nodes.js"

PASS = 0
FAIL = 0


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"[PASS] {msg}", flush=True)


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    print(f"[FAIL] {msg}", flush=True)


def newest_run() -> str:
    """等价 ls -t .pi-workflows/runs | head -1（按 mtime 新→旧取第一个）。"""
    try:
        entries = [p for p in RUNS.iterdir()]
    except OSError:
        return ""
    if not entries:
        return ""
    return max(entries, key=lambda p: p.stat().st_mtime).name


def journal_lines(run_id: str) -> int:
    """等价 wc -l < journal.jsonl（统计换行符个数，文件缺失记 0）。"""
    try:
        data = (RUNS / run_id / "journal.jsonl").read_bytes()
    except OSError:
        return 0
    return data.count(b"\n")


def run_capture(args: list[str]) -> tuple[str, int]:
    p = subprocess.run(args, capture_output=True, text=True)
    return p.stdout + p.stderr, p.returncode


# ── 启动并在 n1/n2 提交后强杀 ──
before = newest_run()
with open("/tmp/g3-run.log", "wb") as log:
    proc = subprocess.Popen(["pi-workflow", "run", SCRIPT], stdout=log, stderr=subprocess.STDOUT)

run_id = ""
for _ in range(100):
    cand = newest_run()
    if cand != before and (RUNS / cand / "journal.jsonl").is_file():
        run_id = cand
        break
    time.sleep(0.3)
if not run_id:
    bad("未捕获 runId")
    proc.kill()
    sys.exit(1)
print(f"runId={run_id}", flush=True)

n = 0
for _ in range(400):
    n = journal_lines(run_id)
    if n >= 2:
        break
    time.sleep(0.3)
if n >= 2:
    ok("journal 到 2 行（n1/n2 已提交）")
else:
    bad(f"journal 未到 2 行（n={n}）")

proc.send_signal(signal.SIGKILL)
proc.wait()
time.sleep(1)

st, _ = run_capture(["pi-workflow", "list"])
st_line = next((ln for ln in st.splitlines() if run_id in ln), "")
if "interrupted" in st_line:
    ok("强杀后状态 interrupted（死进程补偿）")
else:
    bad(f"状态非 interrupted: {st_line}")

# ── G4: 哈希不匹配拒绝（run 仍为 interrupted）──
shutil.copy(SCRIPT, "/tmp/08-backup.js")
src = Path(SCRIPT).read_text(encoding="utf-8")
Path(SCRIPT).write_text(src.replace("node-3-done", "node-3-CHANGED"), encoding="utf-8")
out, rc = run_capture(["pi-workflow", "resume", run_id, "--yes", "--non-interactive"])
if "RESUME_MISMATCH" in out:
    ok("G4 RESUME_MISMATCH 拒绝脚本变更")
else:
    bad(f"G4 未拒绝: {out}")
if rc == 2:
    ok("G4 exit 2")
else:
    bad(f"G4 exit={rc}")
shutil.copy("/tmp/08-backup.js", SCRIPT)

# ── G5: 副作用确认未决拒绝（非交互且未显式 --yes）──
out, rc = run_capture(["pi-workflow", "resume", run_id, "--non-interactive"])
if "非交互模式需显式" in out:
    ok("G5 未决确认拒绝（需显式 --yes）")
else:
    bad(f"G5 输出异常: {out}")
if rc == 2:
    ok("G5 exit 2")
else:
    bad(f"G5 exit={rc}")

# ── G3 收尾: 正常回放恢复 ──
out, rc = run_capture(["pi-workflow", "resume", run_id, "--yes", "--non-interactive"])
if "journal 2 条可回放" in out:
    ok("G3 resume 提示 journal 2 条可回放")
else:
    bad(f"G3 回放提示缺失: {out}")
if "journal 回放" in out:
    ok("G3 n1/n2 带 journal 回放标记")
else:
    bad("G3 回放标记缺失")
if rc == 0:
    ok("G3 resume exit 0")
else:
    bad(f"G3 resume exit={rc}")
lines = journal_lines(run_id)
if lines == 3:
    ok("G3 journal 最终 3 行")
else:
    bad(f"G3 journal 行数={lines}（预期 3）")

print("====================")
print(f"PASS={PASS} FAIL={FAIL} runId={run_id}")
sys.exit(0 if FAIL == 0 else 1)
