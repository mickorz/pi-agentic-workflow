#!/usr/bin/env python3
"""notify_bot.py 自检：SKIP 路径 / 追加格式 / kind 归一。运行即断言，结尾汇总。"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NOTIFY = HERE / "notify_bot.py"
results: list[tuple[str, bool]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" | {detail}" if not cond and detail else ""))


def run(*extra: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(NOTIFY), *extra],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")


with tempfile.TemporaryDirectory() as td:
    # 1) 无 bound-user => SKIP 退出 0
    r = run("--text", "你好", "--data-dir", td)
    check("skip-no-binding", r.returncode == 0 and "[SKIP]" in r.stdout, r.stdout + r.stderr)

    # 2) 有绑定 => 追加 pending 行,格式与服务端 NotificationOutboxItem 一致
    (Path(td) / "bound-user.json").write_text(json.dumps({"userId": "user-x@im.wechat"}), encoding="utf-8")
    r = run("--text", "完成了：测试草稿", "--kind", "completed", "--data-dir", td)
    items = [json.loads(l) for l in (Path(td) / "outbox.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    ok = (r.returncode == 0 and "[OK]" in r.stdout and len(items) == 1
          and items[0]["userId"] == "user-x@im.wechat" and items[0]["kind"] == "completed"
          and items[0]["status"] == "pending" and items[0]["text"] == "完成了：测试草稿"
          and items[0]["outboxId"].startswith("ob-") and "createdAt" in items[0])
    check("append-pending-format", ok, json.dumps(items, ensure_ascii=False))

    # 3) 非法 kind 归一为 info
    run("--text", "x", "--kind", "bogus", "--data-dir", td)
    items = [json.loads(l) for l in (Path(td) / "outbox.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    check("invalid-kind-normalized", items[-1]["kind"] == "info")

print(f"===== SUMMARY: PASS {sum(1 for _, ok in results if ok)} / FAIL {sum(1 for _, ok in results if not ok)} =====")
sys.exit(0 if all(ok for _, ok in results) else 1)
