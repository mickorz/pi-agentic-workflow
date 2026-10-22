#!/usr/bin/env python3
# P2-05 useRunEvents/RunEventSync E2E 冒烟（E16：断网刷新后 UI 状态重建不丢）
# phase1 刷新重建（终态 run 全量补拉）+ phase2 运行中断 Server → 重启 → 补漏收敛 interrupted
# （由 sync-e2e-suite.sh 忠实改写为 Python 3 标准库；输出契约不变）
# 注：设置 PI_WF_SKIP_BUILD=1 可跳过 npm run build（dist 已就绪时使用）。
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent
PORT = 4641
# 固定 token：Server 重启后新会话 token 会变，固定 token 保证驱动进程跨重启可用
TOKEN = "p205-fixed-token-0123456789abcdef"
BASE_URL = f"http://127.0.0.1:{PORT}"
PASS = 0
FAIL = 0
SRV_PID = None  # Popen
SRV_LOG = "/tmp/p205-sync-server.log"
DRIVER_PID = None  # Popen
PHASE2_OUT = "/tmp/p205-phase2.out"
BASE = Path(tempfile.mkdtemp(prefix="p205-sync."))


def pkill_pattern(pattern, sig=signal.SIGTERM):
    try:
        out = subprocess.run(["ps", "-ax", "-o", "pid=,command="],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return
    for line in out.splitlines():
        s = line.strip()
        if not s:
            continue
        pid_str, _, cmd = s.partition(" ")
        if pattern in cmd:
            try:
                os.kill(int(pid_str), sig)
            except (ProcessLookupError, PermissionError, ValueError):
                pass


def port_free(port, timeout=0.4):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return False
    except OSError:
        return True


def stop_server():
    # 先优雅 TERM；但 hijacked SSE 长连接会拖住优雅关停，宽限后必须 KILL 升级（E16 断网语义）
    global SRV_PID
    if SRV_PID is not None:
        try:
            os.kill(SRV_PID.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(6):
            if SRV_PID.poll() is not None:
                break
            time.sleep(0.3)
        if SRV_PID.poll() is None:
            try:
                os.kill(SRV_PID.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        SRV_PID.wait()
        SRV_PID = None
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGTERM)
    time.sleep(0.5)
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGKILL)
    for _ in range(10):
        if port_free(PORT):
            break
        time.sleep(0.3)


def http_ok(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return 200 <= r.status < 300
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError):
        return False


def start_server():
    global SRV_PID
    env = os.environ.copy()
    env["PI_WORKFLOW_TEST_RUNNER"] = "fake"
    env["PI_WORKFLOW_FAKE_DELAY_MS"] = "250"
    log = open(SRV_LOG, "wb")
    SRV_PID = subprocess.Popen(
        ["node", str(REPO / "dist/cli/index.js"), "web", "--config", str(BASE), "--port", str(PORT)],
        cwd=BASE, stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True, env=env)
    for _ in range(50):
        if http_ok(f"{BASE_URL}/api/health"):
            break
        time.sleep(0.2)
    print(f"server pid={SRV_PID.pid}")


def count(text):
    """统计驱动输出的 PASS:/FAIL: 行；DRIVER-ERROR 也计 FAIL（否则 0 断言会被误判 ALL PASS）。"""
    global PASS, FAIL
    p = len(re.findall(r"^PASS:", text, re.M))
    f = len(re.findall(r"^FAIL:", text, re.M))
    if "DRIVER-ERROR" in text:
        f += 1
    PASS += p
    FAIL += f


def cleanup():
    global DRIVER_PID
    if DRIVER_PID is not None:
        try:
            DRIVER_PID.terminate()
        except ProcessLookupError:
            pass
        DRIVER_PID = None
    stop_server()
    shutil.rmtree(BASE, ignore_errors=True)


# ---------- 工程与脚本 ----------
(BASE / "proj").mkdir(parents=True)
(BASE / "proj/ok.js").write_text(
    '''export const meta = { name: "smoke_ok", description: "single agent" };
phase("p1");
const r = await agent("ok", { label: "a1" });
return r;
''', encoding="utf-8")
(BASE / "proj/long.js").write_text(
    '''export const meta = { name: "smoke_long", description: "long run for restart window" };
phase("long");
const out = [];
for (let i = 1; i <= 80; i++) {
  out.push(await agent("step " + i, { label: "s" + i }));
}
return out.length;
''', encoding="utf-8")
(BASE / "pi-workflow.config.json").write_text(json.dumps(
    {"web": {"port": PORT, "token": TOKEN, "projectRoots": ["./proj"]}}), encoding="utf-8")

DRIVER = SCRIPT_DIR / "sync-driver.mts"


def main():
    global DRIVER_PID
    print("== 构建 dist ==")
    if os.environ.get("PI_WF_SKIP_BUILD") != "1":
        if subprocess.run(["npm", "run", "build"], cwd=REPO,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            print("FAIL: build")
            return 1
    else:
        print("[SKIP] npm run build（PI_WF_SKIP_BUILD=1）")

    start_server()

    print("== phase1：刷新重建（终态 run）==")
    env = os.environ.copy()
    env.update({"BASE_URL": BASE_URL, "TOKEN": TOKEN, "PROJECT": "proj",
                "SCRIPT": "ok.js", "PHASE": "phase1"})
    proc = subprocess.run(["npx", "tsx", str(DRIVER)], cwd=REPO, env=env,
                          capture_output=True, text=True)
    out1 = proc.stdout + proc.stderr
    print(out1, end="" if out1.endswith("\n") else "\n")
    with open("/tmp/p205-phase1.out", "w", encoding="utf-8") as f:
        f.write(out1)
    count(out1)

    print("== phase2：运行中 kill Server → 重启 → 补漏收敛 ==")
    # 驱动进程后台跑，等 WATCH-READY 再杀 Server
    env2 = os.environ.copy()
    env2.update({"BASE_URL": BASE_URL, "TOKEN": TOKEN, "PROJECT": "proj",
                 "SCRIPT": "long.js", "PHASE": "phase2"})
    phase2_log = open(PHASE2_OUT, "wb")
    DRIVER_PID = subprocess.Popen(["npx", "tsx", str(DRIVER)], cwd=REPO, env=env2,
                                  stdout=phase2_log, stderr=subprocess.STDOUT,
                                  stdin=subprocess.DEVNULL)

    def phase2_text():
        try:
            return Path(PHASE2_OUT).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    for _ in range(120):
        if "WATCH-READY" in phase2_text():
            break
        time.sleep(0.5)
    if "WATCH-READY" not in phase2_text():
        print("FAIL: 未等到 WATCH-READY")
        if DRIVER_PID is not None:
            DRIVER_PID.terminate()
        DRIVER_PID = None

    print("-- kill Server（模拟断网/进程崩溃）--")
    stop_server()
    time.sleep(1)
    print("-- 重启 Server --")
    start_server()

    if DRIVER_PID is not None:
        DRIVER_PID.wait()
        DRIVER_PID = None
    out2 = phase2_text()
    print(out2, end="" if out2.endswith("\n") else "\n")
    count(out2)

    print()
    print(f"== 结果：PASS={PASS} FAIL={FAIL} ==")
    if FAIL == 0:
        print("ALL PASS")
    else:
        print("HAS FAILURES")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        cleanup()
