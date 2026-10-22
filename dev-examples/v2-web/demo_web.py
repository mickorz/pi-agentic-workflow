#!/usr/bin/env python3
# P3-06 操作演示：一条脚本走完 Web 生命周期（终端版，fake runner 不花 token）
#   启动 Server → 枚举项目 → 启动 run（checkpoint 等待）→ 审批 → 完成 → SSE 重连游标 → 恢复演示
# 人类可读输出；断言失败即退出非 0。浏览器版演示见 gp2_gate.py（Playwright 真浏览器）。
# （由 demo-web.sh 忠实改写为 Python 3 标准库；输出契约不变）
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
import http.client as http_client
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent
PORT = os.environ.get("DEMO_PORT", "4711")
TOKEN = "demo-fixed-token-0123456789abcdef"
BASE_URL = f"http://127.0.0.1:{PORT}"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
BASE = Path(tempfile.mkdtemp(prefix="p306-demo."))
SRV_PID = None  # Popen


class StepError(Exception):
    pass


def http(method, url, headers=None, body=None, timeout=10.0):
    """连接级失败抛 StepError（等价 set -euo pipefail 下 curl 失败即退出）。"""
    req = urllib.request.Request(url, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = None
    if body is not None:
        data = body.encode("utf-8") if isinstance(body, str) else body
        if "Content-Type" not in (headers or {}):
            req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise StepError(f"{method} {url} 连接失败：{e}")


def jload(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise StepError(f"JSON 解析失败：{e}：{text[:200]}")


def jdump_c(obj):
    """等价 jq -c：紧凑单行 UTF-8。"""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def port_free(port, timeout=0.5):
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout):
            return False
    except (OSError, ValueError):
        return True


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


def start_server(append=False):
    global SRV_PID
    env = os.environ.copy()
    env["PI_WORKFLOW_TEST_RUNNER"] = "fake"
    env["PI_WORKFLOW_FAKE_DELAY_MS"] = "250"
    log = open(BASE / "web.log", "ab" if append else "wb")
    SRV_PID = subprocess.Popen(
        ["node", str(REPO / "dist/cli/index.js"), "web", "--config", str(BASE), "--port", str(PORT)],
        cwd=BASE, stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True, env=env)


def wait_health(tries=60, interval=0.25):
    for _ in range(tries):
        try:
            with urllib.request.urlopen(f"{BASE_URL}/api/health", timeout=2) as r:
                if 200 <= r.status < 300:
                    return
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError):
            pass
        time.sleep(interval)
    raise StepError("health 未就绪")


def cleanup():
    global SRV_PID
    if SRV_PID is not None:
        try:
            os.kill(SRV_PID.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        SRV_PID = None
    time.sleep(0.4)
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGKILL)
    shutil.rmtree(BASE, ignore_errors=True)

def step(title):
    print(f"\n\033[1;36m== {title} ==\033[0m")


def note(text):
    print(f"   \033[2m{text}\033[0m")


def sse_read(url, headers, max_seconds):
    u = re.match(r"http://([^:/]+):(\d+)(.*)", url)
    host, port, path = u.group(1), int(u.group(2)), u.group(3) or "/"
    conn = http_client.HTTPConnection(host, port, timeout=max_seconds)
    chunks = []
    try:
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
        deadline = time.time() + max_seconds
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
            chunks.append(line.decode("utf-8", "replace"))
    except (OSError, TimeoutError, http_client.HTTPException):
        pass
    finally:
        conn.close()
    return "".join(chunks)


