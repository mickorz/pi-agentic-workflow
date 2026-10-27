#!/usr/bin/env python3
"""WX-MOCK 引擎 — 微信工作流 mock 标准化验收（P1/P2）

一条命令完成：消息输入 → 路由 → 授权 → Workflow 执行 → 结果断言；失败产出
reports/<ts>-<scenario>/report.json（caseId/runId/expected/actual/stage/logs）。

用法（仓根执行）:
    python3 dev-examples/manual-test/wechat-mock/engine.py \
        --scenario dev-examples/manual-test/wechat-mock/scenarios/route-smoke.json
    python3 dev-examples/manual-test/wechat-mock/engine.py --all                      # 守卫：全量
    python3 dev-examples/manual-test/wechat-mock/engine.py --all --mode deterministic # 仅确定性场景

隔离原则（不碰运行中的 wechat-bot）:
    服务实例用独立数据目录 --data <runDir>/data（服务锁按 dataDir 隔离），
    场景专用 registry（fixtures/registry.json 可被场景 patch），与 pm2 生产实例并存。

超时纪律:
    单步缺省 180s；场景步骤可声明 timeoutSec ≤ 300 且须带 special+reason；
    超时立即转储诊断（bot 最后回复/服务日志尾/挂起授权/tasks 尾）并 FAIL，不盲等。

stdout 契约: 每步 [OK]/[FAIL]，结尾 === ALL PASS === 或 === FAILED n ===；exit 0/1。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parents[3]
MOCK_DIR = Path(__file__).resolve().parent
PI = shutil.which("pi-workflow") or "pi-workflow.cmd"
NPX = shutil.which("npx") or "npx.cmd"
DEFAULT_STEP_TIMEOUT = 180
MAX_STEP_TIMEOUT = 300
MOCK_USER = "mock-user"


class Case:
    def __init__(self, case_id: str, name: str):
        self.case_id = case_id
        self.name = name
        self.ok = False
        self.stage = "expect"
        self.expected = ""
        self.actual = ""


def diag_dump(run_dir: Path, data_dir: Path, note: str) -> str:
    """超时/失败诊断四件套：bot 最后回复 / 服务日志尾 / 挂起授权 / tasks 尾"""
    parts = [f"[DIAG] {note}"]
    ob = data_dir / "mock-outbox.jsonl"
    if ob.exists():
        lines = ob.read_text(encoding="utf-8").splitlines()
        if lines:
            try:
                parts.append("bot最后回复: " + json.loads(lines[-1]).get("text", "")[:220].replace("\n", " "))
            except json.JSONDecodeError:
                pass
    log = run_dir / "mock-service.log"
    if log.exists():
        parts.append("服务日志尾: " + " / ".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-3:]))
    pa = data_dir / "pending-actions.jsonl"
    if pa.exists():
        latest: dict = {}
        for line in pa.read_text(encoding="utf-8").splitlines():
            try:
                j = json.loads(line)
                latest[j.get("actionId")] = j.get("status")
            except json.JSONDecodeError:
                pass
        pend = {k: v for k, v in latest.items() if v == "pending"}
        parts.append("挂起授权: " + (json.dumps(pend) if pend else "无"))
    tk = data_dir / "tasks.jsonl"
    if tk.exists():
        parts.append("tasks尾: " + tk.read_text(encoding="utf-8").splitlines()[-1][:160])
    return "\n".join(parts)


class MockService:
    """独立数据目录的 mock 服务实例（与 pm2 生产实例并存，互不触碰）"""

    def __init__(self, run_dir: Path, mode: str, env_extra: dict, scripts_dir: Path | None):
        self.run_dir = run_dir
        self.data_dir = run_dir / "data"
        self.log_file = run_dir / "mock-service.log"
        self.proc = None
        self.mode = mode
        self.env_extra = env_extra
        self.scripts_dir = scripts_dir

    def start(self, registry_file: Path, route_stub: Path | None) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, **self.env_extra}
        cmd = [PI, "wechat", "start", "--mock-client", "--data", str(self.data_dir), "--registry", str(registry_file)]
        if self.scripts_dir:
            cmd += ["--scripts", str(self.scripts_dir)]
        if self.mode == "deterministic":
            cmd += ["--routing-mode", "legacy"]
            if route_stub:
                cmd += ["--route-stub", str(route_stub)]
        self.log_file.write_text("", encoding="utf-8")
        self.proc = subprocess.Popen(cmd, cwd=str(REPO), stdout=open(self.log_file, "a", encoding="utf-8"),
                                     stderr=subprocess.STDOUT, env=env)

    def ready(self, timeout_s: int = 30) -> tuple[bool, str]:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            log = self.log_file.read_text(encoding="utf-8", errors="replace")
            if "wechat-dispatch 已启动" in log and "client=MOCK" in log:
                return True, ""
            if self.proc and self.proc.poll() is not None:
                return False, f"服务进程提前退出 exit={self.proc.returncode}"
            time.sleep(1)
        return False, "30s 内未见 client=MOCK 就绪横幅"

    def kill(self) -> None:
        """进程树强杀（模拟崩溃；隔离 dataDir 下无状态需要保全）"""
        if self.proc and self.proc.poll() is None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.proc.pid)], capture_output=True, timeout=30)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass


def outbox_read(data_dir: Path) -> list:
    ob = data_dir / "mock-outbox.jsonl"
    if not ob.exists():
        return []
    msgs = []
    for line in ob.read_text(encoding="utf-8").splitlines():
        try:
            j = json.loads(line)
            msgs.append((j.get("toUserId", ""), j.get("text", "")))
        except json.JSONDecodeError:
            pass
    return msgs


def send_inbox(data_dir: Path, user_id: str, text: str) -> None:
    inbox = data_dir / "mock-inbox.jsonl"
    inbox.parent.mkdir(parents=True, exist_ok=True)
    with inbox.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"userId": user_id, "text": text, "messageId": f"wxm-{time.time_ns()}"}) + "\n")


def json_path_get(doc, path: str):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def latest_tasks(data_dir: Path):
    tf = data_dir / "tasks.jsonl"
    if not tf.exists():
        return {}
    latest: dict = {}
    for line in tf.read_text(encoding="utf-8").splitlines():
        try:
            j = json.loads(line)
            latest[j.get("taskBindingId")] = j
        except json.JSONDecodeError:
            pass
    return latest


def pending_latest(data_dir: Path):
    pf = data_dir / "pending-actions.jsonl"
    if not pf.exists():
        return {}
    latest: dict = {}
    for line in pf.read_text(encoding="utf-8").splitlines():
        try:
            j = json.loads(line)
            latest[j.get("actionId")] = j.get("status")
        except json.JSONDecodeError:
            pass
    return latest


def render(text: str, vars_: dict) -> str:
    out = text
    for k, v in vars_.items():
        out = out.replace("{" + k + "}", str(v))
    return out


class Engine:
    def __init__(self, scenario: dict, mode: str, step_timeout: int, keep: bool):
        self.sc = scenario
        self.mode = mode
        self.step_timeout = min(step_timeout, MAX_STEP_TIMEOUT)
        self.keep = keep
        ts = time.strftime("%Y%m%d-%H%M%S")
        self.run_dir = MOCK_DIR / "reports" / f"{ts}-{scenario.get('name', 'scenario')}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir = self.run_dir / "data"
        self.vars = dict(scenario.get("vars", {}))
        self.vars.setdefault("runDir", str(self.run_dir).replace("\\", "/"))  # 正斜杠：stub JSON 转义安全
        self.vars.setdefault("userId", MOCK_USER)
        self.vars.setdefault("runStamp", str(int(time.time())))
        for k, v in list(self.vars.items()):  # 两遍渲染：var 值可引用 runDir 等内建变量
            self.vars[k] = render(str(v), self.vars)
        (self.run_dir / "work").mkdir(parents=True, exist_ok=True)
        self.cases: list[Case] = []
        self.svc = MockService(self.run_dir, mode, scenario.get("env", {}), None)

    # ── 前置 ──
    def preflight(self) -> bool:
        reg_src = MOCK_DIR / "scenarios" / self.sc.get("registry", "fixtures/registry.json")
        if not reg_src.exists():
            print(f"[FAIL] 场景 registry 不存在: {reg_src}")
            return False
        regs = json.loads(reg_src.read_text(encoding="utf-8"))
        for patch in self.sc.get("registryPatch", []):  # 场景级 registry 临时改（如 R2 启用冲突靶子）
            for reg in regs:
                if reg["workflowId"] == patch["workflowId"]:
                    reg.update({k: v for k, v in patch.items() if k != "workflowId"})
        self.fixtures_dir = reg_src.parent
        reg_file = self.run_dir / "registry.json"
        reg_file.write_text(json.dumps(regs, ensure_ascii=False, indent=2), encoding="utf-8")
        self.registry_file = reg_file
        self.svc.scripts_dir = self.fixtures_dir
        enabled = {r["workflowId"]: r.get("enabled", False) for r in regs}
        missing = [w for w in self.sc.get("requiresWorkflows", []) if not enabled.get(w)]
        if missing:
            print(f"[FAIL] registry 预检：未启用 {missing}（检查 enabled 与短关键词）")
            return False
        self.route_stub_file = None
        if self.mode == "deterministic" and self.sc.get("routeStub"):
            rules = json.loads(render(json.dumps(self.sc["routeStub"], ensure_ascii=False), self.vars))
            self.route_stub_file = self.run_dir / "route-stub.json"
            self.route_stub_file.write_text(json.dumps({"rules": rules}, ensure_ascii=False, indent=2), encoding="utf-8")
        return True

    def start_service(self) -> bool:
        self.svc.start(self.registry_file, self.route_stub_file)
        ok, why = self.svc.ready(30)
        if not ok:
            print(f"[FAIL] mock 服务启动: {why}")
            print(self.log_tail())
        return ok

    def log_tail(self) -> str:
        return self.svc.log_file.read_text(encoding="utf-8", errors="replace")[-400:]

    # ── 步骤执行 ──
    def run_steps(self) -> None:
        outbox_n = 0
        for step in self.sc.get("steps", []):
            case = Case(step.get("caseId", "?"), step.get("name", step.get("caseId", "?")))
            kind = step.get("kind", "send")
            try:
                if kind == "kill":
                    self.svc.kill()
                    time.sleep(2)
                    case.ok = True
                elif kind == "restart":
                    self.svc.kill()
                    ok = self.start_service()
                    case.ok = ok
                    if not ok:
                        case.stage = "service"
                        case.actual = self.log_tail()
                elif kind == "resumeRun":
                    self.run_resume_step(step, case)
                else:
                    outbox_n = self.run_send_step(step, case, outbox_n)
            except Exception as e:
                case.ok = False
                case.stage = "engine"
                case.actual = f"{type(e).__name__}: {e}"
            self.cases.append(case)
            tag = "OK  " if case.ok else "FAIL"
            print(f"[{tag}] {case.case_id} {case.name}" + ("" if case.ok else f" | {case.stage}: {case.actual[:180]}"), flush=True)
            if not case.ok:
                break

    def run_resume_step(self, step: dict, case: Case) -> None:
        """deterministic 模式的恢复入口：pi-workflow resume（与微信「确认恢复」同一 runtime 语义）"""
        wf = step.get("workflowId", "")
        run_id = None
        for _ in range(5):
            for tb, tk in latest_tasks(self.data_dir).items():
                if tk.get("workflowId") == wf and tk.get("status") == "interrupted" and tk.get("runId"):
                    run_id = tk["runId"]
                    break
            if run_id:
                break
            time.sleep(3)
        if not run_id:
            case.stage = "resume"
            case.expected = f"{wf} 存在 interrupted 任务"
            case.actual = "未找到 interrupted 任务"
            return
        r = subprocess.run([PI, "resume", run_id], cwd=str(REPO), capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           input="y" + chr(10), timeout=step.get("resumeTimeoutSec", 170))
        case.stage = "resume"
        case.expected = f"resume {run_id} 重放/续跑完成"
        case.actual = (r.stdout + r.stderr)[-300:]
        case.ok = r.returncode == 0

    def run_send_step(self, step: dict, case: Case, outbox_n: int) -> int:
        case.stage = "send"
        text = render(step["send"], self.vars)
        send_inbox(self.data_dir, MOCK_USER, text)
        print(f"[SENT] {text[:70]}...", flush=True)

        approve = step.get("approve", "never")
        expect = step.get("expect", {})
        timeout = min(int(expect.get("timeoutSec", self.step_timeout)), MAX_STEP_TIMEOUT)
        if timeout > DEFAULT_STEP_TIMEOUT and not (step.get("special") and step.get("reason")):
            print(f"[FAIL] {case.case_id} timeoutSec={timeout} >180 未声明 special+reason（超时纪律）")
            case.stage = "config"
            case.expected = "timeoutSec<=180 或 special+reason"
            case.actual = f"timeoutSec={timeout}"
            return outbox_n

        case.stage = "expect"
        deadline = time.time() + timeout
        expect_type = expect.get("type", "replyContains")
        matched = False
        actual = ""
        while time.time() < deadline:
            all_msgs = outbox_read(self.data_dir)
            msgs = all_msgs[outbox_n:]
            n = len(all_msgs)
            for _, reply in msgs:
                is_approval_card = "回复「批准」" in reply or ("actionId" in reply and "pa-" in reply)
                wf_ok = step.get("approveWorkflowId", "") in reply
                if is_approval_card and wf_ok and approve in ("auto", "reject"):
                    time.sleep(1.5)
                    action = "批准" if approve == "auto" else "拒绝"
                    send_inbox(self.data_dir, MOCK_USER, action)
                    print(f"[AUTO] 审批卡（workflowId 匹配）-> {action}", flush=True)
                if expect_type == "replyContains" and any(k in reply for k in expect.get("anyOf", [])):
                    matched, actual = True, reply[:200]
            outbox_n = n
            if matched:
                break
            if expect_type in ("taskCompleted", "taskFailed"):
                wf = expect["workflowId"]
                want = "completed" if expect_type == "taskCompleted" else "failed"
                for tb, tk in latest_tasks(self.data_dir).items():
                    if tk.get("workflowId") == wf and tk.get("status") == want:
                        matched, actual = True, f"tb={tb} {want}"
                        break
                if matched:
                    break
            if expect_type == "pendingActionStatus":
                want_wf = expect["workflowId"]
                target = expect.get("status")
                pf = self.data_dir / "pending-actions.jsonl"
                if pf.exists():
                    ids = {}
                    for line in pf.read_text(encoding="utf-8").splitlines():
                        try:
                            j = json.loads(line)
                            if j.get("workflowId") == want_wf:
                                ids[j["actionId"]] = j.get("status")
                        except json.JSONDecodeError:
                            pass
                    if any(v == target for v in ids.values()):
                        matched, actual = True, f"{want_wf} action -> {target}"
            if expect_type == "fileSettled":
                f = Path(render(expect["file"], self.vars))
                if f.exists():
                    matched, actual = True, str(f)
            time.sleep(2)

        if not matched:
            case.stage = "expect-timeout"
            case.expected = json.dumps(expect, ensure_ascii=False)[:160]
            case.actual = diag_dump(self.run_dir, self.data_dir, f"等待 {timeout}s 超时")
            return outbox_n

        # 终态断言（Run 终态 + 产物为准；回复文本不算成功依据）
        case.stage = "assert"
        problems = []
        aj = step.get("assertJson")
        if aj:
            f = Path(render(aj["file"], self.vars))
            if not f.exists():
                problems.append(f"断言文件缺失 {f}")
            else:
                try:
                    doc = json.loads(f.read_text(encoding="utf-8"))
                    got = json_path_get(doc, aj["path"])
                    if "equals" in aj and got != aj["equals"]:
                        problems.append(f"{aj['path']} 期望 {aj['equals']} 实际 {got}")
                    if "contains" in aj and (not isinstance(got, str) or aj["contains"] not in got):
                        problems.append(f"{aj['path']} 应包含 {aj['contains']}，实际 {got}")
                except json.JSONDecodeError as e:
                    problems.append(f"断言文件不是合法 JSON（{e}），实际内容: {f.read_text(encoding='utf-8')[:80]}")
        for rf in step.get("assertFile", []):
            f = Path(render(rf, self.vars))
            if not f.exists():
                problems.append(f"产物缺失 {f}")
        afcs = step.get("assertFileContains", [])
        for afc in ([afcs] if isinstance(afcs, dict) else afcs):
            f = Path(render(afc["file"], self.vars))
            content = f.read_text(encoding="utf-8") if f.exists() else ""
            needle = render(afc["contains"], self.vars)
            if needle not in content:
                problems.append(f"{f.name} 应包含 '{needle}'，实际: {content[:60]}")
        for rf in step.get("assertAbsent", []):
            f = Path(render(rf, self.vars))
            if f.exists():
                problems.append(f"产物不应存在却存在 {f}")
        apv = step.get("assertPending")
        if apv:
            wf = apv["workflowId"]
            want_status = apv.get("status", "executed")
            anchors = [render(a, self.vars) for a in apv.get("argsContain", [])]
            pa_deadline = time.time() + 30
            pa_ok, pa_detail = False, "无记录"
            while time.time() < pa_deadline and not pa_ok:
                latest_pa = {}
                pf = self.data_dir / "pending-actions.jsonl"
                if pf.exists():
                    for line in pf.read_text(encoding="utf-8").splitlines():
                        try:
                            j = json.loads(line)
                            if j.get("workflowId") == wf:
                                latest_pa[j["actionId"]] = j
                        except json.JSONDecodeError:
                            pass
                for aid, j in latest_pa.items():
                    if j.get("status") == want_status:
                        args_blob = json.dumps(j.get("args", {}), ensure_ascii=False)
                        if all(a in args_blob for a in anchors):
                            pa_ok, pa_detail = True, f"{aid} {want_status} args 含锚点"
                        else:
                            pa_detail = f"{aid} 状态对但 args 缺锚点: {args_blob[:120]}"
                if pa_ok:
                    break
                time.sleep(3)
            if not pa_ok:
                problems.append(f"PendingAction 断言失败: {pa_detail}")
        atc = step.get("assertTextCount")
        if atc:
            f = Path(render(atc["file"], self.vars))
            count = f.read_text(encoding="utf-8").count(atc["substring"]) if f.exists() else -1
            if count != atc["count"]:
                problems.append(f"{f.name} 中 '{atc['substring']}' 期望 {atc['count']} 次实际 {count} 次")
        ate = step.get("assertTaskError")
        if ate:
            wf = ate["workflowId"]
            hit_tb = None
            for _ in range(3):  # 宽限轮询：给 RunMonitor/manifest 落盘留时间
                for tb, tk in latest_tasks(self.data_dir).items():
                    if tk.get("workflowId") == wf and tk.get("status") == "failed":
                        hit_tb = tk
                        break
                if hit_tb:
                    break
                time.sleep(3)
            if not hit_tb:
                problems.append(f"{wf} 无 failed 任务")
            else:
                blob = json.dumps(hit_tb, ensure_ascii=False)
                texts = " ".join(m[1] for m in outbox_read(self.data_dir))
                manifest_err = ""
                run_id = hit_tb.get("runId")
                if run_id:
                    mf = REPO / ".pi-workflows" / "runs" / run_id / "manifest.json"
                    if mf.exists():
                        manifest_err = str(json.loads(mf.read_text(encoding="utf-8")).get("error", ""))
                if ate["contains"] not in blob and ate["contains"] not in texts and ate["contains"] not in manifest_err:
                    problems.append(f"失败原因未含 '{ate['contains']}'（tasks/回执/run-manifest 均未见；manifest_err={manifest_err[:80]}）")
        case.expected = json.dumps({k: step[k] for k in ("assertJson", "assertFile", "assertFileContains", "assertAbsent", "assertPending", "assertTextCount", "assertTaskError") if k in step}, ensure_ascii=False)[:160]
        case.actual = "; ".join(problems) if problems else "断言全过"
        case.ok = not problems
        return outbox_n

    # ── 报告 ──
    def write_report(self) -> Path:
        report = {
            "scenario": self.sc.get("name"),
            "mode": self.mode,
            "runDir": str(self.run_dir),
            "verdict": "PASS" if all(c.ok for c in self.cases) and self.cases else "FAIL",
            "steps": [
                {"caseId": c.case_id, "name": c.name, "ok": c.ok, "stage": c.stage,
                 "expected": c.expected, "actual": c.actual} for c in self.cases
            ],
        }
        rp = self.run_dir / "report.json"
        rp.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return rp


def run_scenario(path: Path, mode_override: str | None, step_timeout: int, keep: bool) -> tuple[bool, Engine]:
    sc = json.loads(path.read_text(encoding="utf-8"))
    mode = mode_override or sc.get("mode", "deterministic")
    eng = Engine(sc, mode, step_timeout, keep)
    print()
    print(f"[RUN] {sc.get('name')} mode={mode} runDir={eng.run_dir.name}")
    if not eng.preflight():
        return False, eng
    if not eng.start_service():
        eng.write_report()
        return False, eng
    try:
        eng.run_steps()
    finally:
        eng.write_report()
        if not keep:
            eng.svc.kill()
        else:
            print(f"[KEEP] 服务保留（dataDir={eng.svc.data_dir}）", flush=True)
    ok = all(c.ok for c in eng.cases) and len(eng.cases) > 0
    print(f"report: {eng.write_report()}")
    if ok:
        print(f"=== ALL PASS === ({len(eng.cases)} pass)")
    else:
        n_fail = sum(1 for c in eng.cases if not c.ok)
        print(f"=== FAILED {n_fail} === ({len(eng.cases)} steps)")
    return ok, eng


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario")
    ap.add_argument("--all", action="store_true", help="跑 scenarios/ 下全部场景（守卫模式）")
    ap.add_argument("--mode", choices=["deterministic", "integration"], default=None,
                    help="覆盖场景模式；与 --all 同用时=只跑该模式的场景（缺省全跑）")
    ap.add_argument("--step-timeout", type=int, default=DEFAULT_STEP_TIMEOUT)
    ap.add_argument("--keep", action="store_true", help="保留服务进程与数据目录（调试用）")
    args = ap.parse_args()

    sc_dir = Path(__file__).resolve().parent / "scenarios"
    results = []

    if args.all:
        files = sorted(sc_dir.glob("*.json"))
        if args.mode:
            files = [f for f in files if json.loads(f.read_text(encoding="utf-8")).get("mode", "deterministic") == args.mode]
        if not files:
            print("[FAIL] 无匹配场景")
            return 1
        print(f"[ALL] {len(files)} 个场景（mode={args.mode or '全部'}）")
        failed = []
        for f in files:
            ok, _ = run_scenario(f, args.mode, args.step_timeout, args.keep)
            results.append((f.stem, ok))
            if not ok:
                failed.append(f.stem)
        if failed:
            print(f"=== FAILED {len(failed)} === 失败场景: " + ", ".join(failed))
            return 1
        print(f"=== ALL PASS === ({len(results)} scenarios)")
        return 0

    if not args.scenario:
        ap.error("需要 --scenario 或 --all")
    ok, _ = run_scenario(Path(args.scenario), args.mode, args.step_timeout, args.keep)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
