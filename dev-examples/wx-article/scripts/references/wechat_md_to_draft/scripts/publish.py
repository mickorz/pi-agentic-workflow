#!/usr/bin/env python3
"""写作稿直发微信草稿箱脚本（原 publish.ps1 的 Python 版，纯标准库跨平台）。

由 workflow wechat_md_to_draft.js 调用：
  python3 publish.py --article-dir <文章目录> --cover <封面图相对路径>

行为：md(含 frontmatter) -> 微信样式 HTML -> 上传封面(add_material)/正文图(uploadimg)
-> 替换图片 URL -> draft/add 建草稿 -> 落 publish.log/article.yaml/article.md。

凭证：向上查找含 .aws-article 的祖先目录（先脚本自身位置后文章目录），
读 aws.env（WECHAT_1_APPID/WECHAT_1_APPSECRET）与 .aws-article/config.json。

输出契约（下游 prompt/断言依赖）：
[md]/[meta]/[html]/[imgs]/[1] TOKEN OK/[2] THUMB OK media_id=.../[3] IMG i/n ref OK/
[4] html after replace N chars/[5] DRAFT OK media_id=.../[6] publish.log + article.yaml + article.md saved/
=== ALL DONE draft_media_id=... ===；失败 [FAIL] ... 退出码 1。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = "https://api.weixin.qq.com"
IMG_PREFIX_EXCLUDE = re.compile(r"^(article|draft|review)")


def fail(msg: str) -> int:
    print(f"[FAIL] {msg}")
    return 1


def find_config_root(start: Path) -> Path | None:
    d = start.resolve()
    while True:
        if (d / ".aws-article").exists():
            return d
        parent = d.parent
        if parent == d:
            return None
        d = parent


def http_json(url: str) -> dict:
    with urlopen(Request(url, headers={"User-Agent": "pi-workflow-publish/1.0"}), timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_multipart(url: str, field: str, path: Path) -> dict:
    """multipart/form-data 文件上传（标准库实现，替代 curl.exe -F media=@file）。"""
    boundary = "----piworkflow" + uuid.uuid4().hex
    ctype = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")
    data = path.read_bytes()
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{field}"; filename="{path.name}"\r\n'.encode(),
            f"Content-Type: {ctype}\r\n\r\n".encode(),
            data,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    req = Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------- markdown -> 微信样式 HTML ----------

TABLE_STYLE = 'width:100%;border-collapse:collapse;margin:0 0 24px;font-size:14px;'
TH_STYLE = 'border:1px solid #DDD;padding:8px;background:#F7F7F9;text-align:left;'
TD_STYLE = 'border:1px solid #DDD;padding:8px;'
SECTION_OPEN = (
    '<section style="font-family:-apple-system,BlinkMacSystemFont,\'Helvetica Neue\','
    '\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif;font-size:16px;'
    'color:#1F1F1F;line-height:1.95;letter-spacing:0.5px;">\n'
)


def render_table(out: list[str], rows: list[str]) -> None:
    cells = [c.strip() for c in rows[0].split("|") if c.strip()]
    th = "".join(f'<th style="{TH_STYLE}">{c}</th>' for c in cells)
    out.append(f'<table style="{TABLE_STYLE}">')
    out.append(f"<thead><tr>{th}</tr></thead><tbody>")
    for r in rows[2:]:
        cells = [c.strip() for c in r.split("|") if c.strip()]
        td = "".join(f'<td style="{TD_STYLE}">{c}</td>' for c in cells)
        out.append(f"<tr>{td}</tr>")
    out.append("</tbody></table>")


def inline(p: str) -> str:
    p = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2" style="color:#5B5B95;text-decoration:none;">\1</a>', p)
    p = re.sub(r"\*\*([^*]+)\*\*", r'<strong style="font-weight:700;">\1</strong>', p)
    p = re.sub(r"(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)", r"<em>\1</em>", p)
    return p


def convert_md(text: str) -> str:
    text = re.sub(r"\A---\r?\n.*?\r?\n---\r?\n", "", text, flags=re.S)
    out: list[str] = [SECTION_OPEN]
    in_list = False
    table_rows: list[str] = []

    def flush() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False
        if table_rows:
            render_table(out, table_rows)
            table_rows.clear()

    for raw in text.split("\r\n" if "\r\n" in text else "\n"):
        t = raw.strip()
        if t == "":
            flush()
            continue
        m = re.match(r"^###\s+(.*)", t)
        if m:
            flush()
            out.append(f'<h3 style="margin:24px 0 12px;font-size:18px;font-weight:700;color:#1F1F1F;">{m.group(1)}</h3>')
            continue
        m = re.match(r"^##\s+(.*)", t)
        if m:
            flush()
            out.append(f'<h2 style="margin:30px 0 16px;font-size:20px;font-weight:700;color:#1F1F1F;">{m.group(1)}</h2>')
            continue
        if re.match(r"^#\s*(.*)", t):
            continue
        if re.match(r"^-{3,}$", t) or re.match(r"^\*{3,}$", t):
            flush()
            out.append('<hr style="border:none;border-top:1px solid #E5E5E5;margin:24px 0;">')
            continue
        m = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)", t)
        if m:
            flush()
            alt, src = m.group(1), m.group(2)
            out.append(
                '<figure style="margin:0 0 24px;"><img src="' + src + '" alt="' + alt
                + '" style="display:block;width:100%;border-radius:8px;">'
                + '<figcaption style="font-size:13px;color:#999;margin-top:6px;text-align:center;">' + alt + "</figcaption></figure>"
            )
            continue
        if t.startswith("|"):
            in_list = False
            table_rows.append(t)
            continue
        m = re.match(r"^- (.*)", t)
        if m:
            if not in_list:
                out.append('<ul style="margin:0 0 20px;padding-left:20px;">')
                in_list = True
            out.append(f'<li style="margin:0 0 8px;line-height:1.8;">{m.group(1)}</li>')
            continue
        flush()
        out.append(f'<p style="margin:0 0 20px;text-align:justify;line-height:1.95;">{inline(t)}</p>')
    flush()
    out.append("</section>")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--article-dir", required=True)
    ap.add_argument("--cover", required=True)
    args = ap.parse_args()

    article_dir = Path(args.article_dir)
    if not article_dir.is_dir():
        return fail(f"article_dir not found: {article_dir}")
    cover_path = article_dir / args.cover
    if not cover_path.is_file():
        return fail(f"cover not found: {cover_path}")

    repo_root = find_config_root(Path(__file__).parent) or find_config_root(article_dir)
    if repo_root is None:
        return fail(f"cannot find config root (.aws-article) near script or {article_dir}")
    env_file = repo_root / "aws.env"
    config_path = repo_root / ".aws-article" / "config.json"

    # 找 .md 写作稿（排除 article/draft/审稿/review 开头，取最长名）
    cands = [
        p for p in article_dir.glob("*.md")
        if not IMG_PREFIX_EXCLUDE.match(p.name) and "审稿" not in p.name
    ]
    if not cands:
        return fail(f"no .md found in {article_dir}")
    md_path = max(cands, key=lambda p: len(p.name))
    print(f"[md] {md_path.name}")

    # 读凭证
    env_vars: dict[str, str] = {}
    for line in env_file.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        m = re.match(r"^\s*(\w+)\s*=\s*(.+?)\s*$", line)
        if m:
            env_vars[m.group(1)] = m.group(2)

    # 读 .md + frontmatter
    md = md_path.read_text(encoding="utf-8-sig")
    title = ""
    description = ""
    m = re.match(r"^---\r?\n(.*?)\r?\n---", md, flags=re.S)
    if m:
        fm = m.group(1)
        t = re.search(r'^title\s*:\s*"?(.+?)"?\s*$', fm, flags=re.M)
        if t:
            title = t.group(1)
        d = re.search(r'^description\s*:\s*"?(.+?)"?\s*$', fm, flags=re.M)
        if d:
            description = d.group(1)
    cfg = json.loads(config_path.read_text(encoding="utf-8-sig"))
    author = cfg.get("default_author") or "AI奇点"
    # 回退链：frontmatter 缺失时读 article.yaml（插图/元数据流程维护），再回退正文首个加粗行
    yaml_author = ""
    yaml_path = article_dir / "article.yaml"
    if yaml_path.is_file():
        yam = yaml_path.read_text(encoding="utf-8-sig", errors="replace")
        if not title:
            t = re.search(r'^title\s*:\s*["\']?(.+?)["\']?\s*$', yam, flags=re.M)
            if t:
                title = t.group(1)
        if not description:
            d = re.search(r'^digest\s*:\s*["\']?(.+?)["\']?\s*$', yam, flags=re.M)
            if d:
                description = d.group(1)
        a = re.search(r'^author\s*:\s*["\']?(.+?)["\']?\s*$', yam, flags=re.M)
        if a:
            yaml_author = a.group(1)
    if yaml_author:
        author = yaml_author
    if not title:
        t = re.search(r"^\*\*([^*\n]{4,40})\*\*\s*$", md, flags=re.M)
        if t:
            title = t.group(1)
    if not title:
        return fail("no title: frontmatter/article.yaml/首个加粗行均未取到 title")
    digest = description or title
    print(f"[meta] title={title} | author={author} | digestLen={len(digest)}")

    html = convert_md(md)
    if len(html) < 200:
        return fail(f"html too short ({len(html)} chars), content likely empty")
    print(f"[html] generated {len(html)} chars")

    # 扫描 .md 图片引用
    img_refs = sorted({m.group(1) for m in re.finditer(r"!\[[^\]]*\]\(([^)]+)\)", md)})
    print(f"[imgs] found {len(img_refs)} image refs")

    # 拿 token
    token_url = BASE + "/cgi-bin/token?" + urlencode(
        {"grant_type": "client_credential", "appid": env_vars["WECHAT_1_APPID"], "secret": env_vars["WECHAT_1_APPSECRET"]}
    )
    try:
        tr = http_json(token_url)
    except (URLError, OSError) as e:
        return fail(f"TOKEN network: {e}")
    if not tr.get("access_token"):
        return fail(f"TOKEN errcode={tr.get('errcode')} errmsg={tr.get('errmsg')}")
    token = tr["access_token"]
    print("[1] TOKEN OK")

    # 上传封面
    thumb_resp = http_multipart(f"{BASE}/cgi-bin/material/add_material?access_token={token}&type=image", "media", cover_path)
    if not thumb_resp.get("media_id"):
        return fail(f"THUMB errcode={thumb_resp.get('errcode')} errmsg={thumb_resp.get('errmsg')} raw={thumb_resp}")
    thumb_media_id = thumb_resp["media_id"]
    print(f"[2] THUMB OK media_id={thumb_media_id}")

    # 上传正文图
    img_map: dict[str, str] = {}
    for idx, ref in enumerate(img_refs, 1):
        img_path = (article_dir / ref.replace("\\", "/"))
        if not img_path.is_file():
            return fail(f"IMG not found: {ref}")
        resp = http_multipart(f"{BASE}/cgi-bin/media/uploadimg?access_token={token}", "media", img_path)
        if not resp.get("url"):
            return fail(f"IMG {idx} {ref} errcode={resp.get('errcode')} errmsg={resp.get('errmsg')}")
        img_map[ref] = resp["url"]
        print(f"[3] IMG {idx}/{len(img_refs)} {ref} OK")

    # 替换 HTML 图片路径为微信 URL（兼容 / 和 \）
    for ref, url in img_map.items():
        html = html.replace(ref, url)
        html = html.replace(ref.replace("/", "\\"), url)
    leftover = [m.group(0) for m in re.finditer(r'(?:src|href)="(?:引用|imgs|图片|placeholder)', html)]
    if leftover:
        print(f"[WARN] leftover: {'; '.join(leftover)}")
    print(f"[4] html after replace {len(html)} chars")

    # draft/add
    body = {
        "articles": [
            {
                "title": title,
                "author": author,
                "digest": digest,
                "content": html,
                "thumb_media_id": thumb_media_id,
                "content_source_url": "",
                "need_open_comment": int(cfg.get("need_open_comment") or 0),
                "only_fans_can_comment": int(cfg.get("only_fans_can_comment") or 0),
            }
        ]
    }
    req = Request(
        f"{BASE}/cgi-bin/draft/add?access_token={token}",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=60) as resp:
            draft_resp = json.loads(resp.read().decode("utf-8"))
    except (URLError, OSError) as e:
        return fail(f"DRAFT network: {e}")
    if not draft_resp.get("media_id"):
        return fail(f"DRAFT errcode={draft_resp.get('errcode')} errmsg={draft_resp.get('errmsg')}")
    draft_media_id = draft_resp["media_id"]
    print(f"[5] DRAFT OK media_id={draft_media_id}")

    # 产物
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(article_dir / "publish.log", "a", encoding="utf-8") as f:
        f.write(f"[publish] {stamp} account={env_vars['WECHAT_1_APPID']} thumb={thumb_media_id} "
                f"draft={draft_media_id} imgs={len(img_map)} method=draft\n")
    (article_dir / "article.yaml").write_text(
        f"title: {title}\nauthor: {author}\ndigest: {digest}\npublish_completed: true\n"
        f"content_source: {md_path.name}\n",
        encoding="utf-8",
    )
    (article_dir / "article.md").write_bytes(md_path.read_bytes())
    print("[6] publish.log + article.yaml + article.md saved")
    print(f"=== ALL DONE draft_media_id={draft_media_id} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
