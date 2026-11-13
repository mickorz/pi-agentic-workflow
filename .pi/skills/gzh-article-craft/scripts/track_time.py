#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gzh-article-craft 耗时追踪：每阶段记一条时间戳，发布后出耗时报告。

数据落文章目录 time-log.jsonl（每行一个 JSON 事件），随文章同步。
算法：阶段耗时 = 相邻阶段完成点的一阶差分（同阶段多条记录取最后一条），
总耗时 = 首末事件间隔；耗时天然包含阶段内等待用户确认的时间。

交互点事件（2026-11-11 新增，D4）：审批完成时记一条 interaction 事件，
支持审批返工率与实际修改产物（changed_artifacts）统计：
  python3 track_time.py log --article-dir <dir> --stage 写作 \
      --interaction approval --result confirm          # 只是确认
  python3 track_time.py log --article-dir <dir> --stage 写作 \
      --interaction approval --result rework --artifacts chapter-03.md,chapter-04.md

用法:
  记录事件（阶段完成时执行；补录历史加 --ts）:
    python3 track_time.py log --article-dir <文章目录> --stage 写作
    python3 track_time.py log --article-dir <dir> --stage 定位 --event start --ts "2026-11-11T14:04:00"
  单篇报告:
    python3 track_time.py report --article-dir <文章目录>
  跨篇历史汇总（扫描 vault_root 下 **/time-log.jsonl）:
    python3 track_time.py report --vault-root "<vault>/60_Workspace/写作/单篇"

输出契约: [OK]/[FAIL]/[WARN] + 中文提示；报告为 stdout 表格，=== ALL DONE === 收尾。
旧格式 time-log.jsonl（无交互事件）照常出报告。
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

LOG_NAME = "time-log.jsonl"
STAGES = ["定位", "写作", "截图", "提示词审批", "生图", "入文", "humanizer", "入箱准备", "排版审阅", "发布"]
INTERACTION_RESULTS = ["confirm", "rework", "edit"]


def load_events(article_dir):
    f = Path(article_dir) / LOG_NAME
    events = []
    if f.is_file():
        for line in f.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
                ev["_dt"] = datetime.fromisoformat(ev["ts"])
                events.append(ev)
            except (ValueError, KeyError):
                print("[WARN] 跳过损坏行: %s" % line[:60])
    return events


def parse_ts(s):
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        print("[FAIL] 时间戳格式非法（需 ISO 格式，如 2026-11-11T14:04:00）: %s" % s)
        return None


def cmd_log(args):
    d = Path(args.article_dir)
    if not d.is_dir():
        print("[FAIL] 文章目录不存在: %s" % d)
        return 2
    if args.ts is not None and parse_ts(args.ts) is None:
        return 2
    ts = args.ts or datetime.now().isoformat(timespec="seconds")
    if args.interaction is not None:
        if args.result is None:
            print("[FAIL] --interaction 需要配套 --result（confirm/rework/edit）")
            return 2
        if args.result not in INTERACTION_RESULTS:
            print("[FAIL] --result 非法: %s（可选 %s）" % (args.result, "/".join(INTERACTION_RESULTS)))
            return 2
        rec = {"ts": ts, "stage": args.stage, "type": "interaction",
               "interaction": args.interaction, "result": args.result}
        if args.artifacts:
            rec["artifacts"] = [a.strip() for a in args.artifacts.split(",") if a.strip()]
        if args.note:
            rec["note"] = args.note
        with (d / LOG_NAME).open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        extra = " 修改产物=%s" % rec["artifacts"] if rec.get("artifacts") else ""
        print("[OK] 已记录 交互=%s 结果=%s 阶段=%s @ %s%s" % (args.interaction, args.result, args.stage, ts, extra))
        return 0
    rec = {"ts": ts, "stage": args.stage, "event": args.event}
    if args.note:
        rec["note"] = args.note
    with (d / LOG_NAME).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print("[OK] 已记录 阶段=%s 事件=%s @ %s" % (args.stage, args.event, ts))
    return 0


def stage_points(events):
    """阶段完成点: 每 stage 取时间最晚的一条【非交互】事件, 返回 [(stage, dt, ts_str)] 按时间升序。
    interaction 事件不参与阶段差分（否则会污染阶段耗时）。"""
    latest = {}
    for ev in events:
        if ev.get("type") == "interaction":
            continue
        s = ev["stage"]
        if s not in latest or ev["_dt"] > latest[s]["_dt"]:
            latest[s] = ev
    pts = sorted(((v["stage"], v["_dt"], v["ts"]) for v in latest.values()), key=lambda x: x[1])
    return pts


