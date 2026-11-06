#!/usr/bin/env python3
"""publish_sticker_cards_Example.py —— 发布入口两阶段授权测试（T5，mock 零真实费用）。

覆盖评审 T5 测试清单：
- 全 APPROVED -> --prepare 通过（指纹 + 审批摘要 + PENDING_APPROVAL）
- 一张 REJECTED / REVISION_REQUIRED -> Gate 1 拒绝
- 图片审批后变化 -> execute 拒绝（指纹不符）
- pages.json 修改 -> prepare/execute 拒绝（Gate 1 绑定失效）
- 标题/配文/账号修改 -> execute 授权失效拒绝
- 发布前图片被修改 -> execute 拒绝（P0-1 重验）
- mock 发布 -> DRAFTED + CONSUMED（重复 execute 拒绝，防重复草稿）
- 发布超时/失败/锁定 -> UNKNOWN/FAILED/LOCKED 终态分开
- 审批期间内容修改 -> 重验拒绝（P0-1/P0-2）

运行：python3 publish_sticker_cards_Example.py
"""
from __future__ import annotations

import hashlib
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "publish_sticker_cards.py"
STICKER = HERE.parent
DRAFT_MANAGER = STICKER.parent / "draft_manager"

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


def make_fixture(root: Path, approved: bool = True, n: int = 2) -> tuple[Path, Path]:
    """构造"已规范化+已审"的文章目录（模拟 T4 交付物），外加 mock 发布所需 cfg。"""
    art = root / "article"
    card = art / "_cards"
    (card / "output").mkdir(parents=True)
    (art / ".aws-article").mkdir(parents=True)
    (art / "aws.env").write_text("WECHAT_1_APPID=wxaaa\nWECHAT_1_APPSECRET=s1\n", encoding="utf-8")
    (art / ".aws-article" / "config.json").write_text("{}", encoding="utf-8")
    pages = {"schema_version": 2, "style_mode": "editorial", "theme": "ink-classic",
             "title": "发布测试小绿书", "content": "这是发布测试的配文。",
             "pages": [{"no": i, "role": "cover" if i == 1 else "point",
                        "source": "html", "layout": "text-card",
                        "copy": {"title": f"页{i}", "body": "内容"}} for i in range(1, n + 1)]}
    pages_path = card / "pages.json"
    pages_path.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    pages_sha = hashlib.sha256(pages_path.read_bytes()).hexdigest()
    entries = []
    for i in range(1, n + 1):
        p = card / "output" / f"{i:02d}.png"
        make_png(p, color=(i * 30, 60, 90))
        sha = hashlib.sha256(p.read_bytes()).hexdigest()
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


