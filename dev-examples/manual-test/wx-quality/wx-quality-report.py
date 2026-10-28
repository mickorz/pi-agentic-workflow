#!/usr/bin/env python3
"""P0.5 每日三层质量报告（失败任务统计与自动诊断 V1.2 · T3）

只读汇总 <dataDir> 一天的微信任务质量，三层口径（V1.2 §3）：
  请求层——请求启动成功率（启动成功 / 启动成功+启动失败；unresolved/unknown/拒绝/unclassified/控制交互单列）
  Run 层——终态成功率 + 全量状态分布（asOf 用 tasks 事件流；final 用 manifest 补充）
  交付层——最终通知入队覆盖率 + 发送成功率（outbox 无历史 → asOf 一律 snapshot_unavailable）

T2 校准约束（方案 §8）：C1 runs 目录仅证据补充不作 run 发现源；C2 审批指令词表；
C3 统计启用日标注；C4 孤立 Run 必列；C5 指标基数为 0 不隐藏。

用法：
    python3 wx-quality-report.py --data <dataDir> [--runs <runsDir>] --date YYYY-MM-DD [--out <目录>]

输出：<out>/quality-YYYY-MM-DD.{json,md} + <out>/snapshots/daily-YYYY-MM-DD.json
stdout 契约：[OK] 请求启动 X/Y (Z%)，Run 终态 X/Y (Z%)，通知入队 X/Y (Z%)，发送 X/Y (Z%) / === ALL DONE ===；exit 0/1
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# 复用诊断模块（文件名含连字符，importlib 按路径加载）
_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("wx_failure_diagnose", _HERE / "wx-failure-diagnose.py")
wfd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wfd)  # type: ignore[union-attr]

# 统计启用日（C3：ChatLog 部署前 chat-log 缺失属已知边界）
STATS_EPOCH = "2026-10-28"
# 应通知终态（RunMonitor.pollOnce 只对 completed/failed/interrupted 入队；V1.2 §2）
NOTIFY_TERMINALS = {"completed", "failed", "interrupted"}
# 审批/控制交互指令词表（C2：命中者不进请求分母、不算统计盲区）
CONTROL_WORDS = ("批准", "拒绝", "恢复任务", "进度", "任务列表", "approve", "reject", "都批准")
# unresolved 观察窗（TaskBinding TTL 15min，LK-05）
UNRESOLVED_WINDOW = timedelta(minutes=15)

SNAPSHOT_UNAVAILABLE = "snapshot_unavailable"


# ── 基础读取工具（与 wx-linkage-check.py 同契约，脚本独立可执行） ──

def read_jsonl(path: Path) -> Tuple[List[dict], int]:
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
        if not isinstance(rec, dict):
            broken += 1
            continue
        recs.append(rec)
    return recs, broken


def fold_last(recs: List[dict], key_field: str) -> Dict[str, dict]:
    folded: Dict[str, dict] = {}
    for r in recs:
        k = r.get(key_field)
        if k:
            folded[k] = r
    return folded


def parse_ts(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def in_day(ts: Optional[str], date: str) -> bool:
    d = parse_ts(ts)
    return d is not None and d.strftime("%Y-%m-%d") == date


def day_end(date: str) -> datetime:
    return datetime.fromisoformat(date + "T00:00:00").astimezone() + timedelta(days=1)


def pct(n: int, d: int) -> Optional[float]:
    return round(n / d, 4) if d else None


def fmt_pct(v: Optional[float]) -> str:
    return "N/A" if v is None else f"{v:.1%}"


# ── 数据源装载 ──

class Sources:
    def __init__(self, data_dir: Path, date: str):
        self.date = date
        self.end = day_end(date)
        self.tasks_recs, _ = read_jsonl(data_dir / "tasks.jsonl")
        self.audit_recs, _ = read_jsonl(data_dir / "audit.jsonl")
        self.attempt_recs, _ = read_jsonl(data_dir / "run-attempts.jsonl")
        self.link_recs, _ = read_jsonl(data_dir / "run-links.jsonl")
        self.outbox_recs, _ = read_jsonl(data_dir / "outbox.jsonl")
        self.inbox_recs, _ = read_jsonl(data_dir / "inbox.jsonl")
        self.inbound = []
        chat, _ = read_jsonl(data_dir / "chat-logs" / f"{date}.jsonl")
        self.inbound = [r for r in chat if r.get("direction") == "in"]
        self.audit_day = [t for t in self.audit_recs if in_day(t.get("at"), date)]


def fold_tasks_as_of(recs: List[dict], end: datetime) -> Dict[str, dict]:
    """严格 asOf：截止 end 各 runId 末条（tasks 有完整追加历史，V1.2 §2 表）。"""
    folded: Dict[str, dict] = {}
    for r in recs:
        ts = parse_ts(r.get("updatedAt") or r.get("createdAt"))
        if ts is None or ts >= end:
            continue
        rid = r.get("runId")
        if rid:
            folded[rid] = r
    return folded


def fold_attempts_as_of(recs: List[dict], end: datetime, day: str) -> Dict[str, dict]:
    """当日创建（归属日）且截止 end 的 attempt 末条。"""
    folded: Dict[str, dict] = {}
    for r in recs:
        created = parse_ts(r.get("createdAt"))
        if created is None or created >= end or created.strftime("%Y-%m-%d") != day:
            continue
        aid = r.get("attemptId")
        if aid:
            folded[aid] = r
    return folded


# ── 请求层 ──

def request_layer(src: Sources) -> dict:
    """请求启动成功率（V1.2 §3.1）。分母 = 有效执行请求（messageId 去重并集）。"""
    # 各来源的 messageId 集合
    intent_msgs = {t.get("target", {}).get("messageId") for t in src.audit_day
                   if t.get("action") == "intent.route" and t.get("target", {}).get("messageId")}
    url_msgs = {t.get("target", {}).get("messageId") for t in src.audit_day
                if t.get("action") == "url.route.direct" and t.get("target", {}).get("messageId")}
    attempts = fold_attempts_as_of(src.attempt_recs, src.end, src.date)
    attempt_msgs = {a.get("originMessageId") for a in attempts.values() if a.get("originMessageId")}
    # 任务关联消息（TaskBinding.messageId，按 createdAt 归属日过滤——请求到达日而非完成日，
    # 否则历史任务的 messageId 会每天重复进有效请求集）
    task_msg_to_run: Dict[str, dict] = {}
    for r in src.tasks_recs:
        if not in_day(r.get("createdAt"), src.date):
            continue
        mid, rid = r.get("messageId"), r.get("runId")
        if mid and rid:
            prev = parse_ts((task_msg_to_run.get(mid) or {}).get("updatedAt")) if mid in task_msg_to_run else None
            cur = parse_ts(r.get("updatedAt") or r.get("createdAt"))
            if mid not in task_msg_to_run or (cur is not None and (prev is None or cur >= prev)):
                task_msg_to_run[mid] = r  # 末条优先
    task_msgs = set(task_msg_to_run.keys())
    link_runs = {r.get("runId") for r in src.link_recs if r.get("runId")}

    valid_requests = (intent_msgs | url_msgs | attempt_msgs | task_msgs)
    # 启动失败：audit run.start outcome=failed（有 messageId 用 messageId，否则按条目）
    start_failed: Set[str] = set()
    for t in src.audit_day:
        if t.get("action") == "run.start" and t.get("outcome") == "failed":
            mid = t.get("target", {}).get("messageId")
            start_failed.add(mid if mid else f"audit:{t.get('auditId')}")
    # unknown / unresolved（attemptId 去重，C2/C5：基数可为 0 不隐藏）
    unknown = sorted(a.get("attemptId") for a in attempts.values() if a.get("status") == "unknown")
    now = datetime.now().astimezone()
    unresolved = sorted(
        a.get("attemptId") for a in attempts.values()
        if a.get("status") == "launched"
        and (now - created > UNRESOLVED_WINDOW if (created := parse_ts(a.get("createdAt"))) is not None else True))
    # 正常拒绝：limit.reject / checkpoint.reject（按 messageId，无则按条目）
    rejected: Set[str] = set()
    for t in src.audit_day:
        if t.get("action") in ("limit.reject", "checkpoint.reject"):
            mid = t.get("target", {}).get("messageId")
            rejected.add(mid if mid else f"audit:{t.get('auditId')}")
    rejected_msgs = {r for r in rejected if not r.startswith("audit:")}
    # 入站消息分类：控制交互（C2 词表）/ unclassified（已归拒绝的不重复分类）
    control, unclassified = [], []
    for m in src.inbound:
        mid = m.get("messageId")
        if not mid or mid in valid_requests or mid in rejected_msgs:
            continue
        text = m.get("text") or ""
        if any(w in text for w in CONTROL_WORDS):
            control.append({"messageId": mid, "text": text[:40]})
        else:
            unclassified.append({"messageId": mid, "ts": m.get("ts"), "text": text[:60]})

    # 启动成功 = 有效请求中已产生 TaskBinding 或（无 binding 时）RunLink 关联
    succeeded = sum(1 for m in valid_requests if m in task_msgs)
    # 启动失败仅计独立 audit 条目（带 messageId 的 start 失败多半已在有效请求集中计入分母）
    standalone_failed = {s for s in start_failed if s.startswith("audit:")}
    failed = len(standalone_failed)
    inbound_total = sum(1 for m in src.inbound if m.get("messageId"))
    coverage = pct(inbound_total - len(unclassified) - len(control), inbound_total) if inbound_total else None

    return {
        "validRequests": len(valid_requests),
        "startedOk": succeeded,
        "startFailed": failed,
        "startupRate": pct(succeeded, succeeded + failed),
        "rejected": len(rejected), "rejectedItems": sorted(rejected),
        "unknownAttempts": unknown, "unresolvedAttempts": unresolved,
        "controlInteractions": len(control), "controlSamples": control[:5],
        "unclassified": unclassified, "unclassifiedCount": len(unclassified),
        "inboundTotal": inbound_total,
        "messageAuditCoverage": coverage,
    }


# ── Run 层 ──

def run_layer(src: Sources, runs_dir: Optional[Path]) -> dict:
    """终态成功率 + 全量状态分布（V1.2 §3.2；C1：run 发现源 = tasks ∪ run-links ∪ audit run.start）。"""
    tasks_asof = fold_tasks_as_of(src.tasks_recs, src.end)
    tasks_final = fold_last(src.tasks_recs, "runId")

    # runId 当日发现（C1）
    discovered: Dict[str, str] = {}  # runId -> 归属来源时间
    for r in src.tasks_recs:
        if in_day(r.get("createdAt"), src.date) and r.get("runId"):
            discovered[r["runId"]] = "task"
    for t in src.audit_day:
        if t.get("action") == "run.start":
            rid = t.get("target", {}).get("runId")
            if rid:
                discovered.setdefault(rid, "audit")
    links_first_seen: Dict[str, datetime] = {}
    for r in src.link_recs:
        rid, ts = r.get("runId"), parse_ts(r.get("updatedAt"))
        if rid and ts and (rid not in links_first_seen or ts < links_first_seen[rid]):
            links_first_seen[rid] = ts
    for rid, ts in links_first_seen.items():
        if ts < src.end and ts.strftime("%Y-%m-%d") == src.date:
            discovered.setdefault(rid, "run-link")

    def status_dist_asof(folded: Dict[str, dict]) -> dict:
        dist = {"completed": 0, "failed": 0, "interrupted": 0, "cancelled": 0,
                "running": 0, "waiting_checkpoint": 0, "unknown": 0}
        for rid in discovered:
            st = folded.get(rid, {}).get("status")
            if st in dist:
                dist[st] += 1
            else:
                dist["unknown"] += 1  # 无 tasks 记录（孤立）归 unknown 分布，明细在 orphanRuns
        return dist

    def status_dist_final() -> dict:
        dist = {"completed": 0, "failed": 0, "interrupted": 0, "cancelled": 0,
                "running": 0, "waiting_checkpoint": 0, "unknown": 0}
        for rid in discovered:
            st = tasks_final.get(rid, {}).get("status")
            if not st and runs_dir and (runs_dir / rid / "manifest.json").is_file():
                try:
                    st = json.loads((runs_dir / rid / "manifest.json").read_text(encoding="utf-8")).get("status")
                except (json.JSONDecodeError, OSError):
                    st = None
            if st in dist:
                dist[st] += 1
            else:
                dist["unknown"] += 1
        return dist

    dist_asof = status_dist_asof(tasks_asof)
    dist_final = status_dist_final()

    # 孤立 Run（C4：必列）
    orphan = sorted(r for r in discovered if r not in tasks_final and r not in tasks_asof)

    def terminal_rate(dist: dict) -> Optional[float]:
        done = dist["completed"] + dist["failed"] + dist["interrupted"]
        return pct(dist["completed"], done)

    return {
        "discoveredRuns": len(discovered),
        "asOf": {"statusDist": dist_asof, "terminalRate": terminal_rate(dist_asof),
                 "source": "tasks 事件流（严格）"},
        "final": {"statusDist": dist_final, "terminalRate": terminal_rate(dist_final),
                  "source": "tasks 末条 + manifest 补充"},
        "orphanRuns": orphan,
    }


# ── 交付层 ──

def delivery_layer(src: Sources) -> dict:
    """入队覆盖率 + 发送成功率（V1.2 §3.3；outbox 无历史 → asOf 恒 snapshot_unavailable）。"""
    tasks_final = fold_last(src.tasks_recs, "runId")
    # 应通知任务按归属日（createdAt 当日）取 final 状态
    should = {rid: b for rid, b in tasks_final.items()
              if in_day(b.get("createdAt"), src.date) and b.get("status") in NOTIFY_TERMINALS}
    outbox = fold_last(src.outbox_recs, "outboxId")
    # 最终通知条目（kind ∈ 应通知终态）按 runId 分组
    by_run: Dict[str, List[dict]] = {}
    for o in outbox.values():
        rid, kind = o.get("runId"), o.get("kind")
        if rid and kind in NOTIFY_TERMINALS:
            by_run.setdefault(rid, []).append(o)

    enqueued = 0
    sent, failed, pending = 0, 0, 0
    retry_chain = 0  # 同任务多条最终通知（interrupted→resume→completed）
    missing = []
    for rid, binding in should.items():
        items = sorted(by_run.get(rid, []), key=lambda o: o.get("sentAt") or o.get("createdAt") or "")
        if not items:
            missing.append(rid)
            continue
        enqueued += 1
        if len(items) > 1:
            retry_chain += len(items) - 1
        # 取最终终态条目（与任务 final 状态同 kind 优先，否则末条）
        final_kind = binding.get("status")
        chosen = next((o for o in reversed(items) if o.get("kind") == final_kind), items[-1])
        st = chosen.get("status")
        if st == "sent":
            sent += 1
        elif st == "failed":
            failed += 1
        else:
            pending += 1

    return {
        "shouldNotify": len(should),
        "enqueued": enqueued,
        "missingEnqueue": missing,
        "enqueueCoverage": pct(enqueued, len(should)),
        "sent": sent, "sendFailed": failed, "sendPending": pending,
        "sendRate": pct(sent, sent + failed),
        "retryChainNotifications": retry_chain,
        "asOf": SNAPSHOT_UNAVAILABLE,  # outbox 重启重写无历史（V1.2 §3.4）
    }


# ── 报告渲染 ──

def render_markdown(r: dict) -> str:
    rq, rn, dl = r["request"], r["run"], r["delivery"]
    dist = rn["asOf"]["statusDist"]
    lines = [
        f"# 微信工作流每日质量报告（{r['date']}）",
        "",
        f"有效执行请求 {rq['validRequests']} | 请求启动成功率 {fmt_pct(rq['startupRate'])} | "
        f"Run 终态成功率 {fmt_pct(rn['asOf']['terminalRate'])} | "
        f"通知入队覆盖率 {fmt_pct(dl['enqueueCoverage'])} | 发送成功率 {fmt_pct(dl['sendRate'])}",
        f"（口径：asOf=截至当日 24:00（tasks 事件流）；final=归属日最终状态；"
        f"交付层 asOf {SNAPSHOT_UNAVAILABLE}，仅 final）",
        "",
        f"Run 全量状态分布（asOf）：completed {dist['completed']} | failed {dist['failed']} | "
        f"interrupted {dist['interrupted']} | cancelled {dist['cancelled']} | running {dist['running']} | "
        f"waiting {dist['waiting_checkpoint']} | 无tasks记录 {dist['unknown']}",
        f"Run 终态成功率（final）：{fmt_pct(rn['final']['terminalRate'])}"
        f"（状态分布 completed {rn['final']['statusDist']['completed']} / failed {rn['final']['statusDist']['failed']}"
        f" / interrupted {rn['final']['statusDist']['interrupted']}）",
        "",
        "## 未决数",
        f"- 待确认（跨日）: running {dist['running']} / waiting_checkpoint {dist['waiting_checkpoint']}",
        f"- unresolved 启动尝试: {len(rq['unresolvedAttempts'])}（需人工核对，不判失败）",
        f"- unknown 启动尝试: {len(rq['unknownAttempts'])}（需人工核对副作用）",
        f"- 孤立 Run: {len(rn['orphanRuns'])}（需人工核对）",
        f"- 正常拒绝: {rq['rejected']}（按设计拒绝，非故障）",
        f"- 控制交互（审批/查询词表命中）: {rq['controlInteractions']}",
        f"- unclassified 入站消息: {rq['unclassifiedCount']} / 入站总数 {rq['inboundTotal']}"
        f"（消息到审计覆盖率 {fmt_pct(rq['messageAuditCoverage'])}）",
        f"- pending 通知: {dl['sendPending']} | 应通知未入队: {len(dl['missingEnqueue'])} | "
        f"重试链通知: {dl['retryChainNotifications']}",
        "",
        "## 明细清单（详 JSON）",
    ]
    if rn["orphanRuns"]:
        lines.append(f"- 孤立 Run: {', '.join(rn['orphanRuns'][:8])}")
    if rq["unknownAttempts"]:
        lines.append(f"- unknown 尝试: {', '.join(rq['unknownAttempts'][:8])}")
    if rq["unresolvedAttempts"]:
        lines.append(f"- unresolved 尝试: {', '.join(rq['unresolvedAttempts'][:8])}")
    if dl["missingEnqueue"]:
        lines.append(f"- 应通知未入队: {', '.join(dl['missingEnqueue'][:8])}")
    if rq["unclassified"]:
        samples = "; ".join(f"{u['messageId']}: {u['text']}" for u in rq["unclassified"][:5])
        lines.append(f"- unclassified 样例: {samples}")
    # 故障排行榜（P1 填充，方案 §4 P0.5；当日窗口 Top，详 diagnose-<date>.md 可用 --days 扩窗口）
    lb = r.get("failureLeaderboard")
    if lb and lb["rows"]:
        lines += [
            "",
            "## 故障排行榜（当日 Top %d，共 %d 条异常 / %d 类）" % (len(lb["rows"]), lb["totalIssues"], lb["totalClasses"]),
            "| # | 错误类别 | errorCode | 失败次数 | 影响任务数 | 可恢复性 | 归一化消息 |",
            "|---|---|---|---|---|---|---|",
        ]
        for i, row in enumerate(lb["rows"], 1):
            lines.append(f"| {i} | {row['category']} | {row['errorCode']} | {row['count']} | "
                         f"{row['affectedTasks']} | {row['recoverability'][:30]} | {row['normalizedMessage'][:50]} |")
    else:
        lines += ["", "## 故障排行榜（当日）", "当日无失败/未决异常。"]
    lines += [
        "",
        "## 数据缺失说明",
        f"- 统计启用日 {STATS_EPOCH}" + ("（本报告早于启用日，chat-log 覆盖率口径可能失真）" if r["date"] < STATS_EPOCH else ""),
        f"- 断裂行跳过: {r['brokenLines']} | outbox/manifest 历史 asOf: {SNAPSHOT_UNAVAILABLE}",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="P0.5 每日三层质量报告（wx-quality T3）")
    parser.add_argument("--data", required=True)
    parser.add_argument("--runs", default=None)
    parser.add_argument("--date", default=None, help="统计日 YYYY-MM-DD（缺省今天；定时任务用）")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    data_dir = Path(args.data)
    runs_dir = Path(args.runs) if args.runs else (data_dir.parent / ".pi-workflows" / "runs")
    out_dir = Path(args.out) if args.out else (data_dir / "quality")
    out_dir.mkdir(parents=True, exist_ok=True)

    the_date = args.date or datetime.now().astimezone().strftime("%Y-%m-%d")
    src = Sources(data_dir, the_date)
    report = {
        "date": the_date,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "dataDir": str(data_dir),
        "runsDir": str(runs_dir),
        "brokenLines": sum(read_jsonl(data_dir / f)[1] for f in
                           ("tasks.jsonl", "audit.jsonl", "run-attempts.jsonl", "run-links.jsonl",
                            "outbox.jsonl", "inbox.jsonl")),
        "request": request_layer(src),
        "run": run_layer(src, runs_dir if runs_dir.is_dir() else None),
        "delivery": delivery_layer(src),
    }
    # 故障排行榜（当日窗口，复用 P1 诊断模块；详报告用 wx-failure-diagnose.py --days 扩窗口）
    day_start = datetime.fromisoformat(the_date + "T00:00:00").astimezone()
    lb_issues = wfd.collect_issues(data_dir, runs_dir if runs_dir.is_dir() else None,
                                   day_start, src.end)
    lb_rows = wfd.build_leaderboard(lb_issues, 5)
    report["failureLeaderboard"] = {"totalIssues": len(lb_issues), "totalClasses": len(lb_rows),
                                    "rows": lb_rows}
    # 快照存档（V1.2 §3.4：历史对比只读快照）
    snap_dir = out_dir / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / f"quality-{the_date}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (snap_dir / f"daily-{the_date}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / f"quality-{the_date}.md").write_text(render_markdown(report), encoding="utf-8")

    rq, rn, dl = report["request"], report["run"], report["delivery"]
    print(f"[OK] 请求启动 {rq['startedOk']}/{rq['startedOk'] + rq['startFailed']} "
          f"({fmt_pct(rq['startupRate'])})，"
          f"Run 终态 {rn['asOf']['statusDist']['completed']}/"
          f"{rn['asOf']['statusDist']['completed'] + rn['asOf']['statusDist']['failed'] + rn['asOf']['statusDist']['interrupted']} "
          f"({fmt_pct(rn['asOf']['terminalRate'])})，"
          f"通知入队 {dl['enqueued']}/{dl['shouldNotify']} ({fmt_pct(dl['enqueueCoverage'])})，"
          f"发送 {dl['sent']}/{dl['sent'] + dl['sendFailed']} ({fmt_pct(dl['sendRate'])})")
    print(f"未决：unresolved {len(rq['unresolvedAttempts'])} | unknown {len(rq['unknownAttempts'])} | "
          f"孤立 Run {len(rn['orphanRuns'])} | unclassified {rq['unclassifiedCount']} | "
          f"待发送 {dl['sendPending']} | 应通知未入队 {len(dl['missingEnqueue'])}")
    lb_top1 = lb_rows[0] if lb_rows else None
    print(f"[排行榜] 当日异常 {len(lb_issues)} 条 / {len(lb_rows)} 类；"
          f"Top1: {lb_top1['category']} {lb_top1['errorCode']} × {lb_top1['count']}" if lb_top1
          else f"[排行榜] 当日异常 0 条")
    print(f"报告: {out_dir / f'quality-{the_date}.md'}（JSON 同名）+ snapshots/daily-{the_date}.json")
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
