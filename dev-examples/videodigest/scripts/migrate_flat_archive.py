#!/usr/bin/env python3
"""migrate_flat_archive.py —— 灵感区归档一次性扁平化迁移（archive_inspire.py 2026-11-10 配套）。

旧格式: <灵感>/<标题>/0-raw.md（每视频一目录）
新格式: <灵感>/<YYYYMMDD>-<标题>.md（扁平，日期取 frontmatter created_at，缺失回落文件 mtime）

规则:
  - 只迁移内容恰为 {0-raw.md} 的目录（纯视频归档）；含 1-idea.md/article.yaml 等的活跃灵感目录一律跳过
  - 同名撞车 → " (2)" 后缀递增
  - 缺省 dry-run 只打印计划；--apply 才执行（os.replace + 删空目录）
用法:
    python3 migrate_flat_archive.py            # dry-run
    python3 migrate_flat_archive.py --apply    # 执行
"""
import argparse
import os
import re
import shutil
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CREATED_RE = re.compile(r"created_at:\s*(\d{4}-\d{2}-\d{2})")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from archive_inspire import discover_vault_root, inspire_dir_from_config  # noqa: E402


def date_prefix_of(md_file: Path) -> str:
    try:
        text = md_file.read_text(encoding="utf-8")
        m = CREATED_RE.search(text)
        if m:
            return m.group(1).replace("-", "")
    except OSError:
        pass
    return time.strftime("%Y%m%d", time.localtime(md_file.stat().st_mtime))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="执行迁移（缺省 dry-run）")
    ap.add_argument("--vault-root", default=None)
    args = ap.parse_args()

    vault_raw, _ = discover_vault_root(args.vault_root)
    if not vault_raw:
        print("[FAIL] vault root 未定位")
        return 1
    inspire = Path(vault_raw).expanduser() / inspire_dir_from_config()
    if not inspire.is_dir():
        print(f"[FAIL] 灵感目录不存在: {inspire}")
        return 1

    moved = skipped = 0
    for sub in sorted(inspire.iterdir()):
        if not sub.is_dir() or sub.name.startswith("."):
            continue
        files = sorted(p.name for p in sub.iterdir())
        if files != ["0-raw.md"]:
            print(f"[SKIP] {sub.name}/（非纯视频归档: {', '.join(files[:4]) or '空'}）")
            skipped += 1
            continue
        src = sub / "0-raw.md"
        date = date_prefix_of(src)
        base = f"{date}-{sub.name}"
        dst = inspire / (base + ".md")
        n = 2
        while dst.exists():
            dst = inspire / f"{base} ({n}).md"
            n += 1
        print(f"[{'MOVE' if args.apply else 'PLAN'}] {sub.name}/0-raw.md → {dst.name}")
        if args.apply:
            try:
                os.replace(src, dst)
                sub.rmdir()
                moved += 1
            except OSError as e:
                print(f"[FAIL] {sub.name}: {e}")
                return 1
    print(f"=== {'APPLIED' if args.apply else 'DRY-RUN'}: 迁移 {moved} 个（dry-run 计入） / 跳过 {skipped} 个活跃目录 ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
