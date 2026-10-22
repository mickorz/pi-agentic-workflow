#!/usr/bin/env python3
"""P0-A 单进程形态验证：node --import tsx 单层进程、锁互斥、陈锁自愈
用法：仓库根执行 python3 dev-examples/wechat-service/verify-p0a.py
设计：使用临时 data 目录，短窗口只验证锁行为（不依赖微信连接成功，不扰动真实服务）
（自 verify-p0a.sh 忠实移植；Windows 专属的 PowerShell 进程查询 / MSYS pid 限制
  改为 macOS 原生等价：Popen 直接持有真实 pid，进程特征查询用 ps + 命令行匹配。）
"""
from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent  # 仓库根

PASS = 0
FAIL = 0


def check(label: str, cond: bool) -> None:
    """等价 check <名> <1|0>：真=PASS。"""
    global PASS, FAIL
    if cond:
        print(f"PASS {label}", flush=True)
        PASS += 1
    else:
        print(f"FAIL {label}", flush=True)
        FAIL += 1


def check_cmd(label: str, rc: int) -> None:
    """等价 check_cmd <名> <命令退出码>：0=PASS（shell 惯例）。"""
    check(label, rc == 0)


def find_bot_cmdline() -> str:
    """等价 PowerShell Get-CimInstance：取首个命令行含 `--import tsx` 且含 `wechat start`
    的 node 进程命令行（即 Bot 本体，无重执行包装）；找不到返回空串。"""
    out = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True)
    for ln in (out.stdout or "").splitlines():
        if "--import tsx" in ln and "wechat start" in ln and ln.strip().split()[0].endswith("node"):
            return ln.strip()
    return ""


def force_kill(pid: int) -> None:
    """等价 PowerShell Stop-Process -Id <pid> -Force。"""
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def main() -> int:
    os.chdir(REPO_ROOT)
    tmp = tempfile.mkdtemp(prefix="p0a-")
    data = Path(tmp) / "pi-wechat-data"
    entry = "src/cli/index.ts"

    # 1. 单进程形态启动（acquire 锁后即认为存活；不等微信连接）
    with open("/tmp/p0a-v1.log", "wb") as log:
        bot = subprocess.Popen(
            ["node", "--import", "tsx", entry, "wechat", "start", "--data", str(data)],
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
    bot_pid = bot.pid
    time.sleep(5)
    check("服务进程存活并到达锁获取点（锁文件生成）", (data / "service.lock").is_file())

    # 2. 单进程形态：存在命令行同时含 --import tsx 与 wechat start 的 node 进程（即 Bot 本体，无重执行包装）
    #    注：bash $! 在 MSYS 下是假 pid 无法查 Windows pid，改按命令行特征查询；
    #    macOS 下 Popen.pid 即真实 pid，此处保留特征查询以忠实原断言（单层进程形态）。
    cmd = find_bot_cmdline()
    check_cmd("单进程形态（node --import tsx 直起 Bot）", 0 if "wechat start" in cmd else 1)

    # 3. 锁内容为当前启动的进程
    try:
        lock_text = (data / "service.lock").read_text(encoding="utf-8")
    except OSError:
        lock_text = ""
    check("锁内容 pid 正确", re.search(rf'"pid":\s*{bot_pid}\b', lock_text) is not None)

    # 4. 二次启动被拦（前台混跑互斥）：等待进程写出报错并退出
    with open("/tmp/p0a-v2.log", "wb") as log:
        second_rc = subprocess.Popen(
            ["node", "--import", "tsx", entry, "wechat", "start", "--data", str(data)],
            stdout=log, stderr=subprocess.STDOUT,
        ).wait()
    check_cmd("二次启动退出码为 2", second_rc)
    try:
        v2 = Path("/tmp/p0a-v2.log").read_text(encoding="utf-8", errors="replace")
    except OSError:
        v2 = ""
    check_cmd("前台二次启动被锁拦截（报错文案）", 0 if "wechat service stop" in v2 else 1)

    # 5. 强杀 Bot（模拟崩溃）→ 锁残留（陈锁场景）
    force_kill(bot_pid)
    bot.wait()
    time.sleep(2)
    check("强杀后锁文件残留（陈锁场景）", (data / "service.lock").is_file())

    # 6. 陈锁自愈：新进程接管（锁内容 pid 变为新进程）
    with open("/tmp/p0a-v3.log", "wb") as log:
        restart = subprocess.Popen(
            ["node", "--import", "tsx", entry, "wechat", "start", "--data", str(data)],
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
    restart_pid = restart.pid
    time.sleep(5)
    try:
        lock_text = (data / "service.lock").read_text(encoding="utf-8")
    except OSError:
        lock_text = ""
    check("陈锁自愈：锁被新进程接管", re.search(rf'"pid":\s*{restart_pid}\b', lock_text) is not None)

    # 清理：强杀新进程；陈锁残留留给下次启动自愈（锁协议预期行为），临时目录整体删除
    force_kill(restart_pid)
    restart.wait()
    time.sleep(1)
    shutil.rmtree(tmp, ignore_errors=True)

    print("----")
    print(f"PASS {PASS} / FAIL {FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
