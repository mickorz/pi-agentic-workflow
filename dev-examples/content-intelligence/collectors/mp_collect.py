#!/usr/bin/env python3
"""mp_collect.py —— 微信公众号采集（T0：搜狗微信发现 + 跳转拼接 + 文章页全字段）

链路（2026-11-12 实测沉淀）：
  搜狗搜索页（真实 Chrome 无验证码）→ 结果卡片(标题/账号/日期/链接)
  → /link 跳转页分段拼 URL（url += '…' 防抓）→ 真实文章 URL
  → 文章页 #activity-name/#js_name/#js_content 全字段
用法：
    python3 mp_collect.py search 企业知识库 --limit 6
    python3 mp_collect.py article https://mp.weixin.qq.com/s?...
输出：stdout 纯 JSON。失败模式：chrome-use 缺失/relay 断/搜狗验证码/跳转拼不出/文章页字段空。
"""
import argparse
import json
import sys
import urllib.parse

from collect_common import ChromeUse, BrowserLock, fail, out, sample

SOGOU_URL = "https://weixin.sogou.com/weixin?type=2&query="

LIST_JS = ("(() => { const out = []; document.querySelectorAll('.news-list li, .news-box li').forEach(li => {"
           " const a = li.querySelector('h3 a'); if (!a) return;"
           " const spText = ((li.querySelector('.s-p') || {}).innerText || '').replace(/\\s+/g, ' ').trim();"
           " const tm = spText.match(/(\\d+分钟前|\\d+小时前|\\d+天前|\\d+月前|\\d{4}-\\d+-\\d+)$/);"
           " const date = tm ? tm[1] : '';"
           " const account = (li.querySelector('.account') || {}).innerText || (tm ? spText.slice(0, spText.length - tm[1].length) : spText);"
           " const accountClean = account.replace(/\\s+/g, ' ').trim().slice(0, 30);"
           " const snippet = ((li.querySelector('.txt-info, p') || {}).innerText || '').trim().slice(0, 80);"
           " out.push({title: a.innerText.trim().slice(0, 50), link: a.href, account: accountClean, date, snippet}); });"
           " const captcha = !!document.querySelector('#seccodeImage, .img-buffer');"
           " return JSON.stringify({items: out.slice(0, 20), captcha}) })()")

# 同源 fetch 跳转页，拼出真实文章 URL（分段 url += '…'）
RESOLVE_JS = ("(async () => { const r = await fetch(%s, {credentials: 'include'}); const html = await r.text();"
              " const parts = [...html.matchAll(/url\\s*\\+=\\s*'([^']*)'/g)].map(m => m[1]);"
              " const target = parts.join('');"
              " return JSON.stringify({ok: target.startsWith('http'), target: target.slice(0, 200), fragments: parts.length}) })()")

ARTICLE_JS = ("(() => { const t = document.querySelector('#activity-name'); const a = document.querySelector('#js_name');"
              " const c = document.querySelector('#js_content'); const pt = document.querySelector('#publish_time');"
              " const acct_info = document.querySelector('.profile_meta, #js_profile_qrcode');"
              " return JSON.stringify({title: ((t||{}).innerText || '').trim(), account: ((a||{}).innerText || '').trim(),"
              " publish_time: ((pt||{}).innerText || '').trim().slice(0, 20), content_len: c ? c.innerText.length : 0,"
              " content_head: c ? c.innerText.replace(/\\s+/g, ' ').slice(0, 150) : ''}) })()")


def cmd_search(kw, limit):
    cu = ChromeUse()
    with BrowserLock():
        cu.open(SOGOU_URL + urllib.parse.quote(kw), wait_sec=5)
        data = cu.eval_json(LIST_JS)
        if data.get("captcha"):
            raise RuntimeError("搜狗触发验证码（真实 Chrome 偶发；稍后重试或换关键词）")
        items = data.get("items") or []
        if not items:
            raise RuntimeError("搜狗无结果或选择器未命中（关键词=%s）" % kw)
        # 第一条顺带解析真实文章 URL（验证拼链接链路）
        resolved = None
        first = items[0]
        r = cu.eval_json(RESOLVE_JS % json.dumps(first["link"]))
        if r.get("ok"):
            resolved = r["target"]
        samples = []
        for it in items[:limit]:
            s = sample("wechat_mp", it["link"], it["title"], it["account"],
                       extra={"date_card": it["date"], "snippet": it["snippet"], "sogou_link": True})
            samples.append(s)
    return out({"ok": True, "keyword": kw, "count": len(samples),
                "first_real_url_resolved": resolved, "samples": samples}, 0)


def cmd_article(url):
    cu = ChromeUse()
    with BrowserLock():
        cu.open(url, wait_sec=5)
        d = cu.eval_json(ARTICLE_JS)
        if not d.get("title") and not d.get("content_len"):
            raise RuntimeError("文章页字段为空（链接失效/参数错误/环境异常）")
        s = sample("wechat_mp", url, d["title"], d["account"],
                   metrics={"content_chars": d["content_len"]},
                   extra={"publish_time": d["publish_time"], "content_head": d["content_head"]})
    return out({"ok": True, "article": s}, 0)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("search")
    p1.add_argument("keyword")
    p1.add_argument("--limit", type=int, default=6)
    p2 = sub.add_parser("article")
    p2.add_argument("url")
    args = ap.parse_args()
    try:
        if args.cmd == "search":
            return cmd_search(args.keyword, args.limit)
        return cmd_article(args.url)
    except RuntimeError as e:
        return fail(str(e))


if __name__ == "__main__":
    sys.exit(main())
