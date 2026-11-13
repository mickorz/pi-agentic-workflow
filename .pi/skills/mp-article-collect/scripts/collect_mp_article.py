#!/usr/bin/env python3
"""collect_mp_article.py —— 微信公众号文章全文+图片采集（xiaolvshu 素材入库）

输入微信公众号文章 URL，采集正文文字与全部图片，落盘为 xiaolvshu 设计参照素材：
  <out-root>/<slug>/<slug>.md   frontmatter(title/source/author/collected) + 正文段落 + 图片引用
  <out-root>/<slug>/imgs/NN.png 组图按出现顺序编号

链路：chrome-use（复用 content-intelligence/collectors/collect_common，真实 Chrome + 全局浏览器锁）
  → 文章页 #activity-name/#js_name/#publish_time/#js_content innerHTML
  → 本地解析（标准库 HTMLParser，无第三方依赖）：段落文本 + <img data-src> 按文档顺序
  → 图片下载（Referer: mp.weixin.qq.com；wx 图床免登录但校验 Referer 的资源也能过）
  → markdown 组装落盘

用法：
    python collect_mp_article.py --url "https://mp.weixin.qq.com/s/xxxx"
    python collect_mp_article.py --url "..." --out-root templates/xiaolvshu --slug 自定义目录名

输出：stdout 纯 JSON（ok/out_dir/md_file/images/title/author）；exit 0=ok / 1=fail。
本脚本只做采集与落盘，不做视觉分析（图片分析用 zai 视觉模型另行逐张分析）。
"""
import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "dev-examples" / "content-intelligence" / "collectors"))
from collect_common import ChromeUse, BrowserLock, out, fail  # noqa: E402

DEFAULT_OUT_ROOT = "templates/xiaolvshu"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
REFERER = "https://mp.weixin.qq.com/"

EXTRACT_JS = (
    "(() => { const t = document.querySelector('#activity-name') || document.querySelector('h1.rich_media_title');"
    " const a = document.querySelector('#js_name');"
    " const pt = document.querySelector('#publish_time');"
    " const c = document.querySelector('#js_content');"
    " const desc = document.querySelector('#js_image_desc');"
    " const seen = {}; const pageImgs = [];"
    " document.querySelectorAll('img').forEach(i => { const w = i.naturalWidth || i.width || 0;"
    "  const u = i.dataset.src || i.currentSrc || i.src || '';"
    "  if (w >= 500 && u.startsWith('http') && !seen[u] && !/avatar/i.test(i.className)) { seen[u] = 1; pageImgs.push(u); } });"
    " return JSON.stringify({title: ((t||{}).innerText || '').trim(),"
    " account: ((a||{}).innerText || '').trim(),"
    " publish_time: ((pt||{}).innerText || '').trim().slice(0, 20),"
    " html: c ? c.innerHTML : '',"
    " desc_text: ((desc||{}).innerText || '').trim(),"
    " page_imgs: pageImgs.slice(0, 12)}) })()"
)

# 每页内容按 80KB 分段 eval，避免超长字符串在 chrome-use stdout 截断
CHUNK = 80000


