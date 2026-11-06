#!/usr/bin/env python3
"""prep_screenshots_Example.py —— 截图预处理测试（T2.1~T2.4，零 LLM，可重复）。

覆盖：
- PNG IHDR 解析（真实 fixture 900x1200）
- JPEG 基线 SOF0 / 渐进式 SOF2 解析（手工构造最小合法 JPEG 字节流）
- EXIF Orientation：1=原向；6=旋转90 显示宽高互换；3=180 不换向（评审 P0 锁定项）
- 分类（landscape/portrait/square）与告警（过小/竖图进横框/超宽/超长/超大文件）
- 重复图片检测（SHA256）
- CLI 全链：报告落盘、approval_required 统计、解析失败退出码 1

运行：python3 prep_screenshots_Example.py
"""
from __future__ import annotations

import copy
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from image_dims import dims  # noqa: E402
from prep_screenshots import classify  # noqa: E402

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


def make_jpeg(path: Path, w: int, h: int, orientation: int | None = None,
              progressive: bool = False) -> None:
    """手工构造最小合法 JPEG（段结构完整，扫描数据留空）——解析器只需段头。"""
    out = bytearray(b"\xff\xd8")
    if orientation:
        tiff = (b"MM\x00\x2a" + struct.pack(">I", 8)          # TIFF 头(MM 大端) + IFD0 偏移
                + struct.pack(">H", 1)                        # IFD0 entry 数
                + struct.pack(">HHI", 0x0112, 3, 1)           # tag=Orientation type=SHORT count=1
                + struct.pack(">H", orientation) + b"\x00\x00")
        payload = b"Exif\x00\x00" + tiff
        out += b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    dqt = bytes([0]) + bytes(64)
    out += b"\xff\xdb" + struct.pack(">H", len(dqt) + 2) + dqt
    sof_marker = b"\xff\xc2" if progressive else b"\xff\xc0"  # C2=渐进式
    sof = bytes([8]) + struct.pack(">HH", h, w) + bytes([1, 1, 0x11, 0])
    out += sof_marker + struct.pack(">H", len(sof) + 2) + sof
    sos = bytes([1, 1, 0x00, 0, 0, 0])
    out += b"\xff\xda" + struct.pack(">H", len(sos) + 2) + sos + b"\x00\xff\xd9"
    path.write_bytes(bytes(out))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="prep-example-"))
    try:
        # --- T2.1 PNG IHDR（真实 fixture） ---
        info = dims(HERE / "fixtures" / "_cards" / "assets" / "shot-01.png")
        check("PNG 900x1200 解析", info["original"] == {"width": 900, "height": 1200}, str(info))
        check("PNG display==original", info["display"] == info["original"])

        # --- T2.1/T2.2 JPEG 基线 + 渐进式 + EXIF ---
        make_jpeg(tmp / "land.jpg", 1920, 1080)  # 无 EXIF
        info = dims(tmp / "land.jpg")
        check("JPEG SOF0 基线解析 1920x1080",
              info["original"] == {"width": 1920, "height": 1080} and info["orientation"] == 1, str(info))
        check("JPEG landscape 显示不换向", info["display"] == {"width": 1920, "height": 1080})

        make_jpeg(tmp / "prog.jpg", 1920, 1080, progressive=True)
        info = dims(tmp / "prog.jpg")
        check("JPEG 渐进式 SOF2 解析", info["original"]["width"] == 1920, str(info))

        make_jpeg(tmp / "phone6.jpg", 1920, 1080, orientation=6)
        info = dims(tmp / "phone6.jpg")
        check("JPEG orientation=6 显示宽高互换（竖拍横存场景）",
              info["orientation"] == 6 and info["display"] == {"width": 1080, "height": 1920}, str(info))

        make_jpeg(tmp / "phone3.jpg", 1920, 1080, orientation=3)
        info = dims(tmp / "phone3.jpg")
        check("JPEG orientation=3 显示不换向",
              info["display"] == {"width": 1920, "height": 1080} and info["orientation"] == 3, str(info))

        make_jpeg(tmp / "phone8.jpg", 1920, 1080, orientation=8)
        check("JPEG orientation=8 显示宽高互换",
              dims(tmp / "phone8.jpg")["display"] == {"width": 1080, "height": 1920})

        # --- T2.3 分类 ---
        check("分类 landscape", classify(1.7778) == "landscape")
        check("分类 portrait", classify(0.75) == "portrait")
        check("分类 square", classify(1.0) == "square")

        # --- T2.3/T2.4 报告：告警 + 重复检测（全链 CLI） ---
        assets = tmp / "assets"
        assets.mkdir()
        make_jpeg(assets / "phone.jpg", 1920, 1080, orientation=6)     # portrait -> approval
        shutil_copy = (HERE / "fixtures" / "_cards" / "assets" / "shot-01.png").read_bytes()
        (assets / "dup-a.png").write_bytes(shutil_copy)
        (assets / "dup-b.png").write_bytes(shutil_copy)                # 与 dup-a 完全相同
        (assets / "wide.png").write_bytes((HERE / "fixtures" / "_cards" / "assets" / "wide-2400x1000.png").read_bytes())
        (assets / "tiny.png").write_bytes(bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201f34a24d50000000049454e44ae426082"))
        (assets / "bad.png").write_bytes(b"not a png")
        (assets / "anim.gif").write_bytes(b"GIF89a")                   # 不支持格式告警

        report_path = tmp / "shots-report.json"
        r = subprocess.run(
            [sys.executable, str(HERE / "prep_screenshots.py"),
             "--assets-dir", str(assets), "--out", str(report_path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        check("CLI 解析失败退出码 1（bad.png）", r.returncode == 1, f"rc={r.returncode} {r.stdout[-300:]}")
        check("CLI 输出 ALL DONE 不出现（有 FAIL 时）", "=== ALL DONE ===" not in r.stdout)

        rep = json.loads(report_path.read_text(encoding="utf-8"))
        by = {s["file"]: s for s in rep["shots"]}
        phone = by["phone.jpg"]
        check("phone.jpg portrait + approval_required",
              phone["category"] == "portrait" and phone["approval_required"], str(phone))
        check("phone.jpg display 1080x1920（EXIF 换算）",
              phone["display"] == {"width": 1080, "height": 1920})
        dups = [s for s in rep["shots"] if s.get("duplicate_of")]
        check("重复图片检出 dup-b -> dup-a",
              len(dups) == 1 and dups[0]["file"] == "dup-b.png" and dups[0]["duplicate_of"] == "dup-a.png",
              str([(s["file"], s.get("duplicate_of")) for s in rep["shots"]]))
        tiny = by["tiny.png"]
        check("过小图 approval_required + 不可读告警",
              tiny["approval_required"] and any("不可读" in w for w in tiny["warnings"]), str(tiny))
        wide = by["wide.png"]
        check("超宽图 crop_required + approval_required",
              wide["recommendation"]["crop_required"] and wide["approval_required"], str(wide))
        check("anim.gif 格式告警", any("不受" in w for w in by["anim.gif"]["warnings"]))
        check("bad.png 解析失败记录", any("解析失败" in w for w in by["bad.png"]["warnings"]))

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
