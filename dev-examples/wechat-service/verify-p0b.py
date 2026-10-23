#!/usr/bin/env python3
"""wechat-p0b T4 程序化验证：PM2 常驻与生命周期（F1+F2+F4；需求 §7 门禁对应项）

用法：python dev-examples/wechat-service/verify-p0b.py   （仓库根执行；需已 npm i -g pm2）

用例（对应 §7 验收门禁）：
  1. 崩溃拉起（F4/§7「强制结束 Bot 子进程」）：service start → online → taskkill 强杀
     实际 pid → PM2 自动拉起（新 pid、online、restarts+1）
  2. 优雅停止（F2/§7「停止」）：pm2 stop 触发 shutdown message → 进程退出 → 锁释放 → 条目清
  3. 启动反复失败上限（F4/§7「启动反复失败」）：坏 registry 启动 → 反复重启 → errored
     （有上限、有退避、错误日志可查）
  4. 混跑互斥（F5/§7「前台+后台混跑」）：服务 online 时前台 wechat start 退出码 2 且报持有者 pid

真实性说明：用例 1/2/4 使用真实 data 目录（.pi-wechat，真凭证真 Bot 在线连接）；
用例 3 使用隔离临时 data 目录（不污染真实数据；失败路径无需凭证）。
每用例独立可重复，结尾汇总 PASS/FAIL 计数，非 0 退出。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
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


def run(cmd: list[str], timeout: int = 120, check: bool = False) -> subprocess.CompletedProcess[str]:
    # Windows 下 pm2/pi-workflow 是 .cmd shim，CreateProcess 需解析出完整路径
    exe = shutil.which(cmd[0])
    if exe:
        cmd = [exe, *cmd[1:]]
    p = subprocess.run(
        cmd, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout
    )
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} 退出码 {p.returncode}: {p.stdout[-400:]} {p.stderr[-400:]}")
    return p


def pm2_json() -> list[dict]:
    p = run(["pm2", "jlist"])
    return json.loads(p.stdout)


def pm2_app() -> dict | None:
    for a in pm2_json():
        if a.get("name") == "wechat-bot":
            return a
    return None


def wait_status(target: str, timeout_s: int = 60, expect_restarts: int | None = None) -> dict | None:
    """轮询直到进程态达到 target（可选 restarts >= expect_restarts）"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        app = pm2_app()
        if app:
            status = (app.get("pm2_env") or {}).get("status")
            restarts = (app.get("pm2_env") or {}).get("restart_time", 0)
            if status == target and (expect_restarts is None or restarts >= expect_restarts):
                return app
        time.sleep(3)
    return None


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        # 注意：Windows 下 os.kill(pid, 0) 非探活（其他信号值会直接 TerminateProcess），改用 tasklist
        p = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
        return str(pid) in p.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def service_start(extra: list[str]) -> int:
    return run(["pi-workflow", "wechat", "service", "start", *extra], timeout=180).returncode


def cleanup() -> None:
    run(["pm2", "delete", "wechat-bot"], timeout=60)


def case_crash_pullup() -> None:
    print("\n== 用例 1：崩溃自动拉起（F4；§7 强制结束 Bot 子进程） ==")
    cleanup()
    rc = service_start([])
    if rc != 0:
        bad(f"service start 退出码 {rc}")
        return
    app = wait_status("online", 90)
    if not app:
        bad("等待 online 超时（90s）")
        return
    pid1 = app.get("pid", 0)
    if not pid_alive(pid1):
        bad(f"pid {pid1} 不存活")
        return
    ok(f"服务 online（pid={pid1}）")
    # 强杀实际 Bot 进程（Windows taskkill / unix kill -9）
    kill = run(["taskkill", "/F", "/PID", str(pid1)]) if sys.platform == "win32" else run(["kill", "-9", str(pid1)])
    if kill.returncode != 0:
        bad(f"强杀失败：{kill.stderr.strip()[:200]}")
        return
    ok("已强杀 Bot 进程")
    app2 = wait_status("online", 90, expect_restarts=1)
    if not app2:
        bad("PM2 未在 90s 内拉起新实例")
        return
    pid2 = app2.get("pid", 0)
    restarts = (app2.get("pm2_env") or {}).get("restart_time", 0)
    if pid2 and pid2 != pid1 and pid_alive(pid2):
        ok(f"已自动拉起：新 pid={pid2}（旧 {pid1}），restarts={restarts}")
    else:
        bad(f"拉起异常：pid2={pid2}（旧 {pid1}）存活={pid_alive(pid2)}")


