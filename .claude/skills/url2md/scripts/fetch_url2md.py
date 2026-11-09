#!/usr/bin/env python3
"""fetch_url2md.py —— 网页文章转 Markdown 并下载全部图片（标准库实现，零依赖）。

用法：
  python3 fetch_url2md.py --url <URL> --out-dir <目标目录> [--title 覆盖标题]
      [--img-subdir imgs] [--max-images 30]

输出：
  <out-dir>/<slug>.md        正文 Markdown（frontmatter 含 source/collected；图片指向本地 imgs/）
  <out-dir>/<img-subdir>/img-NN.<ext>   图片（按正文出现顺序编号）

处理逻辑（来自 2026-11-06 Anthropic 研究长文实测沉淀）：
  1. 下载 HTML（UA 头防拒）
  2. 正文容器：优先 <article>，fallback 全页；剔除 script/style/nav/footer/header
  3. 图片：<img src> -> Next.js 代理（/_next/image?url=）解码原图 URL -> 去重 ->
     下载（magic bytes 校验 PNG/JPEG，<5KB 视为装饰图跳过）-> imgs/img-NN.<ext>
  4. Markdown 转换：h1-h3 / li / img 标签替换为本地引用 / 段落分隔
  5. 起止裁剪：起点=首个标题行或含文章主关键词行；结尾=页脚关键词
     （related content / subscribe / cookie / sign in / join the discussion）
  6. 自检：图片引用数 / 本地文件存在 / MISSING 计数 / 残留 HTML 标签

输出契约：逐图 [OK]/[SKIP]/[FAIL]；结尾 [OK] 自检通过 -> "=== ALL DONE ===" 退出码 0；
  存在 MISSING 引用 -> "=== DONE WITH MISSING ===" 退出码 1。
"""
from __future__ import annotations

import argparse
import html as html_mod
import json
import os
import re
import sys
import time
import shutil
import urllib.request
from pathlib import Path
from urllib.parse import unquote

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
MIN_IMG_BYTES = 5000
FOOTER_KEYWORDS = ("related content", "subscribe", "cookie", "sign in",
                   "join the discussion", "was this page helpful")


