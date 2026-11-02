#!/usr/bin/env python3
"""image-use web 后端生成前的 relay 预检（gzh-article-craft F 阶段用）。

检测 chrome-use（含旧名 agent-browser 等别名）是否可用、relay 是否 CONNECTED。
输出契约：[OK] / [FAIL] / [SKIP] 行 + 中文指引；exit 0=通过，1=不通过。

用法:
    python preflight_relay.py            # 正式预检
    python preflight_relay.py --selftest # 内置解析逻辑自检（不发命令）

详见 dev-docs/experience/chrome-use-relay-not-connected-upgrade-1-5.md
（注意：无论检测结果如何，都不要杀 Chrome / 重启浏览器进程——扩展只在窗口开着时运行。）
"""
import argparse
import shutil
import subprocess
import sys

# 与 image-use 的 AB_BIN_CANDIDATES 同序：新名优先，旧名兜底
CANDIDATES = ("chrome-use", "agent-browser", "agent-browser-stealth", "abs")
TIMEOUT_SECONDS = 30


def find_binary() -> str | None:
    for name in CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def parse_browsers_output(output: str) -> bool:
    """从 `browsers` 输出判断是否有任一 profile CONNECTED=yes。"""
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[3].lower() == "yes":
            return True
    return False


def run_check() -> int:
    binary = find_binary()
    if binary is None:
        print("[FAIL] 未找到 chrome-use（也没有旧名 agent-browser 等别名）")
        print("指引：")
        print("  1. 参考经验文档 dev-docs/experience/chrome-use-relay-not-connected-upgrade-1-5.md 安装/升级 chrome-use（需 ≥1.5.0）")
        print("  2. 装好后重跑本预检")
        return 1
    try:
        proc = subprocess.run(
            [binary, "browsers"], capture_output=True, text=True, timeout=TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        print("[FAIL] chrome-use browsers 超时（daemon 可能未起）")
        print("指引：正常打开日常使用的 Chrome（扩展随浏览器自动上线），稍等几秒后重跑本预检")
        return 1
    output = proc.stdout or ""
    if parse_browsers_output(output):
        print(f"[OK] relay 已连接（{binary}）")
        return 0
    print("[FAIL] relay 未连接（无任何 profile CONNECTED=yes）")
    print("指引：")
    print("  1. 正常打开日常使用的 Chrome 窗口——relay 扩展随浏览器自动上线，不用做别的")
    print("  2. 绝不要杀 Chrome 或重启浏览器进程（杀进程修不好，只会更糟）")
    print("  3. 若打开后仍不连，运行 `" + binary + " extension install` 注册 native host 后重试")
    print("  4. 仍失败参考 dev-docs/experience/chrome-use-relay-not-connected-upgrade-1-5.md")
    return 1


def selftest() -> int:
    """解析逻辑自检：喂样例输出断言，不发真实命令。"""
    ok_table = "PROFILE  DIR      ACCOUNT  CONNECTED  DEFAULT\n用户1    Default  a@b.c    yes        *\n"
    no_table = "PROFILE  DIR      ACCOUNT  CONNECTED  DEFAULT\n用户1    Default  a@b.c    no\n"
    garbage = "relay not connected\n"
    assert parse_browsers_output(ok_table) is True
    assert parse_browsers_output(no_table) is False
    assert parse_browsers_output(garbage) is False
    assert parse_browsers_output("") is False
    print("[OK] selftest 4/4")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true", help="内置解析逻辑自检")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    return run_check()


if __name__ == "__main__":
    sys.exit(main())