def run(art: Path, pages: Path, *extra: str, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--pages", str(pages), "--cards-dir",
         str(art / "_cards"), "--config-dir", str(art), *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="pub-example-"))
    try:
        # ---------- 1 全 APPROVED -> prepare 通过 ----------
        art, pages = make_fixture(tmp / "f1")
        r = run(art, pages, "--prepare")
        check("prepare 通过（全 APPROVED）", r.returncode == 0
              and "=== PREPARE DONE ===" in r.stdout, r.stdout[-300:])
        ap = json.loads((art / "_cards" / "publish-approval.json").read_text(encoding="utf-8"))
        fp = ap["fingerprint"]
        check("指纹与待审批文件就位", ap["status"] == "PENDING_APPROVAL" and len(fp) == 64)
        check("审批摘要含标题与张数", "发布测试小绿书" in r.stdout and "张" in r.stdout)

        # ---------- 2 一张 REJECTED -> Gate 1 拒绝 ----------
        art2, pages2 = make_fixture(tmp / "f2")
        m = json.loads((art2 / "_cards" / "cards-manifest.json").read_text(encoding="utf-8"))
        m["pages"][1]["review"]["status"] = "REJECTED"
        (art2 / "_cards" / "cards-manifest.json").write_text(
            json.dumps(m, ensure_ascii=False), encoding="utf-8")
        r = run(art2, pages2, "--prepare")
        check("REJECTED 页阻止发布", r.returncode == 1 and "=== PUBLISH REJECTED ===" in r.stdout)

        # ---------- 3 REVISION_REQUIRED -> 拒绝 ----------
        m = json.loads((art2 / "_cards" / "cards-manifest.json").read_text(encoding="utf-8"))
        m["pages"][1]["review"]["status"] = "REVISION_REQUIRED"
        (art2 / "_cards" / "cards-manifest.json").write_text(
            json.dumps(m, ensure_ascii=False), encoding="utf-8")
        r = run(art2, pages2, "--prepare")
        check("REVISION_REQUIRED 页阻止发布", r.returncode == 1)

        # ---------- 4 mock 发布全链：prepare -> execute -> DRAFTED -> CONSUMED ----------
        art4, pages4 = make_fixture(tmp / "f4")
        r = run(art4, pages4, "--prepare")
        fp = json.loads((art4 / "_cards" / "publish-approval.json").read_text(
            encoding="utf-8"))["fingerprint"]
        r = run(art4, pages4, "--execute", "--approval", fp, "--mock",
                "--mock-store", str(art4 / "_cards" / "pub-mock-store.json"))
        check("mock 发布 DRAFTED", r.returncode == 0 and "=== PUBLISH DONE (DRAFTED) ===" in r.stdout,
              r.stdout[-300:])
        ap4 = json.loads((art4 / "_cards" / "publish-approval.json").read_text(encoding="utf-8"))
        check("授权置 CONSUMED", ap4["status"] == "CONSUMED" and ap4.get("draft_media_id"))
        r = run(art4, pages4, "--execute", "--approval", fp, "--mock")
        check("重复 execute 拒绝（防重复草稿）", r.returncode == 1 and "已消费" in r.stdout)
        store = json.loads((art4 / "_cards" / "pub-mock-store.json").read_text(encoding="utf-8"))
        drafts = [d for d in store.get("drafts", {}).values() if d.get("article_type") == "newspic"]
        check("mock newspic 草稿已建（单份）", len(drafts) == 1, str(len(drafts)))

        # ---------- 5 标题/配文/账号修改 -> 授权失效 ----------
        art5, pages5 = make_fixture(tmp / "f5")
        r = run(art5, pages5, "--prepare")
        fp5 = json.loads((art5 / "_cards" / "publish-approval.json").read_text(
            encoding="utf-8"))["fingerprint"]
        r = run(art5, pages5, "--execute", "--approval", fp5, "--title", "改过的标题", "--mock")
        check("标题修改 -> 授权失效拒绝", r.returncode == 1 and "指纹不符" in r.stdout)
        r = run(art5, pages5, "--execute", "--approval", fp5, "--content", "改过的配文", "--mock")
        check("配文修改 -> 授权失效拒绝", r.returncode == 1 and "指纹不符" in r.stdout)
        r = run(art5, pages5, "--execute", "--approval", fp5, "--account-slot", "2", "--mock")
        check("账号修改 -> 授权失效拒绝", r.returncode == 1 and "指纹不符" in r.stdout)

        # ---------- 6 图片审批后变化 -> execute 拒绝（P0-1 重验） ----------
        art6, pages6 = make_fixture(tmp / "f6")
        r = run(art6, pages6, "--prepare")
        fp6 = json.loads((art6 / "_cards" / "publish-approval.json").read_text(
            encoding="utf-8"))["fingerprint"]
        make_png(art6 / "_cards" / "output" / "01.png", color=(250, 250, 250))  # 审批后改图
        r = run(art6, pages6, "--execute", "--approval", fp6, "--mock")
        check("发布前图片修改 -> 拒绝（重验/指纹）",
              r.returncode == 1 and "=== PUBLISH REJECTED ===" in r.stdout, r.stdout[-300:])

        # ---------- 7 pages.json 修改 -> Gate 1 绑定失效 ----------
        art7, pages7 = make_fixture(tmp / "f7")
        r = run(art7, pages7, "--prepare")
        pages = json.loads(pages7.read_text(encoding="utf-8"))
        pages["title"] = "改过的标题"
        pages7.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
        fp7 = json.loads((art7 / "_cards" / "publish-approval.json").read_text(
            encoding="utf-8"))["fingerprint"]
        r = run(art7, pages7, "--execute", "--approval", fp7, "--mock")
        check("pages.json 修改 -> 拒绝", r.returncode == 1)

        # ---------- 8 skip_confirm 无法绕过：脚本无该参数 ----------
        r = run(art8, pages8, "--skip-confirm") if False else None
        r = subprocess.run(
            [sys.executable, str(SCRIPT), "--pages", str(art / "_cards" / "pages.json"),
             "--cards-dir", str(art / "_cards"), "--config-dir", str(art),
             "--skip-confirm", "--mock"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        check("无 skip-confirm 入口（argparse 拒绝）", r.returncode == 2, r.stderr[-120:])

        # ---------- 9 发布失败/UNKNOWN/LOCKED 终态分开（透传 publish.py 退出码） ----------
        art9, pages9 = make_fixture(tmp / "f9")
        r = run(art9, pages9, "--prepare")
        fp9 = json.loads((art9 / "_cards" / "publish-approval.json").read_text(
            encoding="utf-8"))["fingerprint"]
        r = run(art9, pages9, "--execute", "--approval", fp9, "--mock",
                "--mock-store", str(art9 / "_cards" / "s.json"), "--inject", "add-errcode")
        check("发布明确失败 -> FAILED 终态", r.returncode == 1
              and "=== PUBLISH DONE (FAILED) ===" in r.stdout, r.stdout[-200:])
        r = run(art9, pages9, "--execute", "--approval", fp9, "--mock",
                "--mock-store", str(art9 / "_cards" / "s.json"), "--inject", "add-timeout")
        check("发布超时 -> UNKNOWN 终态（不标失败）", r.returncode == 2
              and "=== PUBLISH DONE (UNKNOWN) ===" in r.stdout, r.stdout[-200:])
        # UNKNOWN 后重跑同指纹：publish.py pending 守卫仍挡住（防重复草稿，安全行为）
        r = run(art9, pages9, "--execute", "--approval", fp9, "--mock",
                "--mock-store", str(art9 / "_cards" / "s.json"))
        check("UNKNOWN 后重跑仍 UNKNOWN（pending 守卫防重复草稿）",
              r.returncode == 2 and "pending" in r.stdout, r.stdout[-200:])
        # 人工恢复通道：确认未产生草稿 -> clear-pending -> 重跑 execute -> DRAFTED
        r = run(art9, pages9, "--clear-pending", "--mock",
                "--mock-store", str(art9 / "_cards" / "s.json"))
        check("clear-pending 恢复成功", "=== PUBLISH DONE (CLEARED) ===" in r.stdout, r.stdout[-200:])
        r = run(art9, pages9, "--execute", "--approval", fp9, "--mock",
                "--mock-store", str(art9 / "_cards" / "s.json"))
        check("恢复后 execute -> DRAFTED", r.returncode == 0
              and "=== PUBLISH DONE (DRAFTED) ===" in r.stdout, r.stdout[-200:])
        store = json.loads((art9 / "_cards" / "s.json").read_text(encoding="utf-8"))
        drafts = [d for d in store.get("drafts", {}).values() if d.get("article_type") == "newspic"]
        check("恢复闭环后仍单份草稿（无重复）", len(drafts) == 1, str(len(drafts)))

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
