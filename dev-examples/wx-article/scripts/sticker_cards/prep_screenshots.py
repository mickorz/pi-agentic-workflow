#!/usr/bin/env python3
"""prep_screenshots.py —— 截图预处理：尺寸/方向/分类/告警/重复检测（T2.1~T2.4，零 LLM）。

扫描 _cards/assets/ 下图片，产出 shots-report.json 指导规划审批（用户据此确认裁切区域）。
标准库实现，不引入 Pillow（评审 T2 约定）。

报告字段（评审锁定）：
  file / format / bytes / sha256
  original{width,height}  存储尺寸
  display{width,height}   按 EXIF Orientation 换算后的显示尺寸
  exif_orientation / aspect_ratio(显示宽高比,4 位小数) / category(landscape|portrait|square)
  duplicate_of            重复图片（SHA256 相同）时指向首个文件
  warnings[]              告警（过小不可读/竖图进横框/超长图/超大文件/格式不受支持/重复）
  recommendation{fit, crop_required}
  approval_required       true = 必须在规划审批门人工确认（裁切或换图）

告警与建议规则（阈值定案，V1.1 D8 扩展）：
  - 显示宽 < 720px：文字缩放后可能不可读 -> approval_required
  - portrait 图进 4:3 横图框会显著缩小 -> 建议人工裁横局部或换竖版组件(P1) -> crop_required + approval_required
  - landscape 且宽高比 > 2.2（超宽，典型整页网页截图）：建议人工裁切突出局部 -> crop_required + approval_required
  - 显示高/宽 > 3：超长图 -> 建议 contain 全含
  - 文件 > 5MB：超微信素材建议值
  - 不受支持格式（webp/gif 等）：仅告警，尺寸字段留空

CLI：
  python3 prep_screenshots.py --assets-dir <_cards/assets> --out <shots-report.json>
输出契约：逐文件 [OK]/[WARN]/[FAIL]；全部可解析则 "=== ALL DONE ===" 退出码 0
（单张解析失败不阻塞整体，记 FAIL 行但退出码仍 0？——定案：存在解析失败即退出码 1，
让上游显式处理；空目录输出空报告退出码 0）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_dims import dims  # noqa: E402

SUPPORTED = {".png", ".jpg", ".jpeg"}
MIN_WIDTH = 720          # 低于此宽文字缩放后可能不可读
MAX_FILE_BYTES = 5 * 1024 * 1024
VERY_TALL_RATIO = 3.0    # display 高/宽 超过此值视为超长图
WIDE_RATIO = 2.2         # 宽高比超过此值建议人工裁切突出局部
WELL_ASPECT = 4 / 3      # 截图组件图框宽高比（T1 定案 4:3）


def classify(aspect: float) -> str:
    if aspect >= 1.2:
        return "landscape"
    if aspect <= 1 / 1.2:
        return "portrait"
    return "square"


def analyze_file(p: Path, sha_seen: dict[str, str]) -> dict:
    """单文件分析。解析失败抛异常由调用方捕获。"""
    raw = p.read_bytes()
    info = dims(p)
    dw, dh = info["display"]["width"], info["display"]["height"]
    aspect = round(dw / dh, 4) if dh else 0.0
    category = classify(aspect) if dh else "unknown"
    sha = hashlib.sha256(raw).hexdigest()

    warnings: list[str] = []
    rec = {"fit": "contain", "crop_required": False}
    approval = False

    if dw < MIN_WIDTH:
        warnings.append(f"宽 {dw}px < {MIN_WIDTH}px，文字缩放后可能不可读，建议换高清图或放大局部")
        approval = True
    if category == "portrait":
        warnings.append("竖图在 4:3 横图框中会显著缩小；建议人工裁横局部（manual-crop）或后续换竖版组件(P1)")
        rec["crop_required"] = True
        approval = True
    elif category == "landscape" and aspect > WIDE_RATIO:
        warnings.append(f"宽高比 {aspect} > {WIDE_RATIO}，疑似整页网页截图；建议人工裁切突出局部（如去掉地址栏）")
        rec["crop_required"] = True
        approval = True
    if aspect and (dh / dw) > VERY_TALL_RATIO:
        warnings.append("超长图，建议 contain 完整展示（manual-crop 会丢失大部分内容）")
    if len(raw) > MAX_FILE_BYTES:
        warnings.append(f"文件 {len(raw)} 字节 > {MAX_FILE_BYTES}，超微信素材建议值")
    dup = sha_seen.get(sha)
    if dup:
        warnings.append(f"与 {dup} 内容完全相同（SHA256 一致），疑似重复上传")
        rec["crop_required"] = False
    sha_seen.setdefault(sha, p.name)

    return {
        "file": p.name,
        "format": info["format"],
        "bytes": len(raw),
        "sha256": sha[:16],
        "original": info["original"],
        "display": info["display"],
        "exif_orientation": info["orientation"],
        "aspect_ratio": aspect,
        "category": category,
        "duplicate_of": dup,
        "warnings": warnings,
        "recommendation": rec,
        "approval_required": approval,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    assets = Path(args.assets_dir)
    if not assets.is_dir():
        print(f"[FAIL] assets dir not found: {assets}")
        return 1

    files = sorted(p for p in assets.iterdir()
                   if p.is_file() and p.suffix.lower() in (SUPPORTED | {".webp", ".gif"}))
    sha_seen: dict[str, str] = {}
    report: list[dict] = []
    hard_fail = False
    for p in files:
        if p.suffix.lower() not in SUPPORTED:
            print(f"[WARN] {p.name}: 格式 {p.suffix} 不受 P0 预处理支持（仅 png/jpg/jpeg）")
            report.append({"file": p.name, "format": p.suffix.lstrip("."),
                           "warnings": ["格式不受 P0 预处理支持"], "approval_required": True})
            continue
        try:
            item = analyze_file(p, sha_seen)
        except ValueError as e:
            print(f"[FAIL] {p.name}: {e}")
            report.append({"file": p.name, "warnings": [f"解析失败: {e}"], "approval_required": True})
            hard_fail = True
            continue
        line = "[OK]" if not item["warnings"] else "[WARN]"
        print(f"{line} {p.name}: {item['display']['width']}x{item['display']['height']} "
              f"{item['category']} (orientation={item['exif_orientation']})"
              + (f" DUP of {item['duplicate_of']}" if item["duplicate_of"] else "")
              + (" [需人工确认]" if item["approval_required"] else ""))
        report.append(item)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"assets_dir": str(assets), "shots": report},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    n_approval = sum(1 for r in report if r.get("approval_required"))
    print(f"[OK] report -> {out}（{len(report)} 张，{n_approval} 张需规划门人工确认）")
    if hard_fail:
        print("=== PREP FAILED（存在解析失败） ===")
        return 1
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
