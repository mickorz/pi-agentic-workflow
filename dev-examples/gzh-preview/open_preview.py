#!/usr/bin/env python3
"""gzh-preview 工作台免粘贴打开器（G.5 排版审阅用）。

代替"给用户 URL+token 让他手贴 TokenGate"：用 chrome-use 在用户 Chrome 里
开标签页 → 写入 localStorage token → 跳转目标页，用户只需看已经登录的页面。

前置：chrome-use 可用且 relay CONNECTED（可先跑 preflight_relay.py 预检）；
token 读取 pi-workflow.config.json 的 web.token（固定 token，gitignore）。

输出契约：[OK] / [FAIL] 行 + 指引；exit 0=成功，1=失败。
用法:
    python3 open_preview.py                          # 打开工作台首页
    python3 open_preview.py --dir <文章目录绝对路径>   # 直接进指定文章预览
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request

CANDIDATES = ("chrome-use", "agent-browser", "agent-browser-stealth", "abs")
TOKEN_KEY = "pi-workflow-web.token"  # 与 web/src/api/auth.ts TOKEN_KEY 保持一致
TIMEOUT_SECONDS = 30


def find_binary():
    for name in CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def load_config(repo_root):
    path = os.path.join(repo_root, "pi-workflow.config.json")
    if not os.path.exists(path):
        return None, path
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    web = cfg.get("web") or {}
    return web, path


def main():
    parser = argparse.ArgumentParser(description="chrome-use 免粘贴打开 gzh-preview")
    parser.add_argument("--dir", default=None, help="文章目录绝对路径（直接进该文章预览）")
    args = parser.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    web, cfg_path = load_config(repo_root)
    if not web or not web.get("token"):
        print("[FAIL] 未读到 pi-workflow.config.json 的 web.token（固定 token 未配置）")
        print("指引：写入 {\"web\": {\"host\": \"127.0.0.1\", \"port\": 4317, \"token\": \"<高熵随机串>\"} 后重试")
        return 1
    host = web.get("host", "127.0.0.1")
    port = int(web.get("port", 4317))
    token = web["token"]

    # 服务存活检查（免 token 的 health 端点）
    try:
        with urllib.request.urlopen("http://%s:%d/api/health" % (host, port), timeout=3) as resp:
            if resp.status != 200:
                raise OSError("status %d" % resp.status)
    except Exception as exc:  # noqa: BLE001
        print("[FAIL] web 服务不可达 http://%s:%d/api/health（%s）" % (host, port, exc))
        print("指引：先启动 pi-workflow web 再重试")
        return 1

    binary = find_binary()
    if binary is None:
        print("[FAIL] 未找到 chrome-use（也没有旧名 agent-browser 等别名）")
        print("指引：见 dev-docs/experience/chrome-use-relay-not-connected-upgrade-1-5.md")
        return 1

    origin = "http://%s:%d/" % (host, port)
    target = "http://%s:%d/gzh-preview" % (host, port)
    if args.dir:
        from urllib.parse import quote
        target += "?dir=" + quote(args.dir, safe="")

    steps = [
        ["open", origin],
        ["eval", "localStorage.setItem('%s', %s); 'set'" % (TOKEN_KEY, json.dumps(token))],
        ["open", target],
    ]
    for argv in steps:
        proc = subprocess.run([binary] + argv, capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
        if proc.returncode != 0:
            print("[FAIL] chrome-use %s 失败（exit %d）" % (argv[0], proc.returncode))
            print((proc.stdout or "")[-400:])
            print((proc.stderr or "")[-400:])
            print("指引：确认 Chrome 开着且 relay 扩展在线（preflight_relay.py 预检）；不要为此杀 Chrome")
            return 1

    print("[OK] 已在 Chrome 打开（token 已注入，无需粘贴）: " + target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
