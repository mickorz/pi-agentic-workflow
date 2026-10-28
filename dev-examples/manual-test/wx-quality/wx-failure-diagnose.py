#!/usr/bin/env python3
"""P1 失败诊断与故障排行榜（失败任务统计与自动诊断 V1.2 · T6）

只读扫描近 N 天三层失败与未决异常，两级错误归类（V1.2 §4 P1）：
  第一层 错误类别（确定性规则，按故障阶段）：
    ROUTING_ERROR / RUN_START_ERROR / AGENT_UNKNOWN / WORKFLOW_ERROR /
    MODEL_API_ERROR（HTTP 状态码保留）/ TOOL_EXEC_ERROR / NOTIFY_ERROR / UNKNOWN
  第二层 归一化指纹 = sha256(类别|errorCode|stage|normalizedMessage)[:12]
    errorCode（HTTP 状态码/errno）保留；仅数字/UUID/hash/路径/引号内容归一化。

排行榜字段：失败次数、影响任务数（去重）、影响 Workflow、错误类别、证据路径、
可恢复性（V1.2 收紧：interrupted 不自动标可 resume，只报恢复条件事实；unknown/unresolved 必须人工；
NOTIFY_ERROR 机制内重试；置信度首版不标高，无法确认根因标"未知模式"）。

用法：
    python3 wx-failure-diagnose.py --data <dataDir> [--runs <runsDir>] [--days 7] [--top 10] [--date YYYY-MM-DD] [--out <目录>]

输出：<out>/diagnose-<date>.{json,md}；stdout [OK] 榜单概要 / === ALL DONE ===；exit 0/1。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

UNRESOLVED_WINDOW = timedelta(minutes=15)
HTTP_RE = re.compile(r"\b(4\d\d|5\d\d)\b")
ERRNO_RE = re.compile(r"\b(E[A-Z]{4,12})\b")  # ECONNREFUSED / ETIMEDOUT / ENOENT ...
UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
HEX_RE = re.compile(r"\b[0-9a-fA-F]{12,64}\b")
PATH_RE = re.compile(r"(?:[A-Za-z]:[\\/]|\/(?:home|Users|mnt|tmp|var|opt)\/)[^\s\"']+")
NUM_RE = re.compile(r"\d+")
QUOTE_RE = re.compile(r"\"[^\"]{4,}\"|'[^']{4,}'")
SECRET_RE = re.compile(r"(sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S+|token[=:]\s*\S{6,})", re.IGNORECASE)
# MODEL_API 特征（provider 关键词 / 限流 / 额度；HTTP 码由 errorCode 单独保留）
MODEL_API_HINT = re.compile(
    r"(openai|anthropic|claude|gpt|api[_ ]?key|rate[_ ]?limit|quota|too many requests|"
    r"model|provider|completion|embedding)", re.IGNORECASE)
TOOL_HINT = re.compile(r"(node|exit code|command|spawn|工具|节点|script|exec|EAI_AGAIN|ECONN)", re.IGNORECASE)

CATEGORY_ORDER = ["ROUTING_ERROR", "RUN_START_ERROR", "AGENT_UNKNOWN", "WORKFLOW_ERROR",
                  "MODEL_API_ERROR", "TOOL_EXEC_ERROR", "NOTIFY_ERROR", "UNKNOWN"]


# ── 基础工具（与 wx-quality-report.py 同契约） ──

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
        if isinstance(rec, dict):
            recs.append(rec)
        else:
            broken += 1
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


def redact(text: str) -> str:
    return SECRET_RE.sub("***", text or "")


# ── 归一化与指纹 ──

def normalize_message(text: str) -> str:
    """归一化错误文本：引号内容→"…"、路径→<PATH>、UUID/hash→<ID>、数字→N（errorCode 由指纹单独保留）。"""
    s = text or ""
    s = QUOTE_RE.sub('"…"', s)
    s = PATH_RE.sub("<PATH>", s)
    s = UUID_RE.sub("<ID>", s)
    s = HEX_RE.sub("<ID>", s)
    s = NUM_RE.sub("N", s)
    return s.strip().lower()[:300]


def extract_error_code(text: str) -> str:
    """errorCode：HTTP 状态码优先，其次 errno（保留不归一化——401 与 429 必须分开）。"""
    m = HTTP_RE.search(text or "")
    if m:
        return m.group(1)
    m = ERRNO_RE.search(text or "")
    if m:
        return m.group(1)
    return "-"


def fingerprint(category: str, code: str, stage: str, normalized: str) -> str:
    raw = f"{category}|{code}|{stage}|{normalized}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


# ── issue 收集与分类 ──

def read_run_evidence(runs_dir: Optional[Path], run_id: str) -> dict:
    """manifest.error / result 摘要 / journal 尾部（读取失败不阻塞）。"""
    ev = {"manifestError": None, "resultSummary": None, "journalTail": None,
          "hasCheckpointFile": False, "paths": []}
    if not runs_dir or not run_id:
        return ev
    d = runs_dir / run_id
    mf = d / "manifest.json"
    if mf.is_file():
        ev["paths"].append(str(mf))
        try:
            ev["manifestError"] = json.loads(mf.read_text(encoding="utf-8")).get("error")
        except (json.JSONDecodeError, OSError):
            pass
    rs = d / "result.json"
    if rs.is_file():
        ev["paths"].append(str(rs))
        try:
            res = json.loads(rs.read_text(encoding="utf-8"))
            ev["resultSummary"] = str(res.get("summary") or res.get("error") or "")[:200]
        except (json.JSONDecodeError, OSError):
            pass
    jr = d / "journal.jsonl"
    if jr.is_file():
        ev["paths"].append(str(jr))
        try:
            tail = jr.read_text(encoding="utf-8", errors="replace").splitlines()[-50:]
            ev["journalTail"] = "\n".join(redact(x) for x in tail)[-2000:]
        except OSError:
            pass
    # 恢复条件事实（V1.2）：checkpoint 文件存在性。ponytail: 按文件名探测，不解析内容
    try:
        ev["hasCheckpointFile"] = any("checkpoint" in p.name for p in d.iterdir()) if d.is_dir() else False
    except OSError:
        pass
    return ev


def classify(stage: str, error_text: str) -> str:
    """第一层类别：先按 stage 定位，再按文本特征细分（MODEL_API/TOOL 覆盖 WORKFLOW_ERROR）。"""
    if stage in ("notify",):
        return "NOTIFY_ERROR"
    if stage == "agent-unknown":
        return "AGENT_UNKNOWN"
    if stage == "run-start":
        return "RUN_START_ERROR"
    if stage == "routing":
        return "ROUTING_ERROR"
    # workflow 来源：按文本细分
    if MODEL_API_HINT.search(error_text or "") and (HTTP_RE.search(error_text or "") or
                                                    re.search(r"rate|quota|limit|key|429|401", error_text, re.IGNORECASE)):
        return "MODEL_API_ERROR"
    if TOOL_HINT.search(error_text or ""):
        return "TOOL_EXEC_ERROR"
    return "WORKFLOW_ERROR"


def collect_issues(data_dir: Path, runs_dir: Optional[Path], win_start: datetime, win_end: datetime) -> List[dict]:
    """近窗口三层失败与未决异常。unknown/unresolved 天然按 attemptId 去重（只扫 run-attempts）。"""
    now = datetime.now().astimezone()
    issues: List[dict] = []

    def in_win(ts: Optional[str]) -> bool:
        d = parse_ts(ts)
        return d is not None and win_start <= d <= win_end

    # 1) 任务失败/中断（final 折叠）
    tasks = fold_last(read_jsonl(data_dir / "tasks.jsonl")[0], "runId")
    for rid, b in tasks.items():
        if not in_win(b.get("updatedAt") or b.get("createdAt")):
            continue
        if b.get("status") not in ("failed", "interrupted"):
            continue
        ev = read_run_evidence(runs_dir, rid)
        error_text = b.get("summary") or ev["manifestError"] or ""
        issues.append({
            "runId": rid, "taskBindingId": b.get("taskBindingId"), "workflowId": b.get("workflowId"),
            "stage": "workflow", "status": b["status"],
            "occurredAt": b.get("updatedAt") or b.get("createdAt"),
            "errorText": redact(str(error_text)[:500]), "evidence": ev,
        })
    # 2) unknown / unresolved 启动尝试（attemptId 去重）
    attempts = fold_last(read_jsonl(data_dir / "run-attempts.jsonl")[0], "attemptId")
    for aid, a in attempts.items():
        created = parse_ts(a.get("createdAt"))
        if created is None or not (win_start <= created <= win_end):
            continue
        if a.get("status") == "unknown":
            issues.append({"attemptId": aid, "runId": a.get("runId"), "workflowId": a.get("workflowId"),
                           "stage": "agent-unknown", "status": "unknown", "occurredAt": a.get("createdAt"),
                           "errorText": "launch unknown（副作用未确认，禁自动重试）", "evidence": {}})
        elif a.get("status") == "launched" and now - created > UNRESOLVED_WINDOW:
            issues.append({"attemptId": aid, "runId": a.get("runId"), "workflowId": a.get("workflowId"),
                           "stage": "run-start", "status": "unresolved", "occurredAt": a.get("createdAt"),
                           "errorText": "launched 未 link 超 15min 观察窗（不判失败，需人工核对）", "evidence": {}})
    # 3) outbox 放弃/失败
    outbox = fold_last(read_jsonl(data_dir / "outbox.jsonl")[0], "outboxId")
    for oid, o in outbox.items():
        if o.get("status") != "failed" or not in_win(o.get("createdAt")):
            continue
        issues.append({"outboxId": oid, "runId": o.get("runId"), "workflowId": None,
                       "stage": "notify", "status": "failed", "occurredAt": o.get("createdAt"),
                       "errorText": redact(str(o.get("lastError") or "通知重试放弃")[:500]),
                       "evidence": {"paths": [str(data_dir / "outbox.jsonl")]}})
    # 4) 启动失败审计（run.start outcome=failed；与 attempt 维度可能重复，按 runId 无重复项过滤简化为直接计入）
    for t in read_jsonl(data_dir / "audit.jsonl")[0]:
        if t.get("action") == "run.start" and t.get("outcome") == "failed" and in_win(t.get("at")):
            issues.append({"runId": t.get("target", {}).get("runId"),
                           "workflowId": t.get("target", {}).get("workflowId"),
                           "stage": "run-start", "status": "failed", "occurredAt": t.get("at"),
                           "errorText": redact(str(t.get("detail") or "run.start failed")[:500]),
                           "evidence": {"paths": [str(data_dir / "audit.jsonl")]}})
    return issues


def recoverability(issue: dict) -> str:
    """V1.2 收紧：不自动下'可 resume'结论，报告恢复条件事实。"""
    st = issue.get("status")
    if st == "unknown":
        return "必须人工（副作用未确认，禁自动重试）"
    if st == "unresolved":
        return "必须人工（不能证明未执行）"
    if st == "interrupted":
        ck = issue.get("evidence", {}).get("hasCheckpointFile")
        err = (issue.get("evidence", {}).get("manifestError") or "")[:80]
        return f"需人工评估（checkpoint文件: {'有' if ck else '无'}; manifest.error: {redact(err) or '-'}）"
    if issue.get("stage") == "notify":
        return "机制内重试（Outbox 已放弃，用户可主动查询补偿）"
    return "未知模式（需检查证据）"


# ── 聚合与输出 ──

def build_leaderboard(issues: List[dict], top: int) -> List[dict]:
    groups: Dict[str, List[dict]] = {}
    for it in issues:
        text = it.get("errorText") or ""
        cat = classify(it["stage"], text)
        code = extract_error_code(text)
        norm = normalize_message(text)
        fp = fingerprint(cat, code, it["stage"], norm)
        it["_fp"] = fp
        groups.setdefault(fp, []).append(it)
    rows = []
    for fp, items in groups.items():
        runs = {i.get("runId") or i.get("attemptId") or i.get("outboxId") for i in items}
        wfs = sorted({i.get("workflowId") for i in items if i.get("workflowId")})
        times = [parse_ts(i.get("occurredAt")) for i in items]
        times = [t for t in times if t]
        rows.append({
            "fingerprint": fp,
            "category": classify(items[0]["stage"], items[0].get("errorText") or ""),
            "errorCode": extract_error_code(items[0].get("errorText") or ""),
            "stage": items[0]["stage"],
            "normalizedMessage": normalize_message(items[0].get("errorText") or ""),
            "count": len(items),
            "affectedTasks": len(runs),
            "workflows": wfs,
            "firstSeen": min(times).isoformat() if times else None,
            "lastSeen": max(times).isoformat() if times else None,
            "recoverability": recoverability(items[0]),
            "sampleIds": sorted(runs)[:3],
            "evidencePaths": [p for i in items[:3] for p in i.get("evidence", {}).get("paths", [])][:3],
        })
    rows.sort(key=lambda r: (-r["count"], -r["affectedTasks"], r["category"]))
    return rows[:top]


def render_markdown(rows: List[dict], meta: dict) -> str:
    lines = [
        f"# 微信工作流故障排行榜（{meta['date']}，近 {meta['days']} 天）",
        "",
        f"扫描窗口：{meta['windowStart']} ~ {meta['windowEnd']} | 异常条目 {meta['totalIssues']}，"
        f"聚合为 {len(rows)} 类（Top {meta['top']}）",
        "",
        "| # | 错误类别 | errorCode | 失败次数 | 影响任务数 | 影响 Workflow | 可恢复性 | 最近出现 | 归一化消息 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for i, r in enumerate(rows, 1):
        lines.append(
            f"| {i} | {r['category']} | {r['errorCode']} | {r['count']} | {r['affectedTasks']} | "
            f"{', '.join(r['workflows']) or '-'} | {r['recoverability']} | "
            f"{(r['lastSeen'] or '')[:16]} | {r['normalizedMessage'][:60]} |")
    lines += ["", "## 证据与样例（详 JSON）"]
    for i, r in enumerate(rows, 1):
        lines.append(f"- #{i} {r['fingerprint']}：样例 {', '.join(r['sampleIds'])}；"
                     f"证据 {', '.join(r['evidencePaths']) or '-'}")
    lines += ["", "说明：根因提示为确定性规则归类，无法确认的一律未知模式，不作为根因结论；"
              "unknown/unresolved 不判失败、禁自动重试（AM-P0 原则）。"]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="P1 失败诊断与故障排行榜（wx-quality T6）")
    parser.add_argument("--data", required=True)
    parser.add_argument("--runs", default=None)
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--date", default=None, help="窗口截止日 YYYY-MM-DD（缺省今天）")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    data_dir = Path(args.data)
    runs_dir = Path(args.runs) if args.runs else (data_dir.parent / ".pi-workflows" / "runs")
    out_dir = Path(args.out) if args.out else (data_dir / "quality")
    out_dir.mkdir(parents=True, exist_ok=True)

    date = args.date or datetime.now().astimezone().strftime("%Y-%m-%d")
    win_end = datetime.fromisoformat(date + "T23:59:59").astimezone()
    win_start = datetime.fromisoformat(date + "T00:00:00").astimezone() - timedelta(days=args.days - 1)

    issues = collect_issues(data_dir, runs_dir if runs_dir.is_dir() else None, win_start, win_end)
    rows = build_leaderboard(issues, args.top)
    report = {
        "date": date, "days": args.days, "top": args.top,
        "windowStart": win_start.isoformat(), "windowEnd": win_end.isoformat(),
        "totalIssues": len(issues), "leaderboard": rows,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    (out_dir / f"diagnose-{date}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / f"diagnose-{date}.md").write_text(render_markdown(rows, report), encoding="utf-8")

    top1 = rows[0] if rows else None
    print(f"[OK] 近 {args.days} 天异常 {len(issues)} 条 → {len(rows)} 类；"
          f"Top1: {top1['category']} {top1['errorCode']} × {top1['count']}" if top1
          else f"[OK] 近 {args.days} 天无失败/未决异常")
    print(f"报告: {out_dir / f'diagnose-{date}.md'}（JSON 同名）")
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
