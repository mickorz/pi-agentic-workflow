#!/usr/bin/env python3
"""P0 Gate 测试套件：Mock 微信 API + 故障注入，验证 draft_manager/publish.py 状态机契约。

对应需求文档 V1.2 第八节 P0 Gate 与强制场景 A~D/F（E 场景属 P1 inspect）。
运行：python3 run_p0_gate_suite.py [--keep]   （--keep 保留临时目录供排查）

逐断言输出 PASS/FAIL，结尾汇总计数，=== ALL DONE === 表示全部通过（退出码 0）。
不触网：全部走 --mock；临时目录位于系统 temp，套件结束默认清理。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLISH = HERE / "publish.py"

MD_TEMPLATE = """---
title: {title}
description: {digest}
---

# {title}

开场段落，用于验证 markdown 到 HTML 的基础转换流程工作正常，内容保持足够长度。

## 第一章

第一个正文段落，保持足够的长度和真实内容，确保转换后的 HTML 字符数超过门槛值，不会被短内容门禁拒绝。

![插画一](imgs/a.png)

## 第二章

第二个正文段落同样保持一定长度，验证图片引用扫描和多图上传场景工作正常。

![插画二](imgs/b.png)
"""

YAML_PRESET = """title: 测试文章
author: Tester
digest: 自定义摘要
publish_completed: true
content_source: 正文.md
image_medium: AI生成插画（正文 5 张）
custom_keep_field: keepme-123
"""

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63fcffff3f0300050201f34a24d500"
    "00000049454e44ae426082"
)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        PASS.append(name)
        print(f"[PASS] {name}")
    else:
        FAIL.append(name)
        print(f"[FAIL] {name} {detail}")


def make_article(root: Path, name: str, n_md: int = 1) -> Path:
    art = root / name
    (art / "imgs").mkdir(parents=True)
    (art / "imgs" / "a.png").write_bytes(PNG)
    (art / "imgs" / "b.png").write_bytes(PNG)
    (art / "cover.png").write_bytes(PNG)
    for i in range(n_md):
        title = "测试文章" if i == 0 else f"干扰文章{i}"
        (art / f"正文{i if i else ''}.md").write_text(
            MD_TEMPLATE.format(title=title, digest="测试摘要"), encoding="utf-8"
        )
    (art / "article.yaml").write_text(YAML_PRESET, encoding="utf-8")
    return art


def make_config(root: Path) -> Path:
    cfg = root / "cfg"
    (cfg / ".aws-article").mkdir(parents=True)
    (cfg / "aws.env").write_text(
        "WECHAT_1_APPID=wxaaa\nWECHAT_1_APPSECRET=secret-1\n"
        "WECHAT_2_APPID=wxbbb\nWECHAT_2_APPSECRET=secret-2\n",
        encoding="utf-8",
    )
    (cfg / ".aws-article" / "config.json").write_text(
        json.dumps({"default_author": "Tester", "need_open_comment": 1, "only_fans_can_comment": 0}),
        encoding="utf-8",
    )
    return cfg


def run_pub(article_dir: Path, cfg: Path, *extra: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(PUBLISH), "--article-dir", str(article_dir), "--cover", "cover.png",
         "--config-dir", str(cfg), "--mock", *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )


def store_of(article_dir: Path) -> dict:
    f = article_dir / "publish-mock-store.json"
    if not f.is_file():
        return {"drafts": {}, "calls": []}  # 提前 FAIL 时 mock store 不会创建
    return json.loads(f.read_text(encoding="utf-8"))


def drafts_of(article_dir: Path, appid: str) -> dict:
    d = store_of(article_dir)["drafts"]
    return {k: v for k, v in d.items() if v.get("appid") == appid and not v.get("deleted")}


def state_of(article_dir: Path) -> dict:
    return json.loads((article_dir / "publish-state.json").read_text(encoding="utf-8"))


def append_para(art: Path, mark: str) -> None:
    md = next(p for p in art.glob("正文*.md") if "干扰" not in p.name)
    md.write_text(md.read_text(encoding="utf-8") + f"\n追加段落{mark}，保证内容发生变化以触发 Hash 更新。\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    root = Path(tempfile.mkdtemp(prefix="p0gate-"))
    cfg = make_config(root)
    print(f"[suite] workdir={root}")

    # ============ T1: 同账号重复 3 次只保留一份有效草稿 ============
    artA = make_article(root, "artA")
    yaml_before = (artA / "article.yaml").read_bytes()
    media_ids = []
    for i in (1, 2, 3):
        r = run_pub(artA, cfg)
        check(f"T1.run{i}.exit0", r.returncode == 0, r.stdout + r.stderr)
        mid = [ln for ln in r.stdout.splitlines() if ln.startswith("=== ALL DONE")]
        check(f"T1.run{i}.done-line", bool(mid), r.stdout)
        if mid:
            media_ids.append(mid[0].split("draft_media_id=")[-1].rstrip("= "))
    check("T1.one-draft", len(drafts_of(artA, "wxaaa")) == 1, str(drafts_of(artA, "wxaaa").keys()))
    check("T1.same-media", len(set(media_ids)) == 1, str(media_ids))
    check("T1.reuse-mark", "(reuse" in media_ids and True or False, "") if False else None
    r3 = run_pub(artA, cfg)
    check("T1.third-reuse", r3.returncode == 0 and "(reuse" in r3.stdout, r3.stdout)

    # ============ T2: 内容变更走 draft/update，不产生第二份草稿 ============
    append_para(artA, "A2")
    r = run_pub(artA, cfg)
    check("T2.exit0", r.returncode == 0, r.stdout + r.stderr)
    check("T2.updated-mark", "(updated)" in r.stdout, r.stdout)
    check("T2.still-one-draft", len(drafts_of(artA, "wxaaa")) == 1)
    acc1 = state_of(artA)["accounts"]["wxaaa"]
    check("T2.hash-changed", acc1["contentHash"] is not None and acc1["status"] == "drafted")
    check("T2.no-pending", acc1["pendingOperation"] is None)

    # ============ T5: 并发同账号 —— 只允许一个进入，草稿不重复 ============
    p1 = subprocess.Popen(
        [sys.executable, str(PUBLISH), "--article-dir", str(artA), "--cover", "cover.png",
         "--config-dir", str(cfg), "--mock"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace")
    p2 = subprocess.Popen(
        [sys.executable, str(PUBLISH), "--article-dir", str(artA), "--cover", "cover.png",
         "--config-dir", str(cfg), "--mock"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace")
    o1, o2 = p1.communicate(timeout=60)[0], p2.communicate(timeout=60)[0]
    rcs = {p1.returncode, p2.returncode}
    check("T5.rc-ok-or-locked", rcs.issubset({0, 3}), f"{p1.returncode},{p2.returncode}\n{o1}\n{o2}")
    check("T5.count-still-1", len(drafts_of(artA, "wxaaa")) == 1)

    # ============ T6: 多账号各自草稿，状态互不覆盖 ============
    # 注：并发轮次刚结束时，前序进程可能仍持有文章锁片刻(Windows 下管道 EOF 早于
    # 进程退出的时序)，[LOCKED] 属设计行为 -> 模拟用户稍后重试一次
    r = run_pub(artA, cfg, "--account-slot", "2")
    if r.returncode == 3 and "[LOCKED]" in r.stdout:
        import time as _t
        _t.sleep(1.5)
        r = run_pub(artA, cfg, "--account-slot", "2")
    check("T6.slot2-exit0", r.returncode == 0, r.stdout + r.stderr)
    d1, d2 = drafts_of(artA, "wxaaa"), drafts_of(artA, "wxbbb")
    check("T6.two-accounts-one-each", len(d1) == 1 and len(d2) == 1, f"{list(d1)},{list(d2)}")
    st = state_of(artA)["accounts"]
    check("T6.state-isolated", st["wxaaa"]["draftMediaId"] != st["wxbbb"]["draftMediaId"]
          and st["wxaaa"]["status"] == "drafted" and st["wxbbb"]["status"] == "drafted")

    # ============ T7: article.yaml 一个字节都不动（含自定义字段） ============
    check("T7.yaml-untouched", (artA / "article.yaml").read_bytes() == yaml_before)
    check("T7.no-state-in-yaml", "publish-state" not in (artA / "article.yaml").read_text(encoding="utf-8"))

    # ============ T8: 账号槽位透传（mock 记录的 appid 正确） ============
    calls = store_of(artA).get("calls", [])
    appids_used = {c["appid"] for c in calls if c["op"] == "draft_add"}
    check("T8.calls-appids", appids_used == {"wxaaa", "wxbbb"}, str(appids_used))
    check("T8.state-keys", set(state_of(artA)["accounts"].keys()) == {"wxaaa", "wxbbb"})

    # ============ T3: 明确失败（add-errcode）保留 not_drafted，可重试 ============
    artB = make_article(root, "artB")
    r = run_pub(artB, cfg, "--inject", "add-errcode")
    check("T3.exit1", r.returncode == 1 and "[FAIL]" in r.stdout, f"rc={r.returncode}\n{r.stdout}")
    acc = state_of(artB)["accounts"]["wxaaa"]
    check("T3.stay-not-drafted", acc["status"] == "not_drafted" and acc["pendingOperation"] is None)
    check("T3.no-draft", len(drafts_of(artB, "wxaaa")) == 0)
    r = run_pub(artB, cfg)
    check("T3.retry-exit0", r.returncode == 0, r.stdout + r.stderr)
    check("T3.retry-one-draft", len(drafts_of(artB, "wxaaa")) == 1)

    # ============ T4: crash-after-add => unknown，禁止自动重试，人工 resolve ============
    (artB / "publish-state.json").unlink()  # 模拟全新文章状态
    r = run_pub(artB, cfg, "--inject", "crash-after-add")
    check("T4.crash-rc9", r.returncode == 9, f"rc={r.returncode}")
    pend = state_of(artB)["accounts"]["wxaaa"]["pendingOperation"]
    check("T4.pending-running", pend is not None and pend["status"] == "running" and pend["type"] == "draft_add")
    store = store_of(artB)["drafts"]
    # 崩溃后远端草稿已建：wxaaa 名下应有 T3 的草稿 + 崩溃草稿共 2 份
    t3_mid = [k for k, v in store.items() if v["appid"] == "wxaaa"]
    check("T4.remote-draft-created", len(t3_mid) == 2, str(t3_mid))
    r = run_pub(artB, cfg)
    check("T4.unknown-exit2", r.returncode == 2 and "[UNKNOWN]" in r.stdout, f"rc={r.returncode}\n{r.stdout}")
    check("T4.no-blind-retry", len([v for v in store_of(artB)["drafts"].values() if v["appid"] == "wxaaa"]) == 2)
    # crashed 草稿 = draft_add 崩溃产物：state 里 mediaId 是 T3 的，另一个就是 crashed
    state_mid = state_of(artB)["accounts"]["wxaaa"]["draftMediaId"]
    crashed_id = [k for k in t3_mid if k != state_mid][0]
    r = run_pub(artB, cfg, "--resolve-media-id", crashed_id)
    check("T4.resolve-exit0", r.returncode == 0 and "[RESOLVED]" in r.stdout, r.stdout + r.stderr)
    acc = state_of(artB)["accounts"]["wxaaa"]
    check("T4.adopted", acc["status"] == "drafted" and acc["draftMediaId"] == crashed_id
          and acc["pendingOperation"] is None)

    # ============ T9: 多 md 歧义停止；显式 --md-file 可用 ============
    artC = make_article(root, "artC", n_md=2)
    r = run_pub(artC, cfg)
    check("T9.ambiguous-fail", r.returncode == 1 and "multiple .md" in r.stdout, r.stdout + r.stderr)
    check("T9.no-draft-created", len(drafts_of(artC, "wxaaa")) == 0)
    md2 = artC / "正文1.md"
    r = run_pub(artC, cfg, "--md-file", str(md2), "--title", "干扰文章1", "--digest", "摘要")
    check("T9.explicit-ok", r.returncode == 0, r.stdout + r.stderr)

    # ============ T10: crash-after-update => unknown，旧草稿保留 ============
    artD = make_article(root, "artD")
    r = run_pub(artD, cfg)
    check("T10.setup-exit0", r.returncode == 0, r.stdout + r.stderr)
    m1 = state_of(artD)["accounts"]["wxaaa"]["draftMediaId"]
    old_hash = state_of(artD)["accounts"]["wxaaa"]["contentHash"]
    append_para(artD, "D2")
    r = run_pub(artD, cfg, "--inject", "crash-after-update")
    check("T10.crash-rc9", r.returncode == 9, f"rc={r.returncode}")
    pend = state_of(artD)["accounts"]["wxaaa"]["pendingOperation"]
    check("T10.pending-running", pend is not None and pend["type"] == "draft_update")
    check("T10.one-draft", len(drafts_of(artD, "wxaaa")) == 1)
    r = run_pub(artD, cfg)
    check("T10.unknown-exit2", r.returncode == 2, f"rc={r.returncode}\n{r.stdout}")
    check("T10.no-second-draft", len(drafts_of(artD, "wxaaa")) == 1)
    r = run_pub(artD, cfg, "--resolve-media-id", m1)
    check("T10.resolve-keep-old", r.returncode == 0, r.stdout + r.stderr)
    acc = state_of(artD)["accounts"]["wxaaa"]
    check("T10.old-hash-kept", acc["contentHash"] == old_hash and acc["pendingOperation"] is None
          and acc["draftMediaId"] == m1)

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
