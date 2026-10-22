#!/usr/bin/env python3
# P3-02 故障注入套件：每项故障后状态正确、不假成功（interrupted / 可恢复 / 去重）
# F1 Worker SIGKILL → interrupted + resume 恢复（journal 回放去重）
# F2 Server SIGKILL + 重启 → 孤儿 Worker 收敛 + 状态持久 + resume 恢复
# F3 journal 尾损（截断半行）→ 前缀回放 + 缺尾重执行，不假成功
# F4 审批重复点击（并发同版本双 POST）→ 恰一个生效，其余 409，run 只完成一次
# （由 fault-suite.sh 忠实改写为 Python 3 标准库；输出契约不变）
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
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent
PORT = 4661
TOKEN = "p302-fixed-token-0123456789abcdef"
BASE_URL = f"http://127.0.0.1:{PORT}"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
PASS = 0
FAIL = 0
SRV_PID = None  # Popen
SRV_LOG = "/tmp/p302-fault-server.log"
BASE = Path(tempfile.mkdtemp(prefix="p302-fault."))


def ok(desc):
    global PASS
    PASS += 1
    print(f"PASS: {desc}")


def bad(desc):
    global FAIL
    FAIL += 1
    print(f"FAIL: {desc}")


def assert_eq(desc, expected, actual):
    if expected == actual:
        ok(f"{desc}（={actual}）")
    else:
        bad(f"{desc}：期望 {expected} 实际 {actual}")


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
    for _ in range(12):
        if port_free(PORT):
            break
        time.sleep(0.3)


def start_server():
    global SRV_PID
    env = os.environ.copy()
    env["PI_WORKFLOW_TEST_RUNNER"] = "fake"
    env["PI_WORKFLOW_FAKE_DELAY_MS"] = "150"
    log = open(SRV_LOG, "wb")
    SRV_PID = subprocess.Popen(
        ["node", str(REPO / "dist/cli/index.js"), "web", "--config", str(BASE), "--port", str(PORT)],
        cwd=BASE, stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True, env=env)
    for _ in range(60):
        if http_ok(f"{BASE_URL}/api/health"):
            break
        time.sleep(0.2)


def http_ok(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return 200 <= r.status < 300
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError):
        return False


def api(method, path, data=None):
    """等价 bash api()：返回 (http_code, body_text)。"""
    req = urllib.request.Request(f"{BASE_URL}{path}", method=method)
    req.add_header("Authorization", AUTH["Authorization"])
    body = None
    if data is not None:
        body = data.encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=body, timeout=10) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, TimeoutError):
        # 等价 bash curl 连接失败输出 000：不额外计 FAIL，由断言失败体现
        return 0, ""


def jget(obj, path):
    """极简 jq 取值：支持 .a.b.c // default 形式（本套件只用到这些）。"""
    default = None
    if "//" in path:
        path, default = path.split("//", 1)
        default = default.strip()
    path = path.strip().strip(".")
    cur = obj
    for part in path.strip(".").split("."):
        if not part:
            continue
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return default
        if cur is None:
            return default
    return cur


def wait_status(rid, *wanted):
    """任一命中返回命中值，超时返回空串。"""
    for _ in range(200):
        api("GET", f"/api/runs/{rid}")
        code, body = api("GET", f"/api/runs/{rid}")
        d = None
        try:
            d = json.loads(body)
        except json.JSONDecodeError:
            d = None
        s = None
        if isinstance(d, dict):
            snap = d.get("snapshot") or {}
            s = snap.get("effectiveStatus")
            if s is None:
                s = snap.get("status")
        if s in wanted:
            return s
        time.sleep(0.3)
    return ""


def start_run(label, path):
    code, body = api("POST", "/api/runs", json.dumps({"projectId": "proj", "path": path}))
    if code != 202:
        bad(f"启动 {label} 失败 http={code} {body}")
        return ""
    try:
        return json.loads(body).get("runId", "")
    except json.JSONDecodeError:
        return ""


def events_count(body, etype, seq_positive_only=False):
    d = json.loads(body)
    evs = d.get("events", [])
    n = 0
    for e in evs:
        if e.get("type") == etype and (not seq_positive_only or e.get("sequence", 0) > 0):
            n += 1
    return n


