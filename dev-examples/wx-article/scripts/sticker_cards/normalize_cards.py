#!/usr/bin/env python3
"""normalize_cards.py —— 卡片产物规范化 + cards-manifest.json + 审图清单（T4.1/T4.2/T4.3，零 LLM）。

职责边界（评审定案）：
- 规范化只整理产物，**不改变页面语义和顺序**——顺序唯一依据 pages.json；
- manifest 是"最终图片 ↔ 页面"的映射与审图/发布审批依据，**不是第二份页面规划文件**
  （页面语义仍来自 pages.json；manifest 记录 generated_from_pages_sha256 绑定，pages 变更即失效）；
- 人工审图结果结构化（PENDING_REVIEW/APPROVED/REJECTED/REVISION_REQUIRED + reviewer/
  reviewed_at/sha256_at_review），图片变化（SHA256 不一致）时旧审核自动失效重置。

来源映射（三类）：
  html 页    -> _cards/render/xhs-NN.png（render.mjs 产物）
  ai-image 页-> aigen-state.json 中 SUCCEEDED 页的 asset（_cards/assets/ai-NN.*）
输出：
  _cards/output/01.png ~ NN.png（复制，不改源；已存在且 SHA256 相同则幂等跳过）
  _cards/cards-manifest.json（映射 + 每页 review 字段）
  _cards/review-checklist.md（人读审图清单：按页面类型的审核标准 + 逐页核对行）

页面类型（审图标准依据）：
  screenshot  source=html 且 layout=screenshot-with-caption -> 审：文字清晰/裁切正确/关键内容完整
  ai-image    source=ai-image                              -> 审：构图/风格一致/事实准确
  layout-text 其余 html 页                                   -> 审：排版/溢出/层级

CLI：
  python3 normalize_cards.py --pages <pages.json> --cards-dir <article_dir/_cards>
输出契约：逐页 [OK]/[SKIP]/[FAIL]；全部成功 "=== ALL DONE ===" 退出码 0。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

GEN_W, GEN_H = 1080, 1440
REVIEW_STANDARDS = {
    "screenshot": "文字清晰可读、裁切正确（无地址栏/无关区域残留）、关键代码或数据完整",
    "ai-image": "画面构图合理、与本组其他页风格一致、内容事实准确、图中无错误文字",
    "layout-text": "排版无溢出无重叠、字体层级清晰、与画板边缘留白得当",
}


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"not a PNG: {path.name}")
    return struct.unpack(">II", head[16:24])


def page_kind(page: dict) -> str:
    if page.get("source") == "ai-image":
        return "ai-image"
    if page.get("layout") == "screenshot-with-caption":
        return "screenshot"
    return "layout-text"


def find_source(page: dict, cards_dir: Path, aigen_state: dict) -> Path:
    """按页面类型定位源产物。找不到/状态不合规抛 FileNotFoundError/LookupError。"""
    no = page["no"]
    if page.get("source") == "ai-image":
        st = (aigen_state.get("pages") or {}).get(str(no), {})
        if st.get("status") != "SUCCEEDED":
            raise LookupError(f"页 {no}: AI 生图状态为 {st.get('status') or '无'}（需 SUCCEEDED 才能进审图）")
        asset = cards_dir.parent / st.get("asset", "")
        if not asset.is_file():
            raise FileNotFoundError(f"页 {no}: 生图产物缺失 {st.get('asset')}")
        return asset
    render_png = cards_dir / "render" / f"xhs-{no:02d}.png"
    if not render_png.is_file():
        raise FileNotFoundError(f"页 {no}: 渲染产物缺失 {render_png}（先运行 render.mjs）")
    return render_png


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--cards-dir", required=True)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cards_dir = Path(args.cards_dir)
    pages_path = Path(args.pages)
    data = json.loads(pages_path.read_text(encoding="utf-8-sig"))
    pages_sha = sha256_of(pages_path)  # 绑定 pages.json 内容（语义唯一来源）
    out_dir = cards_dir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        aigen_state = json.loads((cards_dir / "aigen-state.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        aigen_state = {}
    old_manifest = {}
    manifest_path = cards_dir / "cards-manifest.json"
    if manifest_path.is_file():
        try:
            old_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    old_by_no = {p.get("no"): p for p in old_manifest.get("pages", [])}

    entries: list[dict] = []
    seen_sha: dict[str, int] = {}
    failed = False
    for page in data.get("pages", []):
        no = page["no"]
        kind = page_kind(page)
        try:
            src = find_source(page, cards_dir, aigen_state)
            w, h = png_size(src)
        except (FileNotFoundError, LookupError, ValueError) as e:
            print(f"[FAIL] {e}")
            failed = True
            continue
        if (w, h) != (GEN_W, GEN_H):
            print(f"[FAIL] 页 {no}: 尺寸 {w}x{h} != {GEN_W}x{GEN_H}（规范化不改尺寸）")
            failed = True
            continue
        sha = sha256_of(src)
        if sha in seen_sha:
            print(f"[FAIL] 页 {no}: 与页 {seen_sha[sha]} 内容完全相同（SHA256 重复）")
            failed = True
            continue
        seen_sha[sha] = no

        dest = out_dir / f"{no:02d}.png"
        if dest.is_file() and sha256_of(dest) == sha:
            print(f"[SKIP] 页 {no}: output/{dest.name} 已一致（幂等）")
        else:
            shutil.copy2(src, dest)
            print(f"[OK] 页 {no}: -> output/{dest.name} ({kind}, {w}x{h})")

        # review 继承规则：页面产物 SHA 未变 -> 保留旧审核；变了 -> 旧审核失效重置
        old = old_by_no.get(no) or {}
        if old.get("sha256") == sha and old.get("review"):
            review = old["review"]
            inherited = "（继承已有审核）"
        else:
            review = {"status": "PENDING_REVIEW", "reviewer": None, "reviewed_at": None,
                      "sha256_at_review": None, "conclusion": None, "notes": None}
            inherited = "（新页/产物已变，审核重置）"
        entries.append({
            "no": no, "role": page.get("role", ""), "source": page.get("source", ""),
            "page_kind": kind, "asset": f"output/{dest.name}",
            "width": w, "height": h, "sha256": sha, "status": "READY",
            "review": review,
        })
        print(f"      审图: {kind} | {REVIEW_STANDARDS[kind]}{inherited}")

    if failed:
        print(f"=== NORMALIZE FAILED ===")
        return 1

    manifest = {
        "version": 1,
        "generated_from_pages_sha256": pages_sha,
        "pages": entries,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[OK] manifest -> {manifest_path}")

    # 人读审图清单（T4.3；人工按此逐页审核后用 mark_review.py 记录结论）
    lines = ["# 小绿书卡片审图清单", "",
             f"- pages.json SHA256: `{pages_sha[:16]}...`（变更后本清单自动失效）",
             f"- 页数: {len(entries)}", "",
             "## 审核标准（按页面类型）", ""]
    for kind, std in REVIEW_STANDARDS.items():
        lines.append(f"- **{kind}**: {std}")
    lines += ["", "## 逐页核对", "",
              "| 页 | 类型 | 来源 | 尺寸 | SHA256(前8) | 审核状态 |", "|--|--|--|--|--|--|"]
    for e in entries:
        lines.append(f"| {e['no']:02d} | {e['page_kind']} | {e['source']} | "
                     f"{e['width']}x{e['height']} | `{e['sha256'][:8]}` | {e['review']['status']} |")
    lines += ["", "## 通用检查（每页都要过）", "",
              "- 首图为封面钩子，缩略图下仍可辨；- 图序叙事连贯；- 全组风格统一不漂移；",
              "- 图中中文完整无缺字；- 无溢出/重叠/贴边。", "",
              "审核结论用 mark_review.py 记录（APPROVED / REJECTED / REVISION_REQUIRED）。"]
    (cards_dir / "review-checklist.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[OK] 审图清单 -> {cards_dir / 'review-checklist.md'}")
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
