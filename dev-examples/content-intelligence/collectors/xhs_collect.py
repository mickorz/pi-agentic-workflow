#!/usr/bin/env python3
"""xhs_collect.py —— 小红书采集（T0：search 卡片列表 + 笔记详情页）

前置：用户 Chrome 开着且小红书登录态有效（chrome-use relay 驱动）。
用法：
    python3 xhs_collect.py search 企业知识库 --limit 6
    python3 xhs_collect.py note https://www.xiaohongshu.com/explore/<id>
输出：stdout 纯 JSON（samples 数组 / note 对象）。
失败模式（exit 1，error 带 reason）：chrome-use 缺失 / relay 断 / 登录墙（未登录时搜索页 noteCount=0）/ 无结果。
"""
import argparse
import json
import sys
import urllib.parse

from collect_common import ChromeUse, BrowserLock, fail, out, sample

SEARCH_URL = "https://www.xiaohongshu.com/search_result?keyword="

# 登录态探测：头像在=已登录；login-modal/登录按钮=未登录
STATE_JS = ("(() => { const avatar = document.querySelector('.user-avatar, [class*=side-bar-user] img, "
            "[class*=avatar-wrapper]'); const login = document.querySelector('.login-modal, .sign-in, [class*=login-container]'); "
            "return JSON.stringify({logged: !!avatar, loginWall: !!login, url: location.href.slice(0,60)}) })()")

# 搜索结果卡片（容忍多版 DOM）：a[href*=search_result / explore]，标题/作者/赞数尽力取
CARDS_JS = ("(() => { const seen = new Set(); const out = []; "
            "document.querySelectorAll('a[href*=\"/search_result/\"], a[href*=\"/explore/\"]').forEach(a => {"
            " const href = a.href.split('?')[0]; const m = href.match(/(search_result|explore)\\/([0-9a-f]{16,})/);"
            " if (!m || seen.has(m[2])) return; seen.add(m[2]);"
            " const sec = a.closest('section, .note-item, li') || a;"
            " const title = (sec.querySelector('.title, .note-text, [class*=title]') || {}).innerText"
            "   || (a.querySelector('img') || {}).alt || a.innerText.trim().slice(0, 40);"
            " const author = (((sec.querySelector('.name, .author, [class*=author]') || {}).innerText || '').split('\\n')[0]) || '';"
            " const likeRaw = ((sec.querySelector('.count, [class*=like] .count, [class*=count]') || {}).innerText || '').trim();"
            " const like = /[0-9万亿kK]/.test(likeRaw) ? likeRaw.slice(0, 8) : '';"
            " out.push({note_id: m[2], url: href, title: (title||'').trim().slice(0,60), author: (author||'').trim().slice(0,30), like: (like||'').trim()});"
            "}); return JSON.stringify(out.slice(0, 30)) })()")

NOTE_JS = ("(() => { const t = document.querySelector('#detail-title, [class*=title]'); "
           "const desc = document.querySelector('#detail-desc, .desc, [class*=desc]'); "
           "const author = document.querySelector('.username, [class*=author] [class*=name], .author-name'); "
           "const counters = {}; "
           "document.querySelectorAll('[class*=engage], [class*=interact] [class*=count], .interact-container .count')"
           ".forEach(e => { const k = (e.className.match(/like|collect|comment|share/) || ['x'])[0];"
           " const v = e.innerText.trim(); if (v && !counters[k]) counters[k] = v; }); "
           "const tagEls = [...document.querySelectorAll('.tag, [class*=tag]')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 6); "
           "return JSON.stringify({title: (t||{}).innerText || document.title.slice(0,50), desc: ((desc||{}).innerText || '').slice(0, 300), "
           "author: ((author||{}).innerText || '').trim().slice(0,30), counters, tags: tagEls, "
           "date: ((document.querySelector('.date, [class*=date]') || {}).innerText || '').slice(0, 20)}) })()")


def check_login(cu, cards):
    """宽容判定：登录墙在=真未登录；头像选择器因页面而异不作硬依据，卡片为空且无头像才报未登录。"""
    try:
        st = cu.eval_json(STATE_JS)
    except RuntimeError:
        st = {}
    if st.get("loginWall"):
        raise RuntimeError("小红书登录墙（未登录）——需用户 Chrome 开着且登录态有效")
    if not cards and not st.get("logged"):
        raise RuntimeError("小红书疑似未登录（无头像也无结果卡片）——需用户 Chrome 登录态")
    return st


def cmd_search(kw, limit):
    cu = ChromeUse()
    with BrowserLock():
        cu.open(SEARCH_URL + urllib.parse.quote(kw), wait_sec=6)
        cards = cu.eval_json(CARDS_JS)
        check_login(cu, cards)
        if not cards:
            raise RuntimeError("搜索无结果或卡片选择器未命中（关键词=%s）" % kw)
        samples = [sample("xiaohongshu", c["url"], c["title"], c["author"],
                          metrics={"likes_card": c["like"]} if c["like"] else {},
                          extra={"note_id": c["note_id"]})
                   for c in cards[:limit]]
    return out({"ok": True, "keyword": kw, "count": len(samples), "samples": samples}, 0)


def cmd_note(url):
    cu = ChromeUse()
    with BrowserLock():
        cu.open(url, wait_sec=6)
        d = cu.eval_json(NOTE_JS)
        if not d.get("title") and not d.get("desc"):
            check_login(cu, [])
            raise RuntimeError("笔记页字段为空（链接失效或选择器未命中）")
        s = sample("xiaohongshu", url, d.get("title"), d.get("author"),
                   metrics=d.get("counters") or {},
                   extra={"desc": d.get("desc"), "tags": d.get("tags"), "publish_date": d.get("date")})
    return out({"ok": True, "note": s}, 0)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("search")
    p1.add_argument("keyword")
    p1.add_argument("--limit", type=int, default=6)
    p2 = sub.add_parser("note")
    p2.add_argument("url")
    args = ap.parse_args()
    try:
        if args.cmd == "search":
            return cmd_search(args.keyword, args.limit)
        return cmd_note(args.url)
    except RuntimeError as e:
        return fail(str(e))


if __name__ == "__main__":
    sys.exit(main())
