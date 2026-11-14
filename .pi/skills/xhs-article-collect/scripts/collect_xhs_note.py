#!/usr/bin/env python3
"""collect_xhs_note.py —— 小红书笔记全文+图片采集（素材入库，落 templates/xiaohongshu/）

输入小红书笔记 URL（www.xiaohongshu.com/explore/<id> 或 search_result/<id>），采集
标题/正文/作者/日期/标签/互动数 + 笔记图片，落盘为设计参照素材：
  <out-root>/<slug>/<slug>.md   frontmatter(title/source/author/collected/tags) + 正文 + 图片引用
  <out-root>/<slug>/imgs/NN.png 组图按出现顺序编号

链路：chrome-use（复用 content-intelligence/collectors/collect_common，真实 Chrome + 登录态 + 全局浏览器锁）
  → 笔记详情页 #detail-title/#detail-desc + 图片轮播容器 <img>
  → 图片下载（Referer: https://www.xiaohongshu.com/）
前置：用户 Chrome 开着且小红书登录态有效。
输出：stdout 纯 JSON（ok/out_dir/md_file/images/title/author/warnings）；exit 0=ok / 1=fail。
"""
import argparse
import json
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "dev-examples" / "content-intelligence" / "collectors"))
from collect_common import ChromeUse, BrowserLock, out, fail  # noqa: E402

DEFAULT_OUT_ROOT = "templates/xiaohongshu"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
REFERER = "https://www.xiaohongshu.com/"

NOTE_JS = (
    "(() => { const t = document.querySelector('#detail-title, .note-content [class*=title]');"
    " const desc = document.querySelector('#detail-desc, .note-text, [class*=desc]');"
    " const author = document.querySelector('.username, [class*=author] [class*=name], .author-name');"
    " const date = (document.querySelector('.date, [class*=date]') || {}).innerText || '';"
    " const tagEls = [...document.querySelectorAll('#detail-desc .tag, [class*=tag]')]"
    "   .map(e => e.innerText.trim()).filter(s => s && s.length < 30).slice(0, 10);"
    " const counters = {};"
    " document.querySelectorAll('[class*=engage] [class*=count], .interact-container .count')"
    "   .forEach(e => { const k = (e.className.match(/like|collect|comment|share/) || ['x'])[0];"
    "   const v = e.innerText.trim(); if (v && !counters[k]) counters[k] = v; });"
    " const seen = {}; const imgs = [];"
    " document.querySelectorAll('img').forEach(i => {"
    "  const w = i.naturalWidth || i.width || 0;"
    "  const u = (i.dataset.src || i.currentSrc || i.src || '').split('?')[0];"
    "  if (w >= 400 && u.startsWith('http') && !seen[u] && !/avatar/i.test(i.className)"
    "      && !/icon|logo/i.test(u)) { seen[u] = 1; imgs.push(i.dataset.src || i.currentSrc || i.src); } });"
    " return JSON.stringify({title: ((t||{}).innerText || document.title.replace(/ - 小红书$/,'')).trim(),"
    " desc: ((desc||{}).innerText || '').trim(),"
    " author: ((author||{}).innerText || '').trim().slice(0, 30),"
    " date: date.trim().slice(0, 20), tags: tagEls, counters, images: imgs.slice(0, 18)}) })()"
)


def sanitize_slug(title, fallback="xhs-note"):
    slug = re.sub(r'[\\/:*?"<>|\s\x00-\x1f]+', "-", (title or "").strip()).strip("-")
    return slug[:24].strip("-") or fallback


def build_markdown(meta, image_names):
    lines = [
        "---",
        'title: "%s"' % meta["title"].replace('"', "'"),
        "source: %s" % meta["source"],
        'author: "%s"' % meta["author"].replace('"', "'"),
        "collected: %s" % date.today().isoformat(),
    ]
    if meta.get("date"):
        lines.append('publish_date: "%s"' % meta["date"])
    if meta.get("tags"):
        lines.append("tags: [%s]" % ", ".join('"%s"' % t.replace('"', "'") for t in meta["tags"]))
    if meta.get("counters"):
        parts = ["%s: %s" % (k, v) for k, v in meta["counters"].items()]
        lines.append("metrics: {%s}" % ", ".join(parts))
    lines += ["---", "", meta["desc"], ""]
    for i, name in enumerate(image_names, 1):
        if name:
            lines.append("![%02d](imgs/%s)" % (i, name))
            lines.append("")
        else:
            lines.append("（图 %02d 下载失败，已跳过）" % i)
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def download_images(urls, imgs_dir):
    imgs_dir.mkdir(parents=True, exist_ok=True)
    names, warnings = [], []
    for i, url in enumerate(urls, 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Referer": REFERER,
                "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                ctype = (resp.headers.get("Content-Type") or "").lower()
            if len(data) < 1024:
                raise RuntimeError("响应过小（%dB）" % len(data))
            ext = ".gif" if "gif" in ctype else ".png" if "png" in ctype else ".jpg"
            name = "%02d%s" % (i, ext)
            (imgs_dir / name).write_bytes(data)
            names.append(name)
        except Exception as e:
            warnings.append("图%02d 下载失败: %s" % (i, e))
            names.append("")
    return names, warnings


def main():
    ap = argparse.ArgumentParser(description="小红书笔记全文+图片采集（素材入库 templates/xiaohongshu）")
    ap.add_argument("--url", required=True, help="笔记链接（xiaohongshu.com/explore/<id> 或 search_result/<id>）")
    ap.add_argument("--out-root", default=DEFAULT_OUT_ROOT)
    ap.add_argument("--slug", default=None, help="目录名（缺省取标题前 24 字）")
    args = ap.parse_args()

    try:
        cu = ChromeUse()
        with BrowserLock():
            cu.open(args.url, wait_sec=6)
            # 逐屏滚动触发轮播懒加载（同微信采集教训：滚到底不够）
            for i in range(1, 5):
                cu.eval("window.scrollTo(0, %d * (window.innerHeight||1000)); JSON.stringify({y: window.scrollY})" % i,
                        wait_sec=1)
            meta = cu.eval_json(NOTE_JS)
        if not meta.get("title") and not meta.get("desc"):
            return fail("笔记页字段为空（链接失效/登录墙/选择器未命中）——需用户 Chrome 登录态有效")

        urls = [u for u in meta.get("images", []) if u]
        if not urls:
            return fail("未采集到图片（视频笔记暂不支持/图片懒加载未渲染）")
        slug = sanitize_slug(args.slug or meta["title"])
        out_dir = Path(args.out_root) / slug
        md_meta = {"title": meta.get("title") or slug, "source": args.url,
                   "author": meta.get("author", ""), "date": meta.get("date", ""),
                   "tags": meta.get("tags", []), "counters": meta.get("counters", {})}
        names, warnings = download_images(urls, out_dir / "imgs")
        md = build_markdown(md_meta, names)
        md_file = out_dir / ("%s.md" % slug)
        md_file.write_text(md, encoding="utf-8")
        ok_imgs = [n for n in names if n]
        return out({"ok": True, "out_dir": str(out_dir), "md_file": str(md_file),
                    "title": md_meta["title"], "author": md_meta["author"],
                    "images_total": len(urls), "images_downloaded": len(ok_imgs),
                    "images": ok_imgs, "warnings": warnings}, 0)
    except RuntimeError as e:
        return fail(str(e))
    except Exception as e:
        return fail("未预期异常：%r" % e)


if __name__ == "__main__":
    sys.exit(main())
