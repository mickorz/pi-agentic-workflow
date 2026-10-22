#!/usr/bin/env python3
"""插图脚本：把 mapping 里的图片按 heading 插入文章 md（原 insert_images.ps1 的 Python 版）。

由 workflow article_insert_images_meta.js 调用（python3 insert_images.py --article-dir ... --mapping-path ...）。

行为：
- mapping 每项 {image, heading, alt}：定位 heading 章节内「**一句话记住」行前插入
  空行 + ![alt](image) + 空行；无「一句话记住」则插到章节末尾。
- --cover-image 非空时把封面 ![文章封面](<cover>) 插到头部段落末尾（首个 ## 章节前），
  已存在则跳过（幂等）。
- 输出契约（下游 prompt/断言依赖，勿改字面量）：
  [md] <path> / [OK] <image> -> <heading> / [OK] cover <cover> -> 头部段落末尾(第 N 行)
  [SKIP] cover already present: <cover> / [FAIL] <reason>
  === inserted N / M ; cover: <state> ; md img markers now: K === / === ALL DONE ===
退出码：0 全部成功；1 参数/文件错误；2 有失败项。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MD_PREFIX_EXCLUDE = re.compile(r"^(article|draft|review)")


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--article-dir", required=True)
    ap.add_argument("--md-file", default="")
    ap.add_argument("--mapping-path", required=True)
    ap.add_argument("--cover-image", default="")
    args = ap.parse_args()

    article_dir = Path(args.article_dir)
    mapping_path = Path(args.mapping_path)
    if not article_dir.is_dir():
        print(f"[FAIL] article_dir not found: {article_dir}")
        return 1
    if not mapping_path.is_file():
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
    print(f"[md] {md_file}")

    mapping = json.loads(mapping_path.read_text(encoding="utf-8-sig"))
    if isinstance(mapping, dict):
        mapping = [mapping]

    text = md_file.read_text(encoding="utf-8-sig")
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split("\r\n" if nl == "\r\n" else "\n")

    inserted = 0
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

        ai = insert_point(lines, hi)
        marker = f"![{alt}]({image})"
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
        if not cover_abs.is_file():
            failed.append(f"cover not found: {cover}")
            cover_state = "failed"
        elif cover_re.search(text):
            print(f"[SKIP] cover already present: {cover}")
            cover_state = "skipped"
        else:
            first_h2 = len(lines)
            for i, line in enumerate(lines):
                if line.strip().startswith("##"):
                    first_h2 = i
                    break
            ci = first_h2
            while ci > 0 and lines[ci - 1].strip() == "":
                ci -= 1
            cmarker = f"![文章封面]({cover})"
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
    print(f"=== inserted {inserted} / {len(mapping)} ; cover: {cover_state} ; md img markers now: {img_count} ===")
    if failed:
        for f in failed:
            print(f"[FAIL] {f}")
        return 2
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