def fetch(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def strip_tags(s: str) -> str:
    return html_mod.unescape(re.sub(r"<[^>]+>", "", s))


def slugify(title: str) -> str:
    """标题 -> 安全文件名（保留中英文/数字，空格转 -，剔除其余）。"""
    s = re.sub(r"[\\/:*?\"<>|]+", " ", title)
    s = re.sub(r"\s+", "-", s.strip()).strip("-.")
    return s[:80] or "page"


def zh_ratio(text: str) -> float:
    """中文字符（含中日韩）占全部字母类字符的比例。"""
    cjk = len(re.findall(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", text))
    letters = len(re.findall(r"[A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", text))
    return cjk / letters if letters else 0.0


def extract_images(raw: str) -> list[str]:
    """按出现顺序提取去重后的原图 URL（解码 Next.js 代理）。"""
    urls: list[str] = []
    for src in re.findall(r'<img[^>]+src="([^"]+)"', raw):
        u = unquote(html_mod.unescape(src))
        m = re.search(r"url=([^&]+)", u)
        if m:
            u = unquote(m.group(1))
        if u.startswith("http") and u not in urls:
            urls.append(u)
    return urls


def download_images(urls: list[str], img_dir: Path, max_images: int) -> dict[str, Path]:
    """下载图片，返回 {原图URL: 本地Path}。装饰图（过小/未知格式）跳过。"""
    img_dir.mkdir(parents=True, exist_ok=True)
    mapping: dict[str, Path] = {}
    idx = 0
    for u in urls:
        if len(mapping) >= max_images:
            break
        try:
            data = fetch(u)
        except Exception as e:
            print(f"[SKIP] img-{idx + 1:02d}: 下载失败 {e} <- {u[:90]}")
            continue
        if len(data) < MIN_IMG_BYTES:
            print(f"[SKIP] img-{idx + 1:02d}: {len(data)}B 过小（装饰图），跳过")
            continue
        ext = ".png" if data[:8] == b"\x89PNG\r\n\x1a\n" else (
            ".jpg" if data[:2] == b"\xff\xd8" else ".bin")
        if ext == ".bin":
            print(f"[SKIP] img-{idx + 1:02d}: 未知格式，跳过")
            continue
        idx += 1
        dest = img_dir / f"img-{idx:02d}{ext}"
        dest.write_bytes(data)
        mapping[u] = dest
        print(f"[OK] {dest.name}: {len(data)} bytes <- {u[:90]}")
    return mapping


def to_markdown(raw: str, title: str, source: str, img_map: dict[str, Path]) -> str:
    """HTML -> Markdown（正文裁剪 + 图片本地引用 + frontmatter）。"""
    m = re.search(r"<article[^>]*>(.*?)</article>", raw, re.S)
    content = m.group(1) if m else raw
    content = re.sub(r"<(script|style|nav|footer|header)[^>]*>.*?</\1>", "", content, flags=re.S)

    # 图片标签 -> 本地引用（按原图 URL 匹配；保持正文出现顺序，编号与下载一致则按 URL 匹配）
    order: list[str] = []

    def img_repl(tag_match: "re.Match") -> str:
        tag = tag_match.group(0)
        src = re.search(r'src="([^"]+)"', tag)
        if not src:
            return ""
        u = html_mod.unescape(src.group(1))
        om = re.search(r"url=([^&]+)", u)
        if om:
            u = unquote(om.group(1))
        if u in img_map:
            if u not in order:
                order.append(u)
            alt = ""
            am = re.search(r'alt="([^"]*)"', tag)
            if am:
                alt = html_mod.unescape(am.group(1))
            local = img_map[u]
            return f"![{alt or 'img'}]({local.name and 'imgs/' + local.name})"
        return ""

    content = re.sub(r"<img[^>]+(?:/?)>", img_repl, content)

    def h(level: int, s: str) -> str:
        return f"\n{'#' * level} {strip_tags(s)}\n"

    content = re.sub(r"<h1[^>]*>(.*?)</h1>", lambda m: h(2, m.group(1)), content, flags=re.S)
    content = re.sub(r"<h2[^>]*>(.*?)</h2>", lambda m: h(2, m.group(1)), content, flags=re.S)
    content = re.sub(r"<h3[^>]*>(.*?)</h3>", lambda m: h(3, m.group(1)), content, flags=re.S)
    content = re.sub(r"<li[^>]*>(.*?)</li>", lambda m: "- " + strip_tags(m.group(1)), content, flags=re.S)
    content = re.sub(r"<(p|div|section|blockquote)[^>]*>", "\n", content)
    content = re.sub(r"<[^>]+>", "", content)
    text = html_mod.unescape(content)
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 起止裁剪
    lines = text.split("\n")
    start = 0
    for i, ln in enumerate(lines):
        if ln.startswith("##") or (title.split(":")[0].split("（")[0].lower() in ln.lower() and len(ln) > 40):
            start = max(0, i - 2)
            break
    end = len(lines)
    for i, ln in enumerate(lines):
        low = ln.lower()
        if any(k in low for k in FOOTER_KEYWORDS):
            end = min(end, i)
            break
    body = "\n".join(lines[start:end]).strip()
    body = re.sub(r"\n{3,}", "\n\n", body)

    collected = time.strftime("%Y-%m-%d")
    front = (f"---\ntitle: {title}\nsource: {source}\n"
             f"collected: {collected}\n---\n\n# {title}\n\n")
    return front + body + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--title", default=None, help="覆盖标题（缺省从 <title> 提取）")
    ap.add_argument("--zh-title", default=None,
                    help="中文标题（原文非中文时：翻译副本将以此命名并作为文档标题；"
                         "调用方 LLM 翻译标题后传入）")
    ap.add_argument("--img-subdir", default="imgs")
    ap.add_argument("--max-images", type=int, default=30)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    img_dir = out_dir / args.img_subdir

    print(f"[下载页面] {args.url}")
    raw = fetch(args.url).decode("utf-8", errors="replace")
    title_m = re.search(r"<title>([^<]+)</title>", raw)
    title = html_mod.unescape(title_m.group(1).strip()) if title_m else args.url
    title = re.sub(r"\s*[|\\\\/-]\s*Anthropic\s*$", "", title)  # 站点后缀清理
    if args.title:
        title = args.title
    print(f"[标题] {title}")

    urls = extract_images(raw)
    print(f"[图片] 去重后 {len(urls)} 张")
    img_map = download_images(urls, img_dir, args.max_images)
    if not img_map:
        print("[WARN] 无可用图片（纯文字页或全部下载失败）")

    md = to_markdown(raw, title, args.url, img_map)

    slug = slugify(title)
    md_path = out_dir / f"{slug}.md"
    md_path.write_text(md, encoding="utf-8")
    print(f"[OK] Markdown -> {md_path}（{len(md)} 字符）")

    # 语言检测：非中文正文 -> 复制原文为中文命名副本（内容由调用方 LLM 翻译填充）
    ratio = zh_ratio(strip_tags(md))
    if ratio < 0.05:
        zh_title = args.zh_title or ("中文翻译 - " + slug)
        zh_slug = slugify(zh_title)
        zh_path = out_dir / f"{zh_slug}.md"
        if zh_path.resolve() != md_path.resolve():
            shutil.copyfile(md_path, zh_path)
        print(f"[LANG] 原文非中文（中文字符占比 {ratio:.1%}），原文已保留：{md_path.name}")
        print(f"[LANG] 翻译副本已创建：{zh_path.name}（内容待翻译）")
        print("[LANG] 请调用方 LLM 将副本全文翻译为中文：保留 frontmatter 的 source/collected、"
              "保留图片引用（同目录相对路径不变），标题改为中文标题，正文逐段忠实翻译。")
    # 自检
    refs = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", md)
    missing = [r for r in refs if not (out_dir / r).is_file()]
    leftover = len(re.findall(r"<(?:p|div|section|h\d)[^>]*>", md))
    check(f"图片引用 {len(refs)} 条全部本地存在", not missing, f"缺失 {missing}")
    check("无残留块级 HTML 标签", leftover == 0, f"残留 {leftover} 处")
    check("正文长度合理（>1000 字符）", len(md) > 1000, f"len={len(md)}")
    if missing:
        print("=== DONE WITH MISSING ===")
        return 1
    print("=== ALL DONE ===")
    return 0


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"[{'OK' if cond else 'FAIL'}] {name}" + (f" | {detail}" if detail and not cond else ""))


if __name__ == "__main__":
    sys.exit(main())
