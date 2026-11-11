#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""session Token 用量离线分析：阶段时间窗 × pi session jsonl → 各阶段 Token/成本/工具统计。

零侵入执行器（2026-11-11 方案 D3）：pi session 文件的 assistant 消息自带
usage（input/output/cacheRead/cacheWrite/reasoning/totalTokens/cost）+ UTC 时间戳，
本脚本读取文章目录 time-log.jsonl 的阶段时间窗做归因聚合。

归因口径：阶段窗 = 相邻阶段完成点区间（与 track_time.py 同算法，交互事件不参与）；
窗内消息归该阶段，首事件前/末阶段点后的消息计入"未归属"。
cacheRead/cacheWrite 与 input 分列展示，不并入 input 重复累加。

归因可信度 attribution_confidence（2026-11-11 评审补充）：
  high   未归属 Token 占比 <5%（窗内消息基本全部归属）
  medium <30%（少量其他活动）
  low    >=30%（会话混杂，数据不可靠，不得进对比结论）
占比分母 = session 文件内全部带 usage 的 assistant 消息（含窗外活动），
专门捕捉"同一 session 混入非本篇工作"的污染。

用法:
  python3 session_usage_report.py --article-dir <文章目录> --session <session.jsonl>
  python3 session_usage_report.py --article-dir <dir> --sessions-dir ~/.pi/agent/sessions
      # 不指定 --session 时在目录下自动挑与时间窗重叠消息最多的 session 文件

