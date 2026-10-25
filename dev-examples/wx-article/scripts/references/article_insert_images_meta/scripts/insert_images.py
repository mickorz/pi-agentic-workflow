#!/usr/bin/env python3
"""插图脚本：把 mapping 里的图片按 heading 插入文章 md（原 insert_images.ps1 的 Python 版）。

由 workflow article_insert_images_meta.js 调用（python3 insert_images.py --article-dir ... --mapping-path ...）。

行为：
- mapping 每项 {image, heading, alt}：定位 heading 章节内「**一句话记住」行前插入
  空行 + ![alt](image) + 空行；无「一句话记住」则插到章节末尾。
- 幂等与替换（2026-10-24 修复重复插入问题）：
  * 章节内已存在相同 image 标记 -> [SKIP] 跳过（幂等，重跑零重复）；
  * 章节内已有其它 imgs/ 配图 -> [REPLACE] 在首个标记位置替换为新图，
    并删除该章节内其余 imgs/ 标记行（错图纠正，不叠加）。
- 序号确定性映射（不读图片内容）：文件名带序号（01-x.png / 1_x.png / 图1-x.png）
  时按「序号 N -> 第 N 个 ## 章节」重锚定，忽略 LLM 给的 heading（防语义漂移）。
  --mode numbered 时无需 mapping，直接扫 imgs/ 生成映射。
- --cover-image 非空时把封面 ![文章封面](<cover>) 插到头部段落末尾（首个 ## 章节前），
  相同封面已存在则跳过（幂等）；已存在指向其它封面的标记则原位替换。
- 输出契约（下游 prompt/断言依赖，勿改字面量）：
  [md] <path> / [OK] <image> -> <heading> / [OK] cover <cover> -> 头部段落末尾(第 N 行)
  [SKIP] <image> already in <heading> / [SKIP] cover already present: <cover>
  [REPLACE] <old> -> <new> in <heading> / [NUMBER] numbered images -> 序号映射覆盖 heading
  [FAIL] <reason>
  === inserted N / M ; skipped: S ; replaced: R ; cover: <state> ; md img markers now: K ===
  / === ALL DONE ===
退出码：0 全部成功；1 参数/文件错误；2 有失败项。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# 同一文章锁（T1.7：补插图阶段临界区缺口；协议见 draft_manager/article_lock.py）
_DRAFT_MANAGER = Path(__file__).resolve().parents[3] / "draft_manager"
sys.path.insert(0, str(_DRAFT_MANAGER))
from article_lock import ArticleLock, LockHeldError  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MD_PREFIX_EXCLUDE = re.compile(r"^(article|draft|review)")
# md 中的图片标记（本地相对路径，http(s) 外链不算本流程配图）
IMG_MARKER_RE = re.compile(r"!\[[^\]]*\]\((imgs/[^)\s]+|cover\.[^)\s]+|imgs/cover[^)\s]*)\)")
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
NUM_RE = re.compile(r"^(?:图\s*)?(\d{1,3})(?=[-_.\s]|$)")


def pick_md(article_dir: Path) -> Path | None:
    cands = [
        p for p in article_dir.glob("*.md")
        if not MD_PREFIX_EXCLUDE.match(p.name) and "审稿" not in p.name and "pre-humanize" not in p.name
    ]
    if not cands:
        return None
    return max(cands, key=lambda p: p.stat().st_size)


def find_heading(lines: list[str], heading: str) -> int:
    hkey = heading.strip()
    for i, line in enumerate(lines):
        if line.strip() == hkey:
            return i
    for i, line in enumerate(lines):
        if line.strip().startswith(hkey):
            return i
    return -1


def section_headings(lines: list[str]) -> list[str]:
    return [line.strip() for line in lines if line.strip().startswith("##")]


def number_of(image: str) -> int | None:
    """从图片文件名提取序号：01-x.png / 1_x.png / 图1-x.png -> 1；无序号 -> None。"""
    m = NUM_RE.match(Path(image).stem)
    return int(m.group(1)) if m else None


def section_span(lines: list[str], hi: int) -> tuple[int, int]:
    """章节体范围 [hi+1, end)：到下一个 ## 或文件末尾。"""
    end = len(lines)
    for i in range(hi + 1, len(lines)):
        if lines[i].strip().startswith("##"):
            end = i
            break
    return hi + 1, end


def markers_in_span(lines: list[str], start: int, end: int) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for i in range(start, end):
        m = IMG_MARKER_RE.search(lines[i])
        if m:
            out.append((i, m.group(1)))
    return out


