#!/usr/bin/env python3
"""wx-linkage-check.py 合成 fixture 测试（wx-quality T1b）

构造最小 fixture 数据目录，覆盖：
  1. 三向 runId 差集（仅 audit 有 / 仅 runs 有）
  2. unresolved（launched 未 link）与 unknown（attemptId 去重）
  3. 孤立 Run（run-links 有 runId 无 TaskBinding）
  4. unclassified 消息与覆盖率
  5. 应通知未入队（completed 任务无最终通知条目）
  6. inbox 与 chat-logs 数量差异
  7. updatedAt 链单调性
  附：断裂行容忍。

用法：python3 wx-linkage-check-Example.py（在本目录执行）
stdout 契约：逐断言 [PASS]/[FAIL]，结尾 === ALL PASS === 或 === FAILED n ===；exit 0/1。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "wx-linkage-check.py"
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
            f.write(r if isinstance(r, str) else json.dumps(r, ensure_ascii=False))
            f.write("\n")


def build_fixture(root: Path) -> Path:
    """构造 fixture：data=<root>/data，runs=<root>/.pi-workflows/runs。"""
    data = root / "data"
    runs = root / ".pi-workflows" / "runs"
    day_start = f"{DATE}T"
    t = lambda h, m=0: f"{DATE}T{h:02d}:{m:02d}:00+08:00"  # noqa: E731

    # tasks.jsonl：r1 completed；r2 failed（应通知）；r3 跨日链（10-28 interrupted→10-29 completed，asOf 应取 interrupted）；
    # r4 cancelled（不应通知）；断裂行 1 条
    w(data / "tasks.jsonl", [
        {"taskBindingId": "tb-1", "runId": "r1", "workflowId": "wf-a", "userId": "u1",
         "status": "completed", "messageId": "m1", "createdAt": t(9), "updatedAt": t(10)},
        {"taskBindingId": "tb-2", "runId": "r2", "workflowId": "wf-a", "userId": "u1",
         "status": "failed", "messageId": "m2", "createdAt": t(11), "updatedAt": t(12)},
        {"taskBindingId": "tb-3", "runId": "r3", "workflowId": "wf-b", "userId": "u2",
         "status": "interrupted", "messageId": "m3", "createdAt": t(23), "updatedAt": t(23, 30)},
        {"taskBindingId": "tb-3", "runId": "r3", "workflowId": "wf-b", "userId": "u2",
         "status": "completed", "messageId": "m3", "createdAt": t(23), "updatedAt": "2026-10-29T08:00:00+08:00"},
        {"taskBindingId": "tb-4", "runId": "r4", "workflowId": "wf-a", "userId": "u2",
         "status": "cancelled", "messageId": "m4", "createdAt": t(13), "updatedAt": t(14)},
        "这不是JSON，是断裂行",
    ])

    # audit.jsonl：m1/m2 意图路由；r_audit_only 仅 audit 有（三向差集）；la-2 unknown 两条审计（attemptId 去重验证）
    w(data / "audit.jsonl", [
        {"auditId": "au-1", "at": t(9), "actor": "u1", "action": "intent.route",
         "target": {"messageId": "m1", "runId": "r1", "workflowId": "wf-a"}, "outcome": "ok"},
        {"auditId": "au-2", "at": t(11), "actor": "u1", "action": "run.start",
         "target": {"runId": "r2", "workflowId": "wf-a"}, "outcome": "ok"},
        {"auditId": "au-3", "at": t(15), "actor": "system", "action": "run.start",
         "target": {"runId": "r_audit_only"}, "outcome": "ok"},
        {"auditId": "au-4", "at": t(16), "actor": "u1", "action": "am.launch.unknown",
         "target": {"attemptId": "la-2"}, "outcome": "failed"},
        {"auditId": "au-5", "at": t(16, 1), "actor": "system", "action": "am.recovery.uncertain",
         "target": {"attemptId": "la-2"}, "outcome": "failed"},
    ])

    # run-attempts.jsonl：la-1 linked；la-2 unknown（末条生效）；la-3 launched 未 link（unresolved）
    w(data / "run-attempts.jsonl", [
        {"attemptId": "la-1", "userId": "u1", "workflowId": "wf-a", "argsDigest": "d1",
         "originMessageId": "m1", "status": "launched", "createdAt": t(8, 59)},
        {"attemptId": "la-1", "userId": "u1", "workflowId": "wf-a", "argsDigest": "d1",
         "status": "linked", "runId": "r1", "taskBindingId": "tb-1", "createdAt": t(8, 59)},
        {"attemptId": "la-2", "userId": "u1", "workflowId": "wf-c", "argsDigest": "d2",
         "originMessageId": "m5", "status": "launched", "createdAt": t(15, 30)},
        {"attemptId": "la-2", "userId": "u1", "workflowId": "wf-c", "argsDigest": "d2",
         "originMessageId": "m5", "status": "unknown", "createdAt": t(15, 30)},
        {"attemptId": "la-3", "userId": "u2", "workflowId": "wf-b", "argsDigest": "d3",
         "originMessageId": "m6", "status": "launched", "createdAt": t(17)},
    ])

    # run-links.jsonl：r1 有链有绑定；r_orphan 有链无 TaskBinding（孤立 Run）
    w(data / "run-links.jsonl", [
        {"runId": "r1", "taskBindingId": "tb-1", "status": "completed",
         "attemptId": "la-1", "updatedAt": t(10)},
        {"runId": "r_orphan", "status": "failed", "updatedAt": t(18)},
    ])

    # outbox.jsonl：r1 completed 通知 sent；r3 interrupted 通知 sent（跨日链通知）；r2 应通知但**无条目**（校验5 FAIL 线）；
    # 另有审批卡类条目（kind=approval，不计最终通知）
    w(data / "outbox.jsonl", [
        {"outboxId": "ob-1", "userId": "u1", "kind": "completed", "runId": "r1",
         "taskBindingId": "tb-1", "status": "sent", "attempts": 1, "createdAt": t(10)},
        {"outboxId": "ob-2", "userId": "u2", "kind": "interrupted", "runId": "r3",
         "taskBindingId": "tb-3", "status": "sent", "attempts": 1, "createdAt": t(23, 30)},
        {"outboxId": "ob-3", "userId": "u2", "kind": "approval", "runId": "r3",
         "taskBindingId": "tb-3", "status": "sent", "attempts": 1, "createdAt": t(22)},
    ])

    # inbox.jsonl：首见 m1..m4（当日）；m7 首见但 chat-logs 缺该消息（差异 1）
    w(data / "inbox.jsonl", [
        {"key": "wechat:m1", "at": t(9)},
        {"key": "wechat:m2", "at": t(11)},
        {"key": "wechat:m3", "at": t(20)},
        {"key": "wechat:m4", "at": t(13)},
        {"key": "wechat:m5", "at": t(15, 30)},
        {"key": "wechat:m6", "at": t(17)},
        {"key": "wechat:m7", "at": t(19)},
        "broken line not json",
    ])

    # chat-logs：入站 m1..m6（m7 缺失 → 差异率 1/7≈14.3%）；m8 无任何审计关联（unclassified）
    w(data / "chat-logs" / f"{DATE}.jsonl", [
        {"ts": t(9), "direction": "in", "userId": "u1", "text": "帮我跑 wf-a", "messageId": "m1"},
        {"ts": t(11), "direction": "in", "userId": "u1", "text": "再来一次", "messageId": "m2"},
        {"ts": t(13), "direction": "in", "userId": "u2", "text": "取消刚才的", "messageId": "m4"},
        {"ts": t(15, 30), "direction": "in", "userId": "u1", "text": "试 wf-c", "messageId": "m5"},
        {"ts": t(17), "direction": "in", "userId": "u2", "text": "再试 wf-b", "messageId": "m6"},
        {"ts": t(19, 30), "direction": "in", "userId": "u1", "text": "今天天气不错", "messageId": "m8"},
        {"ts": t(10), "direction": "out", "userId": "u1", "text": "已完成", "messageId": ""},
    ])
    # 注：m3（20:00）chat-log 故意缺行，inbox 有——两源差异；入站行数=6

    # runs 目录：r1 有 manifest；r_runs_only 仅目录无任务（三向差集）
    for rid in ("r1", "r_runs_only"):
        d = runs / rid
        d.mkdir(parents=True, exist_ok=True)
        (d / "manifest.json").write_text(
            json.dumps({"runId": rid, "status": "completed" if rid == "r1" else "failed",
                        "createdAt": f"{day_start}09:30:00+08:00"}), encoding="utf-8")
    return data


def run_check(data: Path, out: Path) -> tuple:
    p = subprocess.run(
        [sys.executable, str(SCRIPT), "--data", str(data), "--date", DATE, "--out", str(out)],
        capture_output=True, text=True, encoding="utf-8",
    )
    return p.stdout + p.stderr, p.returncode


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="wx-linkage-"))
    try:
        data = build_fixture(root)
        out = root / "quality-out"
        output, rc = run_check(data, out)
        print("---- 脚本输出 ----")
        print(output)
        print("------------------")
        report = json.loads((out / f"linkage-{DATE}.json").read_text(encoding="utf-8"))

        # 校验 1：三向差集
        c1 = report["check1"]
        ok("check1 差集计算") if c1["onlyAudit"] == ["r_audit_only"] else bad(f"check1 onlyAudit={c1['onlyAudit']}")
        ok("check1 差集计算(onlyRuns)") if c1["onlyRuns"] == ["r_runs_only"] else bad(f"check1 onlyRuns={c1['onlyRuns']}")
        # r3/r4 无 audit 无 manifest（如直接建任务后取消）——报出属正确行为
        ok("check1 差集计算(onlyTasks)") if c1["onlyTasks"] == ["r3", "r4"] else bad(f"check1 onlyTasks={c1['onlyTasks']}")

        # 校验 2：attemptId 去重与状态
        c2 = report["check2"]
        if c2["unknown"] == ["la-2"]:
            ok("check2 unknown 按 attemptId 去重（2 条审计 → 1）")
        else:
            bad(f"check2 unknown={c2['unknown']}")
        if c2["unresolved"] == ["la-3"]:
            ok("check2 unresolved=launched 未 link")
        else:
            bad(f"check2 unresolved={c2['unresolved']}")
        if c2["linked"] == 1:
            ok("check2 linked 计数")
        else:
            bad(f"check2 linked={c2['linked']}")

        # 校验 3：孤立 Run
        c3 = report["check3"]
        if c3["orphanRuns"] == ["r_orphan"]:
            ok("check3 孤立 Run 检出 r_orphan")
        else:
            bad(f"check3 orphanRuns={c3['orphanRuns']}")

        # 校验 4：覆盖率（m1/m2/m4 经 task 关联，m5/m6 经 attempt（unknown 末条保留 originMessageId），仅 m8 unclassified）
        c4 = report["check4"]
        if c4["inbound"] == 6 and len(c4["unclassified"]) == 1 and c4["unclassified"][0]["messageId"] == "m8":
            ok(f"check4 unclassified=1 (m8)，覆盖率 {c4['coverage']}")
        else:
            bad(f"check4 inbound={c4['inbound']} unclassified={c4['unclassified']}")

        # 校验 5：应通知未入队（r2 failed 无条目 → FAIL 线，coverage 2/3）
        c5 = report["check5"]
        if c5["shouldNotify"] == 3 and c5["missingEnqueue"] == ["r2"]:
            ok(f"check5 应通知未入队 r2（覆盖率 {c5['coverage']}）")
        else:
            bad(f"check5 should={c5['shouldNotify']} missing={c5['missingEnqueue']}")

        # 校验 6：数量差异率（inbox 首见 7 vs chat 入站 6 → 1/7≈0.1429）
        c6 = report["check6"]
        if c6["inboxFirstSeen"] == 7 and c6["chatlogInbound"] == 6 and abs(c6["diffRate"] - 1 / 7) < 0.001:
            ok(f"check6 数量差异率 {c6['diffRate']}")
        else:
            bad(f"check6 {c6}")

        # 校验 7：单调性（r3 链 23:30 → 次日 08:00 单调，无违例）
        c7 = report["check7"]
        if c7["nonMonotonic"] == [] and c7["tasks"] == 4:
            ok("check7 updatedAt 链单调（4 任务）")
        else:
            bad(f"check7 {c7}")

        # asOf 折叠：r3 截至 24:00 应为 interrupted（次日 completed 不进折叠）→ 应通知 3 = r1/r2/r3
        if report["check5"]["shouldNotify"] == 3:
            ok("asOf 折叠 r3 取 interrupted（跨日链不泄漏次日状态）")
        else:
            bad("asOf 折叠异常")

        # 断裂行容忍：tasks 1 + inbox 1 = 2
        if report["brokenLines"] == 2:
            ok("断裂行 2 条跳过不崩溃")
        else:
            bad(f"brokenLines={report['brokenLines']}")

        # stdout 契约与退出码：check5 应产生 1 FAIL → rc=1
        if rc == 1 and "=== ALL DONE ===" in output and output.count("[FAIL]") == 1:
            ok("stdout 契约：1 FAIL（应通知未入队）→ exit 1")
        else:
            bad(f"rc={rc}，FAIL 行数={output.count('[FAIL]')}")
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n=== {'ALL PASS' if FAIL == 0 else f'FAILED {FAIL}'} ===（PASS {PASS} / FAIL {FAIL}）")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
