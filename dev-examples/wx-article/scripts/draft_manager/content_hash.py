#!/usr/bin/env python3
"""contentHash 计算与内容快照（需求文档 V1.2 第 4.4 节）。

契约：
- contentHash = SHA256(正文 + 引用图片(按引用顺序) + 封面 + 元数据 + HTML转换规则版本 + 目标账号appid)，
  各输入项以固定顺序、UTF-8、NUL 分隔拼接，无变化必得同 Hash
- 快照：prepare 启动时把正文/引用图/封面复制到文章目录 .publish_snapshot/，
  Hash 计算与后续上传都基于快照文件；提交前若现文件 Hash != 快照 Hash 说明内容被并发修改，中止
- 引用图片解析：正文 ![](relpath) 按首次出现顺序，去重
"""
from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path

# HTML 转换规则版本：转换逻辑（publish.py convert_md）变更时递增，使旧草稿自动失效
HTML_RULE_VERSION = "2"

IMG_REF = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def image_refs(md_text: str) -> list[str]:
    """正文图片引用，按首次出现顺序去重（本地相对路径，跳过 http）。"""
    refs: list[str] = []
    for m in IMG_REF.finditer(md_text):
        ref = m.group(1).strip()
        if ref.startswith("http://") or ref.startswith("https://"):
            continue
        if ref not in refs:
            refs.append(ref)
    return refs


def compute_content_hash(
    md_bytes: bytes,
    image_files: list[Path],
    cover_file: Path,
    title: str,
    digest: str,
    author: str,
    appid: str,
) -> str:
    """稳定序列化拼接后取 SHA256。任一输入变化 => Hash 变化；无变化 => 同 Hash。"""
    h = hashlib.sha256()
    parts: list[bytes] = [b"md", md_bytes]
    for img in image_files:
        parts.append(b"img")
        parts.append(img.name.encode("utf-8"))
        parts.append(img.read_bytes())
    parts.append(b"cover")
    parts.append(cover_file.read_bytes())
    parts.append(b"meta")
    parts.append((title + "\x00" + digest + "\x00" + author).encode("utf-8"))
    parts.append(b"htmlver")
    parts.append(HTML_RULE_VERSION.encode("utf-8"))
    parts.append(b"appid")
    parts.append(appid.encode("utf-8"))
    for p in parts:
        h.update(p)
        h.update(b"\x00")  # 明确分隔符，防拼接歧义
    return h.hexdigest()


def make_snapshot(article_dir: Path, md_path: Path, cover_path: Path, html_text: str) -> dict:
    """把本轮发布内容固化到 .publish_snapshot/，返回快照上下文。

    后续上传与 Hash 都只读快照目录；成功结束后调用方负责 cleanup_snapshot。
    """
    snap = article_dir / ".publish_snapshot"
    if snap.exists():
        shutil.rmtree(snap)
    snap.mkdir(parents=True)
    md_bytes = md_path.read_bytes()
    (snap / "content.md").write_bytes(md_bytes)
    (snap / "content.html").write_text(html_text, encoding="utf-8")
    md_text = md_bytes.decode("utf-8-sig")
    copied_imgs: list[Path] = []
    for i, ref in enumerate(image_refs(md_text)):
        src = (article_dir / ref.replace("\\", "/")).resolve()
        if not src.is_file():
            raise FileNotFoundError(f"image ref not found: {ref}")
        dst = snap / f"img_{i:03d}{src.suffix.lower()}"
        shutil.copy2(src, dst)
        copied_imgs.append(dst)
    cover_dst = snap / f"cover{cover_path.suffix.lower()}"
    shutil.copy2(cover_path, cover_dst)
    return {
        "dir": snap,
        "md_bytes": md_bytes,
        "images": copied_imgs,
        "cover": cover_dst,
        # 原始相对引用顺序（与 copied_imgs 下标一一对应，上传后替换 HTML 用）
        "refs": image_refs(md_text),
    }


def snapshot_matches_disk(article_dir: Path, md_path: Path, cover_path: Path, snap: dict) -> bool:
    """提交前核对：正文与封面自快照后未被并发修改（图片由 refs 对应核对）。"""
    if md_path.read_bytes() != snap["md_bytes"]:
        return False
    if cover_path.read_bytes() != snap["cover"].read_bytes():
        return False
    md_text = snap["md_bytes"].decode("utf-8-sig")
    for ref, img_snap in zip(snap["refs"], snap["images"]):
        src = (article_dir / ref.replace("\\", "/")).resolve()
        if not src.is_file() or src.read_bytes() != img_snap.read_bytes():
            return False
    return True


def cleanup_snapshot(article_dir: Path) -> None:
    snap = article_dir / ".publish_snapshot"
    if snap.exists():
        shutil.rmtree(snap, ignore_errors=True)
