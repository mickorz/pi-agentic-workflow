#!/usr/bin/env python3
# P3-03 E06：V1 CLI 旧命令验收（真实 SDK）+ V2 Web 只读兼容
#  validate / run（真实 SDK）/ status / list / run --non-interactive 等待态 / resume(终端审批 y) /
#  V2 Web Server 读 CLI 创建的 run（manifest/events 跨轨读取）
# （由 v1-cli-smoke.sh 忠实改写为 Python 3 标准库；输出契约不变）
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
PORT = 4681
TOKEN = "p303-fixed-token-0123456789abcdef"
BASE_URL = f"http://127.0.0.1:{PORT}"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
PASS = 0
FAIL = 0
SRV_PID = None  # Popen
BASE = Path(tempfile.mkdtemp(prefix="p303-v1cli."))
CLI = str(REPO / "dist/cli/index.js")


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


def http_ok(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return 200 <= r.status < 300
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError):
        return False


def http_get_json(path):
    req = urllib.request.Request(f"{BASE_URL}{path}")
    req.add_header("Authorization", AUTH["Authorization"])
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def cleanup():
    global SRV_PID
    if SRV_PID is not None:
        try:
            os.kill(SRV_PID.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        time.sleep(0.5)
        try:
            os.kill(SRV_PID.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        SRV_PID = None
    pkill_pattern(f"dist/cli/index.js web --config {BASE}", signal.SIGTERM)
    shutil.rmtree(BASE, ignore_errors=True)


def main():
    global SRV_PID
    print("== 构建 dist ==")
    if os.environ.get("PI_WF_SKIP_BUILD") != "1":
        if subprocess.run(["npm", "run", "build"], cwd=REPO,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            print("FAIL: build")
            return 1
    else:
        print("[SKIP] npm run build（PI_WF_SKIP_BUILD=1）")

    print("== 1. validate（旧命令，合法/非法退出码） ==")
    rc = subprocess.run(["node", CLI, "validate", str(REPO / "examples/smoke.js"), "--cwd", str(BASE)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    if rc == 0:
        ok("validate 合法脚本 exit 0")
    else:
        bad("validate 合法脚本非 0")
    (BASE / "bad.js").write_text(
        'export const meta = { name: "X" }\nsyntax ((((', encoding="utf-8")  # 缺 description 之外再破坏语法
    rc = subprocess.run(["node", CLI, "validate", str(BASE / "bad.js"), "--cwd", str(BASE)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    if rc != 0:
        ok("validate 非法脚本 exit 2")
    else:
        bad("validate 非法脚本误 0")

    print("== 2. list 空目录（旧命令 exit 0） ==")
    rc = subprocess.run(["node", CLI, "list", "--cwd", str(BASE)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    if rc == 0:
        ok("list 空 exit 0")
    else:
        bad("list 空目录非 0")

    print("== 3. run examples/smoke.js（真实 SDK，旧主路径） ==")
    run1 = subprocess.run(["node", CLI, "run", str(REPO / "examples/smoke.js"), "--cwd", str(BASE)],
                          capture_output=True, text=True)
    RC = run1.returncode
    assert_eq("run smoke.js exit 0", "0", str(RC))
    out1 = run1.stdout + run1.stderr
    if "pi-workflow smoke ok" in out1:
        ok("真实 agent 回复出现在输出")
    else:
        tail = "\n".join(out1.splitlines()[-3:])
        bad(f"输出未见预期回复：{tail}")
    runs_dir = BASE / ".pi-workflows/runs"
    RID1 = ""
    if runs_dir.is_dir():
        entries = sorted(p.name for p in runs_dir.iterdir())
        RID1 = entries[0] if entries else ""
    if RID1:
        ok(f"runId 落盘 {RID1}")
    else:
        bad("未见 run 目录")

    print("== 4. status / list（旧命令读新 run；两者以 process.cwd() 为 base，需 cd） ==")
    r = subprocess.run(["node", CLI, "status", RID1], cwd=BASE, capture_output=True, text=True)
    if re.search("completed", r.stdout + r.stderr, re.I):
        ok("status 显示 completed")
    else:
        bad("status 未显示 completed")
    r = subprocess.run(["node", CLI, "list"], cwd=BASE, capture_output=True, text=True)
    if RID1 in (r.stdout + r.stderr):
        ok("list 含该 run")
    else:
        bad("list 缺该 run")

    print("== 5. run checkpoint-demo --non-interactive → 等待态 exit 3 ==")
    rc2 = subprocess.run(
        ["node", CLI, "run", str(REPO / "examples/checkpoint-demo.js"),
         "--non-interactive", "--cwd", str(BASE)],
        cwd=BASE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    assert_eq("等待态退出码 3", "3", str(rc2))
    RID2 = ""
    if runs_dir.is_dir():
        entries = sorted(runs_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        RID2 = entries[0].name if entries else ""

    print("== 6. resume + 终端审批（echo y → 批准 → 真实写文件 → exit 0） ==")
    r = subprocess.run(["node", CLI, "resume", RID2], cwd=BASE, input="y\n",
                       capture_output=True, text=True)
    RC3 = r.returncode
    assert_eq("resume 批准路径 exit 0", "0", str(RC3))
    out2 = r.stdout + r.stderr
    if (BASE / "note.txt").is_file():
        ok("note.txt 真实落盘（副作用执行）")
    else:
        tail = "\n".join(out2.splitlines()[-5:])
        bad(f"note.txt 未创建：{tail}")

    print("== 7. V2 Web Server 只读兼容：读 CLI 创建的 run ==")
    (BASE / "pi-workflow.config.json").write_text(json.dumps(
        {"web": {"port": PORT, "token": TOKEN, "projectRoots": [str(REPO / "examples")]}}),
        encoding="utf-8")
    web_log = open(BASE / "web.log", "wb")
    SRV_PID = subprocess.Popen(
        ["node", CLI, "web", "--config", str(BASE), "--port", str(PORT)],
        cwd=BASE, stdout=web_log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        if http_ok(f"{BASE_URL}/api/health"):
            break
        time.sleep(0.2)
    TOTAL = http_get_json("/api/runs").get("total")
    assert_eq("Web list 读到 CLI runs（total=2）", "2", str(TOTAL))
    EFF1 = http_get_json(f"/api/runs/{RID1}").get("snapshot", {}).get("effectiveStatus")
    assert_eq("Web 读 CLI manifest effectiveStatus=completed", "completed", str(EFF1))
    d = http_get_json(f"/api/runs/{RID1}/events?limit=1000")
    EVCNT = sum(1 for e in d.get("events", []) if e.get("sequence", 0) > 0)
    if EVCNT >= 3:
        ok(f"Web 读 CLI events.jsonl（{EVCNT} 条）")
    else:
        bad(f"events 读取异常：{EVCNT}")
    AGENTS = http_get_json(f"/api/runs/{RID1}").get("snapshot", {}).get("result", {}).get("agentCount")
    assert_eq("Web 读 CLI result.json agentCount=1", "1", str(AGENTS if AGENTS is not None else -1))

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