def insert_point(lines: list[str], hi: int) -> int:
    """章节内「**一句话记住」行前；没有则章节末尾（下一个 ## 前/文件末尾）。"""
    for i in range(hi + 1, len(lines)):
        if lines[i].strip().startswith("##"):
            break
        if lines[i].startswith("**一句话记住"):
            return i
    for i in range(hi + 1, len(lines)):
        if lines[i].strip().startswith("##"):
            return i
    return len(lines)


def build_numbered_mapping(article_dir: Path, sections: list[str]) -> tuple[list[dict], list[str]]:
    """扫 imgs/ 生成「序号 N -> 第 N 章」映射。全部带唯一序号才算 numbered。"""
    imgs_dir = article_dir / "imgs"
    files = sorted(
        p.name for p in imgs_dir.iterdir()
        if p.is_file() and p.suffix.lower() in IMG_EXTS and not p.name.lower().startswith("cover")
    ) if imgs_dir.is_dir() else []
    if not files:
        return [], ["imgs 目录为空或不存在"]
    nums = [number_of(n) for n in files]
    if any(n is None for n in nums):
        return [], [f"图片无序号，numbered 模式不适用: {n}" for n, v in zip(files, nums) if v is None]
    if len(set(nums)) != len(nums):
        return [], ["图片序号重复，numbered 模式不适用"]
    mapping: list[dict] = []
    errors: list[str] = []
    for name, n in zip(files, nums):
        if n < 1 or n > len(sections):
            errors.append(f"序号 {n} 超出章节数 {len(sections)}: {name}")
            continue
        stem = re.sub(r"^(?:图\s*)?\d{1,3}[-_.\s]*", "", Path(name).stem) or "配图"
        mapping.append({"image": f"imgs/{name}", "heading": sections[n - 1], "alt": f"术语插画：{stem}"})
    return mapping, errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--article-dir", required=True)
    ap.add_argument("--md-file", default="")
    ap.add_argument("--mapping-path", default="")
    ap.add_argument("--cover-image", default="")
    ap.add_argument("--mode", choices=["auto", "mapping", "numbered"], default="auto",
                    help="auto=有 mapping 用 mapping(序号可覆盖 heading), 无则尝试 numbered; mapping=仅用传入映射; numbered=扫 imgs 按序号映射")
    args = ap.parse_args()

    article_dir = Path(args.article_dir)
    mapping_path = Path(args.mapping_path) if args.mapping_path else None
    if not article_dir.is_dir():
        print(f"[FAIL] article_dir not found: {article_dir}")
        return 1
    if args.mode == "mapping" and not mapping_path:
        print("[FAIL] mapping mode requires --mapping-path")
        return 1
    if mapping_path is not None and not mapping_path.is_file():
        print(f"[FAIL] mapping not found: {mapping_path}")
        return 1

    if args.md_file:
        md_file = Path(args.md_file)
    else:
        picked = pick_md(article_dir)
        if picked is None:
            print(f"[FAIL] no .md found in {article_dir}")
            return 1
        md_file = picked
    if not md_file.is_file():
        print(f"[FAIL] md not found: {md_file}")
        return 1

    # 插图临界区：与生图/发布同一文章锁互斥（D5 互斥矩阵）
    lock_path = article_dir / ".publish.article.lock"
    try:
        with ArticleLock(lock_path, run_id=f"insert-images-{os.getpid()}", scope="insert-images"):
            return insert_all(args, article_dir, md_file, mapping_path)
    except LockHeldError as e:
        info = getattr(e, "info", {}) or {}
        print(f"[LOCKED] pid={info.get('pid')} runId={info.get('runId')}")
        return 3


