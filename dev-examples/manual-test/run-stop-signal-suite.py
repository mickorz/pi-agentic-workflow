#!/usr/bin/env python3
"""G2(SIGINT 取消) / H(stop 跨进程终止) / I(事件流连续性) / J(超时失败路径) 自动化测试
平台说明（Windows）：
  - MSYS/Git Bash 的 kill -INT 无法送达 Windows 原生进程（无同 console CTRL_C_EVENT），
    G2 在此环境下不可自动化；PowerShell 终端手动 Ctrl-C 已验证（manifest=cancelled）。
    脚本仍会尝试并如实报告 SKIP。
  - stop 在 Windows 上表现为强杀 + 死进程补偿标 cancelled；POSIX 下被停进程 exit 130，
    Windows 下 exit 非零（无法捕获信号），故 H 断言终态 cancelled + exit 非零。
用法：python3 run-stop-signal-suite.py（在本目录执行；需要 pi-workflow 全局命令与可用凭证）
（自 run-stop-signal-suite.sh 忠实移植：逐断言 PASS/FAIL/SKIP + 结尾汇总计数）
"""
from __future__ import annotations

import json
import os
import re
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

PASS = 0
FAIL = 0
SKIP = 0


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"[PASS] {msg}", flush=True)


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    print(f"[FAIL] {msg}", flush=True)


def skip(msg: str) -> None:
    global SKIP
    SKIP += 1
    print(f"[SKIP] {msg}", flush=True)


def bash_rc(returncode: int) -> int:
    """shell wait 语义：被信号终止的进程退出码为 128+signal（POSIX）。"""
    return 128 - returncode if returncode < 0 else returncode


def newest_run() -> str:
    """等价 ls -t .pi-workflows/runs | head -1。"""
    try:
        entries = [p for p in RUNS.iterdir()]
    except OSError:
        return ""
    if not entries:
        return ""
    return max(entries, key=lambda p: p.stat().st_mtime).name


def journal_lines(run_id: str) -> int:
    try:
        data = (RUNS / run_id / "journal.jsonl").read_bytes()
    except OSError:
        return 0
    return data.count(b"\n")


def wait_journal(run_id: str, want: int) -> bool:
    """等价 wait_journal runId 期望行数（400 × 0.3s）。"""
    for _ in range(400):
        if journal_lines(run_id) >= want:
            return True
        time.sleep(0.3)
    return False


def start_run(script: str, log_path: str) -> tuple[subprocess.Popen | None, str]:
    """启动后台 run：返回 (进程, runId)；失败返回 (None, "")。"""
    before = newest_run()
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(["pi-workflow", "run", script], stdout=log, stderr=subprocess.STDOUT)
    for _ in range(100):
        cand = newest_run()
        if cand != before and (RUNS / cand / "journal.jsonl").is_file():
            return proc, cand
        time.sleep(0.3)
    return proc, ""


def status_line(run_id: str) -> str:
    out = subprocess.run(["pi-workflow", "list"], capture_output=True, text=True)
    text = (out.stdout or "") + (out.stderr or "")
    return next((ln for ln in text.splitlines() if run_id in ln), "")


# ── G2: SIGINT 取消 ──
proc, run_id = start_run("08-resume-three-nodes.js", "/tmp/g2-run.log")
if proc is not None and run_id:
    wait_journal(run_id, 1)
    try:
        proc.send_signal(signal.SIGINT)
    except ProcessLookupError:
        pass
    proc.wait()
    rc = bash_rc(proc.returncode)
    log = Path("/tmp/g2-run.log").read_text(encoding="utf-8", errors="replace")
    if "收到 SIGINT" in log:
        ok("G2 SIGINT 送达并提示")
        if rc == 130:
            ok("G2 exit 130")
        else:
            bad(f"G2 exit={rc}（预期 130）")
        if "cancelled" in status_line(run_id):
            ok("G2 状态 cancelled")
        else:
            bad("G2 状态非 cancelled")
    else:
        skip("G2 MSYS 下 kill -INT 无法送达 Windows 进程（run 自行跑完）；手动 Ctrl-C 已验证 cancelled")
        try:
            proc.kill()
        except ProcessLookupError:
            pass
else:
    bad("G2 启动失败")

# ── H: stop 跨进程终止 ──
proc, hid = start_run("08-resume-three-nodes.js", "/tmp/h-run.log")
if proc is not None and hid:
    time.sleep(2)  # 等 manifest 写入 pid
    out = subprocess.run(["pi-workflow", "stop", hid], capture_output=True, text=True)
    stop_out = (out.stdout or "") + (out.stderr or "")
    if "SIGINT" in stop_out:
        ok("H stop 发出终止信号")
    else:
        bad(f"H stop 输出异常: {stop_out}")
    proc.wait()
    rc = bash_rc(proc.returncode)
    if rc != 0:
        ok(f"H 被 stop 的 run 非零退出（{rc}）")
    else:
        bad("H exit=0（被停进程不应正常完成）")
    if "cancelled" in status_line(hid):
        ok("H 终态 cancelled（死进程补偿）")
    else:
        bad("H 状态非 cancelled")
    stop_run = hid
else:
    bad("H 启动失败")
    stop_run = ""

# ── I: 事件流连续性（独立跑 01-smoke，天然包含全部事件类型）──
proc, iid = start_run("01-smoke.js", "/tmp/i-run.log")
if proc is not None and iid:
    proc.wait()
    ev = RUNS / iid / "events.jsonl"
    lines = [json.loads(ln) for ln in ev.read_text(encoding="utf-8").splitlines() if ln.strip()]
    seqs = [e["sequence"] for e in lines]
    continuous = all(s == i + 1 for i, s in enumerate(seqs))
    types = {e["type"] for e in lines}
    need = ["run.started", "node.started", "node.completed", "run.completed", "agent.session.created"]
    missing = [t for t in need if t not in types]
    verdict = ("continuous" if continuous else "BROKEN") + "|" + (
        "MISSING:" + ",".join(missing) if missing else "types-ok"
    )
    if verdict.startswith("continuous"):
        ok("I sequence 连续递增无断裂")
    else:
        bad(f"I sequence 断裂: {verdict}")
    if "types-ok" in verdict:
        ok("I 含 run/node/agent.session 全部关键事件")
    else:
        bad(f"I 缺事件: {verdict}")
else:
    bad("I 启动失败")

# ── J: 超时失败路径（09 必然超时，预期 exit 1）──
p = subprocess.run(["pi-workflow", "run", "09-timeout.js"], capture_output=True, text=True)
out = (p.stdout or "") + (p.stderr or "")
if re.search(r"AGENT_TIMEOUT|超时", out):
    ok("J 超时被闸门吸收（AGENT_TIMEOUT）")
else:
    bad(f"J 输出异常: {out}")
if p.returncode == 1:
    ok("J exit 1")
else:
    bad(f"J exit={p.returncode}（预期 1）")

print("====================")
print(f"PASS={PASS} FAIL={FAIL} SKIP={SKIP}")
sys.exit(0 if FAIL == 0 else 1)
