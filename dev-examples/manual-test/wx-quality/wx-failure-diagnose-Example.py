#!/usr/bin/env python3
"""wx-failure-diagnose.py 合成 fixture 测试（wx-quality T6b）

覆盖（方案 V1.2 P1 验收）：HTTP 401 与 429 不归并（状态码保留）、同根因不同参数归同指纹、
unknown 按 attemptId 去重、敏感串脱敏、interrupted 输出恢复条件事实而非"可 resume"结论、
unresolved 不判失败、排行榜字段齐全、stdout 契约。

用法：python3 wx-failure-diagnose-Example.py（在本目录执行）
stdout 契约：逐断言 [PASS]/[FAIL]，结尾 === ALL PASS === 或 === FAILED n ===；exit 0/1。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "wx-failure-diagnose.py"
DATE = "2026-10-28"

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


def w(path: Path, records: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write((r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)) + "\n")


def build_fixture(root: Path) -> Path:
    data = root / "data"
    runs = root / ".pi-workflows" / "runs"
    t = lambda h, m=0, d=DATE: f"{d}T{h:02d}:{m:02d}:00+08:00"  # noqa: E731

    # tasks：r1a/r1b 429 同根因（不同 runId）；r2 401；r3/r4 工具同根因不同参数；r5 interrupted；r6 completed 不入榜
    w(data / "tasks.jsonl", [
        {"taskBindingId": "tb-1a", "runId": "r1a", "workflowId": "wf-a", "userId": "u1",
         "status": "failed", "messageId": "m1", "createdAt": t(9), "updatedAt": t(10)},
        {"taskBindingId": "tb-1b", "runId": "r1b", "workflowId": "wf-a", "userId": "u1",
         "status": "failed", "messageId": "m2", "createdAt": t(11), "updatedAt": t(12)},
        {"taskBindingId": "tb-2", "runId": "r2", "workflowId": "wf-a", "userId": "u1",
         "status": "failed", "messageId": "m3", "createdAt": t(13), "updatedAt": t(14)},
        {"taskBindingId": "tb-3", "runId": "r3", "workflowId": "wf-b", "userId": "u2",
         "status": "failed", "messageId": "m4", "createdAt": t(15), "updatedAt": t(16)},
        {"taskBindingId": "tb-4", "runId": "r4", "workflowId": "wf-b", "userId": "u2",
         "status": "failed", "messageId": "m5", "createdAt": t(17), "updatedAt": t(18)},
        {"taskBindingId": "tb-5", "runId": "r5", "workflowId": "wf-c", "userId": "u1",
         "status": "interrupted", "messageId": "m6", "createdAt": t(19), "updatedAt": t(20)},
        {"taskBindingId": "tb-6", "runId": "r6", "workflowId": "wf-a", "userId": "u1",
         "status": "completed", "messageId": "m7", "createdAt": t(8), "updatedAt": t(9)},
    ])

    # runs：manifest.error 驱动分类与指纹；r5 带 checkpoint 文件（恢复条件事实）
    manifests = {
        "r1a": {"status": "failed", "error": "HTTP 429 Too Many Requests: openai rate limit exceeded"},
        "r1b": {"status": "failed", "error": "HTTP 429 Too Many Requests: openai rate limit exceeded"},
        "r2": {"status": "failed", "error": "HTTP 401 Unauthorized: invalid api key"},
        "r3": {"status": "failed", "error": 'node "gen-3f" exit code 1: E:\\work\\p\\script-a.py failed'},
        "r4": {"status": "failed", "error": 'node "gen-9a" exit code 1: E:\\work\\q\\script-b.py failed'},
        "r5": {"status": "interrupted", "error": "process killed: budget timeout after 180s"},
    }
    for rid, mf in manifests.items():
        d = runs / rid
        d.mkdir(parents=True, exist_ok=True)
        (d / "manifest.json").write_text(json.dumps({"runId": rid, **mf}, ensure_ascii=False), encoding="utf-8")
        (d / "journal.jsonl").write_text(
            "\n".join(json.dumps({"ts": t(10), "type": "node.start", "node": rid}, ensure_ascii=False)
                      for _ in range(3)) + "\n", encoding="utf-8")
    (runs / "r5" / "checkpoint-abc123.json").write_text("{}", encoding="utf-8")

    # tasks summary 优先级低于 manifest.error？——collect 用 summary or manifestError，这里故意留 summary 为空，
    # 让 manifest.error 生效（真实链路 RunMonitor 会写 summary，此处测 manifest 证据链）
    # run-attempts：la-2 unknown（两条审计事件在 audit，不计条数）；la-3 launched 未 link（远过去 → unresolved）
    w(data / "run-attempts.jsonl", [
        {"attemptId": "la-2", "userId": "u1", "workflowId": "wf-c", "argsDigest": "d2",
         "originMessageId": "m5a", "status": "launched", "createdAt": t(15, 30)},
        {"attemptId": "la-2", "userId": "u1", "workflowId": "wf-c", "argsDigest": "d2",
         "status": "unknown", "createdAt": t(15, 30)},
        {"attemptId": "la-3", "userId": "u2", "workflowId": "wf-b", "argsDigest": "d3",
         "status": "launched", "createdAt": t(0, 5)},
    ])

    # audit：la-2 的 unknown 两条（attemptId 去重验证——诊断只扫 run-attempts，不重复计数）
    w(data / "audit.jsonl", [
        {"auditId": "au-4", "at": t(16), "actor": "u1", "action": "am.launch.unknown",
         "target": {"attemptId": "la-2"}, "outcome": "failed"},
        {"auditId": "au-5", "at": t(16, 1), "actor": "system", "action": "am.recovery.uncertain",
         "target": {"attemptId": "la-2"}, "outcome": "failed"},
    ])

    # outbox：ob-9 failed 带敏感串（脱敏断言）
    w(data / "outbox.jsonl", [
        {"outboxId": "ob-9", "userId": "u1", "kind": "completed", "runId": "r6",
         "status": "failed", "attempts": 5, "createdAt": t(21),
         "lastError": "send failed: auth sk-abc123456XYZ rejected, token=secret123456 expired"},
    ])
    return data


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="wx-diag-"))
    try:
        data = build_fixture(root)
        out = root / "quality-out"
        p = subprocess.run(
            [sys.executable, str(SCRIPT), "--data", str(data), "--date", DATE,
             "--days", "1", "--top", "10", "--out", str(out)],
            capture_output=True, text=True, encoding="utf-8",
        )
        output = p.stdout + p.stderr
        print("---- 脚本输出 ----")
        print(output)
        print("------------------")
        r = json.loads((out / f"diagnose-{DATE}.json").read_text(encoding="utf-8"))
        board = r["leaderboard"]
        by_cat = {}
        for row in board:
            by_cat.setdefault(row["category"], []).append(row)
        raw_text = json.dumps(r, ensure_ascii=False) + (out / f"diagnose-{DATE}.md").read_text(encoding="utf-8")

        # 1) 401 与 429 不归并（errorCode 保留）
        api = by_cat.get("MODEL_API_ERROR", [])
        codes = sorted(x["errorCode"] for x in api)
        if codes == ["401", "429"]:
            ok(f"MODEL_API_ERROR 401/429 分开（两类指纹），共 {len(api)} 类")
        else:
            bad(f"MODEL_API_ERROR errorCodes={codes}")

        # 2) 同根因不同 runId 归同指纹（r1a/r1b 429）
        row429 = next((x for x in api if x["errorCode"] == "429"), None)
        if row429 and row429["count"] == 2 and row429["affectedTasks"] == 2:
            ok(f"429 同指纹聚合：count={row429['count']}，影响任务 {row429['affectedTasks']}")
        else:
            bad(f"429 聚合异常: {row429}")

        # 3) 同根因不同参数（node id/路径不同）归同指纹
        tool = by_cat.get("TOOL_EXEC_ERROR", [])
        if len(tool) == 1 and tool[0]["count"] == 2 and "<path>" in tool[0]["normalizedMessage"]:
            ok(f"TOOL_EXEC_ERROR 归一化同指纹（count=2，路径已归一）：{tool[0]['normalizedMessage'][:60]}")
        else:
            bad(f"TOOL_EXEC_ERROR={[(x['count'], x['normalizedMessage'][:50]) for x in tool]}")

        # 4) unknown 按 attemptId 去重（2 条审计 → 1 条 issue）
        au = by_cat.get("AGENT_UNKNOWN", [])
        if len(au) == 1 and au[0]["count"] == 1 and "必须人工" in au[0]["recoverability"]:
            ok("AGENT_UNKNOWN 1 条（attemptId 去重），可恢复性=必须人工")
        else:
            bad(f"AGENT_UNKNOWN={[(x['count'], x['recoverability']) for x in au]}")

        # 5) unresolved 不判失败
        rs = [x for x in by_cat.get("RUN_START_ERROR", []) if "未 link" in x["normalizedMessage"]]
        if len(rs) == 1 and "必须人工" in rs[0]["recoverability"]:
            ok("unresolved 归 RUN_START_ERROR 且必须人工（不判失败）")
        else:
            bad(f"unresolved rows={[(x['category'], x['recoverability']) for x in rs]}")

        # 6) 敏感串脱敏
        if "sk-abc123456XYZ" not in raw_text and "secret123456" not in raw_text:
            ok("敏感串已脱敏（sk-/token= 不出现原文）")
        else:
            bad("敏感串泄漏")

        # 7) interrupted 恢复条件事实，不标可 resume
        wf = by_cat.get("WORKFLOW_ERROR", [])
        row5 = next((x for x in wf if any(s == "r5" for s in x["sampleIds"])), None)
        if row5 and "需人工评估" in row5["recoverability"] and "checkpoint文件: 有" in row5["recoverability"] \
                and "resume" not in row5["recoverability"]:
            ok(f"interrupted 可恢复性=需人工评估+checkpoint 事实：{row5['recoverability'][:60]}")
        else:
            bad(f"interrupted row={row5}")

        # 8) 排行榜排序（count 降序）与字段齐全
        counts = [x["count"] for x in board]
        fields_ok = all(set(("fingerprint", "category", "errorCode", "count", "affectedTasks",
                             "workflows", "firstSeen", "lastSeen", "recoverability",
                             "sampleIds", "evidencePaths")) <= set(x) for x in board)
        if counts == sorted(counts, reverse=True) and fields_ok:
            ok(f"排序 count 降序 {counts}，字段齐全（{len(board)} 类）")
        else:
            bad(f"排序/字段异常 counts={counts} fields_ok={fields_ok}")

        # 9) completed 任务不入榜
        if all("r6" not in (x.get("sampleIds") or []) for x in board if x["category"] != "NOTIFY_ERROR"):
            ok("completed 任务不入榜（仅其失败通知 ob-9 入 NOTIFY_ERROR）")
        else:
            bad("completed 任务误入榜")

        # 10) stdout 契约
        if "[OK]" in output and "=== ALL DONE ===" in output and p.returncode == 0:
            ok("stdout 契约 + exit 0")
        else:
            bad(f"rc={p.returncode}")
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n=== {'ALL PASS' if FAIL == 0 else f'FAILED {FAIL}'} ===（PASS {PASS} / FAIL {FAIL}）")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
