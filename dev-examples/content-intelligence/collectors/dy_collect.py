#!/usr/bin/env python3
"""dy_collect.py —— 抖音采集（T0：视频页全字段，未登录可读）

用法：
    python3 dy_collect.py video https://www.douyin.com/video/<id>
    python3 dy_collect.py search 企业知识库 --limit 6   # 通用搜索引擎赞数快照发现
输出：stdout 纯 JSON。失败模式：chrome-use 缺失/relay 断/视频下架跳首页/搜索无收录。
"""
import argparse
import json
import sys
import urllib.parse

from collect_common import ChromeUse, BrowserLock, fail, out, sample

VIDEO_JS = ("(() => { const title = (document.querySelector('[data-e2e=video-title]') || document.querySelector('h1') || {}).innerText"
            " || document.title.split(' - ')[0];"
            " const author = ((document.querySelector('[data-e2e=video-author-name]') || document.querySelector('[data-e2e=video-author]')) || {}).innerText || '';"
            " const m = {}; document.querySelectorAll('[data-e2e]').forEach(e => {"
            " const k = (e.getAttribute('data-e2e') || '').match(/(digg|like|comment|share|collect|fan)/);"
            " if (k) { const v = e.innerText.trim(); if (v && !m[k[1]]) m[k[1]] = v.slice(0, 12); } });"
            " const desc = ((document.querySelector('[data-e2e=video-desc]') || {}).innerText || '').slice(0, 200);"
            " const onVideo = location.pathname.startsWith('/video/');"
            " return JSON.stringify({title: (title||'').trim().slice(0,60), author, metrics: m, desc,"
            " on_video_page: onVideo, url: location.pathname.slice(0, 40)}) })()")

SEARCH_JS = r"""(() => { const out = []; const seen = new Set();
 const push = (id, txt) => { if (!id || seen.has(id)) return; seen.add(id);
   out.push({url: 'https://www.douyin.com/video/' + id, title: (txt || '').replace(/\s+/g, ' ').trim().slice(0, 50)}); };
 document.querySelectorAll('a[href*="douyin.com/video/"]').forEach(a => {
   const m = a.href.match(/video\/(\d{15,20})/); if (m) push(m[1], a.innerText); });
 const body = document.body.innerText || '';
 const re = /douyin\.com\/video\/(\d{15,20})/g; let m2;
 while ((m2 = re.exec(body)) !== null) { const ctx = body.slice(Math.max(0, m2.index - 60), m2.index).replace(/\s+/g, ' ').trim(); push(m2[1], ctx.slice(-40)); }
 return JSON.stringify(out.slice(0, 15)) })()"""

ENGINES = {
    "sogou": "https://www.sogou.com/web?query=",
    "bing": "https://www.bing.com/search?q=",
    "ddg": "https://html.duckduckgo.com/html/?q=",
}

# 搜狗结果页：h3 标题 + /link 跳转（同 mp_collect 拼 URL 法解析真实地址）
SOGOU_LIST_JS = r"""(() => { const out = [];
 document.querySelectorAll('.vrwrap h3 a, .results h3 a').forEach(a => {
   out.push({title: (a.innerText || '').trim().slice(0, 50), link: a.href}); });
 return JSON.stringify(out.slice(0, 12)) })()"""

SOGOU_RESOLVE_JS_TMPL = r"""(async () => { const r = await fetch(%s, {credentials: 'include'}); const html = await r.text();
 let target = '';
 const mReplace = html.match(/window\.location\.replace\("([^"]+)"\)/);
 if (mReplace) target = mReplace[1];
 if (!target) { const mMeta = html.match(/content="0;\s*url=([^'"]+)"/i); if (mMeta) target = mMeta[1]; }
 if (!target) target = [...html.matchAll(/url\s*\+=\s*'([^']*)'/g)].map(m => m[1]).join('');
 const vm = target.match(/douyin\.com\/(?:share\/)?video\/(\d{15,20})/);
 return JSON.stringify({ok: !!vm, vid: vm ? vm[1] : '', target: target.slice(0, 120)}) })()"""


def cmd_video(url):
    cu = ChromeUse()
    with BrowserLock():
        cu.open(url, wait_sec=8)
        d = cu.eval_json(VIDEO_JS, wait_sec=3)
        if not d.get("on_video_page"):
            raise RuntimeError("未停在视频页（疑似下架/风控跳首页）：url=%s" % d.get("url"))
        if not d.get("title"):
            raise RuntimeError("标题字段为空（页面未就绪，可重试）")
        s = sample("douyin", url, d["title"], d.get("author"),
                   metrics=d.get("metrics") or {}, extra={"desc": d.get("desc")})
    return out({"ok": True, "video": s}, 0)


def cmd_search(kw, limit, engine):
    cu = ChromeUse()
    with BrowserLock():
        # 主路：搜狗（2026-11-13 实测无验证码、抖音结果足；bing 撞验证墙、ddg 无收录）
        items = []
        used = engine
        if engine == "sogou":
            cu.open(ENGINES["sogou"] + urllib.parse.quote("%s site:douyin.com" % kw), wait_sec=5)
            cards = cu.eval_json(SOGOU_LIST_JS)
            for c in cards[: limit + 3]:
                r = cu.eval_json(SOGOU_RESOLVE_JS_TMPL % json.dumps(c["link"]))
                if r.get("ok") and r.get("vid"):
                    title = c["title"].replace(" - 抖音", "").strip()
                    items.append({"url": "https://www.douyin.com/video/" + r["vid"], "title": title or c["title"], "snippet": ""})
                if len(items) >= limit:
                    break
        if not items:
            # 回落：bing/ddg 正文正则抽 video id（跳转链接包住 href，正文 cite 常可见真实链接）
            for eng in ("bing", "ddg"):
                cu.open(ENGINES[eng] + urllib.parse.quote('"%s" site:douyin.com' % kw), wait_sec=5)
                raw = cu.eval_json(SEARCH_JS)
                if raw:
                    items = raw[:limit]
                    used = eng
                    break
        if not items:
            raise RuntimeError("三引擎均无 douyin 视频收录（关键词=%s）" % kw)
        samples = [sample("douyin", it["url"], it["title"], extra={"snippet": it.get("snippet", ""), "discovery": "web_search"})
                   for it in items[:limit]]
    return out({"ok": True, "keyword": kw, "engine": used, "count": len(samples), "samples": samples}, 0)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("video")
    p1.add_argument("url")
    p2 = sub.add_parser("search")
    p2.add_argument("keyword")
    p2.add_argument("--limit", type=int, default=6)
    p2.add_argument("--engine", choices=list(ENGINES), default="bing")
    args = ap.parse_args()
    try:
        if args.cmd == "video":
            return cmd_video(args.url)
        return cmd_search(args.keyword, args.limit, args.engine)
    except RuntimeError as e:
        return fail(str(e))


if __name__ == "__main__":
    sys.exit(main())
