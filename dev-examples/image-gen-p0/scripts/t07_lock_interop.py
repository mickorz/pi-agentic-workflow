#!/usr/bin/env python3
"""P0 T0.7 锁协议跨语言互操作测试。

矩阵（每个用例独立锁路径，避免串扰）：
  T1  Node 持锁(活)     → Python acquire → LockHeldError（携带正确 pid）
  T2  Python 持锁(活)   → Node acquire   → LockHeldError
  T3  Node 死进程锁     → Python acquire → [LOCK] TAKEOVER 成功
  T4  Python 死进程锁   → Node acquire   → TAKEOVER 成功 + release 删除锁文件
  T5  全程结束无锁文件残留
"""
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from pathlib import PurePosixPath

SANDBOX = Path(__file__).resolve().parent.parent
LOCK_URL = "file://" + str(PurePosixPath(SANDBOX / "scripts" / "article_lock.mjs"))
sys.path.insert(0, str(SANDBOX.parent / "wx-article" / "scripts" / "draft_manager"))
from article_lock import ArticleLock, LockHeldError  # noqa: E402

RESULTS = []


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


NODE_HOLDER = f"""
import('{LOCK_URL}').then(async (m) => {{
  const lk = await new m.ArticleLock('{{LOCK}}', {{ runId: 'node-holder', scope: 'article' }}).acquire();
  console.log('NODE_LOCKED');
  await new Promise(r => setTimeout(r, 30000));
  await lk.release();
}});
"""


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="t07-"))

    # ---------- T1: Node 活锁 vs Python ----------
    lock1 = tmp / ".publish.article.t1.lock"
    holder = subprocess.Popen(["node", "--input-type=module", "-e", NODE_HOLDER.replace("{LOCK}", str(lock1))],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if holder.stdout.readline().strip() != "NODE_LOCKED":
        record("T1 Node活锁 vs Python", False, "holder 启动失败: " + holder.stderr.read()[:150])
    else:
        try:
            ArticleLock(lock1, run_id="py-t1").acquire()
            record("T1 Node活锁 vs Python", False, "Python 竟然获取成功")
        except LockHeldError as e:
            record("T1 Node活锁 vs Python", e.info.get("pid") == holder.pid,
                   f"LockHeldError pid={e.info.get('pid')} (期望 {holder.pid}) runId={e.info.get('runId')}")
    holder.terminate(); holder.wait()  # 退出不 release → 崩溃残留

    # ---------- T2: Python 活锁 vs Node ----------
    lock2 = tmp / ".publish.acct.t2.lock"
    plock = ArticleLock(lock2, run_id="py-holder", scope="account")
    plock.acquire()
    r = subprocess.run(["node", "--input-type=module", "-e", f"""
import('{LOCK_URL}').then(async (m) => {{
  await new m.ArticleLock('{lock2}', {{ runId: 'node-t2' }}).acquire();
}}).catch(e => {{ console.log('NODE_ERR:', e.constructor.name, e.message.slice(0, 120)); process.exit(3); }});
"""], capture_output=True, text=True, timeout=30)
    record("T2 Python活锁 vs Node", r.returncode == 3 and "LockHeldError" in r.stdout,
           r.stdout.strip().splitlines()[-1][:120] if r.stdout.strip() else "no output")
    plock.release()

    # ---------- T3: Node 死进程锁 → Python TAKEOVER ----------
    lock3 = tmp / ".publish.article.t3.lock"
    subprocess.run(["node", "--input-type=module", "-e", f"""
import('{LOCK_URL}').then(async (m) => {{
  await new m.ArticleLock('{lock3}', {{ runId: 'node-dying', scope: 'article' }}).acquire();
  console.log('LOCKED_THEN_EXIT');  // 不 release 直接退出
}});"""], capture_output=True, text=True, timeout=30)
    time.sleep(0.3)
    lk = ArticleLock(lock3, run_id="py-t3")
    try:
        lk.acquire()
        record("T3 Node死锁 vs Python接管", lk.taken_over, f"taken_over={lk.taken_over}")
        lk.release()
    except Exception as e:
        record("T3 Node死锁 vs Python接管", False, repr(e)[:120])

    # ---------- T4: Python 死进程锁 → Node TAKEOVER + release ----------
    lock4 = tmp / ".publish.article.t4.lock"
    ghost = subprocess.Popen([sys.executable, "-c", f"""
import sys, time
sys.path.insert(0, '{SANDBOX.parent / 'wx-article' / 'scripts' / 'draft_manager'}')
from article_lock import ArticleLock
ArticleLock('{lock4}', run_id='py-dying', scope='article').acquire()
print('PY_LOCKED')
time.sleep(0.05)
"""], stdout=subprocess.PIPE, text=True)
    ghost.stdout.readline()
    ghost.wait()
    time.sleep(0.3)
    r = subprocess.run(["node", "--input-type=module", "-e", f"""
import('{LOCK_URL}').then(async (m) => {{
  const fs = await import('node:fs');
  const lk = await new m.ArticleLock('{lock4}', {{ runId: 'node-t4' }}).acquire();
  const took = lk.takenOver;
  await lk.release();
  console.log('RESULT', took, !fs.existsSync('{lock4}'));
}}).catch(e => {{ console.log('NODE_ERR:', e.message); process.exit(3); }});
"""], capture_output=True, text=True, timeout=30)
    ok4 = r.returncode == 0 and "RESULT true true" in r.stdout
    record("T4 Python死锁 vs Node接管+release", ok4, (r.stdout + r.stderr).strip().replace("\n", " | ")[:160])

    # ---------- T5: 崩溃残留锁的最终回收（t1 锁持有者已死 → 接管后释放，终态干净）----------
    lk1 = ArticleLock(lock1, run_id="py-t5-recover")
    try:
        lk1.acquire()
        lk1.release()
        leftovers = [p.name for p in tmp.glob("*.lock")]
        record("T5 崩溃残留锁最终回收+无残留", not leftovers, f"leftovers={leftovers}")
    except Exception as e:
        record("T5 崩溃残留锁最终回收+无残留", False, repr(e)[:120])

    n_ok = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n=== T0.7 SUMMARY: {n_ok}/{len(RESULTS)} PASS ===")
    return 0 if n_ok == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