def insert_all(args, article_dir: Path, md_file: Path, mapping_path: Path | None) -> int:
    print(f"[md] {md_file}")

    mapping: list[dict] = []
    if mapping_path is not None:
        mapping = json.loads(mapping_path.read_text(encoding="utf-8-sig"))
        if isinstance(mapping, dict):
            mapping = [mapping]

    text = md_file.read_text(encoding="utf-8-sig")
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split("\r\n" if nl == "\r\n" else "\n")

    # ---- 序号确定性映射 ----
    numbered_override = False
    sections = section_headings(lines)
    non_cover = [m for m in mapping if "cover" not in Path(str(m.get("image", ""))).name.lower()]
    nums = [number_of(str(m.get("image", ""))) for m in non_cover]
    if non_cover and nums and all(n is not None for n in nums) and len(set(nums)) == len(nums):
        # 全部带唯一序号：按「序号 N -> 第 N 章」重锚定，忽略 LLM heading（防漂移）
        ok = True
        for m, n in zip(non_cover, nums):
            if n < 1 or n > len(sections):
                print(f"[FAIL] 序号 {n} 超出章节数 {len(sections)}: {m.get('image')}")
                ok = False
        if ok:
            for m, n in zip(non_cover, nums):
                m["heading"] = sections[n - 1]
            numbered_override = True
            print(f"[NUMBER] numbered images -> 序号映射覆盖 heading（共 {len(non_cover)} 张）")
    elif args.mode == "numbered":
        built, errs = build_numbered_mapping(article_dir, sections)
        if errs or not built:
            for e in errs or ["imgs 无可用图片"]:
                print(f"[FAIL] {e}")
            return 1
        mapping = built
        numbered_override = True
        print(f"[NUMBER] imgs 按序号映射生成 {len(built)} 项（无需 mapping）")
    elif args.mode == "auto" and not mapping:
        built, errs = build_numbered_mapping(article_dir, sections)
        if errs or not built:
            for e in errs or ["无 mapping 且 imgs 无法按序号映射"]:
                print(f"[FAIL] {e}")
            return 1
        mapping = built
        numbered_override = True
        print(f"[NUMBER] imgs 按序号映射生成 {len(built)} 项（无需 mapping）")

    inserted = 0
    skipped = 0
    replaced = 0
    failed: list[str] = []
    for m in mapping:
        image = str(m.get("image", ""))
        heading = str(m.get("heading", ""))
        alt = str(m.get("alt", "")) or "术语插画"
        if not image or not heading:
            failed.append(f"missing image/heading ({image})")
            continue

        hi = find_heading(lines, heading)
        if hi < 0:
            failed.append(f"heading not found: {heading}")
            continue

        marker = f"![{alt}]({image})"
        span_start, span_end = section_span(lines, hi)
        existing = markers_in_span(lines, span_start, span_end)
        paths = [p for _, p in existing]
        if image in paths:
            skipped += 1
            print(f"[SKIP] {image} already in {heading.strip()}")
            continue
        if existing:
            # 章节内已有其它配图：首个标记位置替换为新图，其余 imgs 标记行删除（错图纠正）
            first_idx, old = existing[0]
            lines[first_idx] = marker
            for idx, _ in sorted(existing[1:], reverse=True):
                del lines[idx]
            replaced += 1
            print(f"[REPLACE] {old} -> {image} in {heading.strip()}" +
                  (f"（并清除 {len(existing) - 1} 个多余标记）" if len(existing) > 1 else ""))
            continue

        ai = insert_point(lines, hi)
        lines.insert(ai, "")
        lines.insert(ai, marker)
        lines.insert(ai, "")
        inserted += 1
        print(f"[OK] {image} -> {heading.strip()}")

    cover_state = "none"
    cover = args.cover_image
    if cover:
        cover_abs = article_dir / cover
        cover_re = re.compile(r"!\[[^\]]*\]\(" + re.escape(cover) + r"\)")
        cover_any_re = re.compile(r"!\[文章封面\]\(([^)\s]+)\)")
        if not cover_abs.is_file():
            failed.append(f"cover not found: {cover}")
            cover_state = "failed"
        elif cover_re.search("\n".join(lines)):
            print(f"[SKIP] cover already present: {cover}")
            cover_state = "skipped"
        else:
            cmarker = f"![文章封面]({cover})"
            replaced_cover = False
            for i, line in enumerate(lines):
                m2 = cover_any_re.search(line)
                if m2 and m2.group(1) != cover:
                    lines[i] = cmarker
                    replaced_cover = True
                    print(f"[REPLACE] cover {m2.group(1)} -> {cover}")
                    break
            if replaced_cover:
                cover_state = "replaced"
            else:
                first_h2 = len(lines)
                for i, line in enumerate(lines):
                    if line.strip().startswith("##"):
                        first_h2 = i
                        break
                ci = first_h2
                while ci > 0 and lines[ci - 1].strip() == "":
                    ci -= 1
                if ci > 0:
                    lines.insert(ci, "")
                lines.insert(ci, cmarker)
                lines.insert(ci, "")
                cover_state = "inserted"
                print(f"[OK] cover {cover} -> 头部段落末尾(第 {ci + 1} 行)")

    with open(md_file, "w", encoding="utf-8-sig", newline="") as f:
        f.write(nl.join(lines))

    final = md_file.read_text(encoding="utf-8-sig")
    img_count = len(re.findall(r"!\[[^\]]*\]\(imgs/", final))
    print(f"=== inserted {inserted} / {len(mapping)} ; skipped: {skipped} ; replaced: {replaced}"
          f" ; cover: {cover_state} ; md img markers now: {img_count} ===")
    if failed:
        for f in failed:
            print(f"[FAIL] {f}")
        return 2
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
