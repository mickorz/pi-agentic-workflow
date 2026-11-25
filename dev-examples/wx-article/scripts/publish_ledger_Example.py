#!/usr/bin/env python3
"""publish_ledger_Example.py —— 发布登记脚本测试（零 LLM，可重复）。

覆盖：
- add 首条登记 + 索引文件生成
- list 全量列出
- add 同 media_id 去重（SKIP 不重复登记）
- list 按类型过滤
- 多类型标签存储与查询
- 缺参数报错退出码 1

运行：python publish_ledger_Example.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def run(args: list[str]) -> tuple[int, str]:
    r = subprocess.run(
        [sys.executable, str(HERE / "publish_ledger.py")] + args,
        capture_output=True, text=True, encoding="utf-8",
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="ledger-example-"))
    vault = tmp / "v"
    marker = vault / "60_Workspace/写作/单篇"
    a1 = marker / "20261125/dsh-game-skill"
    a1.mkdir(parents=True)
    a2 = marker / "20261124/riemann"
    a2.mkdir(parents=True)

    # 1) add 首条
    code, out = run(["add", "--article-dir", str(a1), "--title", "AI做3D动作游戏，Boss战都有了",
                     "--kind", "sticker", "--types", "AI做游戏,开源项目,Claude Code",
                     "--media-id", "M1", "--vault-root", str(vault)])
    check("1 add 首条退出码0", code == 0, out)
    check("1 输出 LEDGER SAVED", "=== LEDGER SAVED ===" in out, out)
    idx = vault / "60_Workspace/写作/单篇/发布索引.json"  # vault_root 语义=vault 根
    check("1 索引文件生成", idx.exists())
    data = json.loads(idx.read_text(encoding="utf-8"))
    check("1 索引含 1 条", len(data["entries"]) == 1)

    # 2) 同 media_id 去重
    code, out = run(["add", "--article-dir", str(a1), "--title", "重复登记", "--kind", "sticker",
                     "--types", "AI做游戏", "--media-id", "M1", "--vault-root", str(vault)])
    check("2 去重 SKIP", code == 0 and "[SKIP]" in out, out)
    data = json.loads(idx.read_text(encoding="utf-8"))
    check("2 仍 1 条", len(data["entries"]) == 1)

    # 3) add 第二条（不同类型）
    code, out = run(["add", "--article-dir", str(a2), "--title", "Claude真的证明了黎曼猜想吗",
                     "--kind", "article", "--types", "AI行业动态,核实", "--media-id", "M2",
                     "--vault-root", str(vault)])
    check("3 add 第二条", code == 0, out)

    # 4) list 全量
    code, out = run(["list", "--article-dir", str(a1), "--vault-root", str(vault)])
    check("4 list 全量 2 条", code == 0 and "共 2 条" in out, out)
    check("4 含标题", "AI做3D动作游戏" in out and "黎曼猜想" in out, out)

    # 5) list 按类型过滤
    code, out = run(["list", "--article-dir", str(a1), "--type", "AI做游戏", "--vault-root", str(vault)])
    check("5 过滤后 1 条", code == 0 and "共 1 条" in out and "AI做3D动作游戏" in out, out)

    # 6) 缺参数报错
    code, out = run(["add", "--article-dir", str(a1), "--vault-root", str(vault)])
    check("6 缺参数退出码1", code == 1 and "[FAIL]" in out, out)

    # 7) 非 vault 路径且未指定 vault-root
    code, out = run(["add", "--article-dir", str(tmp / "nowhere"), "--title", "x", "--kind", "sticker",
                     "--types", "x"])
    check("7 无法推断 vault root 报错", code == 1 and "[FAIL] 无法推断" in out, out)

    shutil = None
    import shutil as _sh
    _sh.rmtree(tmp, ignore_errors=True)
    print(f"\n汇总 PASS={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        sys.exit(1)
    print("=== ALL DONE ===")


if __name__ == "__main__":
    main()