def interaction_points(events):
    """交互点: type=interaction 的事件按时间升序，附距上一事件（任意类型）的分钟数。"""
    if not events:
        return []
    timeline = sorted(events, key=lambda e: e["_dt"])
    out = []
    for i, ev in enumerate(timeline):
        if ev.get("type") != "interaction":
            continue
        prev_dt = timeline[i - 1]["_dt"] if i > 0 else ev["_dt"]
        gap = (ev["_dt"] - prev_dt).total_seconds() / 60
        out.append({"ev": ev, "gap": gap})
    return out


def fmt_span(a, b):
    """起止时间显示 HH:MM -> HH:MM（跨天时带日期）。"""
    if a.date() == b.date():
        return "%s:%s -> %s:%s" % ("%02d" % a.hour, "%02d" % a.minute, "%02d" % b.hour, "%02d" % b.minute)
    return "%s %s:%s -> %s %s:%s" % (a.date(), "%02d" % a.hour, "%02d" % a.minute, b.date(), "%02d" % b.hour, "%02d" % b.minute)


def report_one(article_dir, html_out=False):
    events = load_events(article_dir)
    if not events:
        print("[FAIL] 无 %s 或为空: %s" % (LOG_NAME, article_dir))
        return 2
    events.sort(key=lambda e: e["_dt"])
    t0, t1 = events[0]["_dt"], events[-1]["_dt"]
    total_min = (t1 - t0).total_seconds() / 60
    pts = stage_points(events)
    print("=== 单篇耗时报告: %s ===" % Path(article_dir).name)
    print("阶段          起止                        耗时min  占比")
    rows = []
    prev = t0
    for stage, dt, ts in pts:
        mins = (dt - prev).total_seconds() / 60
        pct = round(mins * 100 / total_min) if total_min > 0 else 0
        rows.append((stage, fmt_span(prev, dt), mins, pct))
        prev = dt
    for stage, span, mins, pct in rows:
        print("%-12s %-24s %6.0f    %3d%%" % (stage, span, mins, pct))
    print("总耗时: %.0f min（%s -> %s），共 %d 个阶段" % (total_min, t0.strftime("%m-%d %H:%M"), t1.strftime("%H:%M"), len(pts)))
    print("[提示] 阶段耗时为相邻完成点间隔，包含阶段内等待用户确认的时间")
    # 交互点统计（旧格式无交互事件时整节省略，保持兼容）
    inters = interaction_points(events)
    if inters:
        print("")
        print("交互点        时间                阶段        结果      距上事件min  修改产物")
        for it in inters:
            ev = it["ev"]
            arts = ",".join(ev.get("artifacts", [])) or "-"
            print("%-12s %-18s %-10s %-8s %10.1f    %s" % (
                ev.get("interaction", "approval"), ev["_dt"].strftime("%m-%d %H:%M"),
                ev["stage"], ev.get("result", "?"), it["gap"], arts[:30]))
        n = len(inters)
        reworks = sum(1 for it in inters if it["ev"].get("result") in ("rework", "edit"))
        avg_gap = sum(it["gap"] for it in inters) / n
        changed = sum(len(it["ev"].get("artifacts", [])) for it in inters)
        print("交互合计: %d 次；审批返工率 %d/%d（%d%%）；平均距上事件 %.1f min；修改产物 %d 个" % (
            n, reworks, n, round(reworks * 100 / n), avg_gap, changed))
        print("[提示] 交互耗时为距上一事件间隔（含 agent 产出+等待用户，口径近似）；rework/edit 计入返工，confirm 为纯确认")
    if html_out:
        write_html_report(Path(article_dir), Path(article_dir).name, rows, total_min, t0, t1, len(pts), inters)
    return 0


