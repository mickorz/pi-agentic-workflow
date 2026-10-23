#!/usr/bin/env python3
"""F6 开机自启（P2；需求 §4 F6 平台差异记录：macOS=pm2 startup 官方；Windows=schtasks+pm2 resurrect 原生方案）

用法：
  python dev-examples/wechat-service/setup-autostart.py            # 启用（Windows：schtasks ONLOGON + pm2 save）
  python dev-examples/wechat-service/setup-autostart.py --remove   # 停用（删除登录任务）
  python dev-examples/wechat-service/setup-autostart.py --check    # 查看当前状态

原理：
  Windows：HKCU Run 注册表键（用户登录触发，免管理员）执行 `pm2 resurrect`，
           恢复 `pm2 save` 的进程快照——不引第三方（pm2-installer 重装 PM2 全家桶，超出需要）；
           注：schtasks ONLOGON 需管理员权限，故不用。
  macOS：  `pm2 startup`（launchd，官方路径；命令会输出需 sudo 的注册指令，本脚本代跑并回显）+ pm2 save。

注意：
  - 自启拉起的是「快照时刻在跑的应用」——改配置后需重跑 service start + 本脚本（会重新 pm2 save）。
  - 凭据失效时自启仍拉起进程，service status 会报 login_required（F10 裁决：不自动重登）。
"""

from __future__ import annotations

import shutil
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TASK_NAME = "pi-workflow-wechat-bot-pm2-resurrect"  # 仅 macOS 文档引用；Windows 用 HKCU Run 键名


def run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    exe = shutil.which(cmd[0])
    if exe:
        cmd = [exe, *cmd[1:]]
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def pm2_bin() -> str:
    exe = shutil.which("pm2")
    if not exe:
        print("[FAIL] 未找到 pm2（npm i -g pm2）")
        sys.exit(1)
    return exe


def windows_enable() -> int:
    pm2 = pm2_bin()
    save = run(["pm2", "save"])
    if save.returncode != 0:
        print(f"[FAIL] pm2 save 失败：{save.stderr[-200:]}")
        return 1
    # HKCU Run 键（免管理员）；cmd 包装避免引号解析问题
    val = f'cmd /c "{pm2}" resurrect'
    create = run(["reg", "add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "pi-workflow-wechat-bot", "/t", "REG_SZ", "/d", val, "/f"])
    if create.returncode != 0:
        print(f"[FAIL] reg add 失败：{create.stderr[-200:]}")
        return 1
    q = run(["reg", "query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "pi-workflow-wechat-bot"])
    if q.returncode != 0 or "pm2" not in q.stdout:
        print("[FAIL] 写入后查询不到（异常）")
        return 1
    print("[PASS] Windows 自启已启用：HKCU Run 键 pi-workflow-wechat-bot → pm2 resurrect（快照已 pm2 save）")
    print("      注意：之后改动服务（service start/stop）需重跑本脚本刷新快照")
    return 0


def windows_remove() -> int:
    r = run(["reg", "delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "pi-workflow-wechat-bot", "/f"])
    if r.returncode != 0 and "找不到" not in r.stderr:
        print(f"[FAIL] 删除失败：{r.stderr[-200:]}")
        return 1
    print("[PASS] 已删除用户级自启项")
    return 0


def windows_check() -> int:
    q = run(["reg", "query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "pi-workflow-wechat-bot"])
    print("[状态] 自启已启用：" + q.stdout.strip().splitlines()[-1].strip() if q.returncode == 0 else "[状态] 未启用")
    return 0


def macos_enable() -> int:
    pm2_bin()
    save = run(["pm2", "save"])
    if save.returncode != 0:
        print(f"[FAIL] pm2 save 失败：{save.stderr[-200:]}")
        return 1
    startup = run(["pm2", "startup"])
    # pm2 startup 输出含需 sudo 执行的注册命令——原样回显让用户执行
    print(startup.stdout.strip())
    if startup.stderr.strip():
        print(startup.stderr.strip())
    print("[PASS] macOS：按上方 pm2 输出的 sudo 命令注册 launchd 后自启生效（快照已 pm2 save）")
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "enable"
    if sys.platform == "win32":
        if mode == "--remove":
            return windows_remove()
        if mode == "--check":
            return windows_check()
        return windows_enable()
    if mode == "--remove":
        r = run(["pm2", "unstartup"])
        print("[PASS] 已注销 launchd 自启" if r.returncode == 0 else f"[注意] pm2 unstartup：{r.stderr[-200:]}")
        return 0
    if mode == "--check":
        r = run(["pm2", "startup", "launchd"], timeout=30)
        print("[状态] 见 pm2 输出（已注册的会提示）")
        return 0
    return macos_enable()


if __name__ == "__main__":
    sys.exit(main())
