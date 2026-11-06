#!/usr/bin/env python3
"""build_html_Example.py —— build_html.py 确定性注入器测试（零 LLM，可重复）。

覆盖 T1 验收清单的构建侧用例：
构建成功 / 重复构建字节一致 / 模板不被修改 / HTML 特殊字符转义（禁裸 script）/
asset 路径穿越与缺失拒绝 / margin 清零（画板区域内无 inline margin）/
注入点标记唯一 / ai-image 整页图卡（build_mode 缺 asset 拒绝，有 asset 生成画板）/
两页 fixture 真实渲染（render.mjs --no-embed）→ PNG IHDR 精确 1080x1440。

运行：python3 build_html_Example.py [--no-render]   # --no-render 跳过真实渲染段
输出契约：逐项 [OK]/[FAIL]，结尾汇总；全过退出码 0。
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_html import POSTER_MARKER, build, default_template  # noqa: E402

PASS: list[str] = []
FAIL: list[str] = []
RENDER_MJS = HERE.parents[3] / "thirdparties" / "guizang-social-card-skill" / "scripts" / "render.mjs"
RENDER_TIMEOUT = 170
FIXTURE = json.loads((HERE / "fixtures" / "_cards" / "pages-fixture.json").read_text(encoding="utf-8"))


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    return struct.unpack(">II", head[16:24])


def make_article(tmp: Path) -> tuple[Path, Path, Path]:
    """模拟文章目录：art/_cards/{pages.json, assets/shot-01.png}。返回 (art, pages, out)。"""
    art = tmp / "article"
    card = art / "_cards"
    (card / "assets").mkdir(parents=True)
    pages = card / "pages.json"
    pages.write_text(json.dumps(FIXTURE, ensure_ascii=False), encoding="utf-8")
    shutil.copy2(HERE / "fixtures" / "_cards" / "assets" / "shot-01.png", card / "assets" / "shot-01.png")
    return art, pages, card / "index.html"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-render", action="store_true", help="跳过真实渲染段（快速校验）")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    tmp = Path(tempfile.mkdtemp(prefix="bh-example-"))
    art, pages_path, out_path = make_article(tmp)
    template = default_template("editorial")
    tpl_sha_before = hashlib.sha256(template.read_bytes()).hexdigest()

    # 1 构建成功
    ok, logs = build(pages_path, out_path, cards_root=art)
    check("合法页表构建成功", ok and out_path.is_file(), "\n".join(logs[-3:]))
    html_text = out_path.read_text(encoding="utf-8")
    check("画板 xhs-01/xhs-02 就位", 'id="xhs-01"' in html_text and 'id="xhs-02"' in html_text)

    # 2 重复构建字节一致（幂等）
    first_bytes = out_path.read_bytes()
    build(pages_path, out_path, cards_root=art)
    check("重复构建字节一致", out_path.read_bytes() == first_bytes)

    # 3 模板不被修改（独立断言，构建内部亦有断言）
    check("模板文件未被修改", hashlib.sha256(template.read_bytes()).hexdigest() == tpl_sha_before)

    # 4 HTML 特殊字符转义（禁裸 <script>）
    bad = copy.deepcopy(FIXTURE)
    bad["pages"][0]["copy"]["title"] = '<script>alert("x")</script> & "引号"'
    (art / "_cards" / "pages.json").write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    evil_out = art / "_cards" / "evil.html"
    ok, _ = build(pages_path.parent / "pages.json", evil_out, cards_root=art)
    evil_text = evil_out.read_text(encoding="utf-8") if ok else ""
    check("转义构建成功", ok)
    check("无裸 <script> 标签", "<script>alert" not in evil_text)
    check("文本已转义 (&lt;script&gt;)", "&lt;script&gt;" in evil_text)
    # 还原合法页表
    (art / "_cards" / "pages.json").write_text(json.dumps(FIXTURE, ensure_ascii=False), encoding="utf-8")

    # 5 asset 路径穿越拒绝
    bad = copy.deepcopy(FIXTURE)
    bad["pages"][1]["asset"] = "_cards/assets/../../escape.png"
    (art / "_cards" / "pages.json").write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    ok, logs = build(pages_path, art / "_cards" / "evil2.html", cards_root=art)
    check("asset 路径穿越构建拒绝", not ok and any("校验未通过" in x for x in logs))

    # 6 asset 文件缺失拒绝
    bad = copy.deepcopy(FIXTURE)
    bad["pages"][1]["asset"] = "_cards/assets/not-exist.png"
    (art / "_cards" / "pages.json").write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    ok, _ = build(pages_path, art / "_cards" / "evil3.html", cards_root=art)
    check("asset 缺失构建拒绝", not ok)

    # 7 margin 清零：画板区域内无 inline margin；模板 reset 存在
    (art / "_cards" / "pages.json").write_text(json.dumps(FIXTURE, ensure_ascii=False), encoding="utf-8")
    build(pages_path, out_path, cards_root=art)
    html_text = out_path.read_text(encoding="utf-8")
    posters_region = html_text[html_text.index("xhs-01"):]
    inline_margins = re.findall(r"style=\"[^\"]*margin\s*:\s*(?!0)[^\"]*\"", posters_region)
    check("画板区域无 inline 非零 margin", not inline_margins, str(inline_margins[:3]))
    check("模板全局 reset 存在", "html, body { margin: 0; padding: 0; }" in html_text)
    check("注入点标记唯一(构建后无残留)", html_text.count(POSTER_MARKER) == 0)
    # 模板示例画板不残留（T0 抽检发现：占位 poster 同 id 覆盖真实画板）
    poster_count = len(re.findall(r'class="poster xhs"', html_text))
    check("产物画板数 == 页数(示例画板不残留)", poster_count == len(FIXTURE["pages"]),
          f"poster_count={poster_count} pages={len(FIXTURE['pages'])}")
    check("无模板占位文本", "[标题占位]" not in html_text and "Placeholder: M01" not in html_text)

    # 8 ai-image 整页图卡：build_mode 缺 asset 拒绝；有 asset 生成画板
    bad = copy.deepcopy(FIXTURE)
    bad["pages"].append({"no": 3, "role": "ai-illustration", "source": "ai-image",
                         "prompt": "3:4 竖版测试图"})
    (art / "_cards" / "pages.json").write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    ok, logs = build(pages_path, art / "_cards" / "evil4.html", cards_root=art)
    check("ai-image 缺 asset 构建拒绝", not ok and any("asset" in x for x in logs))
    shutil.copy2(HERE / "fixtures" / "_cards" / "assets" / "shot-01.png",
                 art / "_cards" / "assets" / "gen-03.png")
    bad["pages"][2]["asset"] = "_cards/assets/gen-03.png"
    (art / "_cards" / "pages.json").write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    ok, _ = build(pages_path, art / "_cards" / "with-ai.html", cards_root=art)
    ai_html = (art / "_cards" / "with-ai.html").read_text(encoding="utf-8") if ok else ""
    check("ai-image 有 asset 构建成功", ok)
    check("ai-image 画板 xhs-03 就位", 'id="xhs-03"' in ai_html)

    # 9 真实渲染：fixture 两页 → render.mjs --no-embed → PNG IHDR 精确 1080x1440
    if not args.no_render:
        node = shutil.which("node")
        check("node 可用(渲染段)", node is not None)
        if node and RENDER_MJS.is_file():
            (art / "_cards" / "pages.json").write_text(
                json.dumps(FIXTURE, ensure_ascii=False), encoding="utf-8")
            ok, _ = build(pages_path, out_path, cards_root=art)
            check("渲染前重建成功", ok)
            try:
                r = subprocess.run(
                    [node, str(RENDER_MJS), str(out_path.parent), "--no-embed", "--out", "output"],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=RENDER_TIMEOUT, cwd=str(RENDER_MJS.parents[1]),
                )
                check("render.mjs 退出码 0", r.returncode == 0,
                      f"rc={r.returncode} stderr={r.stderr[-300:]}")
                for no in (1, 2):
                    png = out_path.parent / "output" / f"xhs-{no:02d}.png"
                    if png.is_file():
                        w, h = png_size(png)
                        check(f"PNG xhs-{no:02d} 精确 1080x1440（实际 {w}x{h}）", (w, h) == (1080, 1440))
                    else:
                        check(f"PNG xhs-{no:02d} 存在", False, str(png))
            except subprocess.TimeoutExpired:
                check("render.mjs 超时", False, f">{RENDER_TIMEOUT}s（诊断不重试）")
        else:
            check("渲染段前置就绪", False, f"node={node} render.mjs={RENDER_MJS.is_file()}")

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n汇总 OK={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        return 1
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
