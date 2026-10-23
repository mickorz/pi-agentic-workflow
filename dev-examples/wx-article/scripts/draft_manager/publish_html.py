#!/usr/bin/env python3
"""Markdown -> 微信样式 HTML（从旧 publish.py 原样提取，转换规则未变）。

HTML_RULE_VERSION 在 content_hash.py 中定义；转换逻辑变更时须同步递增版本号，
使旧草稿 Hash 失效、触发 draft/update。
"""
from __future__ import annotations

import re

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
        m = re.match(r"^-( .*)", t)
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
