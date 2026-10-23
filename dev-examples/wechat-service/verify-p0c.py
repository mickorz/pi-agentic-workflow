#!/usr/bin/env python3
"""wechat-p0c 程序化验证：健康监测与日志（F11 + F3；需求 §7 门禁对应项）

用法：python dev-examples/wechat-service/verify-p0c.py   （仓库根执行；前置 npm i -g pm2）

用例：
  1. 双维度聚合（F11）：service start → status 综合 healthy（进程 online + Bot connected +
     心跳新鲜 + pid 三处一致：PM2/锁/状态文件）
  2. login_required ≠ unhealthy 语义（§7.4）：单测覆盖（tests/unit/bot-status.test.ts），
     本脚本仅核对测试文件存在并跑通该文件
  3. 日志滚动（F3）：pm2-logrotate 模块 online 且配置生效（setup-logrotate.py 校验逻辑复用）
  4. 停止后状态：service stop → status 综合 stopped（不假报健康）
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parents[2]
PASS = 0
FAIL = 0


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"[PASS] {msg}")


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    print(f"[FAIL] {msg}")


def run(cmd: list[str], timeout: int = 180) -> subprocess.CompletedProcess[str]:
    exe = shutil.which(cmd[0])
    if exe:
        cmd = [exe, *cmd[1:]]
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def main() -> int:
    print(f"verify-p0c：仓库根 {REPO}")

    # 用例 1：健康聚合（真服务真 Bot）
    print("\n== 用例 1：双维度聚合 healthy ==")
    run(["pi-workflow", "wechat", "service", "stop"], timeout=120)
    start = run(["pi-workflow", "wechat", "service", "start"], timeout=180)
    if start.returncode != 0:
        bad(f"service start 退出码 {start.returncode}")
    else:
        time.sleep(55)  # 进程冷启 + Bot 连接 + 首轮心跳
        st = run(["pi-workflow", "wechat", "service", "status"], timeout=120)
        out = st.stdout
        if "综合状态：healthy" in out and "Bot 连接：connected" in out and st.returncode == 0:
            ok("综合 healthy：进程 online + Bot connected + 心跳新鲜")
        else:
            bad(f"聚合未达 healthy：{out[:300]}")

    # 用例 2：login_required/unhealthy 语义（单测）
    print("\n== 用例 2：健康语义单测（login_required ≠ unhealthy） ==")
    t = run(["node", "--import", "tsx", "--test", "tests/unit/bot-status.test.ts"], timeout=180)
    if t.returncode == 0:
        ok("bot-status 单测全绿（映射/心跳陈旧/反误报/rebind 指引）")
    else:
        bad(f"bot-status 单测失败：{t.stdout[-300:]}")

    # 用例 3：日志滚动
    print("\n== 用例 3：pm2-logrotate 滚动 ==")
    lr = run([sys.executable, "dev-examples/wechat-service/setup-logrotate.py"], timeout=600)
    if lr.returncode == 0:
        ok("pm2-logrotate online + 配置生效（每日/保留14/压缩/50M）")
    else:
        bad(f"logrotate 未就绪：{lr.stdout[-200:]}{lr.stderr[-200:]}")

    # 用例 4：停止后不假报健康
    print("\n== 用例 4：停止态 ==")
    run(["pi-workflow", "wechat", "service", "stop"], timeout=180)
    st = run(["pi-workflow", "wechat", "service", "status"], timeout=120)
    if "综合状态：stopped" in st.stdout and st.returncode == 0:
        ok("停止后综合 stopped（查询退出码 0）")
    else:
        bad(f"停止态异常：{st.stdout[:200]}")

    print("\n====")
    print(f"PASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
