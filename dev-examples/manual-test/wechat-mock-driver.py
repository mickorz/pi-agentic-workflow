#!/usr/bin/env python3
"""wechat-mock-driver.py — 微信链路服务级 mock 验收驱动（P1.6 V8-mock）

用法（仓根执行）:
    python3 dev-examples/manual-test/wechat-mock-driver.py \
        --article-dir "E:/Obsidian/newsky/60_Workspace/写作/单篇/V8微信验收" \
        --provider image-use

流程:
    1. 停 pm2 wechat-bot（避免服务锁冲突），起前台 `pi-workflow wechat start --mock-client`
    2. 写 mock-inbox.jsonl 发用户指令（userId 取 bound-user.json，保持绑定过滤真实生效）
    3. tail mock-outbox.jsonl 自动回复:
         「授权门/待审批」-> 批准      「风格确认」-> 批准
    4. 断言 manifest 状态与产物文件
    5. 停服务进程并恢复 pm2

stdout 契约: 逐步 [OK]/[FAIL]，结尾 === ALL PASS === 或 === FAILED n ===（exit 1）。
前置: npm run build 已执行（dist 含 --mock-client）；全局 pi-workflow 可用。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

PI = shutil.which("pi-workflow") or "pi-workflow.cmd"
NPX = shutil.which("npx") or "npx.cmd"

REPO = Path(__file__).resolve().parents[2]
DATA_DIR = REPO / ".pi-wechat"
INBOX = DATA_DIR / "mock-inbox.jsonl"
OUTBOX = DATA_DIR / "mock-outbox.jsonl"
BOUND = DATA_DIR / "bound-user.json"
SERVICE_LOG = DATA_DIR / "mock-service.log"

PASS: list = []
FAIL: list = []

# Windows GBK 控制台防崩：bot 回复可能含 emoji（如 ⏳ 待审批）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def step(ok: bool, name: str, detail: str = "") -> None:
    tag = "OK  " if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" | {detail}" if detail else ""), flush=True)
    (PASS if ok else FAIL).append(name)


def tail_outbox(after_n: int):
    """返回 outbox 自 after_n 行起的 (new_n, [(toUserId, text)...])"""
    if not OUTBOX.exists():
        return after_n, []
    lines = OUTBOX.read_text(encoding="utf-8").splitlines()
    fresh = lines[after_n:]
    msgs = []
    for line in fresh:
        try:
            j = json.loads(line)
            msgs.append((j.get("toUserId", ""), j.get("text", "")))
        except json.JSONDecodeError:
            pass
    return len(lines), msgs


def send_inbox(user_id: str, text: str) -> None:
    INBOX.parent.mkdir(parents=True, exist_ok=True)
    with INBOX.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"userId": user_id, "text": text, "messageId": f"drv-{time.time_ns()}"}) + "\n")
    print(f"[SENT] {text[:60]}...", flush=True)


def wait_for(patterns, outbox_n, timeout_s, reply_user_id=None, already=None):
    """轮询 outbox 等任一 pattern 出现；期间见授权门/风格确认自动回「批准」。
    patterns: 命中即返回的文本关键词列表。返回 (new_n, 命中的消息文本) 或 (new_n, None) 超时。"""
    seen_rules = ("授权门", "待审批", "风格确认")
    deadline = time.time() + timeout_s
    n = outbox_n
    while time.time() < deadline:
        n, msgs = tail_outbox(n)
        for _, text in msgs:
            if reply_user_id and any(rule in text for rule in seen_rules) and "回复「批准」" in text:
                if already and any(a in text for a in already):
                    continue
                time.sleep(1.5)  # 稍等 agent 落稳 pending action
                send_inbox(reply_user_id, "批准")
                print("[AUTO] 检测到审批/确认卡 -> 已自动回复「批准」", flush=True)
            if any(p in text for p in patterns):
                return n, text
        time.sleep(2)
    # 超时诊断：立即转储 bot 最后一条回复，不盲等
    _, msgs = tail_outbox(n)
    if msgs:
        print(f"[TIMEOUT-DIAG] bot 最后回复: {msgs[-1][1][:200]}", flush=True)
    return n, None


def stop_service_tree(svc):
    """强杀 .cmd->node 进程树 + 优雅停服兜底 + 等锁释放（Windows terminate 不杀孙子进程）"""
    if svc and svc.poll() is None:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(svc.pid)], capture_output=True, timeout=30)
    subprocess.run([PI, "wechat", "service", "stop"], cwd=REPO, capture_output=True, timeout=60)
    lock = DATA_DIR / "service.lock"
    for _ in range(20):
        if not lock.exists():
            return True
        try:
            info = json.loads(lock.read_text(encoding="utf-8"))
            os.kill(info.get("pid", 0), 0)
        except (FileNotFoundError, ProcessLookupError, json.JSONDecodeError, PermissionError, OSError):
            return True
        time.sleep(1)
    return not lock.exists()


def reset_agent_session(user_id: str) -> None:
    """会话隔离：归档该用户 agent 持久会话（多轮失败历史会污染判断，如「拒绝再提交同类指令」）"""
    import re as _re
    safe = _re.sub(r"[^A-Za-z0-9_-]", "_", user_id)
    sess_dir = REPO / ".pi-agent-host" / "sessions"
    if not sess_dir.exists():
        return
    for f in sess_dir.glob(f"am-{safe}*.jsonl"):
        f.rename(f.with_suffix(f".bak-{int(time.time())}.jsonl"))
        print(f"[RESET] 已归档会话 {f.name}", flush=True)


def clean_stale_pending(user_id: str) -> None:
    """前置清理：历史遗留的 pending 授权逐个拒绝，防止被自动批准误消费造成并发 race"""
    pf = DATA_DIR / "pending-actions.jsonl"
    if not pf.exists():
        return
    for _ in range(5):
        pending = []
        latest = {}
        for line in pf.read_text(encoding="utf-8").splitlines():
            try:
                j = json.loads(line)
                latest[j.get("actionId")] = j.get("status")
            except json.JSONDecodeError:
                pass
        pending = [aid for aid, st in latest.items() if st == "pending"]
        if not pending:
            return
        print(f"[CLEAN] 发现挂起授权 {pending} -> 拒绝", flush=True)
        send_inbox(user_id, "拒绝")
        time.sleep(5)


def wait_manifest_all_succeeded(manifest: Path, ids, outbox_n, timeout_s, reply_user_id=None):
    """批量完成判定以 manifest 为准（outbox 完成卡可能来自撞锁的重复 run）；期间持续自动批准授权/确认卡"""
    deadline = time.time() + timeout_s
    n = outbox_n
    while time.time() < deadline:
        n, msgs = tail_outbox(n)
        for _, text in msgs:
            if reply_user_id and ("授权门" in text or "待审批" in text or "风格确认" in text) and "回复「批准」" in text:
                time.sleep(1.5)
                send_inbox(reply_user_id, "批准")
                print("[AUTO] 检测到审批/确认卡 -> 已自动回复「批准」", flush=True)
        if manifest.exists():
            try:
                entries = json.loads(manifest.read_text(encoding="utf-8")).get("entries", {})
                if all(entries.get(i, {}).get("status") == "succeeded" for i in ids):
                    return n, True
            except json.JSONDecodeError:
                pass
        time.sleep(3)
    return n, False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--article-dir", required=True)
    ap.add_argument("--provider", default="image-use")
    ap.add_argument("--step-timeout", type=int, default=180, help="单步等待秒数(硬性 180；超时立即转储诊断)")
    args = ap.parse_args()

    article_dir = Path(args.article_dir)
    manifest = article_dir / "image-manifest.json"

    bound = json.loads(BOUND.read_text(encoding="utf-8")) if BOUND.exists() else {}
    user_id = bound.get("userId", "")
    if not user_id:
        print("[FAIL] bound-user.json 无 userId（先真机绑定过一次）")
        return 1

    # 1. 停 pm2 实例（服务锁互斥）
    subprocess.run([NPX, "pm2", "stop", "wechat-bot"], cwd=REPO, capture_output=True, timeout=60)
    step(True, "pm2 wechat-bot 已停（若在跑）")

    # 2. 清 mock 通道 + 起服务
    for f in (INBOX, OUTBOX):
        f.write_text("", encoding="utf-8")
    SERVICE_LOG.write_text("", encoding="utf-8")
    svc = subprocess.Popen(
        [PI, "wechat", "start", "--mock-client"],
        cwd=str(REPO), stdout=open(SERVICE_LOG, "a", encoding="utf-8"),
        stderr=subprocess.STDOUT,
    )
    ready = False
    for _ in range(30):
        time.sleep(1)
        log = SERVICE_LOG.read_text(encoding="utf-8", errors="replace")
        if "wechat-dispatch 已启动" in log and "client=MOCK" in log:
            ready = True
            break
        if svc.poll() is not None:
            break
    step(ready, "mock 服务启动（registry 含 --mock-client 标记）",
         SERVICE_LOG.read_text(encoding="utf-8", errors="replace")[-200:] if not ready else "")
    if not ready:
        stop_service_tree(svc)
        subprocess.run([NPX, "pm2", "start", "wechat-bot"], cwd=REPO, capture_output=True, timeout=60)
        return 1

    clean_stale_pending(user_id)
    reset_agent_session(user_id)

    outbox_n = 0
    try:
        # 3. preview 指令
        send_inbox(user_id, f"执行公众号两阶段生图 文章目录{article_dir} provider 用{args.provider}，mode 参数用 preview")
        outbox_n, hit = wait_for(["style_approved", "已生成", "预览图已生成", "失败", "校验失败"],
                                 outbox_n, args.step_timeout, reply_user_id=user_id)
        step(hit is not None and "校验失败" not in (hit or "") and "失败" not in (hit or "")[:60],
             "preview 全链（授权卡->批准->出图->风格确认->锁定）", (hit or "timeout")[:120])

        sa_ok = False
        if manifest.exists():
            sa = json.loads(manifest.read_text(encoding="utf-8")).get("style_approval", {})
            sa_ok = sa.get("status") == "approved"
        step(sa_ok, "manifest 风格审批 approved", f"status={sa.get('status') if manifest.exists() else 'no-manifest'}")

        # 4. batch 指令；完成判定以 manifest 为准（避免被撞锁重复 run 的失败卡提前误导）
        send_inbox(user_id, f"继续执行公众号两阶段生图 文章目录{article_dir} provider 用{args.provider}，mode 参数用 batch")
        ids = ["cover", "scene"]
        outbox_n, all_ok = wait_manifest_all_succeeded(manifest, ids, outbox_n, args.step_timeout, reply_user_id=user_id)
        step(all_ok, "batch 全链（授权卡->批准->出图->核验，manifest 2/2）", f"all_succeeded={all_ok}")

        m = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {}
        entries = m.get("entries", {})
        total = len(entries)
        ok_n = sum(1 for e in entries.values() if e.get("status") == "succeeded")
        step(total == 2 and ok_n == 2, "manifest 2/2 succeeded", f"{ok_n}/{total}")
        step((article_dir / "cover.png").exists(), "封面落盘 cover.png")
        step((article_dir / "imgs" / "01-confirm.png").exists(), "正文图落盘 imgs/01-confirm.png")
    finally:
        stop_service_tree(svc)
        subprocess.run([NPX, "pm2", "start", "wechat-bot"], cwd=REPO, capture_output=True, timeout=60)
        print("[DONE] mock 服务已停，pm2 wechat-bot 已恢复", flush=True)

    print(f"=== ALL PASS === ({len(PASS)} pass)" if not FAIL else f"=== FAILED {len(FAIL)} === ({len(FAIL)} fail / {len(PASS)} pass)")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
