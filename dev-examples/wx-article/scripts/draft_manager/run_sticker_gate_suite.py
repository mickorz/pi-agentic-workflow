#!/usr/bin/env python3
"""小绿书（贴图=newspic 图片帖）Gate 测试套件：publish.py --xiaolvshu 全场景，Mock 故障注入。

术语（2026-11 定案）：贴图=小绿书，发布贴图一律叫"发布小绿书"。

覆盖小绿书发布通道契约（与文章模式同构的状态机/锁/失败语义）：
- 首次入箱：imgs/ 自然序全量上传永久素材 -> image_post_add(newspic) -> state(kind=sticker)
- 同内容复用：Hash 同 + draft/get 远端核对通过 => 不重复建草稿
- 图片变更 => draft/update 原地更新（media_id 不变）
- 混型防护：同目录已属文章草稿(kind=article)时拒绝小绿书发布（防互踩）
- freepublish 显式拒绝（newspic 公开发表接口未验证，后台手发）
- 网络不确定（add-timeout）进 unknown 禁自动重试；人工 --resolve-media-id 补记恢复
- 明确失败（add-errcode）清 pending 保留 not_drafted
- 无图/无 imgs 目录明确报错
- 标题超 20 字截断（微信小绿书后台上限，2026-11-10 实测修正，原 32）
- 文章模式缺 --cover 回归（参数改可选后必须仍显式报错）

运行：python3 run_sticker_gate_suite.py [--keep]
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

PASS: list[str] = []
FAIL: list[str] = []

# 1x1 PNG（与 p0/p2 套件同款最小合法图）
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201f34a24d50000000049454e44ae426082")

ARTICLE_YAML = 'title: 小绿书测试\ndigest: 测试配文摘要\n'


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" | {detail}" if not cond and detail else ""))


def run_pub(article_dir: Path, cfg: Path, *extra: str, timeout: int = 90) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(PUBLISH), "--article-dir", str(article_dir),
         "--config-dir", str(cfg), "--mock", "--xiaolvshu", *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def make_fixture(root: Path, name: str, with_imgs: bool = True) -> tuple[Path, Path]:
    art = root / name
    art.mkdir(parents=True)
    (art / "article.yaml").write_text(ARTICLE_YAML, encoding="utf-8")
    if with_imgs:
        (art / "imgs").mkdir()
        for i in (1, 2, 3):
            (art / "imgs" / f"{i:02d}.png").write_bytes(PNG)
    cfg = root / f"cfg-{name}"
    (cfg / ".aws-article").mkdir(parents=True)
    (cfg / "aws.env").write_text("WECHAT_1_APPID=wxaaa\nWECHAT_1_APPSECRET=s1\n", encoding="utf-8")
    (cfg / ".aws-article" / "config.json").write_text(
        json.dumps({"need_open_comment": 1, "only_fans_can_comment": 0}), encoding="utf-8")
    return art, cfg


def store_of(art: Path) -> dict:
    return json.loads((art / "publish-mock-store.json").read_text(encoding="utf-8"))


def acc_of(art: Path) -> dict:
    return json.loads((art / "publish-state.json").read_text(encoding="utf-8"))["accounts"]["wxaaa"]


def calls_of(store: dict, op: str) -> int:
    return sum(1 for c in store.get("calls", []) if c.get("op") == op)


def all_done_id(r) -> str:
    for ln in r.stdout.splitlines():
        if ln.startswith("=== ALL DONE draft_media_id="):
            return ln.split("draft_media_id=")[-1].replace(" ===", "").strip()
    return ""


def sticker_drafts(store: dict) -> dict:
    return {k: v for k, v in store.get("drafts", {}).items() if v.get("article_type") == "newspic"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="保留临时目录便于排查")
    args = ap.parse_args()
    root = Path(tempfile.mkdtemp(prefix="sticker-gate-"))
    print(f"fixture root: {root}")

    try:
        # ---------- T1 首次入箱 ----------
        art, cfg = make_fixture(root, "t1")
        r = run_pub(art, cfg)
        check("T1 首次入箱退出码 0", r.returncode == 0, f"rc={r.returncode} out={r.stdout[-400:]}")
        mid1 = all_done_id(r)
        check("T1 ALL DONE draft_media_id", bool(mid1), r.stdout[-300:])
        store = store_of(art)
        drafts = sticker_drafts(store)
        check("T1 mock 存在 newspic 草稿", len(drafts) == 1 and mid1 in drafts, str(list(drafts)))
        d = drafts.get(mid1, {})
        check("T1 草稿含 3 张图 media_id", len(d.get("image_media_ids") or []) == 3, str(d))
        check("T1 草稿标题来自 article.yaml", d.get("title") == "小绿书测试", str(d.get("title")))
        acc = acc_of(art)
        check("T1 状态 drafted+kind=sticker", acc.get("status") == "drafted" and acc.get("kind") == "sticker", str(acc))
        check("T1 状态记 imageMediaIds", len(acc.get("imageMediaIds") or []) == 3, str(acc.get("imageMediaIds")))
        check("T1 输出含 [2] IMG 3/3", "[2] IMG 3/3 OK" in r.stdout, r.stdout[-300:])

        # ---------- T2 同内容复用 ----------
        r = run_pub(art, cfg)
        check("T2 复用退出码 0", r.returncode == 0, r.stdout[-300:])
        check("T2 同 media_id 复用", all_done_id(r) == mid1, f"{all_done_id(r)} != {mid1}")
        store = store_of(art)
        check("T2 不重复建草稿(image_post_add=1)", calls_of(store, "image_post_add") == 1,
              f"calls={calls_of(store, 'image_post_add')}")
        check("T2 复用标注 (reuse)", "(reuse" in r.stdout, r.stdout[-300:])

        # ---------- T3 图片变更 => 原地更新 ----------
        (art / "imgs" / "02.png").write_bytes(PNG[:-1] + b"\x00")  # 改一字节
        r = run_pub(art, cfg)
        check("T3 变更后更新退出码 0", r.returncode == 0, r.stdout[-300:])
        check("T3 media_id 不变(原地 update)", all_done_id(r) == mid1, r.stdout[-300:])
        store = store_of(art)
        check("T3 走 draft_update 且无新建", calls_of(store, "draft_update") == 1
              and calls_of(store, "image_post_add") == 1, str(calls_of(store, "draft_update")))

        # ---------- T4 混型防护（同目录文章草稿拒绝小绿书） ----------
        art4, cfg4 = make_fixture(root, "t4")
        (art4 / "publish-state.json").write_text(json.dumps({
            "accounts": {"wxaaa": {"status": "drafted", "draftMediaId": "mock-draft-legacy",
                                   "contentHash": "legacy", "pendingOperation": None}}}),
            encoding="utf-8")
        r = run_pub(art4, cfg4)
        check("T4 混型防护退出码 1", r.returncode == 1, f"rc={r.returncode}")
        check("T4 报 kind 不匹配", "kind 不匹配" in r.stdout, r.stdout[-300:])

        # ---------- T5 freepublish 显式拒绝 ----------
        r = run_pub(art, cfg, "--freepublish")
        check("T5 小绿书 freepublish 拒绝 rc=1", r.returncode == 1, f"rc={r.returncode}")
        check("T5 报后台手发提示", "后台" in r.stdout, r.stdout[-300:])

        # ---------- T6 网络不确定 + 人工恢复 ----------
        art6, cfg6 = make_fixture(root, "t6")
        r = run_pub(art6, cfg6, "--inject", "add-timeout")
        check("T6 超时进 UNKNOWN rc=2", r.returncode == 2, f"rc={r.returncode} out={r.stdout[-300:]}")
        acc6 = acc_of(art6)
        check("T6 pending=unknown", (acc6.get("pendingOperation") or {}).get("status") == "unknown", str(acc6))
        check("T6 超时时远端无草稿(请求未完成)", len(sticker_drafts(store_of(art6))) == 0,
              str(list(sticker_drafts(store_of(art6)))))
        r = run_pub(art6, cfg6)
        check("T6 无 resolve 重跑仍 UNKNOWN", r.returncode == 2, f"rc={r.returncode}")
        # 模拟人工核对：后台发现草稿其实已建成（如微信侧实际受理），补记 media_id 恢复
        remote_id = "mock-post-manual0001"
        store6 = store_of(art6)
        store6.setdefault("drafts", {})[remote_id] = {
            "article_type": "newspic", "title": "小绿书测试", "appid": "wxaaa", "deleted": False}
        (art6 / "publish-mock-store.json").write_text(json.dumps(store6, ensure_ascii=False), encoding="utf-8")
        r = run_pub(art6, cfg6, "--resolve-media-id", remote_id)
        check("T6 resolve 补记恢复 rc=0", r.returncode == 0, f"rc={r.returncode} out={r.stdout[-300:]}")
        check("T6 恢复后 media_id 一致", all_done_id(r) == remote_id, r.stdout[-300:])
        check("T6 状态 drafted", acc_of(art6).get("status") == "drafted", str(acc_of(art6)))

        # ---------- T7 明确失败 ----------
        art7, cfg7 = make_fixture(root, "t7")
        r = run_pub(art7, cfg7, "--inject", "add-errcode")
        check("T7 明确失败 rc=1", r.returncode == 1, f"rc={r.returncode}")
        acc7 = acc_of(art7)
        check("T7 pending 清空+not_drafted", acc7.get("status") == "not_drafted"
              and not acc7.get("pendingOperation"), str(acc7))

        # ---------- T8 无图报错 ----------
        art8, cfg8 = make_fixture(root, "t8", with_imgs=False)
        r = run_pub(art8, cfg8)
        check("T8 无 imgs 目录 rc=1", r.returncode == 1, f"rc={r.returncode}")
        check("T8 报缺图", "imgs" in r.stdout, r.stdout[-300:])

        # ---------- T9 标题截断 ----------
        art9, cfg9 = make_fixture(root, "t9")
        r = run_pub(art9, cfg9, "--title", "超长标题测试" * 8)  # 48 字
        check("T9 截断后入箱 rc=0", r.returncode == 0, f"rc={r.returncode} out={r.stdout[-300:]}")
        store9 = store_of(art9)
        d9 = list(sticker_drafts(store9).values())[0]
        check("T9 标题 20 字", len(d9.get("title") or "") == 20, f"len={len(d9.get('title') or '')}")

        # ---------- T10 文章模式缺 cover 回归 ----------
        artA, cfgA = make_fixture(root, "t10")
        (artA / "正文.md").write_text(
            "---\ntitle: 回归\n---\n\n# 回归\n\n" + "正文段落保证长度超过门禁，内容真实自然不空洞。" * 3,
            encoding="utf-8")
        r = subprocess.run(
            [sys.executable, str(PUBLISH), "--article-dir", str(artA), "--config-dir", str(cfgA), "--mock"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
        check("T10 文章模式缺 cover 显式报错 rc=1", r.returncode == 1 and "cover required" in r.stdout,
              f"rc={r.returncode} out={r.stdout[-200:]}")

    finally:
        if args.keep:
            print(f"kept: {root}")
        else:
            shutil.rmtree(root, ignore_errors=True)

    print(f"\n=== 汇总 PASS={len(PASS)} FAIL={len(FAIL)} ===")
    if FAIL:
        print("failed cases: " + ", ".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