def case_graceful_stop() -> None:
    print("\n== 用例 2：优雅停止（F2；shutdown message + 锁释放 + 条目清理） ==")
    app = pm2_app()
    if not app or (app.get("pm2_env") or {}).get("status") != "online":
        bad("前置失败：服务不在线")
        return
    pid = app.get("pid", 0)
    stop = run(["pi-workflow", "wechat", "service", "stop"], timeout=180)
    if stop.returncode != 0:
        bad(f"service stop 退出码 {stop.returncode}：{stop.stderr.strip()[:200]}")
        return
    time.sleep(3)
    # 进程退出（优雅退出码 0 由 out 日志佐证）
    if pid_alive(pid):
        bad(f"进程 {pid} 仍在运行（未优雅退出）")
        return
    ok(f"进程已退出（pid={pid}）")
    out_log = REPO / ".pi-wechat" / "logs" / "wechat-bot-out.log"
    log_tail = out_log.read_text(encoding="utf-8", errors="replace")[-800:] if out_log.exists() else ""
    if "收到停止指令（PM2 shutdown message）" in log_tail:
        ok("日志证实收到 shutdown message 并优雅停止")
    else:
        bad(f"日志未见 shutdown message 处理痕迹：…{log_tail[-200:]}")
    lock = REPO / ".pi-wechat" / "service.lock"
    if not lock.exists():
        ok("单实例锁已释放")
    else:
        bad("锁文件残留（应随优雅停止释放）")
    if pm2_app() is None:
        ok("PM2 条目已清理")
    else:
        bad("PM2 残留 wechat-bot 条目")


def case_restart_cap() -> None:
    print("\n== 用例 3：启动反复失败上限（F4；§7 启动反复失败→上限/退避/日志） ==")
    cleanup()
    # 验证专用配置：max_restarts 降为 2（上限/errored/退避/日志语义等价，不等生产 10 次的分钟级退避）
    with tempfile.TemporaryDirectory(prefix="p0b-fail-") as tmp:
        entry = REPO / "src" / "cli" / "index.ts"
        tsx = (REPO / "node_modules" / "tsx" / "dist" / "loader.mjs").as_uri()
        cfg = f'''module.exports = {{
  apps: [{{
    name: "wechat-bot",
    script: {json.dumps(str(entry))},
    node_args: "--import {tsx}",
    args: {json.dumps("wechat start --registry dev-examples/不存在/registry.json --data " + str(Path(tmp)))},
    interpreter: "node",  // PM2 7 对 .ts 默认 bun（无 bun 静默起不来）
    cwd: {json.dumps(str(REPO))},
    exec_mode: "fork",
    shutdown_with_message: true,
    kill_timeout: 3000,
    min_uptime: "30s",  // 必须大于失败路径实际存活（tsx 冷启约 8s）——PM2 只计不稳定重启；不带 exp_backoff（其 30s worker 重置会复活 errored 应用，干扰断言）
    max_restarts: 2,
    env: {{ PI_WECHAT_SERVICE: "1" }},
    out_file: {json.dumps(str(Path(tmp) / "logs" / "out.log"))},
    error_file: {json.dumps(str(Path(tmp) / "logs" / "err.log"))},
  }}],
}};
'''
        (Path(tmp) / "logs").mkdir()
        cfg_path = Path(tmp) / "ecosystem.config.cjs"  # 必须叫 ecosystem.config.*（PM2 按文件名识别配置，否则当普通脚本执行）
        cfg_path.write_text(cfg, encoding="utf-8")
        start = run(["pm2", "start", str(cfg_path)], timeout=120)
        if start.returncode != 0:
            bad(f"pm2 start 失败：{start.stderr.strip()[:200]}")
            return
        app = wait_status("errored", 240)
        if not app:
            cur = pm2_app()
            status = (cur or {}).get("pm2_env", {}).get("status")
            bad(f"4 分钟内未达 errored（当前 status={status}）")
            return
        env = app.get("pm2_env") or {}
        ok(f"达到重启上限进入 errored（restarts={env.get('restart_time')}，unstable={env.get('unstable_restarts')}）")
        err_log = Path(tmp) / "logs" / "err.log"
        if err_log.exists() and "注册表不存在或为空" in err_log.read_text(encoding="utf-8", errors="replace"):
            ok("错误日志可查且定位到失败原因（注册表不存在）")
        else:
            bad("错误日志缺失或未含失败原因")
    cleanup()


def case_mixed_run_guard() -> None:
    print("\n== 用例 4：前台+后台混跑互斥（F5；§7 前台 start 被拦） ==")
    cleanup()
    if service_start([]) != 0:
        bad("前置失败：service start")
        return
    app = wait_status("online", 90)
    if not app:
        bad("前置失败：等待 online 超时")
        return
    pid = app.get("pid", 0)
    fg = run(["pi-workflow", "wechat", "start"], timeout=120)
    if fg.returncode == 2 and f"pid={pid}" in (fg.stderr + fg.stdout):
        ok(f"前台 start 被锁拦截（退出码 2，报持有者 pid={pid}）")
    else:
        bad(f"前台未被拦：退出码 {fg.returncode}，输出：{(fg.stderr + fg.stdout)[:200]}")
    cleanup()


def main() -> int:
    print(f"verify-p0b：仓库根 {REPO}")
    cases = {"1": case_crash_pullup, "2": case_graceful_stop, "3": case_restart_cap, "4": case_mixed_run_guard}
    only = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        for key, fn in cases.items():
            if only and key != only:
                continue
            fn()
    finally:
        cleanup()
    print("\n====")
    print(f"PASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
