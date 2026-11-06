#!/usr/bin/env python3
"""mark_review.py —— 人工审图结论结构化记录（T4.3，零 LLM）。

把人工审核结果写入 cards-manifest.json 对应页的 review 字段：
  status: APPROVED | REJECTED | REVISION_REQUIRED
  reviewer / reviewed_at(ISO) / sha256_at_review(审核时产物指纹) / conclusion / notes

设计要点（评审 T4 建议）：
- sha256_at_review 用于审核失效判定：图片后续变化（SHA 不一致）时 verify_cards 报审核过期；
- 只改 review 字段，不触碰页面语义与产物。

CLI：
  python3 mark_review.py --manifest <cards-manifest.json> --no <页号>
      --status APPROVED|REJECTED|REVISION_REQUIRED --reviewer <名字> [--notes "<意见>"]
输出契约：[OK]/[FAIL]；成功 "=== REVIEW SAVED ===" 退出码 0。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

VALID_STATUS = ("APPROVED", "REJECTED", "REVISION_REQUIRED")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--no", required=True, type=int)
    ap.add_argument("--status", required=True, choices=VALID_STATUS)
    ap.add_argument("--reviewer", required=True)
    ap.add_argument("--notes", default="")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entry = next((p for p in manifest.get("pages", []) if p.get("no") == args.no), None)
    if entry is None:
        print(f"[FAIL] manifest 中不存在页 {args.no}")
        return 1

    asset = manifest_path.parent / entry["asset"]
    if not asset.is_file():
        print(f"[FAIL] 产物缺失，无法记录审核: {asset}")
        return 1
    sha_now = hashlib.sha256(asset.read_bytes()).hexdigest()

    entry["review"] = {
        "status": args.status,
        "reviewer": args.reviewer,
        "reviewed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "sha256_at_review": sha_now,  # 审核失效判定依据：后续图变则 verify 报审核过期
        "conclusion": args.status,
        "notes": args.notes,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[OK] 页 {args.no}: {args.status} by {args.reviewer} (sha256_at_review={sha_now[:16]}...)")
    print("=== REVIEW SAVED ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
