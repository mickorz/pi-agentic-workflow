#!/usr/bin/env python3
"""vd-cdp-grab.py —— CDP 方案 B 抓取器: 从已打开的抖音视频页提取媒体 URL 与元数据。

用法: python3 vd-cdp-grab.py <page-id> <out-json>
输出: JSON 文件 {audio_url, video_url, duration, title, uploader}
"""
import json
import subprocess
import sys

CDP = "/opt/homebrew/bin/cdp-cli"

# 页内脚本: performance 资源里挑 audio/video 轨 URL(取最后一条=当前视频), 元数据取 DOM
JS = (
    "(() => {"
    "const urls = performance.getEntriesByType('resource').map(e => e.name);"
    "const au = urls.filter(u => u.includes('media-audio')).pop() || '';"
    "const vi = urls.filter(u => u.includes('media-video')).pop() || '';"
    "const v = document.querySelector('video');"
    "const authorEl = document.querySelector('[data-e2e=\"video-author-name\"]') || null;"
    "return JSON.stringify({au, vi, dur: v ? Math.round(v.duration) : null,"
    " title: document.title.split(' - 抖音')[0],"
    " author: authorEl ? authorEl.textContent.trim().slice(0, 50) : ''});"
    "})()"
)


def main() -> int:
    page, out_path = sys.argv[1], sys.argv[2]
    r = subprocess.run([CDP, "eval", page, JS], capture_output=True, text=True, timeout=30)
    envelope = json.loads(r.stdout)
    if not envelope.get("success"):
        print(f"[FAIL] eval 失败: {envelope}", file=sys.stderr)
        return 1
    data = json.loads(envelope["value"])
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(
        f"[OK] dur={data['dur']}s title={data['title'][:40]!r} author={data['author']!r} "
        f"audio_url_len={len(data['au'])} video_url_len={len(data['vi'])}"
    )
    return 0 if data["au"] else 2


if __name__ == "__main__":
    sys.exit(main())
