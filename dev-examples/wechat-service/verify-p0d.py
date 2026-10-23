#!/usr/bin/env python3
"""wechat-p0d 程序化验证（Windows 部分）：长任务中断恢复 + 服务链冒烟（需求 §7 对应项）

用法：python dev-examples/wechat-service/verify-p0d.py   （仓库根执行）

范围说明：
  - 本脚本覆盖 P0-D 可程序化项：长任务进程死亡→interrupted→resume 恢复（§5 兼容、§7 长任务门禁）；
    服务链冒烟（start→healthy→stop→stopped）。
  - 进程模型依据（run-service.ts 头注释）：workflow 为宿主进程内执行（Bot 与 CLI 同一引擎），
    故用 CLI 进程忠实模拟「服务进程死亡中断运行中任务」的恢复语义。
  - 不可程序化项（真机/双平台）在 P0-D 执行报告中另行记录：微信持续收发（真机）、
    公众号文章 Workflow 实测（已于 2026-10-22 真实草稿创建成功，media_id 见报告）、macOS 复跑。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parents[2]
PASS = 0
FAIL = 0


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"[PASS] {msg}")


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    print(f"[FAIL] {msg}")


def run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess[str]:
    exe = shutil.which(cmd[0])
    if exe:
        cmd = [exe, *cmd[1:]]
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def case_budget(name: str):
    """用例计时护栏（用户纪律：单用例 3 分钟，超时即 FAIL 并提示查逻辑）"""
    start = time.time()

    def check():
        if time.time() - start > 180:
            bad(f"{name} 超过 3 分钟预算——按纪律停下检查逻辑，不无脑加等待")
            return False
        return True

    return check


def case_interrupted_resume() -> None:
    print("\n== 用例 1：长任务进程死亡 → interrupted → resume 恢复 ==")
    budget = case_budget("用例1")
    # 后台起长任务（直接 node dist 入口，避开 Windows 下 cmd 垫片子进程树问题）
    node = shutil.which("node")
    proc = subprocess.Popen(
        [node, str(REPO / "dist" / "cli" / "index.js"), "run", "dev-examples/wx-p2/long-demo.js"],
        cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
    )
    # 轮询 manifest 出现 runId 且进入 running（拿到 manifest 内记录的引擎 pid）
    run_id = None
    run_pid = None
    deadline = time.time() + 60
    while time.time() < deadline and run_id is None:
        if not budget():
            proc.kill()
            return
        for d in sorted((REPO / ".pi-workflows" / "runs").glob("run-*"), key=lambda p: p.stat().st_mtime, reverse=True):
            m = d / "manifest.json"
            if not m.exists():
                continue
            try:
                man = json.loads(m.read_text(encoding="utf-8"))
            except Exception:
                continue
            if man.get("status") == "running" and man.get("scriptPath", "").endswith("long-demo.js"):
                run_id = man.get("runId")
                run_pid = man.get("pid")
                break
        time.sleep(1)
    if not run_id:
        proc.kill()
        bad("60s 内未见 long-demo 进入 running")
        return
    ok(f"长任务 running（{run_id}，pid={run_pid}）")
    # 模拟进程死亡：直杀 manifest 记录的引擎 pid（PM2 停止/强杀服务进程对 in-flight run 的等效效果）
    if run_pid and run_pid != proc.pid:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(run_pid)], capture_output=True)
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        bad("宿主进程未退出（taskkill 未生效——检查逻辑）")
        return
    # status 命令会做 crash 分类（running 且 pid 已死 → interrupted）
    st = None
    for _ in range(20):
        if not budget():
            return
        st = run(["pi-workflow", "status", run_id], timeout=120)
        if "interrupted" in st.stdout:
            break
        time.sleep(2)
    if st and "interrupted" in st.stdout:
        ok("进程死亡后状态正确识别 interrupted（journal 完整保留）")
    else:
        bad(f"状态未识别中断：{(st.stdout if st else '')[:200]}")
        return
    # resume 恢复（journal 回放，断点续跑；三步 LLM 预计 ~1 分钟）
    rz = run(["pi-workflow", "resume", run_id, "--yes", "--non-interactive"], timeout=590)
    if rz.returncode == 0:
        ok("resume 恢复成功（退出码 0）")
    else:
        bad(f"resume 失败（{rz.returncode}）：{(rz.stdout + rz.stderr)[-300:]}")
        return
    st2 = run(["pi-workflow", "status", run_id], timeout=120)
    if "completed" in st2.stdout:
        ok("恢复后终态 completed")
    else:
        bad(f"终态异常：{st2.stdout[:200]}")


def case_service_smoke() -> None:
    print("\n== 用例 2：服务链冒烟（start → healthy → stop → stopped） ==")
    budget = case_budget("用例2")
    run(["pi-workflow", "wechat", "service", "stop"], timeout=120)
    s = run(["pi-workflow", "wechat", "service", "start"], timeout=150)
    if s.returncode != 0:
        bad(f"service start 退出码 {s.returncode}")
        return
    st = None
    for _ in range(24):  # 轮询至 healthy（上限 ~2 分钟，替代固定大 sleep）
        if not budget():
            run(["pi-workflow", "wechat", "service", "stop"], timeout=120)
            return
        st = run(["pi-workflow", "wechat", "service", "status"], timeout=60)
        if "综合状态：healthy" in st.stdout:
            break
        time.sleep(3)
    if st and "综合状态：healthy" in st.stdout:
        ok("服务 healthy（进程+Bot+心跳）")
    else:
        bad(f"未达 healthy：{(st.stdout if st else '')[:200]}")
        return
    run(["pi-workflow", "wechat", "service", "stop"], timeout=150)
    st2 = run(["pi-workflow", "wechat", "service", "status"], timeout=60)
    if "综合状态：stopped" in st2.stdout:
        ok("stop 后 stopped（清理干净）")
    else:
        bad(f"停止态异常：{st2.stdout[:200]}")


def main() -> int:
    print(f"verify-p0d：仓库根 {REPO}")
    case_interrupted_resume()
    case_service_smoke()
    print("\n====")
    print(f"PASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
