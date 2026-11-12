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
            " const author = ((document.querySelector('[data-e2e=video-author-name]') || {}).innerText || '').trim();"
            " const m = {}; document.querySelectorAll('[data-e2e]').forEach(e => {"
            " const k = (e.getAttribute('data-e2e') || '').match(/(digg|like|comment|share|collect|fan)/);"
            " if (k) { const v = e.innerText.trim(); if (v && !m[k[1]]) m[k[1]] = v.slice(0, 12); } });"
            " const desc = ((document.querySelector('[data-e2e=video-desc]') || {}).innerText || '').slice(0, 200);"
            " const onVideo = location.pathname.startsWith('/video/');"
            " return JSON.stringify({title: (title||'').trim().slice(0,60), author, metrics: m, desc,"
            " on_video_page: onVideo, url: location.pathname.slice(0, 40)}) })()")

SEARCH_JS = ("(() => { const out = []; document.querySelectorAll('a[href*=\"douyin.com/video/\"]').forEach(a => {"
             " const href = a.href.split('&')[0]; if (out.some(x => x.url === href)) return;"
             " const txt = a.closest('li, .b_algo, .result') || a;"
             " const snippet = txt.innerText.replace(/\\s+/g, ' ').slice(0, 120);"
             " out.push({url: href, title: (a.innerText || '').trim().slice(0, 50) || snippet.slice(0, 40), snippet});"
             "}); return JSON.stringify(out.slice(0, 15)) })()")

ENGINES = {
    "bing": "https://www.bing.com/search?q=",
    "ddg": "https://html.duckduckgo.com/html/?q=",
}


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
    q = urllib.parse.quote('"%s" site:douyin.com' % kw)
    with BrowserLock():
        cu.open(ENGINES[engine] + q, wait_sec=5)
        items = cu.eval_json(SEARCH_JS)
        if not items:
            # bing 偶发 rdr 验证跳转，回落 ddg 一次
            cu.open(ENGINES["ddg"] + q, wait_sec=5)
            items = cu.eval_json(SEARCH_JS)
        if not items:
            raise RuntimeError("通用搜索无 douyin 视频收录（关键词=%s）" % kw)
        samples = [sample("douyin", it["url"], it["title"], extra={"snippet": it["snippet"], "discovery": "web_search"})
                   for it in items[:limit]]
    return out({"ok": True, "keyword": kw, "engine": engine, "count": len(samples), "samples": samples}, 0)


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
