#!/usr/bin/env python3
"""P2 Gate 测试套件：公开发表（freepublish）全场景，Mock 故障注入。

覆盖 V1.2 P2 Gate 与发表模式契约：
- 正常发表：submit 受理 -> get 首查发表中([PUBLISHING]) -> 再查成功([PUBLISHED]) -> 状态 published
- 发表后草稿从草稿箱移除(真实微信行为) => draft/get 为 None
- 重复发表拒绝(status=published)
- 内容变更后发表拒绝(Hash 不一致,提示先 prepare)
- 明确失败(publish-errcode => 原创失败)保留 drafted 可重试
- 不确定失败(publish-timeout)进 unknown 禁自动重试,人工 --clear-pending 恢复
- 崩溃(crash-after-submit)：publish_id 未落盘 => unknown;人工 --resolve-publish-id 补记
- publishId 在手的恢复：重跑 --freepublish 自动轮询核对

运行：python3 run_p2_gate_suite.py [--keep]
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLISH = HERE / "publish.py"

MD = """---
title: 测试文章P2
description: P2 套件摘要
---

# 测试文章P2

开场段落保证转换后的 HTML 长度超过短内容门禁，内容真实自然不空洞。

## 正文

这里是正式段落，保持足够长度，配合发表模式的状态机与故障注入验证。