def write_html_report(article_dir, name, rows, total_min, t0, t1, n_stages, inters):
    """html 版耗时报告：纯 CSS 条形，无依赖，落 <文章目录>/耗时报告.html（2026-11-13 定案）"""
    max_mins = max((r[2] for r in rows), default=1) or 1
    bar_rows = "".join(
        "<tr><td>%s</td><td class=span>%s</td>"
        "<td><div class=bar style=width:%.0f%%></div><span class=val>%.0f min · %d%%</span></td></tr>"
        % (stage, span, mins * 90 / max_mins, mins, pct)
        for stage, span, mins, pct in rows)
    inter_html = ""
    if inters:
        trs = "".join(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td class=%s>%s</td><td>%.1f min</td><td>%s</td></tr>"
            % (it["ev"].get("interaction", "approval"), it["ev"]["_dt"].strftime("%m-%d %H:%M"),
               it["ev"]["stage"], it["ev"].get("result", "?"), it["ev"].get("result", "?"),
               it["gap"], ",".join(it["ev"].get("artifacts", [])) or "-")
            for it in inters)
        n = len(inters)
        reworks = sum(1 for it in inters if it["ev"].get("result") in ("rework", "edit"))
        inter_html = ("<h2>交互点（%d 次，返工 %d）</h2>"
                      "<table><tr><th>类型</th><th>时间</th><th>阶段</th><th>结果</th><th>距上事件</th><th>修改产物</th></tr>"
                      "%s</table>" % (n, reworks, trs))
    parts = []
    parts.append('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>耗时报告 - %s</title>' % name)
    parts.append("""<style>
body{font-family:"Microsoft YaHei",sans-serif;max-width:860px;margin:40px auto;color:#1c2733;line-height:1.6}
h1{border-bottom:3px solid #1776e8;padding-bottom:8px} h2{margin-top:32px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #dde4ec;padding:6px 10px;text-align:left}
.bar{height:18px;background:linear-gradient(90deg,#1776e8,#16b6af);border-radius:3px;display:inline-block;vertical-align:middle}
.val{font-size:13px;color:#5a6b7e;margin-left:8px} .span{white-space:nowrap;color:#5a6b7e;font-size:13px}
.sum{background:#f2f6fb;border-left:4px solid #1776e8;padding:10px 16px;margin:16px 0}
.rework{color:#c2451e;font-weight:bold} .confirm{color:#0f8a4b}
td[class=confirm]{color:#0f8a4b} td[class=rework]{color:#c2451e;font-weight:bold}
</style></head><body>""")
    parts.append("<h1>单篇耗时报告：%s</h1>" % name)
    parts.append('<div class="sum">总耗时 <b>%.0f min</b>（%s → %s）· %d 个阶段 · 含等待用户确认的时间</div>'
                 % (total_min, t0.strftime("%m-%d %H:%M"), t1.strftime("%H:%M"), n_stages))
    parts.append("<h2>阶段耗时</h2><table><tr><th>阶段</th><th>起止</th><th>耗时</th></tr>%s</table>" % bar_rows)
    if inter_html:
        parts.append(inter_html)
    parts.append('<p style="color:#8a97a5;font-size:12px;margin-top:32px">生成：track_time.py report --html</p>')
    parts.append("</body></html>")
    out = Path(article_dir) / "耗时报告.html"
    out.write_text("\n".join(parts), encoding="utf-8")
    print("[OK] html 报告 -> %s" % out)
    return 0



def report_vault(vault_root):
    root = Path(vault_root)
    if not root.is_dir():
        print("[FAIL] vault 根目录不存在: %s" % root)
        return 2
    logs = sorted(root.rglob(LOG_NAME))
    if not logs:
        print("[FAIL] 未找到任何 %s（在 %s 下）" % (LOG_NAME, root))
        return 2
    print("=== 历史耗时汇总: %s ===" % root)
    print("文章目录                                   日期        总耗时min  阶段数")
    total_all, n = 0.0, 0
    for f in logs:
        art = f.parent
        events = load_events(art)
        if not events:
            continue
        events.sort(key=lambda e: e["_dt"])
        mins = (events[-1]["_dt"] - events[0]["_dt"]).total_seconds() / 60
        stages = len(stage_points(events))
        label = "%s/%s" % (art.parent.name, art.name)
        print("%-42s %-11s %8.0f  %6d" % (label[:42], art.parent.name, mins, stages))
        total_all += mins
        n += 1
    if n:
        print("共 %d 篇，平均总耗时 %.0f min" % (n, total_all / n))
    print("=== ALL DONE ===")
    return 0


def main():
    ap = argparse.ArgumentParser(description="gzh 文章全流程耗时追踪")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("log", help="记录阶段事件")
    p1.add_argument("--article-dir", required=True)
    p1.add_argument("--stage", required=True, help="阶段名，推荐: %s" % " / ".join(STAGES))
    p1.add_argument("--event", default="done", help="start/done，默认 done")
    p1.add_argument("--interaction", default=None, help="交互类型（如 approval）；给出时本条为交互点事件而非阶段事件")
    p1.add_argument("--result", default=None, help="交互结果: %s" % " / ".join(INTERACTION_RESULTS))
    p1.add_argument("--artifacts", default=None, help="修改产物清单，逗号分隔（如 chapter-03.md,chapter-04.md）")
    p1.add_argument("--note", default=None)
    p1.add_argument("--ts", default=None, help="补录时间戳 ISO 格式，缺省取当前时间")
    p2 = sub.add_parser("report", help="耗时报告")
    g = p2.add_mutually_exclusive_group(required=True)
    g.add_argument("--article-dir")
    g.add_argument("--vault-root")
    p2.add_argument("--html", action="store_true", help="同时生成 耗时报告.html（仅 --article-dir 单篇模式）")
    args = ap.parse_args()
    if args.cmd == "log":
        sys.exit(cmd_log(args))
    if args.article_dir:
        code = report_one(args.article_dir, html_out=bool(getattr(args, 'html', False)))
    else:
        code = report_vault(args.vault_root)
    if args.article_dir:
        print("=== ALL DONE ===")
    sys.exit(code)


if __name__ == "__main__":
    main()
