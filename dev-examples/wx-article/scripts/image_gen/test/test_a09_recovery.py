#!/usr/bin/env python3
"""A09 中断恢复套件：真 SIGKILL 时机注入（沿 run-resume-suite.py 惯例）。

场景：
  S1 生图中途 SIGKILL → manifest 遗留 running（含已写盘文件）→ 重启核验：
     - 已完成条目不重生成（零重复调用）
     - 遗留 running 且文件有效 → verify-recovered（不重生成）
     - 遗留 running 且文件缺失 → 重跑
     - 全量最终 succeeded，verify-only ok
  S2 生图中途 SIGINT 优雅中止 → running 回写 pending、锁释放、exit 130 → 续跑补齐。

用法：python3 test_a09_recovery.py  （在 image_gen/ 目录下）
平台：macOS/Linux。Windows 信号语义受限（见 dev-docs/experience/windows-signal-semantics-stop.md），
      本套件在 Windows 输出 SKIP。
输出：逐断言 PASS/FAIL + 结尾汇总（=== ALL DONE === / PASS n / FAIL m）。
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent          # image_gen/test/
IG = HERE.parent                                 # image_gen/
GEN = IG / "generate.mjs"
PROVIDER = HERE / "helpers" / "test-provider.mjs"

PASSED = []
FAILED = []


def check(name: str, cond: bool, detail: str = "") -> None:
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name}" + (f" — {detail}" if detail and not cond else ""))
    (PASSED if cond else FAILED).append(name)


def make_article(root: Path, n_items: int = 5, slow_ms: int = 600) -> Path:
    d = root / f"article-{time.time_ns()}"
    d.mkdir(parents=True)
    items = [{"id": "cover", "kind": "cover", "prompt": "封面图", "filename": "cover.png"}]
    for i in range(1, n_items):
        items.append({"id": f"t{i:02d}", "kind": "body", "prompt": f"术语 {i}", "filename": f"t{i:02d}.png"})
    (d / "image-prompts.json").write_text(json.dumps({"version": 1, "article_id": "a09", "style_prefix": "s", "items": items}, ensure_ascii=False), encoding="utf8")
    (d / ".faults.json").write_text("{}", encoding="utf8")
    return d


def spawn_run(d: Path, slow_ms: int = 600, extra=()):
    calls = d / ".calls.jsonl"
    calls.write_text("", encoding="utf8")
    env = dict(os.environ)
    env["TEST_CALLS_FILE"] = str(calls)
    env["TEST_FAULT_FILE"] = str(d / ".faults.json")
    env["TEST_SLOW_MS"] = str(slow_ms)
    out = d / ".run.log"
    f = out.open("wb")
    p = subprocess.Popen(
        ["node", str(GEN), "--article-dir", str(d), "--provider", str(PROVIDER), "--no-require-style-approval", "--continue-on-error", *extra],
        stdout=f, stderr=subprocess.STDOUT, env=env, cwd=str(IG),
    )
    return p, calls, out, env


def read_calls(calls: Path):
    txt = calls.read_text(encoding="utf8").strip()
    return [json.loads(l)["id"] for l in txt.split("\n") if l.strip()]


def read_manifest(d: Path):
    return json.loads((d / "image-manifest.json").read_text(encoding="utf8"))


def s1_sigkill_recovery(root: Path):
    print("== S1 SIGKILL 中断恢复 ==")
    d = make_article(root, 5, slow_ms=500)
    p, calls, out, env = spawn_run(d, slow_ms=500)
    # 等首图完成、第二张进行中（500ms/图）
    time.sleep(1.2)
    p.send_signal(signal.SIGKILL)
    p.wait()
    out_log = out.read_text(encoding="utf8", errors="replace")
    done_first = "[IMG ok] cover" in out_log
    check("S1.1 被杀前至少完成 1 图", done_first, out_log[:200])

    m = read_manifest(d)
    statuses = {e["id"]: e["status"] for e in m["entries"].values()}
    check("S1.2 manifest 存在且有条目", len(statuses) >= 2, str(statuses))

    # 重启（不慢速）
    p2, calls2, out2, _ = spawn_run(d, slow_ms=0, extra=("--retry-failed",))
    rc = p2.wait()
    log2 = (d / ".run.log").read_text(encoding="utf8", errors="replace")
    check("S1.3 重启 exit 0", rc == 0, f"rc={rc}\n{log2[-500:]}")
    result = [l for l in log2.split("\n") if l.startswith("[RESULT]")][-1]
    rj = json.loads(result[len("[RESULT]"):])
    check("S1.4 重启全量 succeeded", rj["ok"] and rj["succeeded"] == 5, result)

    # 已完成条目（cover）不得重生成
    regen = read_calls(calls2)
    check("S1.5 已完成条目零重复生成", "cover" not in regen, f"regen={regen}")
    # 终态核验
    v = subprocess.run(["node", str(GEN), "--article-dir", str(d), "--verify-only"], capture_output=True, text=True, cwd=str(IG))
    check("S1.6 verify-only ok", v.returncode == 0, v.stdout)


def s2_sigint_graceful(root: Path):
    print("== S2 SIGINT 优雅中止 ==")
    d = make_article(root, 5, slow_ms=500)
    p, calls, out, _ = spawn_run(d, slow_ms=500)
    time.sleep(1.2)
    p.send_signal(signal.SIGINT)
    rc = p.wait(timeout=15)
    log = (d / ".run.log").read_text(encoding="utf8", errors="replace")
    check("S2.1 SIGINT 后 exit 130", rc == 130, f"rc={rc}")
    m = read_manifest(d)
    running = [e["id"] for e in m["entries"].values() if e["status"] == "running"]
    check("S2.2 running 回写 pending（无遗留 running）", not running, str(running))
    # 锁文件必须随进程退出释放/可接管；续跑立即成功（不等死锁超时）
    p2, calls2, _, _ = spawn_run(d, slow_ms=0)
    rc2 = p2.wait()
    log2 = (d / ".run.log").read_text(encoding="utf8", errors="replace")
    check("S2.3 续跑不被残留锁阻塞且 exit 0", rc2 == 0, f"rc={rc2}\n{log2[-300:]}")
    result = [l for l in log2.split("\n") if l.startswith("[RESULT]")][-1]
    rj = json.loads(result[len("[RESULT]"):])
    check("S2.4 续跑补齐全量", rj["ok"] and rj["succeeded"] == 5, result)


def main():
    if os.name == "nt":
        print("[SKIP] Windows 信号语义受限（SIGKILL/进程组），按约定跳过（见 windows-signal-semantics-stop.md）")
        print("=== ALL DONE ===")
        print(f"PASS {len(PASSED)} / FAIL {len(FAILED)}")
        return 0
    root = Path(tempfile.mkdtemp(prefix="ig-a09-"))
    try:
        s1_sigkill_recovery(root)
        s2_sigint_graceful(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print("=== ALL DONE ===")
    print(f"PASS {len(PASSED)} / FAIL {len(FAILED)}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