class BlockParser(HTMLParser):
    """按文档顺序抽取块级文本段与 <img> 图片（含懒加载 data-src / data-lazy-src）。"""

    BLOCKS = {"p", "section", "h1", "h2", "h3", "h4", "li", "blockquote", "figcaption"}
    SKIP = {"style", "script", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []          # [("text", str) | ("img", url)]
        self._buf = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip_depth += 1
            return
        if tag == "img":
            d = dict(attrs)
            url = d.get("data-src") or d.get("src") or ""
            if url.startswith("http") and "spacer" not in url:
                self._flush()
                self.blocks.append(("img", url))
            return
        if tag in self.BLOCKS:
            self._flush()

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag in self.BLOCKS:
            self._flush()

    def handle_data(self, data):
        if not self._skip_depth:
            self._buf.append(data)

    def _flush(self):
        text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        self._buf = []
        if text:
            self.blocks.append(("text", text))


def parse_content_html(html):
    """html -> blocks；无 #js_content 内容时返回空列表。"""
    if not html:
        return []
    parser = BlockParser()
    parser.feed(html)
    return parser.blocks


def sanitize_slug(title, fallback="mp-article"):
    """标题 -> 文件系统安全目录名：去非法字符与空白，限 24 字。"""
    slug = re.sub(r'[\\/:*?"<>|\s\x00-\x1f]+', "-", (title or "").strip()).strip("-")
    slug = slug[:24].strip("-")
    return slug or fallback


def build_markdown(meta, blocks, image_names):
    """组装 frontmatter md；img url -> imgs/<名> 占位在下载前生成，顺序一致。"""
    lines = [
        "---",
        'title: "%s"' % meta["title"].replace('"', "'"),
        "source: %s" % meta["source"],
        'author: "%s"' % meta["author"].replace('"', "'"),
        "collected: %s" % date.today().isoformat(),
        "---",
        "",
    ]
    idx = 0
    for kind, val in blocks:
        if kind == "text":
            lines.append(val)
            lines.append("")
        else:
            name = image_names[idx]
            if name:
                lines.append("![%02d](imgs/%s)" % (idx + 1, name))
            else:
                lines.append("（图 %02d 下载失败，已跳过）" % (idx + 1))
            lines.append("")
            idx += 1
    return "\n".join(lines).rstrip() + "\n"


def download_images(blocks, imgs_dir):
    """下载全部图片，返回 [文件名]（与 blocks 中 img 顺序一致）；单张失败记 warning 不中断。"""
    imgs_dir.mkdir(parents=True, exist_ok=True)
    names, warnings = [], []
    for i, (kind, url) in enumerate([b for b in blocks if b[0] == "img"], 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Referer": REFERER,
                "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                ctype = (resp.headers.get("Content-Type") or "").lower()
            if len(data) < 1024:
                raise RuntimeError("响应过小（%dB），疑似反爬占位图" % len(data))
            ext = ".gif" if "gif" in ctype else ".png" if "png" in ctype else ".jpg"
            name = "%02d%s" % (i, ext)
            (imgs_dir / name).write_bytes(data)
            names.append(name)
        except Exception as e:  # 单张失败不中断整组
            warnings.append("图%02d 下载失败: %s" % (i, e))
            names.append("")
    return names, warnings


def main():
    ap = argparse.ArgumentParser(description="微信公众号文章全文+图片采集（xiaolvshu 素材入库）")
    ap.add_argument("--url", required=True, help="微信文章链接（mp.weixin.qq.com）")
    ap.add_argument("--out-root", default=DEFAULT_OUT_ROOT)
    ap.add_argument("--slug", default=None, help="目录名（缺省取标题前 24 字）")
    args = ap.parse_args()

    try:
        cu = ChromeUse()
        with BrowserLock():
            cu.open(args.url, wait_sec=5)
            # 滚底两轮触发懒加载（贴图页组图在视口外时 naturalWidth=0）
            for i in range(1, 7):
                # 逐屏滚动触发轮播组件逐张渲染（滚到底不够，swipe 只渲染可视页±1）
                cu.eval("window.scrollTo(0, %d * (window.innerHeight||1200)); JSON.stringify({y: window.scrollY})" % i, wait_sec=1)
            meta = cu.eval_json(EXTRACT_JS)
        if not meta.get("title"):
            return fail("文章页字段为空（链接失效/非微信文章页/环境异常）")

        blocks = parse_content_html(meta.get("html", ""))
        noise = re.compile(r"赞赏|喜欢作者|扫一扫|老板赏|微信扫一扫|向上滑动|点击上方")
        blocks = [(k, v) for k, v in blocks if not (k == "text" and noise.search(v))]
        if not blocks and meta.get("desc_text"):
            # 贴图页（newspic）：正文只有描述段
            desc_lines = [ln.strip() for ln in meta["desc_text"].splitlines() if ln.strip()]
            clean = [ln for ln in desc_lines if not noise.search(ln)]
            if clean:
                blocks = [("text", "\n".join(clean))]
        # 页面级大图（贴图页组图在 #js_content 之外）：去重后追加到 blocks 尾部
        have = {u for _, u in blocks if _ == "img"}
        for u in meta.get("page_imgs", []):
            if u not in have:
                blocks.append(("img", u))
                have.add(u)
        n_imgs = sum(1 for k, _ in blocks if k == "img")
        if not blocks:
            return fail("正文解析结果为空（页面无文本与图片）")

        slug = sanitize_slug(args.slug or meta["title"])
        out_dir = Path(args.out_root) / slug
        imgs_dir = out_dir / "imgs"
        out_dir.mkdir(parents=True, exist_ok=True)

        image_names, warnings = download_images(blocks, imgs_dir)
        meta_out = {"title": meta["title"], "source": args.url,
                    "author": meta.get("account", ""), "publish_time": meta.get("publish_time", "")}
        md = build_markdown(meta_out, blocks, image_names)
        md_file = out_dir / ("%s.md" % slug)
        md_file.write_text(md, encoding="utf-8")

        ok_imgs = [n for n in image_names if n]
        return out({"ok": True, "out_dir": str(out_dir), "md_file": str(md_file),
                    "title": meta_out["title"], "author": meta_out["author"],
                    "blocks": len(blocks), "images_total": n_imgs,
                    "images_downloaded": len(ok_imgs), "images": ok_imgs,
                    "warnings": warnings}, 0)
    except RuntimeError as e:
        return fail(str(e))
    except Exception as e:
        return fail("未预期异常：%r" % e)


if __name__ == "__main__":
    sys.exit(main())
