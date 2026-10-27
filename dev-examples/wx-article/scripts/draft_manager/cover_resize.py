#!/usr/bin/env python3
"""封面 2.35:1 保障（2026-10-27 经验：微信 draft_add errcode 53401 要求精确 2.35:1）。

策略（ensure_cover_235，确定性、零 LLM、纯标准库）：
  - PNG（8-bit RGB/RGBA、非隔行）：读 IHDR 判断比例
      * 比例接近 2.35（|ratio-2.35| <= near_eps，即"本想做 2.35 只是没对齐"）
        -> 备份原图到 backup_dir，纯 Python 盒式滤波等比缩放到精确 47k × 20k
           （k = min(floor(W/47), floor(H/20))，只降不升；1880×800 属典型落点）
      * 比例明显偏离（如 16:9 / 1:1）-> 不动图（自动裁剪/拉伸会破坏构图），
         返回 warn（历史 16:9 曾通过微信，仅提示风险）
  - JPG/JPEG/WEBP/GIF：无标准库解码器，返回 warn（按原样上传，53401 时人工处理）
  - 原图已是精确 2.35 -> skip（幂等）

返回 dict(action, msg)：action in {"skip", "resized", "warn", "error"}；error 仅当文件不可读。
本模块可被 publish.py 复用；也可独立 CLI 验证：
  python3 cover_resize.py --cover <png路径> [--dry-run]
"""
from __future__ import annotations

import argparse
import shutil
import struct
import sys
import zlib
from pathlib import Path
from typing import List, Optional, Tuple

TARGET_NUM, TARGET_DEN = 47, 20  # 2.35 = 47/20，整数像素下唯一精确表示
NEAR_EPS = 0.01  # 比例偏差 <=1% 视为"意图 2.35 只是没对齐"，自动缩放


def read_png_size(path: Path) -> Optional[Tuple[int, int]]:
    """读 PNG IHDR（只读前 33 字节）。非 PNG / 损坏 -> None。"""
    try:
        with open(path, "rb") as f:
            head = f.read(33)
        if len(head) < 33 or head[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        if head[12:16] != b"IHDR":
            return None
        w, h = struct.unpack(">II", head[16:24])
        return int(w), int(h)
    except OSError:
        return None


def _ratio(w: int, h: int) -> float:
    return w / h if h else 0.0


def is_exact_235(w: int, h: int) -> bool:
    return w * TARGET_DEN == h * TARGET_NUM


# ---------------- 纯标准库 PNG 读取/写入（8-bit truecolor + alpha，非隔行） ----------------

def _png_decode(path: Path) -> Optional[Tuple[int, int, int, List[bytes]]]:
    """返回 (w, h, bpp_row_bytes, 未滤波的每行原始字节 list[bytes])。不支持的色彩类型 -> None。"""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, idat, w = 8, [], 0
    h = bd = ct = 0
    while pos + 8 <= len(data):
        length, ctype = struct.unpack(">I", data[pos:pos + 4])[0], data[pos + 4:pos + 8]
        chunk = data[pos + 8: pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", chunk[:10])
        elif ctype == b"IDAT":
            idat.append(chunk)
        elif ctype == b"IEND":
            break
    if bd != 8 or ct not in (2, 6) or not idat:
        return None  # 仅支持 8-bit RGB(2)/RGBA(6)
    nch = 3 if ct == 2 else 4
    stride = w * nch
    raw = zlib.decompress(b"".join(idat))
    rows: List[bytes] = []
    prev = bytearray(stride)
    p = 0
    for _ in range(h):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ft == 1:  # Sub
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 0xFF
        elif ft == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:  # Average
            for i in range(stride):
                left = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ft == 4:  # Paeth
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(bytes(line))
        prev = line
    return w, h, nch, rows


def _png_encode(w: int, h: int, nch: int, rows: List[bytes]) -> bytes:
    """滤波类型全 0（None）重编码（体积略大，正确性优先）。"""
    ct = 2 if nch == 3 else 6
    out = bytearray(b"\x89PNG\r\n\x1a\n")

    def chunk(ctype: bytes, body: bytes) -> None:
        out.extend(struct.pack(">I", len(body)))
        out.extend(ctype)
        out.extend(body)
        out.extend(struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF))

    chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0))
    raw = bytearray()
    for line in rows:
        raw.append(0)
        raw.extend(line)
    chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    chunk(b"IEND", b"")
    return bytes(out)


