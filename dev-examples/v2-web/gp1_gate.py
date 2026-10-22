#!/usr/bin/env python3
# V2-P1 G-P1 总验收门：真实 Web Server（dist）+ 真实 Worker 子进程（fake agent runner）。
# 覆盖：health / 幂等 start 单创建 / SSE 顺序事件 / cancel / checkpoint 审批 /
#       completed resume 409 / Server 重启历史可读 / E13 穿越 403 / 未授权 401。
# （由 gp1-gate.sh 忠实改写为 Python 3 标准库；输出契约不变）
# 注：设置 PI_WF_SKIP_BUILD=1 可跳过 npm run build（dist 已就绪时使用）。
import json
import os
import re
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
PORT = 4631
PASS = 0
FAIL = 0


def ok(desc):
    global PASS
    PASS += 1
    print(f"PASS: {desc}")


def bad(desc):
    global FAIL
    FAIL += 1
    print(f"FAIL: {desc}")


def check(desc, cond):
    if cond:
        ok(desc)
    else:
        bad(desc)


def http(method, url, headers=None, body=None, timeout=10.0):
    """返回 (status_code, text)；连接级失败返回 (0, "")。等价 curl -s -w %{http_code}。"""
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
    except (urllib.error.URLError, OSError, TimeoutError):
        return 0, ""


