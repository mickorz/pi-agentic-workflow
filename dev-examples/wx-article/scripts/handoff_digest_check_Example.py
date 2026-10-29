#!/usr/bin/env python3
"""handoff digest 来源验证（wx-a1 遗留②修复）

断言：idea_files.py handoff 落盘单篇 article.yaml 的 digest 来自**正文导语**
（去 frontmatter 后首个 ≥20 字非标题段，截 108 字），不再是审稿报告「## 总结」话术；
正文缺失有效导语时回退旧逻辑（review 总结 → title）。

用法：python3 handoff_digest_check_Example.py（临时目录造最小任务，逐断言 PASS/FAIL）
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
IDEA = HERE / "draft_manager" / "idea_files.py"

PASS = 0
FAIL = 0


def ok(msg):
    global PASS
    PASS += 1
    print(f"[PASS] {msg}")


def bad(msg):
    global FAIL
    FAIL += 1
    print(f"[FAIL] {msg}")


def run(args):
    r = subprocess.run([sys.executable, str(IDEA)] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0 or not r.stdout.strip():
        print(f"    [rc={r.returncode}] stdout={r.stdout[:200]!r} stderr={r.stderr[-300:]!r}")
    return r.stdout.strip()


def yaml_field(text, key):
    pat = "^" + key + ": '?(.+?)?'$"
    m = re.search(pat, text, re.M)
    return m.group(1).strip() if m else ""


def build_task(vault: Path, lead: str, summary: str, with_article=True):
    (vault / "60_Workspace" / "写作" / "单篇").mkdir(parents=True)  # handoff 要求交接根目录已存在
    d = vault / "60_Workspace" / "写作" / "灵感" / "测试任务"
    d.mkdir(parents=True)
    (d / "1-idea.md").write_text("原始灵感。", encoding="utf-8")
    (d / "2-topic.md").write_text("# 选题卡\n\n- 建议: B", encoding="utf-8")
    (d / "5-article.md").write_text(
        "---\ntitle: 测试任务\n---\n\n" + lead + "\n\n## 第一节\n\n正文内容。" if with_article else "",
        encoding="utf-8")
    (d / "6-review.md").write_text(f"# 审稿报告\n\n## 总结\n\n{summary}\n", encoding="utf-8")
    y = d / "article.yaml"
    y.write_text(
        "schemaVersion: 1\narticleId: art_x\ntitle: 测试任务\nsource:\n  channel: wechat\n"
        "  messageId: m1\nworkflow:\n  name: idea_to_article\nstatus: draft_ready\ncurrentStage: review\n"
        "approval:\n  topic: approved\n  brief: approved\n  outline: approved\n"
        "files: {}\nstale: {}\nrevision: 1\nhandoff: {}\n"
        "config:\n  outlineApproval: false\ntargetWords: 1500-2500\nreviewFixLimit: 2\nhistoryTurns: 8\n"
        "stats:\n  agentCount: 0\n  durationMs: 0\n  lastRunAt: {}\ncreatedAt: 2026-10-28T00:00:00+08:00\n"
        "updatedAt: 2026-10-28T00:00:00+08:00\n", encoding="utf-8")
    return d


def main():
    vault = Path(tempfile.mkdtemp(prefix="handoff-digest-"))
    try:
        # 场景1：正文导语有效 → digest 来自导语（非审稿总结）
        d = build_task(vault, "这是一段足够长的正文导语，讲清楚了文章的核心观点与读者收益，用来生成摘要。",
                       "八维度均无 blocking 问题，可直接发布。（审稿报告话术，不应出现在 digest）")
        out = run(["--vault-root", str(vault), "handoff", "--dir", str(d)])
        print("    [handoff]", out[:200])
        danpian = vault / "60_Workspace" / "写作" / "单篇" / "测试任务" / "article.yaml"
        got = yaml_field(danpian.read_text(encoding="utf-8"), "digest")
        if "正文导语" in got and "八维度" not in got:
            ok(f"场景1 digest 来自正文导语: {got[:40]}…")
        else:
            bad(f"场景1 digest 异常: {got}")
        if got.endswith("…") or len(got) <= 110:
            ok("场景1 长度规则正确（>110 字截断加省略号）")
        else:
            bad(f"场景1 长度异常: len={len(got)}")

        # 场景2：正文无有效导语（只有标题行）→ 回退 review 总结
        d2 = build_task(vault / "fb", "", "回退：审稿总结话术。")
        (d2 / "5-article.md").write_text("---\ntitle: t\n---\n\n# 只有标题\n\n![图](imgs/x.png)\n", encoding="utf-8")
        out2 = run(["--vault-root", str(vault / "fb"), "handoff", "--dir", str(d2)])
        print("    [handoff-2]", out2[:200])
        danpian2 = vault / "fb" / "60_Workspace" / "写作" / "单篇" / "测试任务" / "article.yaml"
        got2 = yaml_field(danpian2.read_text(encoding="utf-8"), "digest")
        if "审稿总结" in got2:
            ok(f"场景2 回退 review 总结: {got2}")
        else:
            bad(f"场景2 回退异常: {got2}")
    finally:
        shutil.rmtree(vault.parent, ignore_errors=True)

    print(f"\n=== {'ALL PASS' if FAIL == 0 else f'FAILED {FAIL}'} ===（PASS {PASS} / FAIL {FAIL}）")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    sys.exit(main())
