#!/usr/bin/env python3
"""normalize_cards_Example.py —— 规范化 + manifest + 审图记录测试（T4.1/T4.2/T4.3，零 LLM）。

覆盖：
- 三类来源规范化（html 渲染产物 / ai-image SUCCEEDED 产物）按 pages.json 顺序输出 01..NN
- manifest：顺序/SHA256/状态 READY/绑定 pages.json（generated_from_pages_sha256）
- review 初始 PENDING_REVIEW；mark_review 写入 APPROVED；normalize 幂等重跑继承审核
- 渲染源变化 -> 审核失效重置 PENDING_REVIEW
- 硬性拒绝：渲染产物缺失 / AI 状态非 SUCCEEDED / 源尺寸不符 / 重复图片
- 审图清单 review-checklist.md 生成（含页面类型审核标准）

运行：python3 normalize_cards_Example.py
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


def make_fixture(root: Path) -> tuple[Path, Path]:
    """3 页：cover(html) / screenshot(html) / ai-image；render 两页 + aigen state 一页。"""
    art = root / "article"
    card = art / "_cards"
    card.mkdir(parents=True)
    pages = {"schema_version": 2, "style_mode": "editorial", "theme": "ink-classic",
             "title": "规范化测试", "content": "",
             "pages": [
                 {"no": 1, "role": "cover", "source": "html", "layout": "cover-hook",
                  "copy": {"title": "封面", "points": ["a", "b", "c"]}},
                 {"no": 2, "role": "screenshot-evidence", "source": "html",
                  "layout": "screenshot-with-caption", "asset": "_cards/assets/shot-01.png",
                  "copy": {"title": "截图", "caption": "说明"}},
                 {"no": 3, "role": "ai-illustration", "source": "ai-image",
                  "prompt": "测试插画"},
             ]}
    (card / "pages.json").write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    make_png(card / "render" / "xhs-01.png", color=(10, 20, 30))
    make_png(card / "render" / "xhs-02.png", color=(40, 60, 90))
    make_png(card / "assets" / "ai-03.png", color=(100, 110, 120))
    aigen = {"pages": {"3": {"status": "SUCCEEDED", "asset": "_cards/assets/ai-03.png"}}}
    (card / "aigen-state.json").write_text(json.dumps(aigen, ensure_ascii=False), encoding="utf-8")
    return art, card / "pages.json"


def run_norm(art: Path, pages: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HERE / "normalize_cards.py"),
         "--pages", str(pages), "--cards-dir", str(art / "_cards")],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="norm-example-"))
    try:
        art, pages = make_fixture(tmp)
        card = art / "_cards"

        # ---------- 1 全量规范化 ----------
        r = run_norm(art, pages)
        check("规范化退出码 0", r.returncode == 0, f"rc={r.returncode} {r.stdout[-300:]}")
        for n in ("01", "02", "03"):
            check(f"output/{n}.png 存在", (card / "output" / f"{n}.png").is_file())
        manifest = json.loads((card / "cards-manifest.json").read_text(encoding="utf-8"))
        check("manifest 页序正确", [p["no"] for p in manifest["pages"]] == [1, 2, 3])
        check("manifest 状态全 READY",
              all(p["status"] == "READY" for p in manifest["pages"]))
        check("manifest 绑定 pages.json",
              bool(manifest.get("generated_from_pages_sha256")))
        check("review 初始 PENDING_REVIEW",
              all(p["review"]["status"] == "PENDING_REVIEW" for p in manifest["pages"]))
        check("manifest 记页面类型",
              [p["page_kind"] for p in manifest["pages"]] == ["layout-text", "screenshot", "ai-image"])
        checklist = (card / "review-checklist.md").read_text(encoding="utf-8")
        check("审图清单含三类标准",
              all(k in checklist for k in ("screenshot", "ai-image", "layout-text")))

        # ---------- 2 mark_review 写入 APPROVED ----------
        r = subprocess.run(
            [sys.executable, str(HERE / "mark_review.py"), "--manifest",
             str(card / "cards-manifest.json"), "--no", "1",
             "--status", "APPROVED", "--reviewer", "tester", "--notes", "OK"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        check("mark_review 退出码 0", r.returncode == 0, r.stdout[-200:])
        manifest = json.loads((card / "cards-manifest.json").read_text(encoding="utf-8"))
        rv = manifest["pages"][0]["review"]
        check("APPROVED 记录完整",
              rv["status"] == "APPROVED" and rv["reviewer"] == "tester"
              and bool(rv["sha256_at_review"]) and rv["notes"] == "OK", str(rv))

        # ---------- 3 幂等重跑：审核继承 ----------
        r = run_norm(art, pages)
        manifest = json.loads((card / "cards-manifest.json").read_text(encoding="utf-8"))
        check("重跑后 APPROVED 继承（产物未变）",
              manifest["pages"][0]["review"]["status"] == "APPROVED", str(manifest["pages"][0]["review"]))
        check("重跑 [SKIP] 幂等", "SKIP" in r.stdout)

        # ---------- 4 渲染源变化 -> 审核失效重置 ----------
        make_png(card / "render" / "xhs-01.png", color=(200, 10, 10))
        r = run_norm(art, pages)
        manifest = json.loads((card / "cards-manifest.json").read_text(encoding="utf-8"))
        check("源图变化 -> review 重置 PENDING_REVIEW",
              manifest["pages"][0]["review"]["status"] == "PENDING_REVIEW"
              and manifest["pages"][0]["sha256"] != manifest["pages"][1]["sha256"],
              str(manifest["pages"][0]["review"]))

        # ---------- 5 硬性拒绝：缺渲染产物 ----------
        art5, pages5 = make_fixture(tmp / "f5")
        (art5 / "_cards" / "render" / "xhs-02.png").unlink()
        r = run_norm(art5, pages5)
        check("缺渲染产物拒绝退出码 1", r.returncode == 1 and "缺失" in r.stdout, r.stdout[-200:])

        # ---------- 6 硬性拒绝：AI 状态非 SUCCEEDED ----------
        art6, pages6 = make_fixture(tmp / "f6")
        (art6 / "_cards" / "aigen-state.json").write_text(json.dumps(
            {"pages": {"3": {"status": "PENDING"}}}, ensure_ascii=False), encoding="utf-8")
        r = run_norm(art6, pages6)
        check("AI 未 SUCCEEDED 拒绝", r.returncode == 1 and "SUCCEEDED" in r.stdout, r.stdout[-200:])

        # ---------- 7 硬性拒绝：源尺寸不符 ----------
        art7, pages7 = make_fixture(tmp / "f7")
        make_png(art7 / "_cards" / "render" / "xhs-01.png", w=800, h=600)
        r = run_norm(art7, pages7)
        check("源尺寸不符拒绝", r.returncode == 1 and "1080x1440" in r.stdout, r.stdout[-200:])

        # ---------- 7b 失败时旧 manifest 失效保护（评审 T5 P0） ----------
        art7b, pages7b = make_fixture(tmp / "f7b")
        r = run_norm(art7b, pages7b)  # 先成功一次，manifest 在位
        check("7b 首次 normalize 后 manifest 在位",
              (art7b / "_cards" / "cards-manifest.json").is_file())
        (art7b / "_cards" / "render" / "xhs-02.png").unlink()  # 制造失败：源缺失
        r = run_norm(art7b, pages7b)
        check("7b 失败 normalize 退出码 1", r.returncode == 1)
        check("7b 失败后旧 manifest 已失效挪出",
              not (art7b / "_cards" / "cards-manifest.json").is_file())
        r = subprocess.run(
            [sys.executable, str(HERE / "verify_cards.py"),
             "--pages", str(pages7b), "--cards-dir", str(art7b / "_cards"),
             "--require-approved"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        check("7b 失败后 verify 拒绝发布", r.returncode == 1)

        # ---------- 8 硬性拒绝：重复图片 ----------
        art8, pages8 = make_fixture(tmp / "f8")
        shutil.copy2(art8 / "_cards" / "render" / "xhs-01.png",
                     art8 / "_cards" / "render" / "xhs-02.png")
        r = run_norm(art8, pages8)
        check("重复图片拒绝", r.returncode == 1 and "完全相同" in r.stdout, r.stdout[-200:])

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
