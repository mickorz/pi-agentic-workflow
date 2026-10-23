#!/usr/bin/env python3
"""pm2-logrotate 安装与配置（F3；需求 §4：日志按天滚动——PM2 默认不轮转）

用法：python dev-examples/wechat-service/setup-logrotate.py
行为：幂等——已安装则仅校验配置；配置：每日 0 点滚动、保留 14 份、压缩、单文件 50M 兜底。
前提：npm i -g pm2；Windows 下 pm2 install 模块需 bun.exe 可被无 shell spawn（本脚本检测并提示）。
"""

from __future__ import annotations

import shutil
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CONF = {
    "rotateInterval": "0 0 * * *",
    "retain": "14",
    "compress": "true",
    "max_size": "50M",
}


def run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess[str]:
    exe = shutil.which(cmd[0])
    if exe:
        cmd = [exe, *cmd[1:]]
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def main() -> int:
    mods = run(["pm2", "jlist"])
    if "pm2-logrotate" not in mods.stdout:
        print("未安装 pm2-logrotate，执行 pm2 install …")
        r = run(["pm2", "install", "pm2-logrotate"])
        if r.returncode != 0:
            print(f"[FAIL] 安装失败：{r.stderr[-300:]}")
            print("提示（Windows）：pm2 7 模块安装器优先 spawn bun——需 bun.exe 在 PATH（npm i -g bun 后")
            print("复制 node_modules/bun/bin/bun.exe 到 npm-global 根，否则 spawn ENOENT）")
            return 1
    for key, value in CONF.items():
        run(["pm2", "set", f"pm2-logrotate:{key}", value])
    # 校验：逐 key 查当前值（pm2 conf <key> 输出含实际值；无模块帮助模板干扰）
    missing = []
    for key, value in CONF.items():
        cur = run(["pm2", "conf", f"pm2-logrotate:{key}"]).stdout
        if str(value) not in cur:
            missing.append(key)
    if missing:
        print(f"[FAIL] 配置未生效：{missing}")
        return 1
    print(f"[PASS] pm2-logrotate 已就绪：{CONF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
