#!/usr/bin/env python3
"""image_dims.py —— 图片尺寸与方向解析（标准库，零第三方依赖）。

供 prep_screenshots.py（预处理报告）与 build_html.py（manual-crop 变换计算）共用。

契约（2026-11-05 T2 评审锁定）：
- PNG：读 IHDR 宽高；无方向概念，display == original
- JPEG：遍历段（兼容基线 SOF0/SOF1 与渐进式 SOF2 及 SOF3~SOF15 系），读 (height, width)
- JPEG EXIF Orientation（APP1 "Exif" + TIFF IFD0 tag 0x0112）：
    1~2 不换向；3~4 旋转 180；5~8 旋转 90（宽高互换）。display 必须按 orientation 换算，
    不能只看 SOF 存储尺寸（手机竖拍常横向存储，评审 P0 锁定项）
- 解析失败抛 ValueError（上层显式处理，不静默假尺寸）
"""
from __future__ import annotations

import struct
from pathlib import Path

PNG_SIG = b"\x89PNG\r\n\x1a\n"
# SOF 系 marker（携带图像尺寸的帧头）：基线/扩展/渐进/无损等，跳过 DHT(C4)、JPG(C8)、DAC(CC)
SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
EXIF_ORIENTATION_TAG = 0x0112


def png_dims(path: Path) -> tuple[int, int]:
    """PNG IHDR 宽高。"""
    head = path.read_bytes()[:33]
    if head[:8] != PNG_SIG or head[12:16] != b"IHDR":
        raise ValueError(f"not a valid PNG: {path.name}")
    w, h = struct.unpack(">II", head[16:24])
    return w, h


def jpeg_dims_and_orientation(path: Path) -> tuple[int, int, int]:
    """JPEG (width, height, exif_orientation)。段遍历兼容渐进式；EXIF 取 IFD0 tag 0x0112。"""
    data = path.read_bytes()
    if data[:2] != b"\xff\xd8":
        raise ValueError(f"not a valid JPEG (missing SOI): {path.name}")
    i = 2
    size: tuple[int, int] | None = None
    orientation = 1
    n = len(data)
    while i + 1 < n:
        if data[i] != 0xFF:
            raise ValueError(f"JPEG marker misaligned at {i}: {path.name}")
        marker = data[i + 1]
        if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
            i += 2  # 无载荷 marker
            continue
        if marker == 0xD9 or marker == 0xDA:
            break  # EOI / SOS（扫描数据开始，尺寸与 EXIF 应已取得）
        if i + 3 >= n:
            raise ValueError(f"JPEG truncated before segment payload: {path.name}")
        seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
        if seg_len < 2:
            raise ValueError(f"JPEG segment length < 2 at {i}: {path.name}")
        payload = data[i + 4:i + 2 + seg_len]
        if marker in SOF_MARKERS and size is None:
            # 载荷：precision(1) + height(2) + width(2) + ...
            h, w = struct.unpack(">HH", payload[1:5])
            size = (w, h)
        elif marker == 0xE1 and payload[:6] == b"Exif\x00\x00" and orientation == 1:
            orientation = _exif_orientation(payload[6:]) or 1
        if size is not None and (marker in SOF_MARKERS):
            return size[0], size[1], orientation
        i += 2 + seg_len
    if size is None:
        raise ValueError(f"JPEG SOF not found (尺寸未取得): {path.name}")
    return size[0], size[1], orientation


def _exif_orientation(tiff: bytes) -> int | None:
    """TIFF 头 -> IFD0 -> tag 0x0112（SHORT，value 内联）。"""
    if len(tiff) < 8:
        return None
    endian = tiff[:2]
    if endian == b"II":
        e = "<"
    elif endian == b"MM":
        e = ">"
    else:
        return None
    ifd0_off = struct.unpack(e + "I", tiff[4:8])[0]
    if ifd0_off + 2 > len(tiff):
        return None
    (count,) = struct.unpack_from(e + "H", tiff, ifd0_off)
    off = ifd0_off + 2
    for _ in range(count):
        if off + 12 > len(tiff):
            return None
        tag, typ, cnt = struct.unpack_from(e + "HHI", tiff, off)
        if tag == EXIF_ORIENTATION_TAG and typ == 3 and cnt >= 1:
            (val,) = struct.unpack_from(e + "H", tiff, off + 8)
            return val if 1 <= val <= 8 else None
        off += 12
    return None


def dims(path: Path) -> dict:
    """统一入口：返回 {format, original:{width,height}, orientation, display:{width,height}}。"""
    suffix = path.suffix.lower()
    if suffix == ".png":
        w, h = png_dims(path)
        return {"format": "png", "original": {"width": w, "height": h},
                "orientation": 1, "display": {"width": w, "height": h}}
    if suffix in (".jpg", ".jpeg"):
        w, h, ori = jpeg_dims_and_orientation(path)
        # 5~8：存储方向与显示方向差 90°，显示宽高互换（评审 P0 锁定项）
        dw, dh = (h, w) if ori in (5, 6, 7, 8) else (w, h)
        return {"format": "jpeg", "original": {"width": w, "height": h},
                "orientation": ori, "display": {"width": dw, "height": dh}}
    raise ValueError(f"unsupported image format for dims: {suffix} ({path.name})")
