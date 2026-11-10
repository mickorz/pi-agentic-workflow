#!/usr/bin/env python3
"""validate_pages.py —— pages.json schema v2 校验器（确定性，零 LLM）。

契约（方案 2026-11-05 V1.1 D4）：
- schema_version 必须 == 2
- style_mode / theme 枚举；title 必填 <=20 字；content 可选 <=1000 字
- pages 1~9 项；no 唯一且递增；page 1 必须 role=cover
- source 仅 html|ai-image；html 路由 layout 必填且必须在 COMPONENTS 组件表内
- 字段规格（required/optional/types/points_range）以 components.COMPONENTS 为唯一事实来源
- asset 安全检查（P0-2 路径逃逸防护）：
    必须以 "_cards/assets/" 开头、禁 ".."、禁绝对路径与反斜杠、文件必须真实存在
- screenshot 组件 image_fit 仅允许 contain（UI 截图禁 cover，D8）
- ai-image 页 prompt 必填；asset 在 build 阶段（require_ai_assets=True）必填

CLI：
  python3 validate_pages.py --pages <pages.json> [--cards-root <article_dir>] [--build-mode]
输出契约：逐项 [OK]/[FAIL]；全部通过打印 "=== PAGES VALID ===" 退出码 0，否则退出码 1。
库用法：errors = validate_pages(data, cards_root=None, build_mode=False)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from components import ASSET_PREFIX, COMPONENTS, SOURCE_ROUTES, THEMES, WELL_RATIOS  # noqa: E402

MAX_PAGES = 9
TITLE_MAX = 20  # 微信小绿书后台标题上限 20 字（2026-11-10 实测修正，draft/add 接口不拦后台拦）
CONTENT_MAX = 1000


def _check_required_fields(page: dict, spec: dict, errs: list) -> None:
    """按组件表的 required/optional 规格做字段存在性与类型检查（点路径）。"""
    for dotpath, typ in spec["required"].items():
        cur: object = page
        for part in dotpath.split("."):
            if not isinstance(cur, dict) or part not in cur:
                errs.append(f"page.no={page.get('no')} 缺必填字段 {dotpath}")
                cur = None
                break
            cur = cur[part]
        if cur is None:
            continue
        if not isinstance(cur, str) and not isinstance(cur, list):
            errs.append(f"page.no={page.get('no')} 字段 {dotpath} 类型应为 {typ.__name__}")
            continue
        if typ is str and (not isinstance(cur, str) or not cur.strip()):
            errs.append(f"page.no={page.get('no')} 字段 {dotpath} 必须是非空字符串")
        if typ is list:
            if not isinstance(cur, list) or not cur:
                errs.append(f"page.no={page.get('no')} 字段 {dotpath} 必须是非空数组")
                continue
            if not all(isinstance(x, str) and x.strip() for x in cur):
                errs.append(f"page.no={page.get('no')} 字段 {dotpath} 元素必须是非空字符串")
                continue
            lo, hi = spec.get("points_range", (1, 99))
            if not (lo <= len(cur) <= hi):
                errs.append(f"page.no={page.get('no')} 字段 {dotpath} 长度须在 {lo}~{hi}，当前 {len(cur)}")
    for dotpath, typ in spec.get("optional", {}).items():
        cur: object = page
        for part in dotpath.split("."):
            if not isinstance(cur, dict) or part not in cur:
                cur = None
                break
            cur = cur[part]
        if cur is None:
            continue
        if typ is str and not isinstance(cur, str):
            errs.append(f"page.no={page.get('no')} 字段 {dotpath} 类型应为 str")
        if typ is dict and not isinstance(cur, dict):
            errs.append(f"page.no={page.get('no')} 字段 {dotpath} 类型应为 dict")


def _check_asset(page: dict, errs: list, article_root: Path | None) -> None:
    """asset 路径安全（P0-2）：前缀白名单 + 禁穿越 + 存在性。"""
    asset = page.get("asset")
    if not isinstance(asset, str) or not asset:
        return  # 缺失由 required 规格报告；ai-image 可选性由 build_mode 决定
    if not asset.startswith(ASSET_PREFIX):
        errs.append(f"page.no={page.get('no')} asset 必须以 {ASSET_PREFIX} 开头: {asset}")
    if ".." in asset or "\\" in asset or Path(asset).is_absolute():
        errs.append(f"page.no={page.get('no')} asset 含非法路径片段（.. / 绝对路径 / 反斜杠）: {asset}")
        return
    if article_root is not None:
        p = article_root / asset
        if not p.is_file():
            errs.append(f"page.no={page.get('no')} asset 文件不存在: {asset}")


def _check_crop(page: dict, errs: list) -> None:
    """crop 契约（T2.5）：mode=contain（缺省）| manual；manual 必带归一化 x/y/width/height
    （0~1，w/h>0，x+w<=1，y+h<=1）；fit=cover（缺省）|contain；position 仅 contain 模式有效。"""
    crop = page.get("crop")
    if not isinstance(crop, dict):
        return
    mode = crop.get("mode", "contain")
    if mode not in ("contain", "manual"):
        errs.append(f"page.no={page.get('no')} crop.mode 必须是 contain|manual，当前 {mode!r}")
        return
    fit = crop.get("fit", "cover")
    if fit not in ("cover", "contain"):
        errs.append(f"page.no={page.get('no')} crop.fit 必须是 cover|contain，当前 {fit!r}")
    if mode == "manual":
        for k in ("x", "y", "width", "height"):
            v = crop.get(k)
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                errs.append(f"page.no={page.get('no')} crop.manual 缺少数值字段 {k}")
                return
        x, y, w, h = crop["x"], crop["y"], crop["width"], crop["height"]
        eps = 1e-6
        if not (0 <= x <= 1 and 0 <= y <= 1):
            errs.append(f"page.no={page.get('no')} crop.manual x/y 必须在 0~1")
        if not (0 < w <= 1 and 0 < h <= 1):
            errs.append(f"page.no={page.get('no')} crop.manual width/height 必须在 (0,1]")
        if x + w > 1 + eps or y + h > 1 + eps:
            errs.append(f"page.no={page.get('no')} crop.manual 区域越界（x+w={x + w:.4f}, y+h={y + h:.4f}）")
    elif "position" in crop and not isinstance(crop["position"], str):
        errs.append(f"page.no={page.get('no')} crop.position 类型应为 str（object-position）")


def validate_pages(data: dict, article_root: Path | None = None,
                   build_mode: bool = False) -> list[str]:
    """校验 pages 数据，返回错误列表（空 = 通过）。纯函数，不做任何 IO（除 asset 存在性）。"""
    errs: list[str] = []
    if data.get("schema_version") != 2:
        errs.append(f"schema_version 必须为 2，当前 {data.get('schema_version')!r}")
        return errs  # 结构版本不对，后续检查无意义
    style_mode = data.get("style_mode")
    if style_mode not in THEMES:
        errs.append(f"style_mode 必须是 {'|'.join(THEMES)}，当前 {style_mode!r}")
    else:
        if data.get("theme") not in THEMES[style_mode]:
            errs.append(f"theme {data.get('theme')!r} 不属于 {style_mode} 可用主题: {THEMES[style_mode]}")
    title = data.get("title")
    if not isinstance(title, str) or not title.strip():
        errs.append("title 必填且非空")
    elif len(title) > TITLE_MAX:
        errs.append(f"title 超 {TITLE_MAX} 字（{len(title)}）")
    content = data.get("content", "")
    if not isinstance(content, str):
        errs.append("content 类型应为 string")
    elif len(content) > CONTENT_MAX:
        errs.append(f"content 超 {CONTENT_MAX} 字（{len(content)}）")

    pages = data.get("pages")
    if not isinstance(pages, list) or not (1 <= len(pages) <= MAX_PAGES):
        errs.append(f"pages 必须是 1~{MAX_PAGES} 项的数组")
        return errs

    seen_nos: set[int] = set()
    prev_no = 0
    for idx, page in enumerate(pages):
        if not isinstance(page, dict):
            errs.append(f"pages[{idx}] 必须是对象")
            continue
        no = page.get("no")
        if not isinstance(no, int) or isinstance(no, bool):
            errs.append(f"pages[{idx}] no 必须是整数")
            continue
        if no in seen_nos:
            errs.append(f"页号重复: {no}")
        seen_nos.add(no)
        if no <= prev_no:
            errs.append(f"页号必须递增: {no}（前页 {prev_no}）")
        prev_no = no

        if idx == 0 and page.get("role") != "cover":
            errs.append("page 1 必须 role=cover")

        source = page.get("source")
        if source not in SOURCE_ROUTES:
            errs.append(f"page.no={no} source 必须是 {'|'.join(SOURCE_ROUTES)}，当前 {source!r}")
            continue

        if source == "html":
            layout = page.get("layout")
            if not layout:
                errs.append(f"page.no={no} html 路由 layout 必填")
            elif layout not in COMPONENTS:
                errs.append(f"page.no={no} 未知 layout: {layout}（组件表: {'|'.join(COMPONENTS)}）")
            else:
                spec = COMPONENTS[layout]
                _check_required_fields(page, spec, errs)
                _check_crop(page, errs)
                wr = page.get("well_ratio")
                if wr is not None and wr not in WELL_RATIOS:
                    errs.append(f"page.no={no} well_ratio 非法: {wr}（允许 {'|'.join(WELL_RATIOS)}）")
                allow = spec.get("image_fit_allow")
                if allow is not None:
                    fit = page.get("image_fit") or spec.get("image_fit_default", "contain")
                    if fit not in allow:
                        errs.append(f"page.no={no} image_fit={fit} 不允许（{layout} 仅允许 {'|'.join(allow)}；"
                                    "照片页请用 ai-image 路由）")
        else:  # ai-image
            prompt = page.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                errs.append(f"page.no={no} ai-image 页 prompt 必填且非空")
            if build_mode and not isinstance(page.get("asset"), str):
                errs.append(f"page.no={no} build 阶段 ai-image 页必须有 asset（生图产物路径）")
        _check_asset(page, errs, article_root)
    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--cards-root", default=None,
                    help="文章目录（asset 存在性校验的根）；缺省跳过存在性检查")
    ap.add_argument("--build-mode", action="store_true",
                    help="构建前校验：ai-image 页 asset 也必须就位")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    try:
        data = json.loads(Path(args.pages).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"[FAIL] pages.json 读取/解析失败: {e}")
        return 1
    root = Path(args.cards_root).resolve() if args.cards_root else None
    errs = validate_pages(data, article_root=root, build_mode=args.build_mode)
    if errs:
        for e in errs:
            print(f"[FAIL] {e}")
        print(f"=== PAGES INVALID（{len(errs)} 项） ===")
        return 1
    print("[OK] pages.json 通过 schema v2 校验")
    print("=== PAGES VALID ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
