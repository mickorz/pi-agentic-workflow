#!/usr/bin/env python3
"""小绿书卡片审图：逐页调用 DashScope qwen3-vl-plus 审核 + qwen-vl-ocr 读字。

用法：python review_pages.py --cards-dir <_cards目录>
输出：每页两段 JSON（review + ocr），打印到 stdout。
"""
import argparse
import base64
import json
import os
import pathlib
import sys
import urllib.request

BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"

TYPE_RULES = {
    "screenshot": "screenshot 页标准：文字清晰可读、裁切正确（无地址栏/无关区域残留）、关键代码或数据完整",
    "ai-image": "ai-image 页标准：画面构图合理、与本组其他页风格一致、内容事实准确、图中无错误文字",
    "layout-text": "layout-text 页标准：排版无溢出无重叠、字体层级清晰、与画板边缘留白得当",
}

REVIEW_PROMPT = """你是小绿书卡片组审图员，负责严格挑错。整组共 {total} 页，主题：{theme}。
当前是第 {no} 页（共 {total} 页），页面角色：{role}，排版：{layout}，类型：{type}。
该页期望文案（图中应出现与此一致的文字）：
{copy_block}

{type_rule}

通用标准（每页都要过）：无溢出、无重叠、无元素贴边被裁；中文完整无缺字无错字；文字清晰可读、层级清晰、留白得当；
{extra}全组风格统一（indigo-porcelain 靛蓝瓷白编辑风）。
请严格检查并挑错，宁严勿松。只输出 JSON，不要其他文字：
{{"verdict": "APPROVED|REVISION_REQUIRED|REJECTED", "issues": ["具体问题1", ...], "summary": "一句话总评"}}
verdict 判据：无问题=APPROVED；有小瑕疵但不影响信息传达=REVISION_REQUIRED；严重问题（文字错漏、明显重叠溢出、内容错误）=REJECTED"""


def chat(model, messages, timeout=180):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.1,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=body,
        headers={
            "Authorization": "Bearer " + os.environ["DASHSCOPE_API_KEY"],
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["choices"][0]["message"]["content"]


def img_message(prompt, png_path):
    b64 = base64.b64encode(pathlib.Path(png_path).read_bytes()).decode()
    return [
        {"role": "system", "content": "You are a strict image QA reviewer."},
        {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            {"type": "text", "text": prompt},
        ]},
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards-dir", required=True)
    args = ap.parse_args()
    cards = pathlib.Path(args.cards_dir)
    pages = json.loads((cards / "pages.json").read_text(encoding="utf-8"))
    total = len(pages["pages"])

    for p in pages["pages"]:
        no = p["no"]
        png = cards / "output" / f"{no:02d}.png"
        if not png.exists():
            print(json.dumps({"page": no, "error": "png missing"}, ensure_ascii=False))
            continue
        copy = json.dumps(p.get("copy", {}), ensure_ascii=False, indent=1)
        emphasis = p.get("emphasis", "")
        copy_block = copy + (("\n强调/角标文字: " + json.dumps(emphasis, ensure_ascii=False)) if emphasis else "")
        extra = ""
        if p.get("role") == "cover":
            extra = "作为首图封面，缩小到缩略图尺寸时标题与关键信息仍须可辨；"
        ptype = "screenshot" if "screenshot" in p.get("layout", "") else "layout-text"
        if ptype == "screenshot":
            extra = f"内嵌截图资产: {p.get('asset','')}，说明文字(caption)须与图内容相符；"

        review_prompt = REVIEW_PROMPT.format(
            total=total, theme=pages["theme"], no=no,
            role=p.get("role", "content"), layout=p.get("layout", ""),
            type=ptype, copy_block=copy_block,
            type_rule=TYPE_RULES[ptype], extra=extra,
        )
        review = chat("qwen3-vl-plus", img_message(review_prompt, png))
        ocr = chat("qwen-vl-ocr", img_message("Read all the text in this image.", png))
        print(f"=== PAGE {no} REVIEW ===")
        print(review)
        print(f"=== PAGE {no} OCR ===")
        print(ocr)
        sys.stdout.flush()


if __name__ == "__main__":
    main()
