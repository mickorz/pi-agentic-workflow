#!/usr/bin/env python3
"""P0 统计口径数据关联校验（失败任务统计与自动诊断 V1.2 · T1）

只读扫描 <dataDir> 与 runs 目录，验证七项关联/去重/覆盖假设在真实数据上是否成立，
为 P0.5 每日报告的口径参数定标。七项校验：
  1. audit ↔ tasks ↔ runs 三向 runId 覆盖差集
  2. run-attempts ↔ audit attemptId 一致性；launched 未 link → unresolved 计数
  3. run-links 有 runId 无 TaskBinding → 孤立 Run 计数
  4. 消息到审计覆盖率（chat-logs 入站消息可关联 audit/run-attempts 的比例 + unclassified）
  5. 应通知终态（completed/failed/interrupted）↔ outbox 入队覆盖差集
  6. inbox 首见数 vs chat-logs 入站行数 → 数量差异率（语义不同，不下"丢失"结论）
  7. tasks.jsonl 单任务 updatedAt 链单调性抽查（asOf 可行性验证）

用法：
    python3 wx-linkage-check.py --data <dataDir> [--runs <runsDir>] --date YYYY-MM-DD
    python3 wx-linkage-check.py --data .pi-wechat --date 2026-10-28

stdout 契约：逐项 [OK]/[WARN]/[FAIL]，结尾 === ALL DONE ===；exit 0/1。
输出：--out（缺省 <dataDir>/quality）下 linkage-YYYY-MM-DD.json。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# 应通知终态（V1.2 §2：RunMonitor.pollOnce 只对 completed/failed/interrupted 入队）
NOTIFY_TERMINALS = {"completed", "failed", "interrupted"}

WARN = 0
FAILS = 0


def ok(msg: str) -> None:
    print(f"[OK] {msg}", flush=True)


def warn(msg: str) -> None:
    global WARN
    WARN += 1
    print(f"[WARN] {msg}", flush=True)


def fail(msg: str) -> None:
    global FAILS
    FAILS += 1
    print(f"[FAIL] {msg}", flush=True)


# ── 基础读取工具 ──

def read_jsonl(path: Path) -> Tuple[List[dict], int]:
    """读 JSONL，返回 (记录列表, 断裂行数)。文件缺失返回 ([], 0)。"""
    if not path.is_file():
        return [], 0
    recs: List[dict] = []
    broken = 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        t = line.strip()
        if not t:
            continue
        try:
            rec = json.loads(t)
        except json.JSONDecodeError:
            broken += 1
            continue
        # 非 dict 行（如裸字符串）按断裂处理，不进记录流
        if not isinstance(rec, dict):
            broken += 1
            continue
        recs.append(rec)
    return recs, broken


def fold_by(recs: List[dict], key_field: str) -> Dict[str, dict]:
    """追加式折叠：同 key 取末条。"""
    folded: Dict[str, dict] = {}
    for r in recs:
        k = r.get(key_field)
        if k:
            folded[k] = r
    return folded


def in_day(ts: Optional[str], date: str) -> bool:
    """事件时间归属日判断（本地日期；缺 ts 视为不在统计日）。"""
    if not ts:
        return False
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d") == date
    except ValueError:
        return False


def day_bounds(date: str) -> Tuple[datetime, datetime]:
    """统计日本地 00:00 与 24:00（含时区，用于跨日折叠）。"""
    start = datetime.fromisoformat(date + "T00:00:00").astimezone()
    return start, start + timedelta(days=1)


def parse_ts(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


# ── 各数据源读取 ──

def load_chatlog_inbound(data_dir: Path, date: str) -> List[dict]:
    """当日 chat-logs 入站消息。"""
    recs, _ = read_jsonl(data_dir / "chat-logs" / f"{date}.jsonl")
    return [r for r in recs if r.get("direction") == "in"]


def load_tasks_folding_at(recs: List[dict], date: str) -> Dict[str, dict]:
    """asOf 折叠：截止统计日 24:00 各 runId 的末条记录（按行序 + updatedAt 过滤）。"""
    _, end = day_bounds(date)
    folded: Dict[str, dict] = {}
    for r in recs:
        ts = parse_ts(r.get("updatedAt") or r.get("createdAt"))
        if ts is None or ts >= end:
            continue
        rid = r.get("runId")
        if rid:
            folded[rid] = r
    return folded


def load_attempts(recs: List[dict], date: str) -> Dict[str, dict]:
    """run-attempts：当日创建（createdAt 归属日）的 attempt 末条折叠。"""
    folded: Dict[str, dict] = {}
    for r in recs:
        if not in_day(r.get("createdAt"), date):
            continue
        aid = r.get("attemptId")
        if aid:
            folded[aid] = r
    return folded


# ── 七项校验 ──

def check_runid_triangle(tasks_by_run: Dict[str, dict], audit_day: List[dict],
                         runs_dir: Optional[Path]) -> dict:
    """校验 1：audit.target.runId ↔ tasks.runId ↔ runs 目录三向差集。"""
    audit_runs = {t.get("target", {}).get("runId") for t in audit_day if t.get("target", {}).get("runId")}
    task_runs = set(tasks_by_run.keys())
    manifest_runs: set = set()
    if runs_dir and runs_dir.is_dir():
        manifest_runs = {p.name for p in runs_dir.iterdir() if p.is_dir()}
    only_audit = sorted(audit_runs - task_runs - manifest_runs)
    only_tasks = sorted(task_runs - audit_runs - manifest_runs)
    only_runs = sorted(manifest_runs - audit_runs - task_runs)
    parts = [f"audit {len(audit_runs)} / tasks {len(task_runs)} / runs {len(manifest_runs)}"]
    for name, diff in (("仅 audit 有", only_audit), ("仅 tasks 有", only_tasks), ("仅 runs 有", only_runs)):
        if diff:
            parts.append(f"{name} {len(diff)}: {', '.join(diff[:5])}{' …' if len(diff) > 5 else ''}")
    # 差集本身不判 FAIL（可能为正常时序，如 mock 场景数据），只要求可计算
    ok(f"校验1 三向 runId 差集 — {'；'.join(parts) if parts else '无记录'}")
    return {"auditRuns": len(audit_runs), "taskRuns": len(task_runs), "manifestRuns": len(manifest_runs),
            "onlyAudit": only_audit, "onlyTasks": only_tasks, "onlyRuns": only_runs}


def check_attempt_linkage(attempts: Dict[str, dict], audit_day: List[dict]) -> dict:
    """校验 2：attemptId 一致性 + launched 未 link → unresolved。"""
    audit_attempts = {t.get("target", {}).get("attemptId") for t in audit_day
                      if t.get("target", {}).get("attemptId")}
    known = set(attempts.keys())
    orphan_audit = sorted(audit_attempts - known)  # audit 有 attemptId 但当日 attempts 无记录
    if orphan_audit:
        warn(f"校验2 audit 引用但当日 run-attempts 缺失的 attemptId {len(orphan_audit)}: "
             f"{', '.join(orphan_audit[:5])}")
    else:
        ok("校验2 attemptId 引用一致")
    unresolved = sorted(a for a, r in attempts.items() if r.get("status") == "launched")
    unknown = sorted(a for a, r in attempts.items() if r.get("status") == "unknown")
    linked = sum(1 for r in attempts.values() if r.get("status") == "linked")
    # unresolved/unknown 是需人工核对清单，不是失败
    if unresolved:
        warn(f"校验2 launched 未 link（unresolved，需人工核对）{len(unresolved)}: "
             f"{', '.join(unresolved[:5])}{' …' if len(unresolved) > 5 else ''}")
    if unknown:
        warn(f"校验2 unknown 启动尝试 {len(unknown)}（需人工核对副作用）")
    if not unresolved and not unknown:
        ok(f"校验2 启动尝试状态：linked {linked} / launched 0 / unknown 0")
    else:
        ok(f"校验2 启动尝试状态：linked {linked} / unresolved {len(unresolved)} / unknown {len(unknown)}")
    return {"linked": linked, "unresolved": unresolved, "unknown": unknown, "orphanAuditAttempts": orphan_audit}


def check_orphan_runs(tasks_by_run: Dict[str, dict], links: List[dict],
                      attempts: Dict[str, dict]) -> dict:
    """校验 3：run-links 有 runId 无 TaskBinding → 孤立 Run。"""
    link_runs = {r.get("runId") for r in links if r.get("runId")}
    orphan = sorted(r for r in link_runs - set(tasks_by_run.keys()))
    # run-attempts linked 且带 taskBindingId 的也算有主（补链窗口产物）
    linked_tb = {r.get("taskBindingId") for r in attempts.values()
                 if r.get("status") == "linked" and r.get("taskBindingId")}
    if orphan:
        warn(f"校验3 孤立 Run（有 run-links/runId 无 TaskBinding，需人工核对）{len(orphan)}: "
             f"{', '.join(orphan[:5])}{' …' if len(orphan) > 5 else ''}")
    else:
        ok(f"校验3 孤立 Run 0（run-links {len(link_runs)} 条全部有 TaskBinding 或 linked attempt）")
    return {"orphanRuns": orphan, "linkedAttemptBindings": len(linked_tb)}


def check_message_coverage(inbound: List[dict], audit_day: List[dict],
                           attempts: Dict[str, dict], tasks_by_run: Dict[str, dict]) -> dict:
    """校验 4：消息到审计覆盖率（chat-logs 入站可关联 audit messageId /
    run-attempts originMessageId / tasks messageId 的比例）。"""
    audited_msgs = set()
    for t in audit_day:
        mid = t.get("target", {}).get("messageId")
        if mid:
            audited_msgs.add(mid)
    attempt_msgs = {r.get("originMessageId") for r in attempts.values() if r.get("originMessageId")}
    task_msgs = {b.get("messageId") for b in tasks_by_run.values() if b.get("messageId")}
    linkable = audited_msgs | attempt_msgs | task_msgs
    total = 0
    unclassified: List[dict] = []
    for m in inbound:
        mid = m.get("messageId")
        if not mid:
            continue
        total += 1
        if mid not in linkable:
            unclassified.append({"ts": m.get("ts"), "messageId": mid,
                                 "text": (m.get("text") or "")[:60]})
    if total == 0:
        warn("校验4 当日无入站消息记录，覆盖率不可计算")
        return {"inbound": 0, "unclassified": [], "coverage": None}
    coverage = (total - len(unclassified)) / total
    if unclassified:
        warn(f"校验4 消息到审计覆盖率 {coverage:.1%}（{total - len(unclassified)}/{total}），"
             f"unclassified {len(unclassified)} 条（不排除出报告，含普通聊天；样例见 JSON）")
    else:
        ok(f"校验4 消息到审计覆盖率 100%（{total}/{total}）")
    return {"inbound": total, "unclassified": unclassified, "coverage": round(coverage, 4)}


def check_notify_enqueue(tasks_by_run: Dict[str, dict], outbox_folded: Dict[str, dict]) -> dict:
    """校验 5：应通知终态任务 ↔ outbox 最终通知覆盖差集（按任务去重）。"""
    should = {rid: b for rid, b in tasks_by_run.items() if b.get("status") in NOTIFY_TERMINALS}
    # 最终通知 = kind 为最终通知类（completed/failed/interrupted），按 runId 关联；非最终类（审批卡等）不计
    enqueued = {r.get("runId") for r in outbox_folded.values()
                if r.get("runId") and r.get("kind") in NOTIFY_TERMINALS}
    missing = sorted(r for r in should if r not in enqueued)
    # tasks 无 runId 关联的 outbox 条目（如直接广播类）不影响本校验
    if should and missing:
        fail(f"校验5 应通知未入队 {len(missing)}/{len(should)}（入队覆盖率 {1 - len(missing)/len(should):.1%}）："
             f"{', '.join(missing[:5])}{' …' if len(missing) > 5 else ''}")
    elif should:
        ok(f"校验5 应通知 {len(should)} 全部已入队（入队覆盖率 100%）")
    else:
        ok("校验5 当日无应通知终态任务（入队覆盖率分母为 0）")
    return {"shouldNotify": len(should), "missingEnqueue": missing,
            "coverage": round(1 - len(missing) / len(should), 4) if should else None}


def check_inbox_chatlog_diff(inbox_recs: List[dict], inbound: List[dict], date: str) -> dict:
    """校验 6：inbox 首见数 vs chat-logs 入站行数 → 数量差异率（只报差异，不下丢失结论）。"""
    # inbox 记录 {key: "channel:messageId", at}——取统计日窗口内的首见行
    day_start, day_end = day_bounds(date)
    first_seen = sum(
        1 for r in inbox_recs
        if (lambda ts: ts is not None and day_start <= ts < day_end)(parse_ts(r.get("at")))
    )
    chatlog_n = len(inbound)
    if first_seen == 0 and chatlog_n == 0:
        warn("校验6 inbox 与 chat-logs 当日均无入站记录，差异率不可计算")
        return {"inboxFirstSeen": 0, "chatlogInbound": 0, "diffRate": None}
    base = max(first_seen, chatlog_n)
    diff_rate = abs(first_seen - chatlog_n) / base if base else None
    if diff_rate is None:
        warn("校验6 差异率不可计算")
    elif diff_rate > 0.05:
        warn(f"校验6 数量差异率 {diff_rate:.1%}（inbox 首见 {first_seen} vs chat-logs 入站 {chatlog_n}；"
             f"两源记录语义不同，仅提示差异供核对）")
    else:
        ok(f"校验6 数量差异率 {diff_rate:.1%}（inbox {first_seen} vs chat-logs {chatlog_n}）")
    return {"inboxFirstSeen": first_seen, "chatlogInbound": chatlog_n,
            "diffRate": round(diff_rate, 4) if diff_rate is not None else None}


def check_task_chain(recs: List[dict]) -> dict:
    """校验 7：tasks.jsonl 单任务 updatedAt 链单调性（asOf 折叠可行性）。"""
    by_run: Dict[str, List[Optional[datetime]]] = {}
    for r in recs:
        rid = r.get("runId")
        if rid:
            by_run.setdefault(rid, []).append(parse_ts(r.get("updatedAt") or r.get("createdAt")))
    non_mono = []
    for rid, ts_list in by_run.items():
        present = [t for t in ts_list if t is not None]
        if len(present) >= 2 and any(b < a for a, b in zip(present, present[1:])):
            non_mono.append(rid)
    if non_mono:
        fail(f"校验7 updatedAt 链非单调任务 {len(non_mono)}（asOf 按行序折叠仍可行，但需复核）："
             f"{', '.join(non_mono[:5])}")
    else:
        ok(f"校验7 tasks updatedAt 链单调（{len(by_run)} 任务，asOf 折叠可行）")
    return {"tasks": len(by_run), "nonMonotonic": non_mono}


def main() -> int:
    global _date_arg
    parser = argparse.ArgumentParser(description="P0 数据关联校验（wx-quality T1）")
    parser.add_argument("--data", required=True, help="数据目录（缺省布局 .pi-wechat）")
    parser.add_argument("--runs", default=None, help="runs 目录（缺省 <data>/../.pi-workflows/runs）")
    parser.add_argument("--date", required=True, help="统计日 YYYY-MM-DD")
    parser.add_argument("--out", default=None, help="报告目录（缺省 <data>/quality）")
    args = parser.parse_args()

    data_dir = Path(args.data)
    runs_dir = Path(args.runs) if args.runs else (data_dir.parent / ".pi-workflows" / "runs")
    out_dir = Path(args.out) if args.out else (data_dir / "quality")
    out_dir.mkdir(parents=True, exist_ok=True)

    # 数据源读取
    tasks_recs, tasks_broken = read_jsonl(data_dir / "tasks.jsonl")
    audit_recs, audit_broken = read_jsonl(data_dir / "audit.jsonl")
    attempts_recs, attempts_broken = read_jsonl(data_dir / "run-attempts.jsonl")
    links_recs, links_broken = read_jsonl(data_dir / "run-links.jsonl")
    outbox_recs, outbox_broken = read_jsonl(data_dir / "outbox.jsonl")
    inbox_recs, inbox_broken = read_jsonl(data_dir / "inbox.jsonl")
    inbound = load_chatlog_inbound(data_dir, args.date)
    audit_day = [t for t in audit_recs if in_day(t.get("at"), args.date)]

    tasks_by_run = load_tasks_folding_at(tasks_recs, args.date)
    attempts = load_attempts(attempts_recs, args.date)
    outbox_folded = fold_by(outbox_recs, "outboxId")

    broken_total = (tasks_broken + audit_broken + attempts_broken + links_broken
                    + outbox_broken + inbox_broken)
    if broken_total:
        warn(f"JSONL 断裂行共 {broken_total} 行已跳过（tasks {tasks_broken}/audit {audit_broken}/"
             f"attempts {attempts_broken}/links {links_broken}/outbox {outbox_broken}/inbox {inbox_broken}）")
    else:
        ok("JSONL 断裂行 0")

    print(f"统计日 {args.date} | data={data_dir} | runs={runs_dir}")
    print(f"数据量：tasks {len(tasks_recs)} 行（折叠 {len(tasks_by_run)}）| audit 当日 {len(audit_day)} 条 | "
          f"attempts 当日 {len(attempts)} | links {len(links_recs)} 行 | outbox {len(outbox_folded)} 条 | "
          f"chat-logs 入站 {len(inbound)}")

    results = {
        "date": args.date,
        "dataDir": str(data_dir),
        "runsDir": str(runs_dir),
        "brokenLines": broken_total,
        "check1": check_runid_triangle(tasks_by_run, audit_day, runs_dir if runs_dir.is_dir() else None),
        "check2": check_attempt_linkage(attempts, audit_day),
        "check3": check_orphan_runs(tasks_by_run, links_recs, attempts),
        "check4": check_message_coverage(inbound, audit_day, attempts, tasks_by_run),
        "check5": check_notify_enqueue(tasks_by_run, outbox_folded),
        "check6": check_inbox_chatlog_diff(inbox_recs, inbound, args.date),
        "check7": check_task_chain(tasks_recs),
    }

    out_file = out_dir / f"linkage-{args.date}.json"
    out_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"报告已写入 {out_file}")

    if FAILS:
        print(f"=== ALL DONE ===（FAIL {FAILS}，WARN {WARN}）")
        return 1
    print(f"=== ALL DONE ===（FAIL 0，WARN {WARN}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
