#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""track_time.py 自检（脚本名+Example 约定）。

覆盖: log 正常/补录 --ts/非法目录/非法时间戳; report 单篇差分算法（含同阶段多条取最后）、
占比计算、vault 跨篇汇总。全部 assert, 无框架。运行: python3 track_time_example.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "track_time.py"


def run(*args):
    r = subprocess.run([sys.executable, str(SCRIPT)] + list(args),
                       capture_output=True, text=True, encoding="utf-8")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        a = Path(tmp) / "20261111" / "工具瘦身"
        a.mkdir(parents=True)
        b = Path(tmp) / "20261112" / "第二篇"
        b.mkdir(parents=True)

        # 1) log 正常记录 + start 事件 + 补录 --ts
        cases = [
            ("log", "--article-dir", str(a), "--stage", "定位", "--event", "start", "--ts", "2026-11-11T10:00:00"),
            ("log", "--article-dir", str(a), "--stage", "定位", "--ts", "2026-11-11T10:10:00"),
            ("log", "--article-dir", str(a), "--stage", "写作", "--ts", "2026-11-11T10:40:00"),
            ("log", "--article-dir", str(a), "--stage", "发布", "--ts", "2026-11-11T11:10:00"),
        ]
        for c in cases:
            code, out = run(*c)
            assert code == 0 and "[OK]" in out, (c, code, out)

        # 2) 同阶段重复记录: 写作补一条更晚时间, 报告应取最后一条(10:50)
        code, out = run("log", "--article-dir", str(a), "--stage", "写作", "--ts", "2026-11-11T10:50:00")
        assert code == 0, out

        # 3) 单篇报告: 定位 10(10:00->10:10) 写作 40(10:10->10:50) 发布 20(10:50->11:10) 总 70
        code, out = run("report", "--article-dir", str(a))
        assert code == 0, out
        for expect in ["单篇耗时报告", "70 min", "定位", "写作", "发布", "14%", "57%", "29%", "ALL DONE"]:
            assert expect in out, (expect, out)
        # 4) 损坏行容忍: 插入坏行后仍能出报告
        logf = a / "time-log.jsonl"
        bad = logf.read_text(encoding="utf-8") + "这不是JSON\n"
        logf.write_text(bad, encoding="utf-8")
        code, out = run("report", "--article-dir", str(a))
        assert code == 0 and "[WARN]" in out, out

        # 5) vault 汇总: 两篇都被扫到; 单事件篇总耗时为 0
        code, out = run("log", "--article-dir", str(b), "--stage", "发布", "--ts", "2026-11-12T09:00:00")
        assert code == 0, out
        code, out = run("report", "--vault-root", tmp)
        assert code == 0, out
        assert "工具瘦身" in out and "第二篇" in out, out
        assert "平均总耗时" in out and "ALL DONE" in out, out

        # 6) 错误路径: 目录不存在 / 时间戳非法 / report 无数据
        code, out = run("log", "--article-dir", str(Path(tmp) / "不存在"), "--stage", "写作")
        assert code == 2 and "[FAIL]" in out, out
        code, out = run("log", "--article-dir", str(a), "--stage", "写作", "--ts", "不是时间")
        assert code == 2 and "[FAIL]" in out, out
        empty = Path(tmp) / "20261113" / "空篇"
        empty.mkdir(parents=True)
        code, out = run("report", "--article-dir", str(empty))
        assert code == 2 and "[FAIL]" in out, out

        # 7) 交互点事件: interaction 缺 --result → FAIL; result 非法 → FAIL
        code, out = run("log", "--article-dir", str(a), "--stage", "写作", "--interaction", "approval")
        assert code == 2 and "[FAIL]" in out, out
        code, out = run("log", "--article-dir", str(a), "--stage", "写作",
                        "--interaction", "approval", "--result", "随便")
        assert code == 2 and "[FAIL]" in out, out

        # 8) 交互点正常记录: confirm / rework+artifacts
        code, out = run("log", "--article-dir", str(a), "--stage", "写作",
                        "--interaction", "approval", "--result", "confirm", "--ts", "2026-11-11T10:30:00")
        assert code == 0 and "[OK]" in out, out
        code, out = run("log", "--article-dir", str(a), "--stage", "写作",
                        "--interaction", "approval", "--result", "rework",
                        "--artifacts", "chapter-03.md,chapter-04.md", "--ts", "2026-11-11T10:55:00")
        assert code == 0 and "chapter-03.md" in out, out

        # 9) 交互不污染阶段差分: 写作仍是 10:10->10:50=40min（交互事件 10:30/10:55 被忽略）
        code, out = run("report", "--article-dir", str(a))
        assert code == 0, out
        for expect in ["交互合计: 2 次", "审批返工率 1/2", "50%", "修改产物 2 个", "10:30", "10:55"]:
            assert expect in out, (expect, out)

        # 10) 旧格式兼容: b 目录无交互事件，报告无交互节且不报错
        code, out = run("report", "--article-dir", str(b))
        assert code == 0 and "交互合计" not in out, out

    print("=== ALL TESTS PASSED ===")


if __name__ == "__main__":
    main()
