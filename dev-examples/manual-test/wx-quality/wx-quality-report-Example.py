#!/usr/bin/env python3
"""wx-quality-report.py 合成 fixture 测试（wx-quality T3b）

覆盖：三层各分类计数、跨日双口径数字差异（asOf interrupted vs final completed）、
unresolved 不判失败、unknown 按 attemptId 去重、审批控制交互词表（C2）、
孤立 Run（C4）、同任务双通知去重与重试链计数、应通知未入队检出、
outbox snapshot_unavailable 标注、断裂行容忍、快照存档、stdout 契约。

用法：python3 wx-quality-report-Example.py（在本目录执行）
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
SCRIPT = HERE / "wx-quality-report.py"
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

    # tasks：r1 completed / r2 failed / r3 跨日链（当日 interrupted → 次日 completed）/
    # r4 cancelled（不应通知）/ r5 running（待确认）/ 断裂行 1
    w(data / "tasks.jsonl", [
        {"taskBindingId": "tb-1", "runId": "r1", "workflowId": "wf-a", "userId": "u1",
         "status": "completed", "messageId": "m1", "createdAt": t(9), "updatedAt": t(10)},
        {"taskBindingId": "tb-2", "runId": "r2", "workflowId": "wf-a", "userId": "u1",
         "status": "failed", "messageId": "m2", "createdAt": t(11), "updatedAt": t(12)},
        {"taskBindingId": "tb-3", "runId": "r3", "workflowId": "wf-b", "userId": "u2",
         "status": "interrupted", "messageId": "m3", "createdAt": t(23), "updatedAt": t(23, 30)},
        {"taskBindingId": "tb-3", "runId": "r3", "workflowId": "wf-b", "userId": "u2",
         "status": "completed", "messageId": "m3", "createdAt": t(23),
         "updatedAt": "2026-10-29T08:00:00+08:00"},
        {"taskBindingId": "tb-4", "runId": "r4", "workflowId": "wf-a", "userId": "u2",
         "status": "cancelled", "messageId": "m4", "createdAt": t(13), "updatedAt": t(14)},
        {"taskBindingId": "tb-5", "runId": "r5", "workflowId": "wf-b", "userId": "u1",
         "status": "running", "messageId": "m7", "createdAt": t(16), "updatedAt": t(16)},
        "broken line not json",
    ])

    # audit：m1/m2 意图路由；m9 拒绝；run.start 失败 1 条（无 messageId → 独立条目）；
    # la-2 unknown 两条审计（attemptId 去重验证）
    w(data / "audit.jsonl", [
        {"auditId": "au-1", "at": t(9), "actor": "u1", "action": "intent.route",
         "target": {"messageId": "m1", "runId": "r1", "workflowId": "wf-a"}, "outcome": "ok"},
        {"auditId": "au-2", "at": t(11), "actor": "u1", "action": "intent.route",
         "target": {"messageId": "m2", "runId": "r2", "workflowId": "wf-a"}, "outcome": "ok"},
        {"auditId": "au-3", "at": t(13), "actor": "u2", "action": "limit.reject",
         "target": {"messageId": "m9"}, "outcome": "rejected"},
        {"auditId": "au-f1", "at": t(15), "actor": "system", "action": "run.start",
         "target": {"workflowId": "wf-x"}, "outcome": "failed"},
        {"auditId": "au-4", "at": t(16), "actor": "u1", "action": "am.launch.unknown",
         "target": {"attemptId": "la-2"}, "outcome": "failed"},
        {"auditId": "au-5", "at": t(16, 1), "actor": "system", "action": "am.recovery.uncertain",
         "target": {"attemptId": "la-2"}, "outcome": "failed"},
    ])

    # run-attempts：la-1 linked（m1→r1）；la-2 unknown（m5）；la-3 launched 未 link（m6，超观察窗 → unresolved）
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
         "originMessageId": "m6", "status": "launched", "createdAt": t(0, 5)},
    ])

    # run-links：r1 有链；r_orphan 无 TaskBinding（孤立 Run）
    w(data / "run-links.jsonl", [
        {"runId": "r1", "taskBindingId": "tb-1", "status": "completed", "updatedAt": t(10)},
        {"runId": "r_orphan", "status": "failed", "updatedAt": t(18)},
    ])

    # outbox：r1 completed sent；r2 failed sent；r3 interrupted+completed 双条（重试链）；
    # 审批卡一条（kind=approval 不计）；r2 之外的 r5 running 无（不应通知）
    w(data / "outbox.jsonl", [
        {"outboxId": "ob-1", "userId": "u1", "kind": "completed", "runId": "r1",
         "taskBindingId": "tb-1", "status": "sent", "attempts": 1, "createdAt": t(10)},
        {"outboxId": "ob-2", "userId": "u1", "kind": "failed", "runId": "r2",
         "taskBindingId": "tb-2", "status": "sent", "attempts": 2, "createdAt": t(12)},
        {"outboxId": "ob-3", "userId": "u2", "kind": "interrupted", "runId": "r3",
         "taskBindingId": "tb-3", "status": "sent", "attempts": 1, "createdAt": t(23, 30)},
        {"outboxId": "ob-4", "userId": "u2", "kind": "completed", "runId": "r3",
         "taskBindingId": "tb-3", "status": "sent", "attempts": 1, "createdAt": "2026-10-29T08:00:30+08:00"},
        {"outboxId": "ob-5", "userId": "u2", "kind": "approval", "runId": "r5",
         "taskBindingId": "tb-5", "status": "sent", "attempts": 1, "createdAt": t(21)},
    ])

    # chat-logs：入站 8 条（m1,m2,m4,m5,m6,m9,mc1=批准,mu1=闲聊）+ 出站 1
    w(data / "chat-logs" / f"{DATE}.jsonl", [
        {"ts": t(9), "direction": "in", "userId": "u1", "text": "帮我跑 wf-a", "messageId": "m1"},
        {"ts": t(11), "direction": "in", "userId": "u1", "text": "再来一次", "messageId": "m2"},
        {"ts": t(13), "direction": "in", "userId": "u2", "text": "取消刚才的", "messageId": "m4"},
        {"ts": t(15, 30), "direction": "in", "userId": "u1", "text": "试 wf-c", "messageId": "m5"},
        {"ts": t(17), "direction": "in", "userId": "u2", "text": "再试 wf-b", "messageId": "m6"},
        {"ts": t(13, 5), "direction": "in", "userId": "u2", "text": "帮我跑个不存在的", "messageId": "m9"},
        {"ts": t(14), "direction": "in", "userId": "u1", "text": "批准", "messageId": "mc1"},
        {"ts": t(19, 30), "direction": "in", "userId": "u1", "text": "今天天气不错", "messageId": "mu1"},
        {"ts": t(10), "direction": "out", "userId": "u1", "text": "已完成", "messageId": ""},
    ])

    # inbox：首见行与 chat 对齐（报告请求层不直接用，仅完整性）
    w(data / "inbox.jsonl", [
        {"key": f"wechat:{m}", "at": t(h)} for m, h in
        (("m1", 9), ("m2", 11), ("m4", 13), ("m5", 15), ("m6", 17), ("m9", 13), ("mc1", 14), ("mu1", 19))
    ])

    # runs 目录：r_orphan manifest（final 补充 failed）；r5 manifest running；r1 manifest completed
    for rid, st in (("r1", "completed"), ("r5", "running"), ("r_orphan", "failed")):
        d = runs / rid
        d.mkdir(parents=True, exist_ok=True)
        (d / "manifest.json").write_text(json.dumps({"runId": rid, "status": st}), encoding="utf-8")
    return data


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="wx-quality-"))
    try:
        data = build_fixture(root)
        out = root / "quality-out"
        p = subprocess.run(
            [sys.executable, str(SCRIPT), "--data", str(data), "--date", DATE, "--out", str(out)],
            capture_output=True, text=True, encoding="utf-8",
        )
        output = p.stdout + p.stderr
        print("---- 脚本输出 ----")
        print(output)
        print("------------------")
        r = json.loads((out / f"quality-{DATE}.json").read_text(encoding="utf-8"))
        rq, rn, dl = r["request"], r["run"], r["delivery"]

        # ── 请求层 ──
        # 有效请求 = m1,m2（intent）∪ m3,m4,m7（task）∪ m5,m6（attempt）= 7；启动成功 = 有 task 的 m1,m2,m3,m4,m7 = 5
        if rq["validRequests"] == 7:
            ok(f"请求层 有效执行请求 7（实际 {rq['validRequests']}）")
        else:
            bad(f"validRequests={rq['validRequests']}")
        if rq["startedOk"] == 5 and rq["startFailed"] == 1 and abs(rq["startupRate"] - 5 / 6) < 0.001:
            ok(f"请求层 启动 5/6 ({rq['startupRate']})，独立 run.start 失败 1 计入分母")
        else:
            bad(f"startedOk={rq['startedOk']} startFailed={rq['startFailed']} rate={rq['startupRate']}")
        if rq["unknownAttempts"] == ["la-2"]:
            ok("请求层 unknown 按 attemptId 去重（2 条审计 → 1）且不进分母")
        else:
            bad(f"unknownAttempts={rq['unknownAttempts']}")
        if rq["unresolvedAttempts"] == ["la-3"]:
            ok("请求层 unresolved=launched 超 15min 窗口，单列不判失败")
        else:
            bad(f"unresolvedAttempts={rq['unresolvedAttempts']}")
        if rq["rejected"] == 1:
            ok("请求层 正常拒绝 1（limit.reject）")
        else:
            bad(f"rejected={rq['rejected']}")
        if rq["controlInteractions"] == 1 and rq["controlSamples"][0]["messageId"] == "mc1":
            ok("请求层 审批控制交互 1（C2 词表命中「批准」）")
        else:
            bad(f"control={rq['controlInteractions']} {rq['controlSamples']}")
        if rq["unclassifiedCount"] == 1 and rq["unclassified"][0]["messageId"] == "mu1":
            ok(f"请求层 unclassified 1（mu1 闲聊），覆盖率 {rq['messageAuditCoverage']}")
        else:
            bad(f"unclassified={rq['unclassifiedCount']} {rq['unclassified']}")

        # ── Run 层 ──
        da, df = rn["asOf"]["statusDist"], rn["final"]["statusDist"]
        if rn["discoveredRuns"] == 6:
            ok("Run 层 发现 6（tasks 5 + run-links 1；C1 不从 runs 目录发现）")
        else:
            bad(f"discoveredRuns={rn['discoveredRuns']}")
        if (da["completed"], da["failed"], da["interrupted"], da["cancelled"], da["running"], da["unknown"]) \
                == (1, 1, 1, 1, 1, 1) and abs(rn["asOf"]["terminalRate"] - 1 / 3) < 0.001:
            ok(f"Run 层 asOf 分布 1/1/1/1/1/1（r3 取 interrupted，终态率 1/3）")
        else:
            bad(f"asOf dist={da} rate={rn['asOf']['terminalRate']}")
        if (df["completed"], df["failed"], df["interrupted"]) == (2, 2, 0) and abs(rn["final"]["terminalRate"] - 0.5) < 0.001:
            ok("Run 层 final 分布 2/2/0（r3 跨日 completed + r_orphan manifest failed 补充），终态率 0.5")
        else:
            bad(f"final dist={df} rate={rn['final']['terminalRate']}")
        if da["interrupted"] == 1 and df["interrupted"] == 0 and da["completed"] == 1 and df["completed"] == 2:
            ok("跨日双口径：asOf interrupted=1/completed=1 vs final 0/2（数字差异为设计行为）")
        else:
            bad(f"双口径差异异常 asOf={da} final={df}")
        if rn["orphanRuns"] == ["r_orphan"]:
            ok("Run 层 孤立 Run 检出 r_orphan（C4 必列）")
        else:
            bad(f"orphanRuns={rn['orphanRuns']}")

        # ── 交付层 ──
        if dl["shouldNotify"] == 3 and dl["enqueued"] == 3 and dl["enqueueCoverage"] == 1.0:
            ok("交付层 应通知 3（r1/r2/r3）全部入队（cancelled/running/次日归属不计）")
        else:
            bad(f"should={dl['shouldNotify']} enqueued={dl['enqueued']}")
        if dl["sent"] == 3 and dl["sendFailed"] == 0 and dl["sendRate"] == 1.0:
            ok("交付层 发送 3/3（按任务去重，r3 取最终终态 completed 条目）")
        else:
            bad(f"sent={dl['sent']} failed={dl['sendFailed']} rate={dl['sendRate']}")
        if dl["retryChainNotifications"] == 1:
            ok("交付层 重试链通知 1（r3 interrupted+completed 双条，不重复计数）")
        else:
            bad(f"retryChain={dl['retryChainNotifications']}")
        if dl["asOf"] == "snapshot_unavailable":
            ok("交付层 asOf 标注 snapshot_unavailable（outbox 无历史）")
        else:
            bad(f"delivery.asOf={dl['asOf']}")

        # ── 输出契约 ──
        if "[OK] 请求启动 5/6 (83.3%)" in output and "Run 终态 1/3 (33.3%)" in output \
                and "通知入队 3/3 (100.0%)" in output and "发送 3/3 (100.0%)" in output \
                and "=== ALL DONE ===" in output and p.returncode == 0:
            ok("stdout 契约四指标 + ALL DONE + exit 0")
        else:
            bad(f"stdout 契约异常 rc={p.returncode}")
        if (out / "snapshots" / f"daily-{DATE}.json").is_file():
            ok("快照存档 snapshots/daily-2026-10-28.json")
        else:
            bad("快照文件缺失")
        md = (out / f"quality-{DATE}.md").read_text(encoding="utf-8")
        if "snapshot_unavailable" in md and "孤立 Run" in md and "unresolved" in md:
            ok("Markdown 含口径标注/孤立 Run/unresolved 未决清单")
        else:
            bad("Markdown 关键内容缺失")
        if r["brokenLines"] == 1:
            ok("断裂行 1 跳过不崩溃")
        else:
            bad(f"brokenLines={r['brokenLines']}")

        # ── 故故排行榜嵌入（P1 填充）──
        lb = r.get("failureLeaderboard")
        # fixture 进榜 4 条：r2 failed + la-2 unknown + la-3 unresolved + run.start 失败（均属失败/未决异常）
        if lb and lb["totalIssues"] == 4 and len(lb["rows"]) == 4:
            ok(f"排行榜嵌入：{lb['totalIssues']} 条异常 / {lb['totalClasses']} 类")
        else:
            bad(f"failureLeaderboard={lb}")
        row2 = next((x for x in lb["rows"] if "r2" in (x.get("sampleIds") or [])), None)
        if row2 and row2["category"] == "WORKFLOW_ERROR":
            ok(f"r2 failed 入榜 WORKFLOW_ERROR（count={row2['count']}）")
        else:
            bad(f"r2 未入榜: {row2}")
        if "故障排行榜" in md and "[排行榜]" in output:
            ok("md 含排行榜节 + stdout 排行榜行")
        else:
            bad("排行榜输出缺失")
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n=== {'ALL PASS' if FAIL == 0 else f'FAILED {FAIL}'} ===（PASS {PASS} / FAIL {FAIL}）")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
