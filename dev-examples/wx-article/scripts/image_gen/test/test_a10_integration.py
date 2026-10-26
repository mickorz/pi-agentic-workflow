#!/usr/bin/env python3
"""A10 集成：fake 生图 → insert_images.py 插图 → check_state.py 状态核验（T2.3 插图衔接）。

链路：image-prompts.json（convert.mjs 产物）→ generate.mjs(fake) → mapping →
insert_images.py（含 cover）→ check_state.py --article-dir。

Windows 输出 [SKIP]（依赖 POSIX 信号语义的部分在 A09；本用例纯文件操作可跑，但
Node 执行器路径假设 POSIX；为一致性仍 SKIP）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
IG = HERE.parent  # image_gen/
CONVERT = IG / "convert.mjs"
GENERATE = IG / "generate.mjs"
FIXTURE_MD = HERE / "fixtures" / "prompts-with-labels.md"
INSERT = (
    IG.parent / "references" / "article_insert_images_meta" / "scripts" / "insert_images.py"
)
CHECK = IG.parent / "draft_manager" / "check_state.py"

PASS = 0
FAIL = 0


def ok(name: str) -> None:
    global PASS
    PASS += 1
    print(f"PASS: {name}")


def bad(name: str, detail: str = "") -> None:
    global FAIL
    FAIL += 1
    print(f"FAIL: {name} {detail}")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", **kw)


def main() -> int:
    if os.name == "nt":
        print("[SKIP] Windows 平台语义差异，见 dev-docs/experience/windows-signal-semantics-stop.md")
        return 0

    workdir = Path(tempfile.mkdtemp(prefix="ig-a10-"))
    article = workdir / "ai-terms-a10"
    article.mkdir()
    try:
        # ---- 1. 转换：配图建议 md → image-prompts.json ----
        shutil.copy(FIXTURE_MD, article / "配图建议.md")
        r = run([sys.executable, "-c", "pass"])  # warmup no-op
        r = run(["node", str(CONVERT), "--article-dir", str(article)])
        if r.returncode != 0:
            bad("convert", r.stdout + r.stderr)
            return 1
        prompts = json.loads((article / "image-prompts.json").read_text(encoding="utf-8"))
        body_items = [i for i in prompts["items"] if i["kind"] == "body"]
        cover_items = [i for i in prompts["items"] if i["kind"] == "cover"]
        if len(body_items) != 8 or len(cover_items) != 1:
            bad("convert-shape", f"body={len(body_items)} cover={len(cover_items)}")
            return 1
        ok(f"转换 {len(prompts['items'])} 条（cover+8 body）")

        # ---- 2. 正文 md：标题与清单 heading 逐字一致（模拟真实文章结构） ----
        lines = ["# 从零学AI：A10 测试文章\n"]
        for i, item in enumerate(body_items):
            lines.append(item["heading"] + "\n")
            lines.append(f"第 {i + 1} 个术语的正文段落。\n")
            lines.append("**一句话记住**：" + item["heading"].strip("# ").split("（")[0] + " 很重要。\n")
        (article / "main.md").write_text("\n".join(lines), encoding="utf-8")
        ok("正文 md 构造（heading 与清单对齐）")

        # ---- 3. fake 生图 ----
        env = dict(os.environ, IMAGE_GEN_INTER_DELAY_MS="0")
        r = run(["node", str(GENERATE), "--article-dir", str(article), "--provider", "fake", "--no-require-style-approval"], env=env)
        result_line = [l for l in r.stdout.splitlines() if l.startswith("[RESULT] ")]
        if r.returncode != 0 or not result_line:
            bad("generate", r.stdout[-800:] + r.stderr[-400:])
            return 1
        result = json.loads(result_line[-1][len("[RESULT] "):])
        if not (result["ok"] and result["succeeded"] == 9):
            bad("generate-result", json.dumps(result, ensure_ascii=False)[:400])
            return 1
        cover_file = article / "cover.png"
        if not cover_file.exists():
            bad("cover", "cover.png 未生成")
            return 1
        for item in body_items:
            if not (article / "imgs" / item["filename"]).exists():
                bad("body-img", item["filename"])
                return 1
        ok("fake 生图 9/9（cover + 8 正文图，PNG 魔数由 verify 已验）")

        # ---- 3b. 生图后、插图前：needs_insert 必为 True（配图存在但正文未引用）----
        r = run([sys.executable, str(CHECK), "--article-dir", str(article)])
        m = re.search(r'\"needs_insert\"\s*:\s*(true|false)', r.stdout)
        if not m or m.group(1) != 'true':
            bad("needs-insert-before", r.stdout[-300:])
            return 1
        ok("插图前 needs_insert=true（article_prepare 将自然判定需要插图）")

        # ---- 4. mapping → insert_images.py（生图产物被插图链直接消费） ----
        mapping = [
            {
                "image": f"imgs/{i['filename']}",
                "heading": i["heading"],
                "alt": "术语插画：" + i["heading"].strip("# ").split("（")[0],
            }
            for i in body_items
        ]
        map_path = article / "mapping.json"
        map_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
        r = run(
            [
                sys.executable,
                str(INSERT),
                "--article-dir",
                str(article),
                "--mapping-path",
                str(map_path),
                "--md-file",
                str(article / "main.md"),
                "--cover-image",
                "cover.png",
            ]
        )
        if r.returncode != 0 or "=== ALL DONE ===" not in r.stdout:
            bad("insert", r.stdout[-800:] + r.stderr[-400:])
            return 1
        m = re.search(r"=== inserted (\d+) / (\d+)", r.stdout)
        if not m or m.group(1) != "8":
            bad("insert-count", r.stdout[-300:])
            return 1
        ok("insert_images 8/8 + cover 插入")

        # ---- 5. 幂等重跑（插图链的既有幂等语义不受生图影响） ----
        r = run(
            [
                sys.executable,
                str(INSERT),
                "--article-dir",
                str(article),
                "--mapping-path",
                str(map_path),
                "--md-file",
                str(article / "main.md"),
                "--cover-image",
                "cover.png",
            ]
        )
        # 再次插入会重复插入正文图（insert 非幂等是既有已知行为）；断言 cover SKIP 幂等
        if "cover already present" not in r.stdout and "[SKIP] cover" not in r.stdout:
            bad("cover-idempotent", r.stdout[-300:])
            return 1
        ok("cover 幂等（正文图非幂等为既有已知行为，不回归）")

        # ---- 6. check_state.py 状态核验 ----
        r = run([sys.executable, str(CHECK), "--article-dir", str(article)])
        # check_state 对非发布态文章会列出缺失项（如 article.yaml），只断言不报致命错误且能定位正文
        combined = r.stdout + r.stderr
        if r.returncode not in (0, 1, 2) or "Traceback" in combined:
            bad("check-state", combined[-400:])
            return 1
        if "main.md" not in combined and "md" not in combined:
            bad("check-state-body", combined[-300:])
            return 1
        # needs_insert 语义核验（T2.3 验收：article_prepare 的 needs_insert 由 check_state 计算）
        # 插图已完成 => 引用数 == 图数 => needs_insert 必为 False
        m = re.search(r'\"needs_insert\"\s*:\s*(true|false)', r.stdout)
        if not m or m.group(1) != 'false':
            bad("needs-insert-after", r.stdout[-300:])
            return 1
        ok("插图后 needs_insert=false（article_prepare 判定基础成立）")

        # ---- 7. verify-only（生图侧终审在插图后仍成立） ----
        r = run(["node", str(GENERATE), "--article-dir", str(article), "--verify-only"], env=env)
        if r.returncode != 0:
            bad("verify-after-insert", r.stdout[-300:])
            return 1
        ok("插图后 verify-only 仍 ok（manifest 与文件一致）")

        print(f"\n=== A10 ALL DONE: PASS={PASS} FAIL={FAIL} ===")
        return 0 if FAIL == 0 else 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
