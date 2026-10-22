#!/usr/bin/env python3
"""wechat_md_to_draft/scripts/publish.py 端到端自检：fixture 文章直发公众号草稿箱。

用法：python3 run.py（在本目录或任意位置执行）
行为：
  1. 每次重建 fixture（干净态，可重复执行）：sample-article/ 下写作稿 md + 封面 + 正文图；
  2. 用仓库 .aws-article 真实公众号凭证跑 `python3 ../scripts/publish.py` 端到端发草稿
     （允许创建一个测试草稿——这就是对 publish.py 的端到端验证）；
  3. 逐断言校验输出契约：
     [md]/[meta]/[html]/[imgs]/[1] TOKEN OK/[2] THUMB OK media_id=/[3] IMG i/n ref OK/
     [4] html after replace/[5] DRAFT OK media_id=/[6] saved/=== ALL DONE draft_media_id= ===。
凭证缺失（.aws-article + aws.env 未同步到本机）时：静态断言照跑，端到端断言逐条 SKIP，
不静默假 PASS；有 FAIL 时退出码 1。
"""
from __future__ import annotations

import base64
import py_compile
import shutil
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
PUBLISH = HERE.parent / "scripts" / "publish.py"
ARTICLE_DIR = HERE / "sample-article"

PASS = 0
FAIL = 0
SKIP = 0
SKIP_REASON = ""


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"[PASS] {msg}", flush=True)


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    print(f"[FAIL] {msg}", flush=True)


def skip(msg: str) -> None:
    global SKIP
    SKIP += 1
    print(f"[SKIP] {msg}", flush=True)


def skip_e2e(label: str) -> None:
    skip(f"{label}（{SKIP_REASON}）")


# 1×1 白色 PNG（真实图片字节，微信上传接口可接受）
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

SAMPLE_MD = """---
title: "从零学AI：publish.py 端到端测试文章"
description: "verify fixture：用于 publish.py 草稿箱端到端自检的测试文章，可随时删除。"
---

# 从零学AI：publish.py 端到端测试文章

这是一篇用于端到端自检的测试文章，验证 md 转微信样式 HTML、封面/正文图上传与草稿创建。

![示例插图](imgs/sample.png)

## 要点列表

- frontmatter 提供 title 与 description
- 正文含一个图片引用，走 uploadimg 并回写微信 URL
- 本草稿允许保留在草稿箱，供人工核对后删除
"""


def find_config_root(start: Path) -> Path | None:
    """与 publish.py 相同的凭证定位：向上找首个含 .aws-article 的祖先目录。"""
    d = start.resolve()
    while True:
        if (d / ".aws-article").exists():
            return d
        parent = d.parent
        if parent == d:
            return None
        d = parent


def build_fixture() -> None:
    if ARTICLE_DIR.exists():
        shutil.rmtree(ARTICLE_DIR)
    (ARTICLE_DIR / "imgs").mkdir(parents=True)
    (ARTICLE_DIR / "imgs" / "sample.png").write_bytes(PNG_1PX)
    (ARTICLE_DIR / "cover.png").write_bytes(PNG_1PX)
    (ARTICLE_DIR / "sample-post.md").write_text(SAMPLE_MD, encoding="utf-8")


def main() -> int:
    global SKIP_REASON

    # ── 静态断言（不依赖凭证/网络）──
    build_fixture()
    ok("fixture 重建（sample-post.md + cover.png + imgs/sample.png）")
    if all(
        (ARTICLE_DIR / p).is_file() for p in ("sample-post.md", "cover.png", "imgs/sample.png")
    ):
        ok("fixture 文件齐全（md/封面/正文图）")
    else:
        bad("fixture 文件缺失")

    try:
        py_compile.compile(str(PUBLISH), doraise=True)
        py_compile.compile(str(__file__), doraise=True)
        ok("publish.py 与 run.py 编译通过（py_compile）")
    except py_compile.PyCompileError as e:
        bad(f"编译失败: {e}")

    # ── 凭证预检：缺失则端到端逐条 SKIP ──
    config_root = find_config_root(PUBLISH.parent) or find_config_root(ARTICLE_DIR)
    has_creds = bool(
        config_root and (config_root / "aws.env").is_file()
        and (config_root / ".aws-article" / "config.json").is_file()
    )

    # ── 端到端断言 ──
    out = ""
    rc = -1
    if has_creds:
        p = subprocess.run(
            [sys.executable, str(PUBLISH), "--article-dir", str(ARTICLE_DIR), "--cover", "cover.png"],
            capture_output=True,
            text=True,
        )
        out = (p.stdout or "") + (p.stderr or "")
        rc = p.returncode
    else:
        SKIP_REASON = (
            f"本机未同步公众号凭证（.aws-article + aws.env，期望位于 "
            f"{config_root or 'dev-examples/wx-article'}），不发起真实草稿创建"
        )

    checks = [
        ("[md] 写作稿选中", lambda: "[md] sample-post.md" in out),
        ("[meta] title/author/digest 解析", lambda: "[meta] title=" in out),
        ("[html] md 转微信样式 HTML", lambda: "[html] generated " in out),
        ("[imgs] 扫到 1 个图片引用", lambda: "[imgs] found 1" in out),
        ("[1] TOKEN OK", lambda: "[1] TOKEN OK" in out),
        ("[2] THUMB OK media_id=", lambda: "[2] THUMB OK media_id=" in out),
        ("[3] IMG 1/1 正文图 OK", lambda: "[3] IMG 1/1 imgs/sample.png OK" in out),
        ("[4] html after replace", lambda: "[4] html after replace " in out),
        ("[5] DRAFT OK media_id=", lambda: "[5] DRAFT OK media_id=" in out),
        ("[6] publish.log + article.yaml + article.md saved", lambda: "[6] " in out),
        ("=== ALL DONE draft_media_id= ===", lambda: "=== ALL DONE draft_media_id=" in out),
        ("publish.py exit 0", lambda: rc == 0),
    ]
    for label, cond in checks:
        if has_creds:
            if cond():
                ok(label)
            else:
                bad(f"{label}（输出片段: …{out[-300:] if out else '<无输出>'}）")
        else:
            skip_e2e(label)

    print("====================")
    print(f"PASS={PASS} FAIL={FAIL} SKIP={SKIP}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