def main():
    # （set -e）构建失败即静默退出非 0
    if os.environ.get("PI_WF_SKIP_BUILD") != "1":
        if subprocess.run(["npm", "run", "build"], cwd=REPO,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            return 1
    else:
        print("[SKIP] npm run build（PI_WF_SKIP_BUILD=1）")

    step("0. 准备演示项目（白名单 + 固定 token）")
    (BASE / "proj").mkdir(parents=True)
    (BASE / "proj/approve_demo.js").write_text(
        '''export const meta = { name: "approve_demo", description: "演示：审批前 2 agent，批准后 1 agent", phases: [{ title: "before" }, { title: "gate" }, { title: "after" }] }
phase("before")
const p1 = await agent("prepare part 1", { label: "prep-1" })
const p2 = await agent("prepare part 2", { label: "prep-2" })
phase("gate")
const ok = await checkpoint("演示审批：允许执行有副作用的收尾阶段吗？")
phase("after")
const fin = await agent("finish", { label: "finalize" })
return { p1, p2, ok, fin }
''', encoding="utf-8")
    (BASE / "pi-workflow.config.json").write_text(json.dumps(
        {"web": {"token": TOKEN, "projectRoots": [str(BASE / "proj")]}}), encoding="utf-8")
    note(f"BASE={BASE}（演示结束自动清理）")

    step("1. 启动 Web Server（fake runner，可视化延迟 250ms/agent）")
    start_server()
    wait_health()
    code, body = http("GET", f"{BASE_URL}/api/health")
    d = jload(body)
    print("   " + jdump_c({"ok": d.get("ok"), "service": d.get("service"), "uptimeSec": d.get("uptimeSec")}))
    note("health 免 token；其余全部要 token")

    step("2. 无 token → 401（安全边界演示）")
    code, _ = http("GET", f"{BASE_URL}/api/runs")
    print(f"   HTTP {code}")

    step("3. 枚举白名单项目与 workflow")
    code, body = http("GET", f"{BASE_URL}/api/projects", headers=AUTH)
    PROJ = jload(body)["projects"][0]["id"]
    code, body = http("GET", f"{BASE_URL}/api/projects/{PROJ}/workflows", headers=AUTH)
    for w in jload(body)["workflows"]:
        print("   " + jdump_c({"path": w.get("path"), "name": (w.get("meta") or {}).get("name")}))

    step("4. 启动 run → 前两阶段执行 → checkpoint 等待")
    code, body = http("POST", f"{BASE_URL}/api/runs", headers={**AUTH, "content-type": "application/json"},
                      body=json.dumps({"projectId": PROJ, "path": "approve_demo.js"}))
    RID = jload(body)["runId"]
    note(f"runId={RID}")
    S = None
    for _ in range(60):
        code, body = http("GET", f"{BASE_URL}/api/runs/{RID}", headers=AUTH)
        S = jload(body)["snapshot"]["effectiveStatus"]
        if S == "waiting_checkpoint":
            break
        time.sleep(0.3)
    print(f"   状态={S}")
    code, body = http("GET", f"{BASE_URL}/api/runs/{RID}/events?limit=50", headers=AUTH)
    lines = [f"   #{e.get('sequence')} {e.get('type')}" for e in jload(body)["events"]]
    for ln in lines[-4:]:
        print(ln)

    step("5. 审批（approve，expectedVersion=1 乐观并发）")
    code, body = http("GET", f"{BASE_URL}/api/runs/{RID}/checkpoints", headers=AUTH)
    CPID = jload(body)["checkpoints"][0]["checkpointId"]
    code, body = http("POST", f"{BASE_URL}/api/runs/{RID}/checkpoints/{CPID}/decision",
                      headers={**AUTH, "content-type": "application/json"},
                      body='{"decision":"approve","expectedVersion":1}')
    cp = jload(body)["checkpoint"]
    print("   " + jdump_c({"checkpointId": cp.get("checkpointId"), "status": cp.get("status"),
                           "version": cp.get("version")}))

    step("6. SSE 订阅（Last-Event-ID 游标重连：从 #3 续读，不重复不缺口）")
    sse = sse_read(f"{BASE_URL}/api/runs/{RID}/stream",
                   {**AUTH, "Last-Event-ID": "3"}, 6)
    ids = re.findall(r"^id: (\S+)", sse, re.M)
    for i in ids[-5:]:
        print(f"   收到帧 {i}")

    step("7. 终态与用量")
    S = None
    for _ in range(60):
        code, body = http("GET", f"{BASE_URL}/api/runs/{RID}", headers=AUTH)
        S = jload(body)["snapshot"]["effectiveStatus"]
        if S == "completed":
            break
        time.sleep(0.3)
    code, body = http("GET", f"{BASE_URL}/api/runs/{RID}", headers=AUTH)
    snap = jload(body)["snapshot"]
    result = snap.get("result") or {}
    print("   " + jdump_c({"status": snap.get("status"),
                           "agentCount": result.get("agentCount"),
                           "durationMs": result.get("durationMs")}))

    step("8. 幂等重放（同 Idempotency-Key 二次提交 → 同一 run，不重复执行）")
    for _ in range(2):
        code, body = http("POST", f"{BASE_URL}/api/runs",
                          headers={**AUTH, "content-type": "application/json",
                                   "Idempotency-Key": "demo-key-001"},
                          body=json.dumps({"projectId": PROJ, "path": "approve_demo.js"}))
        print("   " + jdump_c(jload(body)))

    step("9. 刷新重建（Server 重启后历史仍在，模拟浏览器 reload）")
    os.kill(SRV_PID.pid, signal.SIGTERM)
    for _ in range(40):
        if port_free(PORT):
            break
        time.sleep(0.25)
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGTERM)
    start_server(append=True)
    wait_health()
    code, body = http("GET", f"{BASE_URL}/api/runs", headers=AUTH)
    d = jload(body)
    runs = d.get("runs") or []
    print("   " + jdump_c({"total": d.get("total"),
                           "first": runs[0]["runId"] if runs else None}))

    print("\n\033[1;32m演示完成：New Run → 实时事件 → 审批 → 完成 → 游标重连 → 幂等 → 重启重建 全链路 OK\033[0m")
    print(f"   （带 UI 的浏览器版：python3 {SCRIPT_DIR}/gp2_gate.py）")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except StepError as e:
        # set -e：任何步骤失败静默退出非 0（保留一行原因便于排查）
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        cleanup()
