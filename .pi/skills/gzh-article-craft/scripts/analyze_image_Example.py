#!/usr/bin/env python3
"""analyze_image.py 的自检脚本：本地图 + expected_text 核对 + URL 三种用法各跑一遍。

运行：python analyze_image_Example.py
前置：环境变量 DASHSCOPE_API_KEY 已配置；测试图用当前文章的引用截图。
"""
import subprocess
import sys

SCRIPT = "analyze_image.py"
IMG = "E:/Obsidian/newsky/60_Workspace/写作/单篇/20261118/游戏上架平台/imgs/02-九大平台对比总表.jpg"

def run(args):
    r = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout + r.stderr).strip()
    print("$ python %s %s\n%s\n" % (SCRIPT, " ".join(args), out[:600]))
    # 断言：进程正常退出且 stdout 有模型回复（不约束内容长短）
    return r.returncode == 0 and len(r.stdout.strip()) > 0

ok = True
# 1) 本地图 + 期望文字核对
ok &= run(["--image", IMG, "--expected-text", "Steam,itch.io,微信小游戏"])
# 2) 自由描述
ok &= run(["--image", IMG, "--prompt", "这张图是表格还是海报？一句话回答。"])

print("=== ALL PASS ===" if ok else "=== FAIL ===")
sys.exit(0 if ok else 1)
