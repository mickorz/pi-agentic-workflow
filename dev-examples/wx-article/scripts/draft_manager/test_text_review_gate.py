#!/usr/bin/env python3
"""文字验收门测试（IMG-L T4）：check_state.py 的 text_review 检查分级。

场景：
  G1 无 manifest                → 零影响（present=false，现网旧文章不受约束）
  G2 pending                     → 阻断 + prepare_ready=false
  G3 rejected                    → 阻断 + prepare_ready=false
  G4 approved + sha 匹配         → 通过（prepare_ready 不受影响）
  G5 approved + path 缺失        → 提示不阻断（T0 取证：下游重命名断裂是现网常态）
  G6 approved + path 在但 sha 不符 → 阻断（图被换过，审核绑定失效）

运行：python3 test_text_review_gate.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHECK = HERE / "check_state.py"

PASS = 0
FAIL = 0


def run_check(dir_: Path) -> dict:
    r = subprocess.run(
        [sys.executable, str(CHECK), "--article-dir", str(dir_)],
        capture_output=True, text=True, encoding="utf-8",
    )
    return json.loads(r.stdout)


def make_article(manifest: dict | None) -> Path:
    d = Path(tempfile.mkdtemp(prefix="tr-gate-"))
    (d / "正文测试.md").write_text("# 标题\n\n正文\n", encoding="utf-8")
    (d / "cover.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    (d / "article.yaml").write_text("title: 测试文章\ndigest: 摘要\nauthor: a\ncontent_source: s\n", encoding="utf-8")
    if manifest is not None:
        (d / "image-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return d


def entry(review: dict | None, path: str = "cover.png", sha: str = "a" * 64) -> dict:
    return {
        "id": "cover", "kind": "cover", "status": "succeeded", "path": path,
        "content_review": review,
    }


def review(status: str, sha: str = "a" * 64) -> dict:
    return {"status": status, "image_sha256": sha, "requirements_hash": "b" * 64, "reviewed_at": "2026-10-28T00:00:00Z"}


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[OK] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} {detail}")


def sha_of(p: Path) -> str:
    import hashlib
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    # G1 无 manifest：零影响
    d = make_article(None)
    r = run_check(d)
    check("G1 无 manifest 零影响", r["text_review"]["present"] is False and r["prepare_ready"] is True, json.dumps(r.get("text_review"), ensure_ascii=False))
    shutil.rmtree(d, ignore_errors=True)

    # G2 pending：阻断
    d = make_article({"version": 1, "article_id": "x", "entries": {"cover": entry(review("pending"))}})
    r = run_check(d)
    check("G2 pending 阻断", r["prepare_ready"] is False and any(i.startswith("文字审核待") for i in r["issues"]), str(r["issues"]))
    shutil.rmtree(d, ignore_errors=True)

    # G3 rejected：阻断
    d = make_article({"version": 1, "article_id": "x", "entries": {"cover": entry(review("rejected"))}})
    r = run_check(d)
    check("G3 rejected 阻断", r["prepare_ready"] is False and any(i.startswith("文字审核已拒绝") for i in r["issues"]), str(r["issues"]))
    shutil.rmtree(d, ignore_errors=True)

    # G4 approved + sha 匹配：通过（先建文章再算文件 sha）
    d = make_article(None)
    (d / "image-manifest.json").write_text(json.dumps(
        {"version": 1, "article_id": "x", "entries": {"cover": entry(review("approved", sha_of(d / "cover.png")))}},
        ensure_ascii=False), encoding="utf-8")
    r = run_check(d)
    check("G4 approved sha 匹配通过", r["prepare_ready"] is True and r["text_review"]["blocking"] == [], str(r["issues"]))
    shutil.rmtree(d, ignore_errors=True)

    # G5 approved + path 缺失：提示不阻断
    d = make_article({"version": 1, "article_id": "x", "entries": {"cover": entry(review("approved"), path="imgs/renamed-missing.png")}})
    r = run_check(d)
    check("G5 路径断裂不阻断", r["prepare_ready"] is True and any("路径断裂" in i for i in r["issues"]), str(r["issues"]))
    shutil.rmtree(d, ignore_errors=True)

    # G6 approved + sha 不符：阻断
    d = make_article({"version": 1, "article_id": "x", "entries": {"cover": entry(review("approved", sha="0" * 64))}})
    r = run_check(d)
    check("G6 sha 不符阻断", r["prepare_ready"] is False and any(i.startswith("文字审核绑定失效") for i in r["issues"]), str(r["issues"]))
    shutil.rmtree(d, ignore_errors=True)

    print(f"\n=== {PASS} PASS / {FAIL} FAIL ===")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
