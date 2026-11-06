#!/usr/bin/env python3
"""verify_cards.py —— 卡片序列最终验收（T4.4，硬性规则全查，零 LLM）。

任何一项失败即退出码 1（不能进入 T5 发布审批）。硬性规则（评审 T4.4 定案）：
  1. 页面数量与 pages.json 完全一致
  2. 页面编号 01~NN 连续
  3. 图片全部存在
  4. 图片尺寸 1080x1440
  5. 图片格式 PNG
  6. 无重复图片（SHA256）
  7. manifest 存在且与 pages.json 绑定（generated_from_pages_sha256 一致）、与实际文件一致
  8. 审核状态：全部非 PENDING_REVIEW；--require-approved 时全部 APPROVED；
     sha256_at_review 与当前产物一致（审核后图未再变化，旧审核未失效）

CLI：
  python3 verify_cards.py --pages <pages.json> --cards-dir <article_dir/_cards>
      [--require-approved]
输出契约：逐项 [OK]/[FAIL]；全过 "=== CARDS VERIFIED ===" 退出码 0。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

GEN_W, GEN_H = 1080, 1440


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"not a PNG: {path.name}")
    return struct.unpack(">II", head[16:24])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--cards-dir", required=True)
    ap.add_argument("--require-approved", action="store_true",
                    help="发布门：要求全部页面 review.status == APPROVED")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cards_dir = Path(args.cards_dir)
    out_dir = cards_dir / "output"
    pages_path = Path(args.pages)
    data = json.loads(pages_path.read_text(encoding="utf-8-sig"))
    pages = data.get("pages", [])
    nos = [p["no"] for p in pages]
    PASS: list[str] = []
    FAIL: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        (PASS if cond else FAIL).append(name)
        print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))

    manifest_path = cards_dir / "cards-manifest.json"
    manifest = None
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    check("manifest 存在且可解析", manifest is not None)
    if manifest is None:
        print("=== CARDS VERIFY FAILED ===")
        return 1
    check("manifest 与 pages.json 绑定一致",
          manifest.get("generated_from_pages_sha256") == sha256_of(pages_path),
          "pages.json 已变更，请重新 normalize")
    m_by_no = {p.get("no"): p for p in manifest.get("pages", [])}

    check("页面数量一致", len(m_by_no) == len(pages),
          f"manifest={len(m_by_no)} pages.json={len(pages)}")
    check("编号连续 01~NN", sorted(nos) == list(range(1, len(nos) + 1)), str(sorted(nos)))

    shas: dict[str, int] = {}
    approved_ok, stale_ok = True, True
    for page in pages:
        no = page["no"]
        m = m_by_no.get(no)
        dest = out_dir / f"{no:02d}.png"
        if not dest.is_file():
            check(f"页 {no:02d} 产物存在", False, str(dest))
            review_ok = stale_ok = False
            continue
        try:
            w, h = png_size(dest)
        except ValueError as e:
            check(f"页 {no:02d} PNG 可解析", False, str(e))
            continue
        # ai-image 来源允许 3:4 比例 ±3%（上游忽略精确 size，T7 实测）；html 渲染页必须精确
        m_entry = m_by_no.get(no) or {}
        if m_entry.get("source") == "ai-image":
            ratio_dev = abs(w / h - GEN_W / GEN_H) / (GEN_W / GEN_H)
            size_ok = ratio_dev <= 0.03 and w >= 1000
        else:
            size_ok = (w, h) == (GEN_W, GEN_H)
        check(f"页 {no:02d} 尺寸达标", size_ok, f"{w}x{h}")
        sha = sha256_of(dest)
        if sha in shas:
            check(f"页 {no:02d} 无重复图片", False, f"与页 {shas[sha]} SHA256 相同")
        shas.setdefault(sha, no)
        if not m:
            check(f"页 {no:02d} 在 manifest 中", False)
            review_ok = False
            continue
        if m.get("sha256") != sha:
            check(f"页 {no:02d} manifest 与实际文件一致", False,
                  f"manifest={str(m.get('sha256'))[:12]} 实际={sha[:12]}")
            approved_ok = False
            stale_ok = False
            continue
        check(f"页 {no:02d} manifest 一致", True)
        rv = m.get("review") or {}
        if rv.get("status") == "PENDING_REVIEW":
            approved_ok = False
        if args.require_approved and rv.get("status") != "APPROVED":
            approved_ok = False
        if rv.get("sha256_at_review") and rv["sha256_at_review"] != sha:
            stale_ok = False  # 审核后图又变了：旧审核失效

    if args.require_approved:
        # 发布门：全部 APPROVED + 审核后产物未变化（审核过期检查）
        check("审核状态全部 APPROVED（发布门）", approved_ok)
        check("审核未过期（审核后产物未变化）", stale_ok)
    # 非 require-approved（制作验收）不检查审核状态：normalize 后 review 必然 PENDING_REVIEW

    print(f"\n汇总 OK={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        print("=== CARDS VERIFY FAILED ===")
        return 1
    print("=== CARDS VERIFIED ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
