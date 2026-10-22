#!/usr/bin/env python3
"""AM-9 启动后绑定前崩溃（kill -9 注入）—— 两分支断言：自动补链 / unknown 禁重试
用法：python3 dev-examples/am-p0/kill-window-suite.py   （逐断言 PASS/FAIL，结尾汇总）
（自 kill-window-suite.sh 忠实移植；stdout 文本契约不变）
"""
from __future__ import annotations

import json
import os
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
ROOT = HERE.parent.parent
ENTRY = str(ROOT / "dev-examples" / "am-p0" / "crash-window.ts")

PASS = 0
FAIL = 0


def say(*args: object) -> None:
    print(*args, flush=True)


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    say(f"PASS: {msg}")


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    say(f"FAIL: {msg}")


def assert_eq(actual: object, expected: object, label: str) -> None:
    """等价 assert_eq actual expected label（字符串比较）。"""
    if str(actual) == str(expected):
        ok(f"{label} (={actual})")
    else:
        bad(f"{label}：期望 {expected} 实得 {actual}")


child: subprocess.Popen | None = None


def run_child(mode: str, data_dir: Path) -> bool:
    """mode dataDir → 全局 child；等 READY 后由调用方 kill。"""
    global child
    with open(data_dir / "child.log", "wb") as log:
        child = subprocess.Popen(
            ["npx", "tsx", ENTRY, mode, str(data_dir)], stdout=log, stderr=subprocess.STDOUT
        )
    for _ in range(120):
        try:
            if "READY" in (data_dir / "child.log").read_text(encoding="utf-8", errors="replace"):
                return True
        except OSError:
            pass
        if child.poll() is not None:
            break
        time.sleep(0.25)
    return False


def kill_child() -> None:
    if child is None:
        return
    try:
        child.send_signal(signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        child.wait()
    except OSError:
        pass


def last_line_of(args: list[str]) -> str:
    """等价 OUT="$(cmd | tail -1)"：取 stdout 最后一行（stderr 直通不捕获）。"""
    p = subprocess.run(args, stdout=subprocess.PIPE, text=True)
    lines = [ln for ln in (p.stdout or "").splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def json_field(out: str, field: str) -> str:
    """等价 node -e 解析末行 JSON 取字段；解析失败/缺字段返回空串。"""
    try:
        v = json.loads(out)[field]
    except Exception:
        return ""
    if isinstance(v, bool):  # node console.log 布尔输出为 true/false
        return "true" if v else "false"
    return str(v)


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="am-kill-", dir="/tmp")
    try:
        say("── 分支 1：启动成功+绑定落盘 → kill -9 于 link 前 → 恢复自动补链")
        d1 = Path(tmp) / "case1"
        d1.mkdir(parents=True)
        if run_child("prime-linked", d1):
            kill_child()
            out = last_line_of(["npx", "tsx", ENTRY, "recover", str(d1)])
            assert_eq(json_field(out, "linked"), 1, "对上 TaskBinding → 自动补链 1 条")
            assert_eq(json_field(out, "unknown"), 0, "无 unknown")
            starts = last_line_of(["npx", "tsx", ENTRY, "service-starts", str(d1)])
            assert_eq(starts, 1, "恢复期零新启动（总启动数仍为崩溃前的 1）")
        else:
            bad("prime-linked 子进程未达 READY")
            kill_child()

        say("── 分支 2：仅预写（start 前被杀）→ 恢复 unknown + 禁自动重试")
        d2 = Path(tmp) / "case2"
        d2.mkdir(parents=True)
        if run_child("prime-unknown", d2):
            kill_child()
            out = last_line_of(["npx", "tsx", ENTRY, "recover", str(d2)])
            assert_eq(json_field(out, "linked"), 0, "无绑定 → 不补链")
            assert_eq(json_field(out, "unknown"), 1, "标记 unknown（人工核对）")
            starts = last_line_of(["npx", "tsx", ENTRY, "service-starts", str(d2)])
            assert_eq(starts, 0, "禁自动重试：全程零启动")
        else:
            bad("prime-unknown 子进程未达 READY")
            kill_child()

        say("")
        say(f"汇总：PASS={PASS} FAIL={FAIL}")
        return 0 if FAIL == 0 else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
