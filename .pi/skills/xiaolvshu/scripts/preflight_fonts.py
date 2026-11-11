#!/usr/bin/env python3
"""xiaolvshu 渲染字体预置：预下载 guizang render.mjs 字体内嵌所需 TTF 到本地缓存。

解决：字体内嵌从 raw.githubusercontent.com 下载 Noto Serif/Sans SC 国内直连超时，
workflow 里 300s 强杀直接 fail。本脚本走代理预置全部 TTF 后，embed 渲染全程离线。

用法：
  python3 preflight_fonts.py                     # 默认代理 http://127.0.0.1:7897
  python3 preflight_fonts.py --proxy direct      # 直连（不走代理）
  python3 preflight_fonts.py --proxy http://x:1  # 自定义代理

输出契约：逐文件 [OK]/[SKIP]/[FAIL]，结尾 === FONTS READY ===（全就绪）或 === FONTS INCOMPLETE ===。
标准库实现，零第三方依赖。字体清单更新自 gz-fonts.mjs 内嵌 manifest（pin 变更时同步本表）。
"""
import argparse
import hashlib
import os
import re
import sys
import urllib.request

PIN = "6157dfaa640ca5738b4d1a7070fe389c3036d7fc"
PIN12 = PIN[:12]
RAW_BASE = f"https://raw.githubusercontent.com/google/fonts/{PIN}"

# in-use 字体清单（与 guizang gz-fonts.mjs 内嵌 manifest 一致；editorial 模板 data-gz-fonts 5 个 id）
FONTS = [
    ("playfair-display", "ofl/playfairdisplay/PlayfairDisplay[wght].ttf"),
    ("playfair-display", "ofl/playfairdisplay/PlayfairDisplay-Italic[wght].ttf"),
    ("noto-serif-sc", "ofl/notoserifsc/NotoSerifSC[wght].ttf"),
    ("source-serif-4", "ofl/sourceserif4/SourceSerif4[opsz,wght].ttf"),
    ("source-serif-4", "ofl/sourceserif4/SourceSerif4-Italic[opsz,wght].ttf"),
    ("noto-sans-sc", "ofl/notosanssc/NotoSansSC[wght].ttf"),
    ("ibm-plex-mono", "ofl/ibmplexmono/IBMPlexMono-Regular.ttf"),
    ("ibm-plex-mono", "ofl/ibmplexmono/IBMPlexMono-Medium.ttf"),
    ("ibm-plex-mono", "ofl/ibmplexmono/IBMPlexMono-SemiBold.ttf"),
]

TTF_MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"true")


def cache_dir() -> str:
    env = os.environ.get("GUIZANG_FONT_CACHE")
    if env:
        return env
    home = os.path.expanduser("~")
    return os.path.join(home, ".cache", "guizang-design", "fonts")


def cache_path(path: str) -> str:
    # 与 gz-fonts.mjs cachePath 一致：pin 前 12 位 + path 中 [] 替换为 _
    rel = path.replace("[", "_").replace("]", "_")
    return os.path.join(cache_dir(), PIN12, rel)


def is_ttf(data: bytes) -> bool:
    return data[:4] in TTF_MAGIC


def main() -> int:
    ap = argparse.ArgumentParser(description="guizang 渲染字体预置")
    ap.add_argument("--proxy", default="http://127.0.0.1:7897",
                    help="下载代理（默认 http://127.0.0.1:7897；传 direct 直连）")
    ap.add_argument("--skill-root", default=None,
                    help="guizang skill 根目录（默认自动探测仓库内 thirdparties/guizang-social-card-skill）")
    args = ap.parse_args()

    cache = cache_dir()
    print(f"[i] 字体缓存目录: {cache}")

    # skill fonts/ 目录（fetchFont 首次写 lock.json 需要）
    skill_root = args.skill_root
    if not skill_root:
        # 自动探测：从本脚本向上找仓库根，再进 thirdparties
        here = os.path.dirname(os.path.abspath(__file__))
        repo = here
        for _ in range(4):
            repo = os.path.dirname(repo)
            cand = os.path.join(repo, "thirdparties", "guizang-social-card-skill")
            if os.path.isdir(cand):
                skill_root = cand
                break
    if not skill_root or not os.path.isdir(skill_root):
        print("[FAIL] 未找到 guizang-social-card-skill 目录，用 --skill-root 指定")
        return 1
    fonts_meta_dir = os.path.join(skill_root, "fonts")
    os.makedirs(fonts_meta_dir, exist_ok=True)

    proxy = None if args.proxy == "direct" else args.proxy
    if proxy:
        handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        opener = urllib.request.build_opener(handler)
        urllib.request.install_opener(opener)
        print(f"[i] 代理: {proxy}")

    ok = skip = fail = 0
    for font_id, path in FONTS:
        dest = cache_path(path)
        url = f"{RAW_BASE}/{path}"
        if os.path.exists(dest) and os.path.getsize(dest) > 10000:
            print(f"[SKIP] {font_id}: {os.path.basename(dest)} 已缓存")
            skip += 1
            continue
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            req = urllib.request.Request(url, headers={"User-Agent": "python-urllib"})
            data = urllib.request.urlopen(req, timeout=120).read()
            if not is_ttf(data):
                raise ValueError(f"非 TTF 内容（{data[:4]!r}），可能被拦截页替换")
            tmp = dest + ".part"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, dest)
            print(f"[OK] {font_id}: {os.path.basename(dest)} {len(data)} bytes")
            ok += 1
        except Exception as e:  # noqa: BLE001 — 逐文件容错，结尾汇总
            print(f"[FAIL] {font_id}: {url}\n       {e}")
            fail += 1

    # sha256 摘要（供人工核对 gz-fonts lock.json；fetchFont 首次运行会自写 lock）
    print("[i] sha256（lock.json 校验参考）:")
    for font_id, path in FONTS:
        dest = cache_path(path)
        if os.path.exists(dest):
            digest = hashlib.sha256(open(dest, "rb").read()).hexdigest()
            print(f"    {PIN12}/{path}  {digest[:16]}…")

    if fail:
        print(f"=== FONTS INCOMPLETE ===（OK={ok} SKIP={skip} FAIL={fail}；失败文件修复网络后重跑）")
        return 1
    print(f"=== FONTS READY ===（OK={ok} SKIP={skip}；embed 渲染可全程离线）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
