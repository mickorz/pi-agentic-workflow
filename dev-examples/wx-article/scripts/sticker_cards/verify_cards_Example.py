#!/usr/bin/env python3
"""verify_cards_Example.py —— 卡片序列最终验收测试（T4.4，零 LLM）。

覆盖硬性规则（评审 T4.4 定案）：页数一致 / 编号连续 / 存在 / 1080x1440 / PNG /
无重复 SHA256 / manifest 绑定与一致 / 审核状态（含 --require-approved 发布门）/
审核过期（审核后图变化）。

运行：python3 verify_cards_Example.py
"""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def make_png(path: Path, w: int = 1080, h: int = 1440, color: tuple = (40, 60, 90)) -> None:
    raw = b"".join(b"\x00" + bytes(color) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def make_verified_fixture(root: Path, n: int = 3, approved: bool = True) -> tuple[Path, Path]:
    """构造一份"已通过验收"的基线：pages + output/01..NN + manifest（review 已审）。"""
    art = root / "article"
    card = art / "_cards"
    (card / "output").mkdir(parents=True)
    pages = {"schema_version": 2, "style_mode": "editorial", "theme": "ink-classic",
             "title": "验收测试", "content": "",
             "pages": [{"no": i, "role": "cover" if i == 1 else "point",
                        "source": "html", "layout": "text-card",
                        "copy": {"title": f"页{i}", "body": "内容"}} for i in range(1, n + 1)]}
    pages_path = card / "pages.json"
    pages_path.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    pages_sha = __import__("hashlib").sha256(pages_path.read_bytes()).hexdigest()
    entries = []
    for i in range(1, n + 1):
        p = card / "output" / f"{i:02d}.png"
        make_png(p, color=(i * 30, 60, 90))
        sha = __import__("hashlib").sha256(p.read_bytes()).hexdigest()
        entries.append({"no": i, "role": "point", "source": "html", "page_kind": "layout-text",
                        "asset": f"output/{i:02d}.png", "width": 1080, "height": 1440,
                        "sha256": sha, "status": "READY",
                        "review": {"status": "APPROVED" if approved else "PENDING_REVIEW",
                                   "reviewer": "tester", "reviewed_at": "2026-11-06T00:00:00",
                                   "sha256_at_review": sha, "conclusion": None, "notes": None}})
    (card / "cards-manifest.json").write_text(json.dumps(
        {"version": 1, "generated_from_pages_sha256": pages_sha, "pages": entries},
        ensure_ascii=False, indent=1), encoding="utf-8")
    return art, pages_path


def run_verify(art: Path, pages: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HERE / "verify_cards.py"),
         "--pages", str(pages), "--cards-dir", str(art / "_cards"), *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="verify-example-"))
    try:
        # ---------- 1 基线全绿（已审 + require-approved） ----------
        art, pages = make_verified_fixture(tmp / "f1")
        r = run_verify(art, pages, "--require-approved")
        check("基线（已审）require-approved 通过", r.returncode == 0, r.stdout[-300:])
        check("输出 CARDS VERIFIED", "=== CARDS VERIFIED ===" in r.stdout)

        # ---------- 2 未审（PENDING_REVIEW）----------
        # 制作验收（非 require-approved）不检查审核状态；发布门（require-approved）才要求 APPROVED
        art2, pages2 = make_verified_fixture(tmp / "f2", approved=False)
        r = run_verify(art2, pages2)
        check("PENDING_REVIEW 非 require 时通过（制作验收不查审核）", r.returncode == 0)
        r = run_verify(art2, pages2, "--require-approved")
        check("PENDING_REVIEW require-approved FAIL", r.returncode == 1)

        # ---------- 3 缺页 ----------
        art3, pages3 = make_verified_fixture(tmp / "f3")
        (art3 / "_cards" / "output" / "02.png").unlink()
        r = run_verify(art3, pages3)
        check("缺页拒绝", r.returncode == 1 and "产物存在" in r.stdout)

        # ---------- 4 尺寸不符 ----------
        art4, pages4 = make_verified_fixture(tmp / "f4")
        make_png(art4 / "_cards" / "output" / "01.png", w=800, h=600)
        r = run_verify(art4, pages4)
        check("尺寸不符拒绝", r.returncode == 1 and "1080x1440" in r.stdout)

        # ---------- 5 重复图片 ----------
        art5, pages5 = make_verified_fixture(tmp / "f5")
        shutil.copy2(art5 / "_cards" / "output" / "01.png", art5 / "_cards" / "output" / "02.png")
        # 01/02 内容相同，但 manifest 里 sha 不同 -> manifest 一致性或重复检查必触发其一
        r = run_verify(art5, pages5)
        check("重复图片拒绝", r.returncode == 1, r.stdout[-200:])

        # ---------- 6 篡改产物（同尺寸字节变化）-> manifest 不一致 + 审核过期 ----------
        art6, pages6 = make_verified_fixture(tmp / "f6")
        make_png(art6 / "_cards" / "output" / "02.png", color=(250, 250, 250))  # 同尺寸不同内容
        r = run_verify(art6, pages6)
        check("篡改产物拒绝（manifest 不一致）", r.returncode == 1 and "一致" in r.stdout)
        r = run_verify(art6, pages6, "--require-approved")
        check("审核过期检出（require-approved）", r.returncode == 1 and "过期" in r.stdout, r.stdout[-300:])

        # ---------- 7 pages.json 变更 -> 绑定失效 ----------
        art7, pages7 = make_verified_fixture(tmp / "f7")
        pages = json.loads(pages7.read_text(encoding="utf-8"))
        pages["title"] = "改过的标题"
        pages7.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
        r = run_verify(art7, pages7)
        check("pages.json 变更 -> 绑定失效拒绝", r.returncode == 1 and "绑定" in r.stdout)

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n汇总 OK={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        return 1
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
