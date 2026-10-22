#!/usr/bin/env python3
# V2-P3-07 性能基线采集（真实数据，可复现）：
#   1) Server 冷启动→health 200 耗时
#   2) Run 生命周期延迟（fake runner 固定 250ms/agent，5-agent 脚本：POST→completed）
#   3) SSE 首帧延迟（逐行带时间戳读流）
#   4) 内存：Server / Worker 进程 RSS（实抓 node 进程；Worker run 中采样）
# 用法：python3 dev-examples/v2-web/perf_baseline.py [port]
# （由 perf-baseline.sh 忠实改写为 Python 3 标准库；输出契约不变）
import http.client
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

PORT = sys.argv[1] if len(sys.argv) > 1 else "4731"
TOKEN = "perf-fixed-token-0001"
REPO = Path(__file__).resolve().parent.parent.parent
BASE = Path(tempfile.mkdtemp(prefix="v2-perf."))

(BASE / "proj").mkdir(parents=True)
(BASE / "proj/p5.js").write_text(
    '''export const meta = { name: "p5_baseline", description: "perf" }
phase("load")
const a = await agent("a", { label: "a1" })
const b = await agent("b", { label: "a2" })
const c = await agent("c", { label: "a3" })
const d = await agent("d", { label: "a4" })
const e = await agent("e", { label: "a5" })
return { a, b, c, d, e }
''', encoding="utf-8")
(BASE / "pi-workflow.config.json").write_text(json.dumps(
    {"web": {"token": TOKEN, "port": int(PORT), "projectRoots": [str(BASE / "proj")]}}),
    encoding="utf-8")

AUTH = {"Authorization": f"Bearer {TOKEN}"}
U = f"http://127.0.0.1:{PORT}"


def stop_server():
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGTERM)


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


def pgrep_first(pattern):
    """等价 pgrep -f <pattern> | head -1。"""
    try:
        out = subprocess.run(["ps", "-ax", "-o", "pid=,command="],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    for line in out.splitlines():
        s = line.strip()
        if not s:
            continue
        pid_str, _, cmd = s.partition(" ")
        if pattern in cmd:
            return int(pid_str)
    return None


def rss_kb(pid):
    """等价 ps -o rss= -p <pid>（KB）；失败返回 0。"""
    if pid is None:
        return 0
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        return int(out) if out else 0
    except (ValueError, subprocess.SubprocessError):
        return 0


def now_ms():
    return int(time.time() * 1000)


def main():
    print("== 0. 环境 ==")
    node_v = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()
    uname = subprocess.run(["uname", "-s", "-m"], capture_output=True, text=True).stdout.strip()
    date = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"   node {node_v} · {uname} · {date}")

    print("== 1. Server 冷启动 → health 200 ==")
    t0 = now_ms()
    env = os.environ.copy()
    env["PI_WORKFLOW_TEST_RUNNER"] = "fake"
    env["PI_WORKFLOW_FAKE_DELAY_MS"] = "250"
    with open("/tmp/v2-perf-server.log", "wb") as log:
        subprocess.Popen(
            ["node", str(REPO / "dist/cli/index.js"), "web", "--config", str(BASE), "--port", str(PORT)],
            cwd=BASE, stdout=log, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True, env=env)
    for _ in range(200):
        try:
            with urllib.request.urlopen(f"{U}/api/health", timeout=2) as r:
                if 200 <= r.status < 300:
                    break
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError):
            pass
        time.sleep(0.05)
    t1 = now_ms()
    STARTUP_MS = t1 - t0
    SERVER_PID = pgrep_first(f"dist/cli/index.js web --config {BASE}")
    SRSS_IDLE = rss_kb(SERVER_PID)
    print(f"   启动耗时 ≈ {STARTUP_MS}ms · pid={SERVER_PID}")
    print(f"   Server 空载 RSS ≈ {SRSS_IDLE // 1024}MB")

    print("== 2. Run 生命周期（5 agent × 250ms） ==")
    t0 = now_ms()
    req = urllib.request.Request(f"{U}/api/runs", method="POST")
    req.add_header("Authorization", AUTH["Authorization"])
    req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, data=b'{"projectId":"proj","path":"p5.js"}', timeout=10) as r:
        RID = json.loads(r.read().decode())["runId"]
    WPID = None
    WRSS = 0
    for _ in range(300):
        with urllib.request.urlopen(urllib.request.Request(
                f"{U}/api/runs/{RID}", headers=AUTH), timeout=10) as r:
            DETAIL = json.loads(r.read().decode())
        snap = DETAIL.get("snapshot") or {}
        S = snap.get("effectiveStatus")
        if WPID is None:
            P = (snap.get("manifest") or {}).get("pid")
            if P:
                WPID = P
                WRSS = rss_kb(P)
        if S == "completed":
            break
        time.sleep(0.1)
    t1 = now_ms()
    RUN_MS = t1 - t0
    print(f"   POST→completed ≈ {RUN_MS}ms（含 5×250ms 模拟延迟 + 100ms 轮询粒度）")
    print(f"   Worker RSS（run 中采样）≈ {WRSS // 1024}MB")

    print("== 3. SSE 首帧延迟（逐行时间戳） ==")
    t0 = now_ms()
    FIRST = ""
    try:
        u = re.match(r"http://([^:/]+):(\d+)(.*)", f"{U}/api/runs/{RID}/stream")
        conn = http.client.HTTPConnection(u.group(1), int(u.group(2)), timeout=30)
        conn.request("GET", u.group(3), headers=AUTH)
        resp = conn.getresponse()
        deadline = t0 / 1000.0 + 30
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            try:
                conn.sock.settimeout(remaining)
            except OSError:
                pass
            line = resp.fp.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace")
            m = re.match(r"^(id|event):", text)
            if m:
                FIRST = text.rstrip("\n")
                break
        conn.close()
    except (OSError, TimeoutError, http.client.HTTPException):
        pass
    t1 = now_ms()
    SSE_MS = t1 - t0
    first_head = FIRST.split("\n")[0] if FIRST else ""
    print(f"   首帧到达 ≈ {SSE_MS}ms（已完成 run 补传场景；帧：{first_head}）")

    print("== 4. Server run 后 RSS ==")
    SRSS_AFTER = rss_kb(SERVER_PID)
    print(f"   Server RSS ≈ {SRSS_AFTER // 1024}MB（空载 {SRSS_IDLE // 1024}MB）")

    print("== 汇总（真实采集） ==")
    print(f"""   启动→health 200   : {STARTUP_MS}ms
   5-agent run 全程  : {RUN_MS}ms
   SSE 首帧(补传)    : {SSE_MS}ms
   Server RSS 空载/后: {SRSS_IDLE // 1024}MB / {SRSS_AFTER // 1024}MB
   Worker RSS(run中) : {WRSS // 1024}MB""")
    shutil.rmtree(BASE, ignore_errors=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        stop_server()