def _resample_rows(rows: List[bytes], w: int, nch: int, tw: int) -> List[bytes]:
    """水平方向盒式滤波降到 tw 像素（浮点累加，RGBA/RGB 逐通道）。"""
    out = []
    for line in rows:
        nl = bytearray(tw * nch)
        for x in range(tw):
            x0, x1 = x * w / tw, (x + 1) * w / tw
            i0, acc = int(x0), [0.0] * nch
            cnt = 0
            while i0 < x1:
                wx = min(i0 + 1.0, x1) - max(i0, x0)
                base = i0 * nch
                for c in range(nch):
                    acc[c] += line[base + c] * wx
                cnt += 0  # 权重归一在下方统一除以 (x1-x0)
                i0 += 1
            span = x1 - x0
            for c in range(nch):
                nl[x * nch + c] = int(acc[c] / span + 0.5) & 0xFF
        out.append(bytes(nl))
    return out


def _resample_cols(rows: List[bytes], h: int, nch: int, th: int, w: int) -> List[bytes]:
    """垂直方向盒式滤波降到 th 行。"""
    out = []
    for y in range(th):
        y0, y1 = y * h / th, (y + 1) * h / th
        i0 = int(y0)
        acc = [0.0] * (w * nch)
        while i0 < y1:
            wy = min(i0 + 1.0, y1) - max(i0, y0)
            line = rows[i0]
            for i in range(w * nch):
                acc[i] += line[i] * wy
            i0 += 1
        span = y1 - y0
        out.append(bytes(int(v / span + 0.5) & 0xFF for v in acc))
    return out


def resize_png_exact_235(path: Path) -> Tuple[bool, str]:
    """PNG 等比缩放到精确 47k×20k（只降不升）。成功返回 (True, 'WxH->W'xH'')。"""
    dec = _png_decode(path)
    if dec is None:
        return False, "仅支持 8-bit RGB/RGBA 非隔行 PNG"
    w, h, nch, rows = dec
    k = min(w // TARGET_NUM, h // TARGET_DEN)
    if k < 1:
        return False, f"图过小（{w}x{h}），无法降到精确 2.35:1"
    tw, th = TARGET_NUM * k, TARGET_DEN * k
    if tw == w and th == h:
        return True, f"{w}x{h}（已是精确 2.35:1）"
    rows = _resample_rows(rows, w, nch, tw)
    rows = _resample_cols(rows, h, nch, th, tw)
    path.write_bytes(_png_encode(tw, th, nch, rows))
    return True, f"{w}x{h} -> {tw}x{th}"


# ---------------- 对外入口 ----------------

def ensure_cover_235(path: Path, backup_dir: Optional[Path] = None) -> dict:
    """确保封面精确 2.35:1（详见模块 docstring 策略）。"""
    if not path.is_file():
        return {"action": "error", "msg": f"封面不存在: {path}"}
    size = read_png_size(path)
    if size is None:
        return {"action": "warn",
                "msg": f"封面 {path.name} 非 PNG（或损坏），跳过 2.35:1 自动保障，按原样上传"}
    w, h = size
    if is_exact_235(w, h):
        return {"action": "skip", "msg": f"{w}x{h} 精确 2.35:1"}
    ratio = _ratio(w, h)
    if abs(ratio - TARGET_NUM / TARGET_DEN) > NEAR_EPS:
        return {"action": "warn",
                "msg": f"封面 {path.name} 比例 {ratio:.3f} 明显偏离 2.35:1（不自动裁剪/拉伸，"
                       f"如遇 53401 需提供 1880x800 类精确封面）"}
    # 接近 2.35：备份 + 等比缩放
    if backup_dir is not None:
        backup_dir.mkdir(parents=True, exist_ok=True)
        bak = backup_dir / f"{path.stem}-original-{w}x{h}{path.suffix}"
        if not bak.exists():
            shutil.copy2(path, bak)
    ok, detail = resize_png_exact_235(path)
    if not ok:
        return {"action": "warn", "msg": f"封面自动缩放失败（{detail}），按原样上传"}
    return {"action": "resized", "msg": f"封面已缩放到精确 2.35:1: {detail}（原图备份于 {backup_dir}）"}


def main() -> int:
    ap = argparse.ArgumentParser(description="封面精确 2.35:1 保障（独立验证入口）")
    ap.add_argument("--cover", required=True)
    ap.add_argument("--backup-dir", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    p = Path(args.cover).expanduser().resolve()
    if args.dry_run:
        size = read_png_size(p)
        if size is None:
            print(f"[WARN] 非 PNG: {p}")
            return 0
        w, h = size
        print(f"[OK] {p.name} {w}x{h} ratio={_ratio(w, h):.4f} exact_235={is_exact_235(w, h)}")
        return 0
    r = ensure_cover_235(p, Path(args.backup_dir) if args.backup_dir else p.parent / "_cover-original")
    tag = {"skip": "[OK]", "resized": "[OK]", "warn": "[WARN]", "error": "[FAIL]"}[r["action"]]
    print(f"{tag} {r['msg']}")
    return 0 if r["action"] != "error" else 1


if __name__ == "__main__":
    sys.exit(main())
