#!/usr/bin/env python3
"""render_smoke.py —— 小绿书卡片化 T0 渲染冒烟（确定性，零 LLM）。

验证链路：guizang render.mjs（playwright chromium）能对最小画板 HTML 真正产出
1080x1440 PNG。是卡片化全链（build_html 注入器 / verify_render / Gate B）的地基验收。

流程：
  1. 临时任务目录写入最小 index.html（单个 .poster.xhs 画板，内联尺寸 CSS，
     不依赖种子模板与网络字体，--no-embed 离线确定性）
  2. node thirdparties/guizang-social-card-skill/scripts/render.mjs <dir> --no-embed
  3. 断言 output/<id>.png 存在且 PNG IHDR 尺寸 == 1080x1440（标准库解析，不经 LLM）

前置依赖（缺失时明确 [FAIL]，不做降级假 PASS）：
  - node 可执行
  - thirdparties/guizang-social-card-skill/node_modules（T0 已 npm install）

输出契约：逐项 [OK]/[FAIL]；结尾 === ALL DONE ===（全过）或 [FAIL] 汇总后退出码 1。
运行：python3 render_smoke.py [--keep]
"""
from __future__ import annotations

import argparse
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / "thirdparties" / "guizang-social-card-skill"
RENDER = SKILL / "scripts" / "render.mjs"

MINIMAL_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  /* 最小画板：只约定 .poster.xhs 尺寸（render.mjs 按 class 校验 1080x1440），
     不引入种子模板与外部字体（--no-embed 离线渲染）。
     注意：默认 margin 会产生分数坐标（如 h1 的 21.4375px），元素截图取整后尺寸差 1px，
     故画板必须从 0,0 整数位置开始（教训见 render_smoke 首次运行） */
  body { margin: 0; }
  h1, p { margin: 0; padding: 16px; }
  .poster.xhs { width: 1080px; height: 1440px; background: #f5f1e8; color: #1a1a1a; }
</style>
</head>
<body>
  <main>
    <section class="poster xhs" id="xhs-smoke">
      <h1>渲染冒烟</h1>
      <p>小绿书卡片化 T0</p>
    </section>
  </main>
</body>
</html>
"""

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def png_ihdr_size(path: Path) -> tuple[int, int]:
    """标准库读 PNG IHDR 宽高（字节 16~24），不引第三方。"""
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        raise ValueError("not a valid PNG (missing IHDR)")
    w, h = struct.unpack(">II", head[16:24])
    return w, h


def find_node() -> str | None:
    for c in ("node",):
        try:
            r = subprocess.run([c, "-v"], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                return c
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="保留临时目录便于排查")
    args = ap.parse_args()

    # 前置：node 与 submodule 依赖（缺失明确 FAIL，不降级假 PASS）
    node = find_node()
    check("node 可执行", node is not None)
    check("render.mjs 存在", RENDER.is_file(), str(RENDER))
    nm = SKILL / "node_modules" / "playwright"
    check("skill node_modules(playwright) 已安装", nm.is_dir(), str(nm))

    if FAIL:
        print(f"\n=== 前置缺失，共 {len(FAIL)} 项 FAIL（先 npm install，见方案 D2） ===")
        return 1

    work = Path(tempfile.mkdtemp(prefix="sticker-render-smoke-"))
    try:
        (work / "index.html").write_text(MINIMAL_HTML, encoding="utf-8")
        r = subprocess.run(
            [node, str(RENDER), str(work), "--no-embed"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=170,
            cwd=str(SKILL),
        )
        check("render.mjs 退出码 0", r.returncode == 0,
              f"rc={r.returncode} stdout={r.stdout[-300:]} stderr={r.stderr[-300:]}")
        png = work / "output" / "xhs-smoke.png"
        check("产物 xhs-smoke.png 存在", png.is_file(), str(png))
        if png.is_file():
            try:
                w, h = png_ihdr_size(png)
                check(f"PNG 尺寸 1080x1440（实际 {w}x{h}）", (w, h) == (1080, 1440))
                check("PNG 字节数合理(>10KB)", png.stat().st_size > 10 * 1024,
                      f"{png.stat().st_size} bytes")
            except ValueError as e:
                check("PNG IHDR 可解析", False, str(e))
        else:
            check("PNG 尺寸 1080x1440", False, "产物不存在")
    except subprocess.TimeoutExpired:
        check("render.mjs 170s 内完成", False, "超时（按验收门纪律：诊断不重试）")
    finally:
        if args.keep:
            print(f"kept: {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    print(f"\n汇总 OK={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("=== RENDER SMOKE FAILED ===")
        return 1
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
