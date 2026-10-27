#!/usr/bin/env python3
"""任务成功率统计基线（只读）—— 日报 2026-10-27 §5.2 的最小可验收实现。

数据源：<dataDir>/tasks.jsonl（append-only，同 taskBindingId 多行，末行为准）。
口径：
  - terminal = completed / failed / cancelled（有终态）
  - running 且 updatedAt 距今 > --stale-hours → stale_running（僵死，不计入"活跃"）
  - 成功率两种分母：
      strict : completed / terminal                （终态口径，乐观）
      real   : completed / (terminal + stale_running)（把僵死算失败，悲观）
输出契约：stdout 文本，[OK]/[FAIL]/[WARN] 前缀，结尾 === ALL DONE ===。退出码 0=正常，1=数据缺失。
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

TERMINAL = ("completed", "failed", "cancelled")


def load_tasks(path: Path) -> List[dict]:
    tasks = []
    if not path.exists():
        return tasks
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                tasks.append(json.loads(line))
            except ValueError:
                pass  # 尽力而为：坏行跳过（复盘可容忍丢行）
    return tasks


def dedupe_last(tasks: List[dict]) -> Dict[str, dict]:
    """同 taskBindingId 多条 → 取最后一条为当前状态。"""
    by_id = {}  # type: Dict[str, dict]
    for t in tasks:
        tid = t.get("taskBindingId") or t.get("runId") or ""
        if tid:
            by_id[tid] = t
    return by_id


def parse_ts(s: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def fmt_pct(n: int, d: int) -> str:
    return "{:.1f}%".format(100.0 * n / d) if d else "n/a"


def main() -> int:
    ap = argparse.ArgumentParser(description="任务成功率统计基线（只读）")
    ap.add_argument("--data-dir", default=".pi-wechat", help="wechat 数据目录（含 tasks.jsonl）")
    ap.add_argument("--stale-hours", type=float, default=2.0, help="running 超过该小时数判为僵死（默认 2）")
    ap.add_argument("--since", default=None, help="只统计 createdAt >= YYYY-MM-DD 的任务")
    ap.add_argument("--top", type=int, default=10, help="僵死清单最多显示条数（默认 10）")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    tasks_path = data_dir / "tasks.jsonl"
    if not tasks_path.exists():
        print("[FAIL] 找不到 {}".format(tasks_path))
        return 1

    raw = load_tasks(tasks_path)
    if not raw:
        print("[FAIL] {} 无有效记录".format(tasks_path))
        return 1

    by_id = dedupe_last(raw)
    now = datetime.now(timezone.utc)
    since_dt = None  # type: Optional[datetime]
    if args.since:
        since_dt = parse_ts(args.since + "T00:00:00+00:00")

    cur = list(by_id.values())
    if since_dt is not None:
        cur = [t for t in cur if (parse_ts(t.get("createdAt", "")) or now) >= since_dt]

    total = len(cur)
    status_count = {}  # type: Dict[str, int]
    stale = []  # type: List[dict]
    for t in cur:
        st = t.get("status", "?")
        status_count[st] = status_count.get(st, 0) + 1
        if st == "running":
            ts = parse_ts(t.get("updatedAt", ""))
            if ts is not None and (now - ts) > timedelta(hours=args.stale_hours):
                stale.append(t)

    terminal_n = sum(status_count.get(s, 0) for s in TERMINAL)
    completed = status_count.get("completed", 0)
    stale_n = len(stale)
    active_running = status_count.get("running", 0) - stale_n

    print("[OK] 数据源: {} （原始 {} 行，去重后 {} 任务，since={}）".format(
        tasks_path, len(raw), total, args.since or "全部"))
    print()
    print("== 状态分布（去重，末行为准）==")
    for st in sorted(status_count, key=lambda s: -status_count[s]):
        print("  {:24s} {:4d}".format(st, status_count[st]))
    print()
    print("== 成功率 ==")
    print("  strict（终态口径）      : {} / {} = {}".format(completed, terminal_n, fmt_pct(completed, terminal_n)))
    real_d = terminal_n + stale_n
    print("  real（僵死计失败口径）  : {} / {} = {}".format(completed, real_d, fmt_pct(completed, real_d)))
    print("  （active running {} 条不计入，等待 checkpoint {} 条不计入）".format(
        active_running, status_count.get("waiting_checkpoint", 0)))
    print()
    print("== 渠道分布 ==")
    ch = {}  # type: Dict[str, int]
    for t in cur:
        c = t.get("channel", "?")
        ch[c] = ch.get(c, 0) + 1
    for c in sorted(ch, key=lambda k: -ch[k]):
        print("  {:24s} {:4d}".format(c, ch[c]))
    print()
    print("== 工作流分布（top）==")
    wf = {}  # type: Dict[str, List[int]]
    for t in cur:
        w = t.get("workflowId", "?")
        st = t.get("status", "?")
        cnt = wf.setdefault(w, [0, 0, 0])  # total, completed, failed
        cnt[0] += 1
        if st == "completed":
            cnt[1] += 1
        elif st == "failed":
            cnt[2] += 1
    for w in sorted(wf, key=lambda k: -wf[k][0])[:15]:
        tot, ok, bad = wf[w]
        print("  {:32s} total={:3d} ok={:3d} fail={:3d}".format(w, tot, ok, bad))
    print()
    if stale_n:
        print("[WARN] 僵死 running（> {}h 无更新）{} 条：".format(args.stale_hours, stale_n))
        stale.sort(key=lambda t: t.get("updatedAt", ""))
        for t in stale[: args.top]:
            age_h = "?"

            ts = parse_ts(t.get("updatedAt", ""))
            if ts is not None:
                age_h = "{:.1f}h".format((now - ts).total_seconds() / 3600)
            print("    {} {} {} updatedAt={} age={}".format(
                t.get("taskBindingId", "?"), t.get("workflowId", "?"),
                t.get("channel", "?"), t.get("updatedAt", "?"), age_h))
        if stale_n > args.top:
            print("    ... 其余 {} 条省略".format(stale_n - args.top))
    else:
        print("[OK] 无僵死 running")
    print()
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