"""

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" | {detail}" if not cond and detail else ""))


def run_pub(article_dir: Path, cfg: Path, *extra: str, timeout: int = 90) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(PUBLISH), "--article-dir", str(article_dir), "--cover", "cover.png",
         "--config-dir", str(cfg), "--mock", "--title", "测试文章P2", "--digest", "P2 摘要",
         "--author", "Tester", *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def make_fixture(root: Path, name: str) -> tuple[Path, Path]:
    art = root / name
    art.mkdir(parents=True)
    (art / "cover.png").write_bytes(bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201f34a24d50000000049454e44ae426082"))
    (art / "正文.md").write_text(MD, encoding="utf-8")
    cfg = root / f"cfg-{name}"
    (cfg / ".aws-article").mkdir(parents=True)
    (cfg / "aws.env").write_text("WECHAT_1_APPID=wxaaa\nWECHAT_1_APPSECRET=s1\n", encoding="utf-8")
    (cfg / ".aws-article" / "config.json").write_text(
        json.dumps({"default_author": "Tester", "need_open_comment": 1, "only_fans_can_comment": 0}),
        encoding="utf-8")
    return art, cfg


def store_of(art: Path) -> dict:
    return json.loads((art / "publish-mock-store.json").read_text(encoding="utf-8"))


def acc_of(art: Path) -> dict:
    return json.loads((art / "publish-state.json").read_text(encoding="utf-8"))["accounts"]["wxaaa"]


def all_done_id(r) -> str:
    for ln in r.stdout.splitlines():
        if ln.startswith("=== ALL DONE"):
            key = "draft_media_id=" if "draft_media_id=" in ln else "publish_id="
            return ln.split(key)[-1].replace(" ===", "").strip()
    return ""


def pid_from(r) -> str:
    """从 [PUBLISHING]/[PUBLISHED]/[2] FREESUBMIT 行提取 publish_id(发表中路径无 ALL DONE 行)。"""
    for ln in r.stdout.splitlines():
        if "publish_id=" in ln:
            return ln.split("publish_id=")[-1].strip().replace(" ===", "")
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    root = Path(tempfile.mkdtemp(prefix="p2gate-"))
    print(f"[suite] workdir={root}")

    # ============ T1: 正常发表全流程（受理 -> 发表中 -> 成功）+ 发表后草稿移除 ============
    art, cfg = make_fixture(root, "t1")
    r = run_pub(art, cfg)  # 先建草稿
    check("T1.setup-exit0", r.returncode == 0, r.stdout + r.stderr)
    media_id = all_done_id(r)

    r = run_pub(art, cfg, "--freepublish")
    check("T1.first-submit-publishing", r.returncode == 0 and "[PUBLISHING]" in r.stdout, r.stdout + r.stderr)
    pid = pid_from(r)
    check("T1.pending-has-publish-id", acc_of(art)["pendingOperation"] is not None
          and acc_of(art)["pendingOperation"].get("publishId") == pid, str(acc_of(art)["pendingOperation"]))

    r = run_pub(art, cfg, "--freepublish")  # 恢复：pending 带 publishId => 自动轮询核对
    check("T1.recovery-poll-published", r.returncode == 0 and "[PUBLISHED]" in r.stdout, r.stdout + r.stderr)
    acc = acc_of(art)
    check("T1.status-published", acc["status"] == "published" and acc["publishId"] == pid
          and acc["pendingOperation"] is None)
    # 发表成功后草稿从草稿箱移除(真实微信行为)
    check("T1.draft-removed-after-publish", store_of(art)["drafts"][media_id]["deleted"] is True)

    # ============ T2: 重复发表拒绝 ============
    r = run_pub(art, cfg, "--freepublish")
    check("T2.duplicate-rejected", r.returncode == 1 and "already published" in r.stdout, r.stdout + r.stderr)
    check("T2.status-unchanged", acc_of(art)["status"] == "published")

    # ============ T3: 内容变更后发表拒绝（Hash 不一致 => 先 prepare） ============
    art3, cfg3 = make_fixture(root, "t3")
    run_pub(art3, cfg3)
    md = art3 / "正文.md"
    md.write_text(md.read_text(encoding="utf-8") + "\n追加段落导致内容变更。\n", encoding="utf-8")
    r = run_pub(art3, cfg3, "--freepublish")
    check("T3.changed-content-rejected", r.returncode == 1 and "Hash" in r.stdout, r.stdout + r.stderr)
    check("T3.still-drafted", acc_of(art3)["status"] == "drafted"
          and acc_of(art3)["pendingOperation"] is None)

    # ============ T4: publish-errcode 明确失败 => 保留 drafted 可重试 ============
    art4, cfg4 = make_fixture(root, "t4")
    run_pub(art4, cfg4)
    r = run_pub(art4, cfg4, "--inject", "publish-errcode", "--freepublish")
    check("T4.definite-fail-exit1", r.returncode == 1 and "[FAIL]" in r.stdout, r.stdout + r.stderr)
    acc = acc_of(art4)
    check("T4.keep-drafted-clear-pending", acc["status"] == "drafted" and acc["pendingOperation"] is None)
    r = run_pub(art4, cfg4, "--freepublish")  # 无注入重试
    check("T4.retry-ok", r.returncode == 0, r.stdout + r.stderr)

    # ============ T5: publish-timeout 不确定 => unknown 禁自动重试,人工 clear ============
    art5, cfg5 = make_fixture(root, "t5")
    run_pub(art5, cfg5)
    r = run_pub(art5, cfg5, "--inject", "publish-timeout", "--freepublish")
    check("T5.unknown-exit2", r.returncode == 2 and "[UNKNOWN]" in r.stdout, r.stdout + r.stderr)
    acc = acc_of(art5)
    check("T5.pending-unknown", acc["pendingOperation"] is not None
          and acc["pendingOperation"]["status"] == "unknown")
    r = run_pub(art5, cfg5, "--freepublish")
    check("T5.rerun-still-blocked", r.returncode == 2, f"rc={r.returncode}\n{r.stdout}")
    r = run_pub(art5, cfg5, "--clear-pending")
    check("T5.clear-pending-ok", r.returncode == 0 and "[RESOLVED]" in r.stdout, r.stdout + r.stderr)
    check("T5.drafted-restored", acc_of(art5)["status"] == "drafted"
          and acc_of(art5)["pendingOperation"] is None)

    # ============ T6: crash-after-submit => publish_id 未落盘 => unknown => 人工补记 ============
    art6, cfg6 = make_fixture(root, "t6")
    run_pub(art6, cfg6)
    r = run_pub(art6, cfg6, "--inject", "crash-after-submit", "--freepublish")
    check("T6.crash-rc9", r.returncode == 9, f"rc={r.returncode}")
    pend = acc_of(art6)["pendingOperation"]
    check("T6.pending-running-no-pid", pend is not None and pend["status"] == "running"
          and not pend.get("publishId"))
    r = run_pub(art6, cfg6, "--freepublish")
    check("T6.unknown-hint", r.returncode == 2 and "resolve-publish-id" in r.stdout, r.stdout + r.stderr)
    # 人工从后台找到 publish_id（此处从 mock store 取）补记；首查可能发表中，再查确认
    pid6 = list(store_of(art6).get("publishes", {}).keys())[0]
    r = run_pub(art6, cfg6, "--resolve-publish-id", pid6)
    if "[PUBLISHING]" in r.stdout:
        r = run_pub(art6, cfg6, "--resolve-publish-id", pid6)  # 异步:稍后再查终态
    check("T6.resolve-published", r.returncode == 0 and "[PUBLISHED]" in r.stdout, r.stdout + r.stderr)
    check("T6.final-state", acc_of(art6)["status"] == "published"
          and acc_of(art6)["publishId"] == pid6 and acc_of(art6)["pendingOperation"] is None)

    # ============ T7: --publish-status 纯查询 ============
    r = run_pub(art6, cfg6, "--publish-status")
    check("T7.status-query", r.returncode == 0 and "[PUBLISHED]" in r.stdout, r.stdout + r.stderr)

    # ============ 汇总 ============
    print(f"\n===== SUITE SUMMARY: PASS {len(PASS)} / FAIL {len(FAIL)} =====")
    if FAIL:
        print("failed items:")
        for f in FAIL:
            print(f"  - {f}")
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)
    else:
        print(f"[suite] kept workdir: {root}")
    print("=== ALL DONE ===" if not FAIL else "=== SUITE FAILED ===")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
