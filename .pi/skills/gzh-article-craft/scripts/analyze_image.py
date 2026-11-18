#!/usr/bin/env python3
"""文章配图视觉核对：调 DashScope qwen3-vl-plus 分析图片。

用法：
  python analyze_image.py --image <图片路径或URL> --prompt "检查要点"
  python analyze_image.py --image <图片路径> --expected-text "词1,词2"   # 核对画面文字

输出：模型回复文本打印到 stdout。审图通过与否由 agent 依据回复判断。
"""
import argparse
import base64
import json
import os
import pathlib
import sys
import urllib.request

BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL = "qwen3-vl-plus"


def chat(prompt, image_path, timeout=180):
    # 本地路径转 base64，http(s) 直传 URL
    if image_path.startswith("http://") or image_path.startswith("https://"):
        image_url = image_path
    else:
        suffix = pathlib.Path(image_path).suffix.lstrip(".").lower() or "png"
        if suffix == "jpg":
            suffix = "jpeg"
        b64 = base64.b64encode(pathlib.Path(image_path).read_bytes()).decode()
        image_url = "data:image/%s;base64,%s" % (suffix, b64)
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "你是公众号文章配图审核员，严格挑错，宁严勿松。"},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": image_url}},
                {"type": "text", "text": prompt},
            ]},
        ],
        "temperature": 0.1,
    }).encode("utf-8")
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=body,
        headers={
            "Authorization": "Bearer " + os.environ["DASHSCOPE_API_KEY"],
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["choices"][0]["message"]["content"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="图片路径或 URL")
    ap.add_argument("--prompt", default="", help="检查要点")
    ap.add_argument("--expected-text", default="", help="逗号分隔的期望画面文字，逐项核对")
    args = ap.parse_args()

    prompt = args.prompt or "描述这张图的内容、画面元素与风格。"
    if args.expected_text:
        expected = [t.strip() for t in args.expected_text.split(",") if t.strip()]
        prompt += "\n\n请逐项核对图中出现的文字，输出 JSON：{\"found\": {\"词\": true/false, ...}, \"wrong_text\": [图中实际出现的错误或乱码文字], \"verdict\": \"PASS|FAIL\"}。期望文字清单：" + json.dumps(expected, ensure_ascii=False)
    print(chat(prompt, args.image))


if __name__ == "__main__":
    main()
