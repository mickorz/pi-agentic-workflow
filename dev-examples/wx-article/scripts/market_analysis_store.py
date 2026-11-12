#!/usr/bin/env python3
"""market_analysis_store.py —— 市场分析工作流落盘器（T1，archive_inspire 同款模式）

职责（workflow VM 沙箱零 import，全部 fs 操作集中在此）：
  vault root 解析 / 状态机文件(.state/<MA-id>.json) / 幂等检查 / 受限写入报告
硬约束：所有写入必须位于 <vault>/60_Workspace/写作/市场分析/ 前缀内（commonpath + 无符号链接段）。
输出契约：stdout 纯 JSON；exit 0=ok / 1=fail。

子命令：
  probe                                     → {vault_root, market_root, state_dir, today, iso}
  idem-check --topic-key K --today D        → {exists, report_rel?, analysisId?}
  begin --topic T --topic-key K --today D   → {analysisId}（当日序号，写 RUNNING 态）
  fail --analysis-id ID --coverage JSON     → {ok}（置 RESEARCH_FAILED）
  report --analysis-id ID --topic T --today D --coverage JSON --partial 0|1
         --samples-json JSON                → {ok, report_rel}（写报告+置 RESEARCH_READY）
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MARKET_REL = "60_Workspace/写作/市场分析"


def out(payload, code):
    payload.setdefault("ok", code == 0)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return code


def fail(message):
    return out({"ok": False, "error": message}, 1)


def find_config(start: Path):
    for cur in [start, *start.parents]:
        c = cur / ".aws-article" / "config.json"
        if c.is_file():
            return c
    return None


def vault_root() -> Path:
    for anchor in (Path.cwd(), Path(__file__).resolve().parent):
        cfg = find_config(anchor)
        if cfg:
            try:
                v = json.loads(cfg.read_text(encoding="utf-8")).get("vault_root", "")
                if isinstance(v, str) and v.strip():
                    return Path(v.strip()).expanduser()
            except (OSError, ValueError):
                pass
    raise RuntimeError("vault root 未定位")


def ensure_under(child: Path, root: Path) -> Path:
    rc, rr = child.resolve(), root.resolve()
    if os.path.commonpath([str(rc), str(rr)]) != str(rr):
        raise RuntimeError(f"目标路径越界：{rc}")
    cur = rr
    for part in rc.relative_to(rr).parts[:-1]:
        cur = cur / part
        if cur.is_symlink():
            raise RuntimeError(f"路径段含符号链接：{cur}")
    return rc


def market_paths():
    v = vault_root()
    m = v / MARKET_REL
    m.mkdir(parents=True, exist_ok=True)
    s = ensure_under(m / ".state", m)
    s.mkdir(parents=True, exist_ok=True)
    return v, m, s


def read_state(state_dir: Path, aid: str):
    try:
        return json.loads((state_dir / f"{aid}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_state(state_dir: Path, aid: str, payload):
    p = ensure_under(state_dir / f"{aid}.json", state_dir)
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def main(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe")
    p1 = sub.add_parser("idem-check"); p1.add_argument("--topic-key", required=True); p1.add_argument("--today", required=True)
    p2 = sub.add_parser("begin"); p2.add_argument("--topic", required=True); p2.add_argument("--topic-key", required=True); p2.add_argument("--today", required=True)
    p3 = sub.add_parser("fail"); p3.add_argument("--analysis-id", required=True); p3.add_argument("--coverage", default="{}")
    p4 = sub.add_parser("report")
    p4.add_argument("--analysis-id", required=True); p4.add_argument("--topic", required=True); p4.add_argument("--topic-key", required=True); p4.add_argument("--today", required=True)
    p4.add_argument("--coverage", default="{}"); p4.add_argument("--partial", default="0"); p4.add_argument("--samples-json", required=True); p4.add_argument("--analysis-json", default=None)
    a = ap.parse_args(argv)

    _, market, state_dir = market_paths()
    if a.cmd == "probe":
        return out({"vault_root": str(vault_root()), "market_root": str(market), "state_dir": str(state_dir),
                    "today": time.strftime("%Y%m%d"), "iso": time.strftime("%Y-%m-%dT%H:%M:%S")}, 0)

    if a.cmd == "idem-check":
        report = f"{a.today}-{a.topic_key}.md"
        if (market / report).exists():
            aid = ""
            for f in sorted(state_dir.glob("MA-*.json")):
                st = read_state(state_dir, f.stem)
                if st.get("topic_key") == a.topic_key:
                    aid = st.get("analysisId", f.stem)
                    break
            return out({"exists": True, "report_rel": f"{MARKET_REL}/{report}", "analysisId": aid}, 0)
        return out({"exists": False}, 0)

    if a.cmd == "begin":
        seq = len([f for f in state_dir.glob(f"MA-{a.today}*")]) + 1
        aid = f"MA-{a.today}-{seq:03d}"
        write_state(state_dir, aid, {"analysisId": aid, "topic": a.topic, "topic_key": a.topic_key,
                                     "status": "RESEARCH_RUNNING", "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
        return out({"analysisId": aid}, 0)

    if a.cmd == "fail":
        st = read_state(state_dir, a.analysis_id) or {"analysisId": a.analysis_id}
        st.update({"status": "RESEARCH_FAILED", "coverage": json.loads(a.coverage or "{}")})
        write_state(state_dir, a.analysis_id, st)
        return out({"ok": True}, 0)

    if a.cmd == "report":
        try:
            samples = json.loads(a.samples_json)
        except ValueError:
            return fail("samples-json 非法")
        try:
            coverage = json.loads(a.coverage or "{}")
        except ValueError:
            coverage = {}
        partial = str(a.partial) == "1"
        try:
            analysis = json.loads(a.analysis_json) if a.analysis_json else None
        except ValueError:
            analysis = None
        name = f"{a.today}-{a.topic_key}.md"
        rp = ensure_under(market / name, market)
        lines = [
            "---",
            f'analysis_id: "{a.analysis_id}"',
            f'topic: "{a.topic.replace(chr(34), chr(39))}"',
            "status: RESEARCH_READY",
            f"created_at: {time.strftime('%Y-%m-%dT%H:%M:%S')}",
            f"coverage: {json.dumps(coverage, ensure_ascii=False)}",
            f"partial_coverage: {str(partial).lower()}",
            f"samples_total: {len(samples)}",
            "---",
            "",
            f"# 市场分析：{a.topic}",
            "",
            f"> 研究编号 {a.analysis_id} ｜ 状态 RESEARCH_READY（报告可读，方向待人工确认）",
            f"> 样本 {len(samples)} 条｜" + " / ".join(f"{k} {v.get('count', '未采') if v.get('ok') else '未采'}" for k, v in coverage.items()) + ("（部分覆盖）" if partial else ""),
            "",
            "## 样本清单（卡片级采集；分类/证据分级见下节）",
            "",
            "| # | 渠道 | 标题 | 作者 | 指标 | 链接 |",
            "|---|---|---|---|---|---|",
        ]
        for i, s in enumerate(samples, 1):
            m = " ".join(f"{k}:{v}" for k, v in (s.get("metrics") or {}).items()) or "-"
            lines.append(f"| {i} | {s.get('channel','')} | {str(s.get('title',''))[:40].replace('|','/')} | "
                         f"{str(s.get('author',''))[:16].replace('|','/')} | {m[:40]} | {s.get('url','')} |")
        lines += ["", f"## 待确认（回复「确认 {a.analysis_id} 方向N」）", ""]
        if analysis:
            lines += ["## 样本分类（八类 × 证据分级）", ""]
            for c in analysis.get("classification", []):
                lines.append(f"- #{c.get('i')} {c.get('content_type')}（证据 {c.get('evidence')}）")
            lines += ["", "分布: " + json.dumps(analysis.get("type_stats", {}), ensure_ascii=False), ""]
            lines += ["## 六维拆解", ""]
            for k, v in (analysis.get("dims") or {}).items():
                lines += [f"### {k}", str(v), ""]
            lines += ["## 竞品真空带", "", str(analysis.get("gaps", "")), ""]
            lines += ["## 建议方向（【策略建议】，需人工拍板）", ""]
            for d in analysis.get("directions", []):
                lines += [f"### 方向 {d.get('n')}：{d.get('类型')}（可执行性 {d.get('可执行性')}）",
                          f"- 切入角度: {d.get('切入角度')}",
                          f"- 差异化理由: {d.get('差异化理由')}",
                          f"- 标题策略: {d.get('标题策略')}", ""]
            lines += ["## 样本局限", "", str(analysis.get("caveats", "")), ""]
            lines += [f"---", f"确认后流转：回复「确认 {a.analysis_id} 方向N」→ 作为引用材料输入 gzh-article-craft A 定位阶段。", ""]
        else:
            lines += ["> 方向候选由 T3 分析段生成；当前为 T1 骨架。", ""]
        tmp = rp.with_name(rp.name + ".tmp")
        tmp.write_text("\n".join(lines), encoding="utf-8", newline="\n")
        os.replace(tmp, rp)
        st = read_state(state_dir, a.analysis_id) or {"analysisId": a.analysis_id, "topic": a.topic}
        st.update({"status": "RESEARCH_READY", "coverage": coverage, "report_rel": f"{MARKET_REL}/{name}", "samples_total": len(samples)})
        write_state(state_dir, a.analysis_id, st)
        return out({"ok": True, "report_rel": f"{MARKET_REL}/{name}"}, 0)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as e:  # noqa: BLE001
        sys.exit(fail(str(e)))