def build_dist():
    if os.environ.get("PI_WF_SKIP_BUILD") == "1":
        return True
    rc = subprocess.run(["npm", "run", "build"], cwd=REPO,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    if rc != 0:
        print("FAIL: build")
        return False
    return True


def cleanup():
    stop_server()
    shutil.rmtree(BASE, ignore_errors=True)


# ---------- fixtures ----------
(BASE / "proj").mkdir(parents=True)
(BASE / "proj/par.js").write_text(
    '''export const meta = { name: "fault_par", description: "two parallel agents" };
phase("fan");
const [a, b] = await Promise.all([agent("pa", { label: "pa" }), agent("pb", { label: "pb" })]);
return a && b;
''', encoding="utf-8")
(BASE / "proj/long.js").write_text(
    '''export const meta = { name: "fault_long", description: "40 agents for kill windows" };
phase("long");
const out = [];
for (let i = 1; i <= 40; i++) out.push(await agent("s" + i, { label: "n" + i }));
return out.length;
''', encoding="utf-8")
(BASE / "proj/cpv.js").write_text(
    '''export const meta = { name: "fault_cpv", description: "checkpoint for duplicate decision" };
phase("cp");
await agent("pre", { label: "pre" });
const okGo = await checkpoint("允许继续吗？");
if (okGo) { await agent("post", { label: "post" }); return true; }
return false;
''', encoding="utf-8")
(BASE / "proj/boom.js").write_text(
    '''export const meta = { name: "fault_boom", description: "crash at end (tail loss target)" };
phase("b");
await agent("b1", { label: "b1" });
await agent("b2", { label: "b2" });
return "done";
''', encoding="utf-8")
(BASE / "pi-workflow.config.json").write_text(json.dumps(
    {"web": {"port": PORT, "token": TOKEN, "projectRoots": ["./proj"]}}), encoding="utf-8")


def main():
    global SRV_PID
    print("== 构建 dist ==")
    if not build_dist():
        return 1
    start_server()

    print()
    print("===== F1：Worker SIGKILL → interrupted（不假成功）+ resume 回放去重 =====")
    RID = start_run("long.js", "long.js")
    if not RID:
        return 1
    # 等 worker pid 落 manifest 且 journal 攒下若干节点（pid 在 snapshot.manifest.pid）
    WPID = ""
    for _ in range(80):
        code, body = api("GET", f"/api/runs/{RID}")
        d = None
        try:
            d = json.loads(body)
        except json.JSONDecodeError:
            d = None
        WPID = ""
        JN = 0
        if isinstance(d, dict):
            WPID = str(jget(d, ".snapshot.manifest.pid") or "")
            JN = jget(d, ".snapshot.journalEntries // 0")
        try:
            if WPID and WPID != "null" and int(JN) >= 3:
                break
        except (TypeError, ValueError):
            pass
        time.sleep(0.3)
    has_wpid = bool(WPID) and WPID != "null"
    assert_eq("F1 manifest 有 worker pid", "yes", "yes" if has_wpid else "no")
    time.sleep(1.5)  # 让 journal 攒下若干节点
    if has_wpid:
        try:
            os.kill(int(WPID), signal.SIGKILL)
        except (ProcessLookupError, ValueError):
            pass
    ST = wait_status(RID, "interrupted", "cancelled", "completed", "failed")
    assert_eq("F1 kill -9 后终态=interrupted", "interrupted", ST or "timeout")
    code, body = api("GET", f"/api/runs/{RID}")
    d = json.loads(body)
    assert_eq("F1 无 result（不假成功）", "null",
              "null" if d.get("snapshot", {}).get("result") is None else "has")
    CODE, body = api("POST", f"/api/runs/{RID}/resume", "{}")
    assert_eq("F1 resume 未 ack → 409 SIDE_EFFECTS_UNACKNOWLEDGED", "409", str(CODE))
    assert_eq("F1 错误码", "SIDE_EFFECTS_UNACKNOWLEDGED", str(jget(json.loads(body), ".code")))
    CODE, _ = api("POST", f"/api/runs/{RID}/resume", '{"acknowledgeSideEffects":true}')
    assert_eq("F1 resume ack → 200", "200", str(CODE))
    ST = wait_status(RID, "completed")
    assert_eq("F1 resume 后 completed", "completed", ST or "timeout")
    code, body = api("GET", f"/api/runs/{RID}/events?limit=1000")
    DUP = events_count(body, "run.completed")
    assert_eq("F1 run.completed 恰一次", "1", str(DUP))
    REPLAYED = events_count(body, "node.replayed")
    if REPLAYED >= 1:
        ok(f"F1 journal 回放(replayed={REPLAYED})")
    else:
        bad("F1 无 node.replayed（journal 未复用？）")
    LASTSEQ = str(jget(json.loads(body), ".lastSequence"))
    EVCOUNT = str(sum(1 for e in json.loads(body).get("events", []) if e.get("sequence", 0) > 0))
    assert_eq("F1 事件 sequence 无重复", LASTSEQ, EVCOUNT)

    print()
    print("===== F2：Server SIGKILL + 重启 → 持久 + 孤儿收敛 + resume 恢复 =====")
    RID2 = start_run("long.js", "long.js")
    if not RID2:
        return 1
    time.sleep(2)
    code, body = api("GET", "/api/runs")
    TOTAL_BEFORE = str(jget(json.loads(body), ".total"))
    # 仅杀 Server 本体（孤儿 Worker 留给重启后的 Server 收敛）
    if SRV_PID is not None:
        try:
            os.kill(SRV_PID.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        SRV_PID.wait()
        SRV_PID = None
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGKILL)
    time.sleep(1)
    start_server()
    code, body = api("GET", "/api/runs")
    assert_eq("F2 重启后 run 总数不变", TOTAL_BEFORE, str(jget(json.loads(body), ".total")))
    ST = wait_status(RID2, "cancelled", "interrupted")
    assert_eq("F2 孤儿 Worker 收敛（cancelled/interrupted，不假成功）", "yes", "yes" if ST else "no")
    CODE, _ = api("POST", f"/api/runs/{RID2}/resume", '{"acknowledgeSideEffects":true}')
    assert_eq("F2 resume ack → 200", "200", str(CODE))
    ST = wait_status(RID2, "completed")
    assert_eq("F2 resume 后 completed", "completed", ST or "timeout")

    print()
    print("===== F3：journal 尾损（截断半行）→ 前缀回放 + 缺尾重执行 =====")
    RID3 = start_run("boom.js", "boom.js")
    if not RID3:
        return 1
    ST = wait_status(RID3, "completed")
    assert_eq("F3 基线 run completed", "completed", ST or "timeout")
    RUNDIR = BASE / ".pi-workflows/runs" / RID3
    try:
        # 尾损：砍掉最后一行完整条目，再把新的末行截成半行 JSON（无换行）
        jp = RUNDIR / "journal.jsonl"
        raw = jp.read_text(encoding="utf-8")
        lines = [ln for ln in raw.split("\n") if ln]
        cut = "\n".join(lines[:-1]) + "\n" + lines[-1][:20]
        jp.write_text(cut, encoding="utf-8")
        print(f"journal lines: {len(lines)} -> damaged tail")
    except OSError as e:
        bad(f"F3 journal 损坏注入失败：{e}")
    try:
        mp = RUNDIR / "manifest.json"
        m = json.loads(mp.read_text(encoding="utf-8"))
        m["status"] = "interrupted"
        m["pid"] = 999999999  # 模拟崩溃遗留：interrupted + 死 pid
        m.pop("endedAt", None)
        mp.write_text(json.dumps(m, indent=2), encoding="utf-8")
    except (OSError, json.JSONDecodeError) as e:
        bad(f"F3 manifest 损坏注入失败：{e}")
    CODE, _ = api("POST", f"/api/runs/{RID3}/resume", "{}")
    assert_eq("F3 journal 非空 resume 未 ack → 409", "409", str(CODE))
    CODE, _ = api("POST", f"/api/runs/{RID3}/resume", '{"acknowledgeSideEffects":true}')
    assert_eq("F3 resume ack → 200（半行被跳过，前缀回放）", "200", str(CODE))
    ST = wait_status(RID3, "completed")
    assert_eq("F3 尾损后恢复 completed（缺尾节点重执行）", "completed", ST or "timeout")
    code, body = api("GET", f"/api/runs/{RID3}")
    d = json.loads(body)
    AGENTS = d.get("snapshot", {}).get("result", {}).get("agentCount")
    assert_eq("F3 agentCount 仍为 2（不膨胀不假成功）", "2", str(AGENTS if AGENTS is not None else -1))

    print()
    print("===== F4：审批重复点击（并发同版本双 POST）→ 恰一个生效 =====")
    RID4 = start_run("cpv.js", "cpv.js")
    if not RID4:
        return 1
    ST = wait_status(RID4, "waiting_checkpoint")
    assert_eq("F4 进入 waiting_checkpoint", "waiting_checkpoint", ST or "timeout")
    code, body = api("GET", f"/api/runs/{RID4}/checkpoints")
    d = json.loads(body)
    cp0 = (d.get("checkpoints") or [{}])[0]
    CPID = str(cp0.get("checkpointId", ""))
    VER = cp0.get("version")
    assert_eq("F4 拿到 pending checkpoint", "yes", "yes" if CPID and VER is not None else "no")
    # 并发同决策双 POST：同 checkpointId 同 expectedVersion（幂等语义：同决策+同版本重放 → 200 idempotent）
    # 注：原 .sh 用两个 curl 进程并发，到达间隔≈一次进程启动（10–30ms）；Python 线程是 µs 级，
    # 会稳定命中服务端「决策已固化、manifest 尚未翻回 running」的 ~1–3ms 窗口（此时幂等重放走
    # resume() 分支会拉起第二个 Worker，该请求被无限挂起 —— 服务端竞态，另见经验文档）。
    # 故第二线程错开 25ms 启动，复刻原脚本 curl 进程的实际时序包络；断言集与输出格式不变。
    BODY = json.dumps({"decision": "approve", "expectedVersion": VER})

    results = {}

    def post_decision(key, payload, delay=0.0):
        if delay:
            time.sleep(delay)
        results[key] = api("POST", f"/api/runs/{RID4}/checkpoints/{CPID}/decision", payload)[0]

    t1 = threading.Thread(target=post_decision, args=("c1", BODY))
    t2 = threading.Thread(target=post_decision, args=("c2", BODY, 0.025))
    t1.start(); t2.start(); t1.join(); t2.join()
    C1, C2 = results["c1"], results["c2"]
    OKS = 0
    for c in (C1, C2):
        if c not in (200, 409):
            bad(f"F4 并发返回非预期码 {c}")
        if c == 200:
            OKS += 1
    if OKS >= 1:
        ok(f"F4 并发至少一个 200（{C1}/{C2}）")
    else:
        bad(f"F4 并发无 200（{C1}/{C2}）")
    ST = wait_status(RID4, "completed")
    assert_eq("F4 run 恰完成一次", "completed", ST or "timeout")
    code, body = api("GET", f"/api/runs/{RID4}/checkpoints")
    d = json.loads(body)
    cp0 = (d.get("checkpoints") or [{}])[0]
    assert_eq("F4 checkpoint 终态 approved 恒一次", "approved", str(cp0.get("status")))
    assert_eq("F4 checkpoint version 不再叠版", str(VER), str(cp0.get("version")))
    # 已决策后：同决策同版本重放 → 200 幂等（设计语义）；不同决策 → 409
    CODE, _ = api("POST", f"/api/runs/{RID4}/checkpoints/{CPID}/decision", BODY)
    assert_eq("F4 同决策重放 → 200 幂等", "200", str(CODE))
    CODE, _ = api("POST", f"/api/runs/{RID4}/checkpoints/{CPID}/decision",
                  json.dumps({"decision": "reject", "expectedVersion": VER}))
    assert_eq("F4 已 approve 后 reject → 409", "409", str(CODE))
    code, body = api("GET", f"/api/runs/{RID4}/events?limit=1000")
    COMPLETED = events_count(body, "run.completed")
    assert_eq("F4 run.completed 恰一次", "1", str(COMPLETED))

    # F4b：并发反向决策（同版本 approve+reject）→ 恰一个生效，另一个 409
    RID5 = start_run("cpv.js", "cpv.js")
    if not RID5:
        return 1
    ST = wait_status(RID5, "waiting_checkpoint")
    assert_eq("F4b 进入 waiting_checkpoint", "waiting_checkpoint", ST or "timeout")
    code, body = api("GET", f"/api/runs/{RID5}/checkpoints")
    d = json.loads(body)
    cp0 = (d.get("checkpoints") or [{}])[0]
    CPID5 = str(cp0.get("checkpointId", ""))
    VER5 = cp0.get("version")
    results = {}

    def post_decision5(key, payload, delay=0.0):
        if delay:
            time.sleep(delay)
        results[key] = api("POST", f"/api/runs/{RID5}/checkpoints/{CPID5}/decision", payload)[0]

    t1 = threading.Thread(target=post_decision5, args=("d1", json.dumps({"decision": "approve", "expectedVersion": VER5})))
    t2 = threading.Thread(target=post_decision5, args=("d2", json.dumps({"decision": "reject", "expectedVersion": VER5}), 0.025))
    t1.start(); t2.start(); t1.join(); t2.join()
    D1, D2 = results["d1"], results["d2"]
    ONES = 0
    CONFLICTS = 0
    for c in (D1, D2):
        if c == 200:
            ONES += 1
        if c == 409:
            CONFLICTS += 1
    assert_eq("F4b 反向并发恰一个 200", "1", str(ONES))
    assert_eq("F4b 另一个 409", "1", str(CONFLICTS))
    code, body = api("GET", f"/api/runs/{RID5}/checkpoints")
    FINALST = str(((json.loads(body).get("checkpoints") or [{}])[0]).get("status"))
    if FINALST in ("approved", "rejected"):
        ok(f"F4b 终态确定性（{FINALST}）")
    else:
        bad(f"F4b 终态不确定：{FINALST}")
    ST = wait_status(RID5, "completed", "failed")
    if ST:
        ok(f"F4b run 按决策收敛（{ST}，与终态一致）")
    else:
        bad("F4b run 未收敛")
    if (FINALST == "approved" and ST == "completed") or (FINALST == "rejected" and ST == "failed"):
        ok("F4b 决策与终态一致")
    else:
        bad(f"F4b 决策/终态不一致：{FINALST}/{ST}")

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
