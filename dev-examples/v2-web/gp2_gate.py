#!/usr/bin/env python3
# G-P2 浏览器验收门：真实 Chromium 驱动 Web 工作台全流程（TokenGate→New Run→实时→审批→拒绝→刷新重建→浏览器关闭 Worker 存活）。
# （由 gp2-gate.sh 忠实改写为 Python 3 标准库；输出契约不变）
# 注：设置 PI_WF_SKIP_BUILD=1 可跳过 npm run build（repo dist 与 web 产物均已就绪时使用）。
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent
BASE = Path(tempfile.mkdtemp(prefix="gp2."))
PORT = 4651
WEB_PORT = 5199
TOKEN = "gp2-fixed-token-123456"
PASS = 0
FAIL = 0
SERVER_PROC = None
VITE_PROC = None


def cleanup():
    global SERVER_PROC, VITE_PROC
    if VITE_PROC is not None:
        try:
            os.killpg(VITE_PROC.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        VITE_PROC = None
    if SERVER_PROC is not None:
        try:
            SERVER_PROC.terminate()
        except ProcessLookupError:
            pass
    time.sleep(0.5)
    if SERVER_PROC is not None:
        try:
            os.kill(SERVER_PROC.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        SERVER_PROC = None
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGTERM)
    pkill_pattern(f"vite --port {WEB_PORT}", signal.SIGTERM)
    shutil.rmtree(BASE, ignore_errors=True)


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


def count(out):
    global PASS, FAIL
    if "PASS=" in out:
        p = re.search(r"PASS=(\d+)", out)
        f = re.search(r"FAIL=(\d+)", out)
        PASS += int(p.group(1)) if p else 0
        FAIL += int(f.group(1)) if f else 0
    else:
        FAIL += 1


def http_ok(url, timeout=5.0):
    """等价 curl -sf：仅 2xx 算成功。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return 200 <= r.status < 300
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError):
        return False


def main():
    global SERVER_PROC, VITE_PROC
    print(f"== G-P2 浏览器门 BASE={BASE} ==")

    # 1) 准备项目脚本（agent/parallel/verify/checkpoint/长流程）
    (BASE / "proj").mkdir(parents=True)
    (BASE / "proj/par.js").write_text(
        '''export const meta = { name: "par_demo", description: "phase + parallel agents" };
phase("fan-out")
const [a, b] = await parallel([
  () => agent("A", { label: "pa" }),
  () => agent("B", { label: "pb" }),
])
return { a, b }
''', encoding="utf-8")
    (BASE / "proj/cpv.js").write_text(
        '''export const meta = { name: "cpv_demo", description: "verify + checkpoint + agent" };
const v = await verify("1+1=2")
const ok = await checkpoint("允许继续吗？")
const r = await agent("after-cp")
return { real: v.real, ok, r }
''', encoding="utf-8")
    (BASE / "proj/long.js").write_text(
        '''export const meta = { name: "long_demo", description: "40 agents" };
phase("loop")
const out = []
for (let i = 0; i < 40; i++) out.push(await agent("step " + i, { label: "s" + i }))
return { steps: out.length }
''', encoding="utf-8")
    (BASE / "pi-workflow.config.json").write_text(json.dumps(
        {"web": {"port": PORT, "token": TOKEN, "projectRoots": ["./proj"]}}), encoding="utf-8")

    # 2) 构建产物（Server 走 dist；Web 用 vite dev 代理）
    if os.environ.get("PI_WF_SKIP_BUILD") != "1":
        if subprocess.run(["npm", "run", "build"], cwd=REPO,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            print("FAIL: dist build")
            return 1
        if subprocess.run(["npm", "run", "build"], cwd=REPO / "web",
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            print("FAIL: web build")
            return 1
    else:
        print("[SKIP] npm run build（PI_WF_SKIP_BUILD=1）")

    # 3) 启动 Server（fake runner 250ms/agent）与 vite dev
    env = os.environ.copy()
    env["PI_WORKFLOW_TEST_RUNNER"] = "fake"
    env["PI_WORKFLOW_FAKE_DELAY_MS"] = "250"
    SERVER_PROC = subprocess.Popen(
        ["node", str(REPO / "dist/cli/index.js"), "web", "--config", str(BASE)],
        cwd=BASE, stdout=open(BASE / "server.log", "wb"), stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True, env=env)
    env2 = os.environ.copy()
    env2["PI_WORKFLOW_WEB_PROXY_TARGET"] = f"http://127.0.0.1:{PORT}"
    VITE_PROC = subprocess.Popen(
        ["npx", "vite", "--port", str(WEB_PORT), "--strictPort"],
        cwd=REPO / "web", stdout=open(BASE / "vite.log", "wb"), stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True, env=env2)

    for _ in range(40):
        if http_ok(f"http://127.0.0.1:{PORT}/api/health"):
            break
        time.sleep(0.5)
    if not http_ok(f"http://127.0.0.1:{PORT}/api/health"):
        print("FAIL: server 未起")
        return 1
    for _ in range(60):
        if http_ok(f"http://localhost:{WEB_PORT}/"):
            break
        time.sleep(0.5)
    if not http_ok(f"http://localhost:{WEB_PORT}/"):
        tail = (BASE / "vite.log").read_text(encoding="utf-8", errors="replace").splitlines()[-3:]
        print(f"FAIL: vite 未起（{chr(10).join(tail)}）")
        return 1

    # 4) 跑浏览器验收
    env3 = os.environ.copy()
    env3["WEB_URL"] = f"http://localhost:{WEB_PORT}"
    env3["TOKEN"] = TOKEN
    env3["API"] = f"http://127.0.0.1:{PORT}"
    proc = subprocess.run(["npx", "tsx", "gp2-browser.mts"],
                          cwd=SCRIPT_DIR, env=env3,
                          capture_output=True, text=True)
    out = proc.stdout + proc.stderr
    print(out, end="" if out.endswith("\n") else "\n")
    count(out)

    print(f"== G-P2 结果：PASS={PASS} FAIL={FAIL} ==")
    return 0 if (FAIL == 0 and PASS >= 15) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        cleanup()
