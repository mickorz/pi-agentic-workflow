#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""session_usage_report.py 自检（脚本名+Example 约定）。

覆盖: 阶段窗归因聚合（calls/四类 Token 分列）、未归属尾窗、归因可信度 high/low、
非对话 usage 条目提示、工具调用计数、--sessions-dir 自动挑选、错误路径。
全部 assert, 无框架。时区无关: time-log 时间戳由 UTC 测试数据转本地生成。
运行: python3 session_usage_report_Example.py
"""
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "session_usage_report.py"


def run(*args):
    r = subprocess.run([sys.executable, str(SCRIPT)] + list(args),
                       capture_output=True, text=True, encoding="utf-8")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def utc_iso(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc).isoformat()


def local_iso(y, mo, d, h, mi):
    """UTC 时刻转本地 naive ISO（与被测脚本同口径），保证 time-log 与 session 同一瞬间。"""
    dt = datetime(y, mo, d, h, mi, tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
    return dt.isoformat(timespec="seconds")


def msg_entry(eid, ts, tools, usage):
    content = [{"type": "toolCall", "id": "t_%s_%d" % (eid, i), "name": n, "arguments": {}}
               for i, n in enumerate(tools)]
    return {"type": "message", "id": eid, "timestamp": ts,
            "message": {"role": "assistant", "content": content, "usage": usage}}


def usage_entry(ts, kind, total):
    return {"type": "usage", "id": "u_" + kind, "timestamp": ts, "kind": kind,
            "usage": {"input": 0, "output": 0, "cacheRead": total, "cacheWrite": 0,
                      "totalTokens": total, "cost": {"total": 0}}}


def write_session(f, entries):
    lines = [{"type": "session", "version": 3, "id": f.name, "timestamp": entries[0]["timestamp"], "cwd": "."}]
    lines += entries
    f.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in lines), encoding="utf-8")


def write_timelog(d, stage_ts):
    d.mkdir(parents=True, exist_ok=True)
    rows = [{"ts": stage_ts["start"], "stage": "定位", "event": "start"}]
    for stage, ts in stage_ts["points"]:
        rows.append({"ts": ts, "stage": stage, "event": "done"})
    (d / "time-log.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        art = tmp / "20261111" / "测试篇"
        # 阶段完成点（本地时间, 由 UTC 换算）: 定位 01:55Z, 写作 02:50Z, 发布 03:00Z；start 01:45Z
        write_timelog(art, {
            "start": local_iso(2026, 11, 11, 1, 45),
            "points": [("定位", local_iso(2026, 11, 11, 1, 55)),
                       ("写作", local_iso(2026, 11, 11, 2, 50)),
                       ("发布", local_iso(2026, 11, 11, 3, 0))],
        })

        # 场景A: m4 大 token 在窗外 → 未归属占比高 → low
        sessA = tmp / "sessA.jsonl"
        write_session(sessA, [
            msg_entry("m1", utc_iso(2026, 11, 11, 1, 50), ["read"],
                      {"input": 100, "output": 10, "cacheRead": 50, "cacheWrite": 0,
                       "reasoning": 5, "totalTokens": 160, "cost": {"total": 0.01}}),
            msg_entry("m2", utc_iso(2026, 11, 11, 2, 20), ["bash", "bash", "edit"],
                      {"input": 800, "output": 100, "cacheRead": 100, "cacheWrite": 0,
                       "reasoning": 0, "totalTokens": 1000, "cost": {"total": 0.02}}),
            msg_entry("m3", utc_iso(2026, 11, 11, 2, 35), [],
                      {"input": 1500, "output": 400, "cacheRead": 100, "cacheWrite": 0,
                       "reasoning": 20, "totalTokens": 2000, "cost": {"total": 0.03}}),
            msg_entry("m4", utc_iso(2026, 11, 11, 3, 30), [],
                      {"input": 50000, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                       "reasoning": 0, "totalTokens": 50000, "cost": {"total": 0}}),
            usage_entry(utc_iso(2026, 11, 11, 1, 46), "cache_warm", 500),
        ])
        code, out = run("--article-dir", str(art), "--session", str(sessA))
        assert code == 0 and "ALL DONE" in out, (code, out)
        for expect in ["定位", "写作", "发布", "未归属", "汇总",
                       "1 条非对话 usage 条目", "500 tokens", "read×1", "bash×2",
                       "归因可信度: low", "94.1%"]:
            assert expect in out, (expect, out)
        # 归因检查: 定位 1 次调用, 写作 2 次, 未归属 1 次
        loc = [l for l in out.splitlines() if l.startswith("定位 ")][0]
        assert loc.split()[1] == "1" and " 100" in loc, loc
        wri = [l for l in out.splitlines() if l.startswith("写作 ")][0]
        assert wri.split()[1] == "2", wri
        una = [l for l in out.splitlines() if l.startswith("未归属 ")][0]
        assert una.split()[1] == "1", una

        # 场景B: 窗外消息 token 极小 → high
        sessB = tmp / "sessB.jsonl"
        write_session(sessB, [
            msg_entry("m1", utc_iso(2026, 11, 11, 1, 50), [],
                      {"input": 100, "output": 10, "cacheRead": 50, "cacheWrite": 0,
                       "reasoning": 0, "totalTokens": 160, "cost": {"total": 0}}),
            msg_entry("m4", utc_iso(2026, 11, 11, 3, 30), [],
                      {"input": 4, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                       "reasoning": 0, "totalTokens": 4, "cost": {"total": 0}}),
        ])
        code, out = run("--article-dir", str(art), "--session", str(sessB))
        assert code == 0 and "归因可信度: high" in out, (code, out)

        # 自动挑选: 干扰文件无窗内消息 → 选中 sessA
        decoy = tmp / "decoy.jsonl"
        write_session(decoy, [
            msg_entry("d1", utc_iso(2026, 11, 10, 9, 0), [],
                      {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0,
                       "reasoning": 0, "totalTokens": 2, "cost": {"total": 0}}),
        ])
        code, out = run("--article-dir", str(art), "--sessions-dir", str(tmp))
        assert code == 0 and "自动选中 session: sessA.jsonl" in out, (code, out)

        # 错误路径: 目录不存在 / 缺 time-log / session 不存在 / 无重叠
        code, out = run("--article-dir", str(tmp / "不存在"), "--session", str(sessA))
        assert code == 2 and "[FAIL]" in out, out
        empty = tmp / "空篇"
        empty.mkdir()
        code, out = run("--article-dir", str(empty), "--session", str(sessA))
        assert code == 2 and "[FAIL]" in out, out
        code, out = run("--article-dir", str(art), "--session", str(tmp / "没有.jsonl"))
        assert code == 2 and "[FAIL]" in out, out
        code, out = run("--article-dir", str(art), "--sessions-dir", str(empty))
        assert code == 2 and "[FAIL]" in out, out

    print("=== ALL TESTS PASSED ===")


if __name__ == "__main__":
    main()
