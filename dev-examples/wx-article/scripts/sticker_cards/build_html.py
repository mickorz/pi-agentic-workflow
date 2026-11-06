#!/usr/bin/env python3
"""build_html.py —— 卡片 HTML 确定性注入器（P0-2 核心，零 LLM）。

职责边界（评审定案）：Agent 只写 pages.json；本脚本负责一切 HTML：
  1. 程序复制种子模板（thirdparties/guizang-social-card-skill/assets/template-<style_mode>-card.html），
     不允许 Agent 重写模板；构建前后对模板文件做 SHA256 断言（模板不被修改）。
  2. 按 pages.json 注入：<html data-theme> 替换为页表主题；
     在唯一标记 `    <!-- POSTERS_HERE -->` 处按页号顺序注入画板（组件片段来自 components.py）。
  3. 所有文本经 html.escape 转义；片段不含任何 margin/定位样式（画板整数坐标，T0 经验）。
  4. 幂等：相同输入 -> 输出字节一致（无时间戳/随机数）。
  5. 构建前以 build_mode 复跑校验（ai-image 页 asset 必须就位）。

CLI：
  python3 build_html.py --pages <pages.json> --out <index.html> [--template <模板路径>]
    [--cards-root <article_dir>]
  模板缺省按 pages.json 的 style_mode 自动定位 submodule 内种子模板。
输出契约：[OK]/[FAIL] 逐项；成功 "=== BUILD DONE ===" 退出码 0。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from components import COMPONENTS  # noqa: E402
from validate_pages import validate_pages  # noqa: E402

REPO = Path(__file__).resolve().parents[4]
SKILL_ASSETS = REPO / "thirdparties" / "guizang-social-card-skill" / "assets"
POSTER_MARKER = "    <!-- POSTERS_HERE -->"
# <html ...> 标签内的 data-theme（仅第一个，即文档主题）
THEME_RE = re.compile(r'(data-theme=")[^"]*(")')


def default_template(style_mode: str) -> Path:
    return SKILL_ASSETS / f"template-{style_mode}-card.html"


def build(pages_path: Path, out_path: Path, template_path: Path | None = None,
          cards_root: Path | None = None) -> tuple[bool, list[str]]:
    """构建 index.html。返回 (ok, 日志行)。确定性：同输入同输出字节。"""
    logs: list[str] = []
    data = json.loads(pages_path.read_text(encoding="utf-8-sig"))

    # 构建前校验（build_mode：ai-image 页 asset 必须就位）
    root = cards_root or pages_path.parent.parent  # pages.json 在 <article_dir>/_cards/ 下
    errs = validate_pages(data, article_root=root, build_mode=True)
    if errs:
        return False, [f"[FAIL] 校验未通过: {e}" for e in errs] + ["=== BUILD INVALID ==="]
    logs.append("[OK] pages.json build_mode 校验通过")

    template_path = template_path or default_template(data["style_mode"])
    if not template_path.is_file():
        return False, [f"[FAIL] 模板不存在: {template_path}", "=== BUILD INVALID ==="]
    before_hash = hashlib.sha256(template_path.read_bytes()).hexdigest()
    tpl = template_path.read_text(encoding="utf-8")

    # 主题注入（仅 <html> 标签处的第一个 data-theme）
    tpl_new, n = THEME_RE.subn(lambda m: m.group(1) + data["theme"] + m.group(2), tpl, count=1)
    if n != 1:
        return False, ["[FAIL] 模板缺少 <html data-theme> 注入点", "=== BUILD INVALID ==="]
    logs.append(f"[OK] 主题注入: {data['theme']}")

    # 画板生成：页号顺序，render_page 统一分发（P0-2：html=组件注入；ai-image=整页图卡）
    parts: list[str] = []
    for page in data["pages"]:
        source = page["source"]
        if source == "html":
            try:
                inner = COMPONENTS[page["layout"]]["render"](page, page["no"], root)
            except ValueError as e:  # 如 manual-crop 读图片尺寸失败（不支持格式/损坏文件）
                return False, [f"[FAIL] 画板 xhs-{page['no']:02d} 渲染失败: {e}", "=== BUILD INVALID ==="]
        else:  # ai-image：整页图卡（生图产物经 well contain 呈现，3:4 画板）
            src = page["asset"][len("_cards/"):]
            inner = (
                f'    <section class="poster xhs" id="xhs-{page["no"]:02d}">\n'
                f'      <figure class="gz-figure" data-kind="photo" data-ratio="3x4" style="height:100%">\n'
                f'        <div class="gz-figure__well">\n'
                f'          <img src="{src}" alt="{page.get("role", "ai-image")}">\n'
                f"        </div>\n"
                f"      </figure>\n"
                f"    </section>\n"
            )
        parts.append(inner)
        logs.append(f"[OK] 画板 xhs-{page['no']:02d} ({source}"
                    f"{':' + page['layout'] if source == 'html' else ''})")

    if tpl_new.count(POSTER_MARKER) != 1:
        return False, ["[FAIL] 模板注入点标记不唯一（应为 1 处）", "=== BUILD INVALID ==="]
    # 整段替换：标记 → </main> 之间是模板示例画板（T0 抽检发现残留占位会同 id 覆盖真实画板），
    # 不能只换标记行，否则示例 poster 会留在产物里
    marker_idx = tpl_new.index(POSTER_MARKER)
    main_close = tpl_new.find("</main>", marker_idx)
    if main_close == -1:
        return False, ["[FAIL] 模板缺少 </main> 闭合（结构异常）", "=== BUILD INVALID ==="]
    posters_html = "\n" + "\n".join(p.rstrip("\n") for p in parts) + "\n"
    html_out = tpl_new[:marker_idx] + posters_html + "  " + tpl_new[main_close:]

    # 模板不可修改断言（P0-2）
    after_hash = hashlib.sha256(template_path.read_bytes()).hexdigest()
    if before_hash != after_hash:
        return False, ["[FAIL] 模板文件在构建过程中被修改（严重）", "=== BUILD INVALID ==="]
    logs.append("[OK] 模板文件未被修改 (sha256 前=后)")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html_out, encoding="utf-8", newline="\n")
    logs.append(f"[OK] 写出 {out_path}（{len(html_out)} chars）")
    logs.append("=== BUILD DONE ===")
    return True, logs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--template", default=None)
    ap.add_argument("--cards-root", default=None)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    template = Path(args.template).resolve() if args.template else None
    ok, logs = build(Path(args.pages).resolve(), Path(args.out).resolve(),
                     template_path=template,
                     cards_root=Path(args.cards_root).resolve() if args.cards_root else None)
    for line in logs:
        print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
