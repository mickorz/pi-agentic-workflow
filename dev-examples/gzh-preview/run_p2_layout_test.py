#!/usr/bin/env python3
"""GZH P2 layout-html 模式测试(publish.py --html-file,纯 mock 零触网)。

用法:python dev-examples/gzh-preview/run_p2_layout_test.py
覆盖:layout 模式入箱成功 / 与 convert_md 模式哈希不碰撞 / layout 变更触发草稿更新 /
     layout 未变更复用(不重复建稿) / html-file 缺失报错。
输出:[OK]/[FAIL] + === P2 LAYOUT DONE PASS=n FAIL=m ===
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
PUBLISH = HERE.parent / "wx-article" / "scripts" / "draft_manager" / "publish.py"

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000d49444154789c626001000000ffff030000060005"
    "57bfabd40000000049454e44ae426082"
)
MD = "---\ntitle: 布局模式测试\ndigest: 一句话导语\n---\n\n# 布局模式测试\n\n![图](imgs/a.png)\n"
YAML = "title: 布局模式测试\ndigest: 一句话导语\nauthor: Tester\n"
LAYOUT_A = '<section style="font-size:16px;"><h1 style="color:#d32f2f;">布局模式测试</h1><p style="margin:16px 0;">段落A</p><img src="imgs/a.png" style="max-width:100%;"/></section>' + "x" * 100
LAYOUT_B = LAYOUT_A.replace("段落A", "段落B")

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[OK] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} {detail}")


def make_env(root: Path) -> tuple[Path, Path]:
    art = root / "art"
    (art / "imgs").mkdir(parents=True)
    (art / "imgs" / "a.png").write_bytes(PNG)
    (art / "cover.png").write_bytes(PNG)
    (art / "正文.md").write_text(MD, encoding="utf-8")
    (art / "article.yaml").write_text(YAML, encoding="utf-8")
    cfg = root / "cfg"
    (cfg / ".aws-article").mkdir(parents=True)
    (cfg / "aws.env").write_text("WECHAT_1_APPID=wxaaa\nWECHAT_1_APPSECRET=s1\n", encoding="utf-8")
    (cfg / ".aws-article" / "config.json").write_text(json_cfg(), encoding="utf-8")
    return art, cfg


def json_cfg() -> str:
    import json

    return json.dumps({"default_author": "Tester"})


def run_pub(art: Path, cfg: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(PUBLISH), "--article-dir", str(art), "--cover", "cover.png",
         "--config-dir", str(cfg), "--mock", *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
    )


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="gzh-p2-"))
    try:
        art, cfg = make_env(root)
        (art / "layout.html").write_text(LAYOUT_A, encoding="utf-8")

        # 1. layout 模式入箱成功
        r1 = run_pub(art, cfg, "--html-file", "layout.html")
        out1 = r1.stdout + r1.stderr
        check("layout 模式入箱成功", "[5] DRAFT OK" in out1 and "layout mode" in out1, out1.strip().splitlines()[-1] if out1.strip() else "")
        hash1 = None
        for line in out1.splitlines():
            if line.startswith("[hash]"):
                hash1 = line.split()[1]
        check("layout 模式打印混合哈希", hash1 is not None and "layout mode" in out1)

        # 2. 同 layout 复跑:哈希一致走复用(打印 reuse,不建新稿)
        r2 = run_pub(art, cfg, "--html-file", "layout.html")
        out2 = r2.stdout + r2.stderr
        check("同 layout 复跑走复用不建新稿", r2.returncode == 0 and "(reuse, verified" in out2)

        # 3. layout 变更:哈希变化触发草稿更新
        (art / "layout.html").write_text(LAYOUT_B, encoding="utf-8")
        r3 = run_pub(art, cfg, "--html-file", "layout.html")
        out3 = r3.stdout + r3.stderr
        check("layout 变更触发草稿更新", r3.returncode == 0 and "layout mode" in out3 and "DRAFT OK" in out3)

        # 4. 换回 convert_md 模式:哈希不碰撞(必须视为内容变化)
        r4 = run_pub(art, cfg)
        out4 = r4.stdout + r4.stderr
        check("convert_md 模式哈希不碰撞", r4.returncode == 0 and "html rule v" in out4 and "DRAFT OK" in out4)

        # 5. html-file 不存在:显式报错
        r5 = run_pub(art, cfg, "--html-file", "nope.html")
        out5 = r5.stdout + r5.stderr
        check("html-file 缺失显式报错", "html file not found" in out5 and r5.returncode != 0)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print(f"=== P2 LAYOUT DONE PASS={PASS} FAIL={FAIL} ===")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