def jload(text):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def port_responds(port, timeout=0.5):
    """curl 成功（任何 HTTP 响应都算连通）的等价物。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def port_free(port, timeout=0.5):
    return not port_responds(port, timeout)


def pkill_pattern(pattern, sig=signal.SIGTERM):
    """等价 pkill -f <pattern>：ps 扫描命令行后逐 pid 发信号。"""
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


def build_dist():
    if os.environ.get("PI_WF_SKIP_BUILD") == "1":
        return True
    with open(BASE / "build.log", "w") as log:
        rc = subprocess.run(["npm", "run", "build"], cwd=REPO,
                            stdout=log, stderr=subprocess.STDOUT).returncode
    if rc != 0:
        print("FAIL: build")
        return False
    return True


SERVER_PROC = None


def start_server(logfile):
    """返回 True/False；等价 bash：后台 node web + 轮询 health（40×0.25s）。"""
    global SERVER_PROC
    env = os.environ.copy()
    env["PI_WORKFLOW_TEST_RUNNER"] = "fake"
    env["PI_WORKFLOW_FAKE_DELAY_MS"] = "300"
    log = open(logfile, "wb")
    SERVER_PROC = subprocess.Popen(
        ["node", str(REPO / "dist/cli/index.js"), "web", "--config", str(BASE), "--port", str(PORT)],
        cwd=BASE, stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True, env=env)
    for _ in range(40):
        if port_responds(PORT):
            return True
        time.sleep(0.25)
    return False


def stop_server():
    global SERVER_PROC
    if SERVER_PROC is not None:
        try:
            SERVER_PROC.terminate()
        except ProcessLookupError:
            pass
        SERVER_PROC = None
    # 兜底清理 node 本体（等价 pkill -f "dist/cli/index.js web --config $BASE"）
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGTERM)
    for _ in range(20):
        if port_free(PORT):
            return
        time.sleep(0.25)


BASE = Path(tempfile.mkdtemp(prefix="v2-gp1-"))
(BASE / "proj").mkdir(parents=True)

(BASE / "proj/ok.js").write_text(
    '''export const meta = { name: "ok", description: "单 agent" }
const a = await agent("hi")
return { a }
''', encoding="utf-8")
(BASE / "proj/long.js").write_text(
    '''export const meta = { name: "long", description: "40 agent 长 run（取消用）" }
const out = []
for (let i = 0; i < 40; i++) out.push(await agent(`step ${i}`))
return { n: out.length }
''', encoding="utf-8")
(BASE / "proj/cp.js").write_text(
    '''export const meta = { name: "cp", description: "checkpoint 审批" }
const a = await agent("prepare")
const ok = await checkpoint("允许继续吗？")
const b = await agent("after")
return { a, ok, b }
''', encoding="utf-8")
(BASE / "pi-workflow.config.json").write_text(json.dumps(
    {"web": {"port": PORT, "projectRoots": ["./proj"]}}), encoding="utf-8")

AUTH_HDR = None
API = f"http://127.0.0.1:{PORT}/api"


def main():
    global AUTH_HDR
    print("== 构建 dist ==")
    if not build_dist():
        sys.exit(1)

    if not start_server(BASE / "server1.log"):
        print("FAIL: server 启动")
        sys.exit(1)
    token_match = re.search(r"token（本次会话）：(.*)", (BASE / "server1.log").read_text(encoding="utf-8", errors="replace"))
    token = token_match.group(1) if token_match else ""
    AUTH_HDR = {"Authorization": f"Bearer {token}"}
    if token:
        ok("server 启动+token 提取")
    else:
        bad("token 提取")

    # 1 health
    st, _ = http("GET", f"{API}/health")
    check("G1 health 200（免 token）", st == 200)

    # 2 未授权不可读（events/list）+ E13 穿越 + 跨 Origin
    code, body = http("POST", f"{API}/runs", headers={**AUTH_HDR, "Idempotency-Key": "gp1-key-1"},
                      body='{"projectId":"proj","path":"ok.js"}')
    d = jload(body) or {}
    RUNID = d.get("runId", "")
    check("G2 幂等 start 202 且返回 runId", code == 202 and bool(RUNID))
    code, body = http("POST", f"{API}/runs", headers={**AUTH_HDR, "Idempotency-Key": "gp1-key-1"},
                      body='{"projectId":"proj","path":"ok.js"}')
    d2 = jload(body) or {}
    check("G2 同幂等键 → 同 runId+replayed", d2.get("runId") == RUNID and d2.get("replayed") is True)
    code, body = http("GET", f"{API}/runs", headers=AUTH_HDR)
    TOTAL = (jload(body) or {}).get("total")
    check("G2 幂等=单创建（total=1）", TOTAL == 1)

    st, _ = http("GET", f"{API}/runs/{RUNID}/events")
    check("G3 未授权不可读事件（401）", st == 401)
    st, _ = http("POST", f"{API}/runs", headers=AUTH_HDR,
                 body='{"projectId":"proj","path":"../../etc/passwd"}')
    check("G3 E13 路径穿越被拒（403）", st == 403)
    st, _ = http("GET", f"{API}/projects", headers={**AUTH_HDR, "Origin": "http://evil.example"})
    check("G3 跨 Origin 被拒（403）", st == 403)

    # 4 等完成 + SSE 顺序事件（断连重连补传用 Last-Event-ID）
    ST = None
    for _ in range(40):
        code, body = http("GET", f"{API}/runs/{RUNID}", headers=AUTH_HDR)
        ST = (jload(body) or {}).get("snapshot", {}).get("status") if jload(body) else None
        if ST == "completed":
            break
        time.sleep(0.5)
    check("G4 run 真实完成（Worker 子进程）", ST == "completed")

    def sse_get(url, headers, max_seconds):
        """等价 curl -s -N --max-time N：读到 EOF 或超时，返回收到的文本。"""
        import http.client
        from urllib.parse import urlsplit
        u = urlsplit(url)
        conn = http.client.HTTPConnection(u.hostname, u.port, timeout=max_seconds)
        chunks = []
        try:
            conn.request("GET", u.path, headers=headers)
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
        except (OSError, TimeoutError, http.client.HTTPException):
            pass
        finally:
            conn.close()
        return "".join(chunks)

    sse1 = sse_get(f"{API}/runs/{RUNID}/stream", AUTH_HDR, 8)
    (BASE / "sse1.txt").write_text(sse1, encoding="utf-8")
    check("G4 SSE 流含顺序事件+done",
          "id: 1" in sse1 and "run.completed" in sse1 and "event: done" in sse1)
    ids = re.findall(r"^id: (\d+)", sse1, re.M)
    LAST = ids[-1] if ids else ""
    sse2 = sse_get(f"{API}/runs/{RUNID}/stream", {**AUTH_HDR, "Last-Event-ID": LAST}, 6)
    (BASE / "sse2.txt").write_text(sse2, encoding="utf-8")
    check("G4 SSE 游标重连零重复补传",
          re.search(r"id: 1\b", sse2) is None and "event: done" in sse2)

    # 5 cancel：长 run 中途取消 → cancelled
    code, body = http("POST", f"{API}/runs", headers=AUTH_HDR,
                      body='{"projectId":"proj","path":"long.js"}')
    CRUN = (jload(body) or {}).get("runId", "")
    time.sleep(2)
    code, body = http("POST", f"{API}/runs/{CRUN}/cancel", headers=AUTH_HDR)
    CRES = (jload(body) or {}).get("snapshot", {}).get("status")
    check("G5 cancel → cancelled（幂等快照）", CRES == "cancelled")

    # 6 checkpoint 审批：cp.js → waiting → approve → completed
    code, body = http("POST", f"{API}/runs", headers=AUTH_HDR,
                      body='{"projectId":"proj","path":"cp.js"}')
    PRUN = (jload(body) or {}).get("runId", "")
    PST = None
    for _ in range(40):
        code, body = http("GET", f"{API}/runs/{PRUN}", headers=AUTH_HDR)
        PST = (jload(body) or {}).get("snapshot", {}).get("status") if jload(body) else None
        if PST == "waiting_checkpoint":
            break
        time.sleep(0.5)
    check("G6 checkpoint 挂起 waiting_checkpoint", PST == "waiting_checkpoint")
    code, body = http("GET", f"{API}/runs/{PRUN}/checkpoints", headers=AUTH_HDR)
    cps = (jload(body) or {}).get("checkpoints", [{}])
    cp0 = cps[0] if cps else {}
    CPID, CPV = cp0.get("checkpointId", ""), cp0.get("version")
    check("G6 审批清单 pending", cp0.get("status") == "pending")
    code, body = http("POST", f"{API}/runs/{PRUN}/checkpoints/{CPID}/decision",
                      headers=AUTH_HDR, body=json.dumps({"decision": "approve", "expectedVersion": CPV}))
    DRES = (jload(body) or {}).get("checkpoint", {}).get("status")
    check("G6 approve → approved", DRES == "approved")
    PST = None
    for _ in range(40):
        code, body = http("GET", f"{API}/runs/{PRUN}", headers=AUTH_HDR)
        PST = (jload(body) or {}).get("snapshot", {}).get("status") if jload(body) else None
        if PST == "completed":
            break
        time.sleep(0.5)
    check("G6 审批后 run completed", PST == "completed")

    # 7 resume 语义：completed run resume → 409（不允许无意义恢复）
    st, _ = http("POST", f"{API}/runs/{RUNID}/resume", headers=AUTH_HDR,
                 body='{"acknowledgeSideEffects":true}')
    check("G7 completed resume → 409", st == 409)
    st, _ = http("POST", f"{API}/runs/run-nope/resume", headers=AUTH_HDR, body="{}")
    check("G7 未知 run resume → 404", st == 404)

    # 8 Server 重启 → 历史可读（幂等键缓存丢失但 run 历史完整）
    stop_server()
    if not start_server(BASE / "server2.log"):
        print("FAIL: server 重启")
        sys.exit(1)
    token_match = re.search(r"token（本次会话）：(.*)", (BASE / "server2.log").read_text(encoding="utf-8", errors="replace"))
    token2 = token_match.group(1) if token_match else ""
    AUTH2 = {"Authorization": f"Bearer {token2}"}
    code, body = http("GET", f"{API}/runs", headers=AUTH2)
    LIST = (jload(body) or {}).get("total")
    check("G8 重启后历史可读（3 runs）", LIST == 3)
    st, _ = http("GET", f"{API}/runs/{RUNID}", headers=AUTH2)
    check("G8 重启后 run 快照 200", st == 200)
    st, _ = http("GET", f"{API}/openapi.json", headers=AUTH2)
    check("G8 重启后 openapi 可用", st == 200)

    stop_server()

    print()
    print(f"== G-P1 结果：PASS={PASS} FAIL={FAIL} ==")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        stop_server()