输出契约: [OK]/[FAIL]/[WARN] + 中文提示；报告为 stdout 表格，=== ALL DONE === 收尾。
Python 3.9 兼容，仅标准库。
"""
import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from track_time import load_events, stage_points  # 复用窗口算法，保证口径一致


def parse_iso(s):
    """解析 ISO 时间戳（兼容 Z 后缀），aware 转本地 naive。"""
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt


def load_session(path):
    """读 session jsonl，返回 (usage_msgs, other_usage, tool_errors)。
    usage_msgs: [(dt, usage_dict, tool_names:list)]
    other_usage: [(dt, kind, usage_dict)]  非 assistant 消息的 usage 条目（如 cache_warm）
    """
    usage_msgs, other_usage, bad = [], [], 0
    f = Path(path)
    if not f.is_file():
        print("[FAIL] session 文件不存在: %s" % f)
        return usage_msgs, other_usage, bad, False
    for line in f.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            bad += 1
            continue
        if entry.get("type") == "usage":
            try:
                other_usage.append((parse_iso(entry["timestamp"]), entry.get("kind", "?"), entry["usage"]))
            except (KeyError, ValueError):
                bad += 1
            continue
        if entry.get("type") != "message":
            continue
        msg = entry.get("message") or {}
        if msg.get("role") != "assistant":
            continue
        usage = msg.get("usage")
        if not usage:
            continue
        tools = [b.get("name", "?") for b in (msg.get("content") or [])
                 if isinstance(b, dict) and b.get("type") == "toolCall"]
        try:
            usage_msgs.append((parse_iso(entry["timestamp"]), usage, tools))
        except (KeyError, ValueError):
            bad += 1
    return usage_msgs, other_usage, bad, True


def pick_session(sessions_dir, t0, t1):
    """在 sessions_dir 下递归找与时间窗重叠 assistant 消息最多的 jsonl。"""
    root = Path(sessions_dir).expanduser()
    if not root.is_dir():
        print("[FAIL] sessions 目录不存在: %s" % root)
        return None
    best, best_score = None, 0
    for f in root.rglob("*.jsonl"):
        msgs = load_session(f)[0]
        score = sum(1 for dt, _, _ in msgs if t0 <= dt <= t1)
        if score > best_score:
            best, best_score = f, score
    if best is None:
        print("[FAIL] %s 下没有与时间窗 %s~%s 重叠的 session" % (root, t0, t1))
        return None
    print("[OK] 自动选中 session: %s（窗内 %d 条 assistant 消息）" % (best.name, best_score))
    return best


def fmt_num(n):
    return "{:,}".format(int(n))


def build_report(article_dir, session_path):
    events = load_events(article_dir)
    if not events:
        print("[FAIL] 无 time-log.jsonl 或为空: %s" % article_dir)
        return 2
    pts = stage_points(events)
    if not pts:
        print("[FAIL] time-log 无阶段完成点（只有交互事件？）")
        return 2
    events.sort(key=lambda e: e["_dt"])
    t0 = events[0]["_dt"]
    last_point = pts[-1][1]

    usage_msgs, other_usage, bad, ok = load_session(session_path)
    if not ok:
        return 2
    if bad:
        print("[WARN] 跳过 %d 行损坏/缺字段的 session 行" % bad)
    if not usage_msgs:
        print("[FAIL] session 内无带 usage 的 assistant 消息: %s" % session_path)
        return 2

    # 阶段窗边界: [t0,p1) [p1,p2) ... [p_{n-1},pn)；pn 之后为未归属尾
    bounds = [t0] + [p[1] for p in pts]
    stages = [p[0] for p in pts]
    labels = stages + ["未归属"]
    agg = {lb: {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                "reasoning": 0, "calls": 0, "cost": 0.0, "tools": Counter()}
           for lb in labels}
    all_total = 0
    for dt, usage, tools in usage_msgs:
        total = int(usage.get("totalTokens") or 0)
        all_total += total
        lb = "未归属"
        if t0 <= dt < bounds[-1]:
            for i in range(len(bounds) - 1):
                if bounds[i] <= dt < bounds[i + 1]:
                    lb = stages[i]
                    break
        a = agg[lb]
        a["input"] += int(usage.get("input") or 0)
        a["output"] += int(usage.get("output") or 0)
        a["cacheRead"] += int(usage.get("cacheRead") or 0)
        a["cacheWrite"] += int(usage.get("cacheWrite") or 0)
        a["reasoning"] += int(usage.get("reasoning") or 0)
        a["calls"] += 1
        cost = usage.get("cost") or {}
        a["cost"] += float(cost.get("total") or 0)
        for t in tools:
            a["tools"][t] += 1
    other_calls = len(other_usage)
    other_total = sum(int(u.get("totalTokens") or 0) for _, _, u in other_usage)

    unattr = agg["未归属"]
    unattr_tokens = sum(unattr[k] for k in ("input", "output", "cacheRead", "cacheWrite", "reasoning"))
    ratio = unattr_tokens / max(all_total, 1)
    if ratio < 0.05:
        conf = "high"
    elif ratio < 0.30:
        conf = "medium"
    else:
        conf = "low"

    print("=== Session Token 用量报告: %s ===" % Path(article_dir).name)
    print("session: %s" % session_path)
    print("时间窗: %s -> %s（%d 个阶段）" % (t0.strftime("%m-%d %H:%M"), last_point.strftime("%m-%d %H:%M"), len(stages)))
    print("")
    print("%-12s %6s %12s %12s %12s %12s %10s %10s" % ("阶段", "调用", "输入", "输出", "缓存读", "缓存写", "推理", "成本"))
    for lb in labels + ["汇总"]:
        a = agg["未归属"] if lb == "未归属" else agg.get(lb)
        if lb == "汇总":
            a = {k: sum(agg[x][k] for x in labels) for k in
                 ("input", "output", "cacheRead", "cacheWrite", "reasoning", "calls", "cost")}
        print("%-12s %6d %12s %12s %12s %12s %10s %10.4f" % (
            lb, a["calls"], fmt_num(a["input"]), fmt_num(a["output"]),
            fmt_num(a["cacheRead"]), fmt_num(a["cacheWrite"]), fmt_num(a["reasoning"]), a["cost"]))
    if other_calls:
        print("[提示] 另有 %d 条非对话 usage 条目（如 cache_warm），共 %s tokens，未计入上表" % (other_calls, fmt_num(other_total)))
    print("")
    top_tools = Counter()
    for lb in labels:
        top_tools.update(agg[lb]["tools"])
    if top_tools:
        heads = ", ".join("%s×%d" % (n, c) for n, c in top_tools.most_common(8))
        print("工具调用（窗内合计）: %s" % heads)
    print("")
    print("归因可信度: %s（未归属 Token 占比 %.1f%%，分母=session 全部 assistant usage=%s tokens）" % (
        conf, ratio * 100, fmt_num(all_total)))
    if conf == "low":
        print("[WARN] low：会话混杂严重，本表数据不得用于跨篇对比结论")
    elif conf == "medium":
        print("[提示] medium：存在少量窗外活动，跨篇对比时注明口径")
    print("[提示] cacheRead/cacheWrite 与 input 分列，不重复累加；推理 tokens 单列（provider 口径）")
    print("=== ALL DONE ===")
    return 0


def main():
    ap = argparse.ArgumentParser(description="阶段时间窗 × pi session jsonl 的 Token 用量分析")
    ap.add_argument("--article-dir", required=True, help="文章目录（读 time-log.jsonl）")
    ap.add_argument("--session", default=None, help="session jsonl 路径；缺省时用 --sessions-dir 自动挑")
    ap.add_argument("--sessions-dir", default=None, help="sessions 根目录（如 ~/.pi/agent/sessions），自动挑窗内消息最多的文件")
    args = ap.parse_args()
    d = Path(args.article_dir)
    if not d.is_dir():
        print("[FAIL] 文章目录不存在: %s" % d)
        sys.exit(2)
    session = args.session
    if session is None:
        if args.sessions_dir is None:
            print("[FAIL] 需要 --session 或 --sessions-dir 之一")
            sys.exit(2)
        events = load_events(d)
        if not events:
            print("[FAIL] 无 time-log.jsonl: %s" % d)
            sys.exit(2)
        events.sort(key=lambda e: e["_dt"])
        picked = pick_session(args.sessions_dir, events[0]["_dt"], events[-1]["_dt"])
        if picked is None:
            sys.exit(2)
        session = picked
    sys.exit(build_report(d, session))


if __name__ == "__main__":
    main()
