#!/usr/bin/env python3
"""写作稿直发微信草稿箱脚本 v2（P0 重构 + P2 公开发表：状态机 + 原子锁 + 账号透传 + 同内容复用）。

需求文档：dev-docs/planning/公众号文章统一处理流水线（article_pipeline）需求文档（V1.2）.md

CLI（向后兼容 wechat_md_to_draft.js 现有调用，新增参数全部可选）：
  python3 publish.py --article-dir <dir> --cover <相对路径>
                     [--account-slot N]        # 凭证取 WECHAT_N_APPID/SECRET，默认 1
                     [--md-file <路径>]        # 显式正文；缺省按 5.1 规则定位（唯一合法才自动）
                     [--title T] [--digest D] [--author A]  # 显式元数据（pipeline 传入），缺省读 frontmatter
                     [--config-dir <dir>]      # 含 aws.env 与 .aws-article 的目录；缺省向上查找
                     [--mock] [--mock-store <path>] [--inject <场景>]
                     [--freepublish]           # P2:基于已有草稿提交公开发表(内容未变才允许)
                     [--publish-status]        # 查询/落定发表状态(纯状态操作,不需要正文)
                     [--resolve-publish-id <id>]  # 人工核对后的发表结论补记
                     [--clear-pending]         # 人工确认丢弃未决操作
                     [--resolve-media-id <id>] # draft_add/update unknown 的人工恢复

两种模式（同一状态文件，互斥分支）：
  草稿模式（默认）：快照 Hash -> drafted+Hash同 复用 / Hash变 draft/update / not_drafted draft/add
  发表模式（--freepublish）：校验 drafted+Hash 未变 -> draft/get 远端核对 -> freepublish/submit
    -> pendingOperation 记 publishId -> freepublish/get 轮询确认后才写 published；
    发表成功后草稿从草稿箱移除(真实微信行为)，重复发表被拒绝。

失败语义（两模式一致）：
  WechatAPIError     明确失败 => 清 pending 保留旧状态，退出码 1（[FAIL]）
  WechatNetworkError 不确定   => pending 置 unknown/保留，退出码 2（[UNKNOWN]），禁止自动重试
  崩溃注入           进程硬退 => pending 停在 running，下次运行视为 unknown 转人工

输出契约（下游 prompt/断言依赖，不得改动字面量）：
[md]/[meta]/[html]/[imgs]/[1] TOKEN OK/[2] THUMB OK media_id=.../[3] IMG i/n ref OK/
[4] html after replace N chars/[5] DRAFT OK media_id=.../[6] state saved/
=== ALL DONE draft_media_id=... ===；失败 [FAIL] ... 退出码 1；
[UNKNOWN] ... 退出码 2；[LOCKED] ... 退出码 3；
发表模式：[PUBLISHED] .../=== ALL DONE publish_id=... ===；[PUBLISHING] ...（已受理未确认，退出码 0）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from article_lock import ArticleLock, LockHeldError  # noqa: E402
from article_state import StateRMW  # noqa: E402
from cover_resize import ensure_cover_235  # noqa: E402
from content_hash import (  # noqa: E402
    HTML_RULE_VERSION,
    cleanup_snapshot,
    compute_content_hash,
    image_refs,
    make_snapshot,
    snapshot_matches_disk,
)
from wechat_draft_api import (  # noqa: E402
    MockWechatClient,
    WechatAPIError,
    WechatClient,
    WechatNetworkError,
    load_account_credentials,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

IMG_PREFIX_EXCLUDE = re.compile(r"^(article|draft|review)")
NAME_ILLEGAL = ("审稿", "图片引用清单", "大纲", "配图建议")  # 5.1：产物命名不是合法正文


def fail(msg: str) -> int:
    print(f"[FAIL] {msg}")
    return 1


def unknown(msg: str) -> int:
    print(f"[UNKNOWN] {msg}")
    return 2


def find_config_root(start: Path) -> Path | None:
    d = start.resolve()
    while True:
        if (d / ".aws-article").exists():
            return d
        parent = d.parent
        if parent == d:
            return None
        d = parent


def select_md(article_dir: Path, explicit: str | None) -> Path:
    """V1.2 第 5.1 节正文定位：显式指定 > 唯一合法正文 > 报错（绝不猜最长名）。"""
    if explicit:
        p = Path(explicit)
        if not p.is_file():
            raise FileNotFoundError(f"md not found: {p}")
        return p
    cands = [
        p for p in sorted(article_dir.glob("*.md"))
        if not IMG_PREFIX_EXCLUDE.match(p.name)
        and not any(bad in p.name for bad in NAME_ILLEGAL)
    ]
    if len(cands) == 1:
        return cands[0]
    if not cands:
        raise FileNotFoundError(f"no legal .md in {article_dir}")
    names = ", ".join(p.name for p in cands)
    raise ValueError(f"multiple .md candidates, pass --md-file explicitly: {names}")


def read_article_yaml(article_dir: Path) -> dict:
    """读 article.yaml 的顶层 key: value（handoff/prepare 产物；简单行式解析，不引 pyyaml）。"""
    out: dict = {}
    p = article_dir / "article.yaml"
    if not p.is_file():
        return out
    for line in p.read_text(encoding="utf-8-sig").splitlines():
        if line.startswith((" ", "\t", "#")) or ":" not in line:
            continue
        k, _, v = line.partition(":")
        out[k.strip()] = v.strip()
    return out


def parse_frontmatter(md_text: str) -> tuple[str, str]:
    m = re.match(r"^---\r?\n(.*?)\r?\n---", md_text, flags=re.S)
    if not m:
        return "", ""
    fm = m.group(1)
    t = re.search(r'^title\s*:\s*"?(.+?)"?\s*$', fm, flags=re.M)
    d = re.search(r'^description\s*:\s*"?(.+?)"?\s*$', fm, flags=re.M)
    return (t.group(1) if t else ""), (d.group(1) if d else "")


def make_client(args, appid: str, secret: str, article_dir: Path, api_base: str | None = None):
    if args.mock:
        store = Path(args.mock_store) if args.mock_store else article_dir / "publish-mock-store.json"
        return MockWechatClient(appid, store, inject=args.inject, secret=secret)
    if args.inject:
        fail_and_raise("--inject only available with --mock")
    return WechatClient(appid, secret, api_base)


def fail_and_raise(msg: str):
    print(f"[FAIL] {msg}")
    sys.exit(1)


def build_article(title: str, author: str, digest: str, html: str, thumb_media_id: str, cfg: dict) -> dict:
    return {
        "title": title,
        "author": author,
        "digest": digest,
        "content": html,
        "thumb_media_id": thumb_media_id,
        "content_source_url": "",
        "need_open_comment": int(cfg.get("need_open_comment") or 0),
        "only_fans_can_comment": int(cfg.get("only_fans_can_comment") or 0),
    }


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- 发表模式 --


def _get_acc(state_path: Path, appid: str) -> dict:
    with StateRMW(state_path) as st:
        acc = st.account(appid)
        return {
            "status": acc.get("status", "not_drafted"),
            "draftMediaId": acc.get("draftMediaId"),
            "contentHash": acc.get("contentHash"),
            "publishId": acc.get("publishId"),
            "pendingOperation": dict(acc["pendingOperation"]) if acc.get("pendingOperation") else None,
        }


def freepublish_poll_and_finalize(client, state_path: Path, appid: str, publish_id: str,
                                  had_pending: bool, attempts: int = 5) -> int:
    """轮询 freepublish/get 并把终态写回状态文件。只有 status=0 才写 published。"""
    for _ in range(attempts):
        try:
            r = client.freepublish_get(publish_id)
        except WechatNetworkError as e:
            return unknown(f"发表状态查询网络异常: {e}; 稍后重跑 --publish-status 确认")
        except WechatAPIError as e:
            return unknown(f"发表状态查询失败({e}); 请人工在公众号后台核对后 --resolve-publish-id {publish_id}")
        ps = r.get("publish_status")
        if ps == 0:
            with StateRMW(state_path) as st:
                a = st.account(appid)
                a.update(status="published", publishId=publish_id, pendingOperation=None,
                         updatedAt=_now())
            print(f"[PUBLISHED] publish_id={publish_id} (草稿已从草稿箱移除)")
            print("[6] state saved")
            print(f"=== ALL DONE publish_id={publish_id} ===")
            return 0
        if ps == 1:
            if had_pending:
                with StateRMW(state_path) as st:
                    a = st.account(appid)
                    if a.get("pendingOperation"):
                        a["pendingOperation"]["publishId"] = publish_id
                        a["pendingOperation"]["status"] = "running"
            print(f"[PUBLISHING] publish_id={publish_id} 微信侧仍在发表中; 稍后重跑 --publish-status 确认")
            print("[6] state saved")
            return 0
        # 明确失败（2 原创失败 / 3 常规失败 / 4 审核不通过等）：保留 drafted 草稿，可修后重试
        with StateRMW(state_path) as st:
            a = st.account(appid)
            a["pendingOperation"] = None
            a["updatedAt"] = _now()
        return fail(f"freepublish failed publish_status={ps} (草稿保留,修复后可重新发表)")
    if had_pending:
        with StateRMW(state_path) as st:
            a = st.account(appid)
            if a.get("pendingOperation"):
                a["pendingOperation"]["publishId"] = publish_id
    print(f"[PUBLISHING] publish_id={publish_id} 轮询 {attempts} 次仍发表中; 稍后重跑 --publish-status")
    return 0


def freepublish_flow(args, client, state_path: Path, appid: str, content_hash: str | None) -> int:
    acc = _get_acc(state_path, appid)
    status = acc["status"]
    media_id = acc["draftMediaId"]
    pending = acc["pendingOperation"]

    # 1) 人工确认丢弃未决操作
    if args.clear_pending:
        if not pending:
            return fail("no pendingOperation to clear")
        with StateRMW(state_path) as st:
            st.account(appid)["pendingOperation"] = None
            st.account(appid)["updatedAt"] = _now()
        print(f"[RESOLVED] cleared pending {pending.get('type')} (人工确认不推进)")
        print("[6] state saved")
        return 0

    # 2) 未决发表操作的恢复：有 publishId 则自动查微信侧核对；无则人工
    if pending and pending.get("type") == "freepublish":
        pid = pending.get("publishId") or args.resolve_publish_id
        if not pid:
            return unknown(
                "上次发表提交结果不确定（无 publish_id）。请到公众号后台核对："
                "确认已受理 => --resolve-publish-id <publish_id>；确认未提交 => --clear-pending"
            )
        return freepublish_poll_and_finalize(client, state_path, appid, pid, had_pending=True)

    # 3) 无 pending 的人工补记（如发表成功但状态文件丢失/损坏后重建）
    if args.resolve_publish_id:
        return freepublish_poll_and_finalize(client, state_path, appid, args.resolve_publish_id, had_pending=False)

    # 4) 纯查询
    if args.publish_status:
        if status == "published":
            print(f"[PUBLISHED] 已发表 publish_id={acc.get('publishId')}")
        elif pending:
            print(f"[PUBLISHING] pending {pending.get('type')} status={pending.get('status')} "
                  f"publish_id={pending.get('publishId')}")
        else:
            print(f"[INFO] status={status}, no publish in progress")
        return 0

    if not args.freepublish:
        return fail("unreachable")

    # 5) 正式发表前置校验（V1.2 4.2：已有草稿且内容未变才允许；重复发表拒绝）
    if status == "published":
        return fail(f"already published (publish_id={acc.get('publishId')}); 重复发表拒绝")
    if status != "drafted" or not media_id:
        return fail(f"status={status} 无可发表草稿, 先运行 prepare 创建/更新草稿")
    if content_hash is None:
        return fail("content hash unavailable (本地阶段未执行?)")
    if acc["contentHash"] != content_hash:
        return fail("content changed since draft (Hash 不一致), 请先运行 prepare 更新草稿再发表")
    got = client.draft_get(media_id)
    if got is None:
        return unknown(
            f"远端草稿 {media_id} 已不存在（可能已被人工发表或删除）。请到公众号后台核对："
            f"若已发表 => --resolve-publish-id <publish_id> 补记；若被误删 => --clear-pending 后重新 prepare"
        )

    # 6) 提交（写前 pending -> submit -> 记 publishId -> 轮询确认）
    with StateRMW(state_path) as st:
        a = st.account(appid)
        a["pendingOperation"] = {"type": "freepublish", "targetHash": acc["contentHash"],
                                 "status": "running", "startedAt": _now()}
    try:
        publish_id = client.freepublish_submit(media_id)
    except WechatAPIError as e:
        with StateRMW(state_path) as st:
            a = st.account(appid)
            a["pendingOperation"] = None
            a["updatedAt"] = _now()
        return fail(f"freepublish_submit 明确失败: {e}（草稿保留,可修复后重试）")
    except WechatNetworkError as e:
        with StateRMW(state_path) as st:
            a = st.account(appid)
            if a.get("pendingOperation"):
                a["pendingOperation"]["status"] = "unknown"
        return unknown(f"freepublish_submit 网络异常: {e}; 请人工核对后台后按提示恢复")
    with StateRMW(state_path) as st:
        a = st.account(appid)
        if a.get("pendingOperation"):
            a["pendingOperation"]["publishId"] = publish_id
    print(f"[2] FREESUBMIT OK publish_id={publish_id}")
    with open(article_dir_of(state_path) / "publish.log", "a", encoding="utf-8") as f:
        f.write(f"[freepublish] {_now()} account={appid} draft={media_id} publish={publish_id}\n")
    return freepublish_poll_and_finalize(client, state_path, appid, publish_id, had_pending=True)


def article_dir_of(state_path: Path) -> Path:
    return state_path.parent


# ---------------------------------------------------------------- 草稿模式 --


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--article-dir", required=True)
    ap.add_argument("--cover", required=True)
    ap.add_argument("--account-slot", type=int, default=1)
    ap.add_argument("--md-file", default=None)
    ap.add_argument("--title", default=None)
    ap.add_argument("--digest", default=None)
    ap.add_argument("--author", default=None)
    ap.add_argument("--config-dir", default=None)
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--mock-store", default=None)
    ap.add_argument("--inject", default=None)
    ap.add_argument("--resolve-media-id", default=None)
    ap.add_argument("--freepublish", action="store_true")
    ap.add_argument("--publish-status", action="store_true")
    ap.add_argument("--resolve-publish-id", default=None)
    ap.add_argument("--clear-pending", action="store_true")
    args = ap.parse_args()

    article_dir = Path(args.article_dir)
    if not article_dir.is_dir():
        return fail(f"article_dir not found: {article_dir}")
    cover_path = (article_dir / args.cover).resolve()
    if not cover_path.is_file():
        return fail(f"cover not found: {cover_path}")
    # 封面 2.35:1 保障（2026-10-27 53401 教训：接近但非精确 2.35 会被拒；接近比例自动缩放，明显偏离仅提示）
    cov_fix = ensure_cover_235(cover_path, backup_dir=article_dir / "_cover-original")
    print(f"[COVER] {cov_fix['action']}: {cov_fix['msg']}")

    config_root = Path(args.config_dir) if args.config_dir else (
        find_config_root(article_dir) or find_config_root(Path(__file__).parent)
    )
    if config_root is None:
        return fail("cannot find config root (.aws-article); pass --config-dir")
    config_path = config_root / ".aws-article" / "config.json"
    cfg = json.loads(config_path.read_text(encoding="utf-8-sig"))

    # 账号槽位透传（P0 修复：不再写死 WECHAT_1）
    try:
        appid, secret, api_base = load_account_credentials(config_root, args.account_slot)
    except WechatAPIError as e:
        return fail(str(e))
    print(f"[account] slot={args.account_slot} appid={appid} api_base={api_base or 'official'}")

    state_path = article_dir / "publish-state.json"
    client = make_client(args, appid, secret, article_dir, api_base)
    status_only = args.publish_status or bool(args.resolve_publish_id) or args.clear_pending

    run_id = f"pid{__import__('os').getpid()}-{time.strftime('%H%M%S')}"

    # ---------- 纯状态操作（--publish-status/--resolve-publish-id/--clear-pending）不需要正文 ----------
    if status_only:
        try:
            acct_lock = ArticleLock(article_dir / f".publish.acct.{appid}.lock",
                                    run_id=run_id, scope=f"account:{appid}").acquire()
        except LockHeldError as e:
            print(f"[LOCKED] account busy: {e}")
            return 3
        try:
            return freepublish_flow(args, client, state_path, appid, None)
        finally:
            acct_lock.release()

    # ---------- 文章锁：本地阶段（正文定位/快照/Hash） ----------
    try:
        article_lock = ArticleLock(article_dir / ".publish.article.lock", run_id=run_id, scope="article").acquire()
    except LockHeldError as e:
        print(f"[LOCKED] article busy: {e}")
        return 3
    try:
        try:
            md_path = select_md(article_dir, args.md_file)
        except (FileNotFoundError, ValueError) as e:
            return fail(str(e))
        print(f"[md] {md_path.name}")

        md_text = md_path.read_text(encoding="utf-8-sig")
        fm_title, fm_digest = parse_frontmatter(md_text)
        # article.yaml 兑底（handoff/prepare 产出的标题与摘要在此；CLI 显式参数 > frontmatter > article.yaml）
        ym = read_article_yaml(article_dir)
        title = args.title or fm_title or ym.get("title", "")
        digest = args.digest or fm_digest or ym.get("digest", "")
        author = args.author or ym.get("author", "") or cfg.get("default_author") or ""
        if not title:
            return fail("no title: pass --title or add frontmatter (no more guessing)")
        digest = digest or title
        # 微信草稿 digest 上限 120 字（errcode 45004 description size out of limit）；超长截断到句读边界
        if len(digest) > 120:
            cut = digest[:120]
            for sep in ("。", "；", "，", ","):
                idx = cut.rfind(sep)
                if idx >= 54:  # 至少保留 54 字，避免截得太碎
                    cut = cut[: idx + len(sep)]
                    break
            digest = cut
            print(f"[digest] 超 120 字截断 -> {len(digest)} 字")
        author = author or "AI奇点"
        print(f"[meta] title={title} | author={author} | digestLen={len(digest)}")

        from publish_html import convert_md

        html = convert_md(md_text)
        if len(html) < 200:
            return fail(f"html too short ({len(html)} chars), content likely empty")
        print(f"[html] generated {len(html)} chars")

        refs = image_refs(md_text)
        print(f"[imgs] found {len(refs)} image refs")

        try:
            snap = make_snapshot(article_dir, md_path, cover_path, html)
        except FileNotFoundError as e:
            return fail(str(e))
        content_hash = compute_content_hash(
            snap["md_bytes"], snap["images"], snap["cover"], title, digest, author, appid
        )
        print(f"[hash] {content_hash[:16]}... (html rule v{HTML_RULE_VERSION})")
    finally:
        article_lock.release()

    # ---------- 账号锁：远程阶段（状态决策/上传/草稿或发表操作/写回） ----------
    acct_lock_path = article_dir / f".publish.acct.{appid}.lock"
    try:
        acct_lock = ArticleLock(acct_lock_path, run_id=run_id, scope=f"account:{appid}").acquire()
    except LockHeldError as e:
        print(f"[LOCKED] account busy: {e}")
        return 3

    try:
        # 发表模式分支（本地阶段已算好 content_hash）
        if args.freepublish:
            try:
                return freepublish_flow(args, client, state_path, appid, content_hash)
            finally:
                cleanup_snapshot(article_dir)

        acc = _get_acc(state_path, appid)
        pending = acc["pendingOperation"]
        if pending:
            pstatus = pending.get("status")
            ptype = pending.get("type")
            if args.resolve_media_id:
                mid = args.resolve_media_id
                if ptype == "draft_add":
                    got = client.draft_get(mid)
                    if got is None:
                        return fail(f"resolve: draft_get({mid}) not found, cannot adopt")
                    with StateRMW(state_path) as st:
                        a = st.account(appid)
                        a.update(status="drafted", draftMediaId=mid,
                                 contentHash=pending.get("targetHash"), pendingOperation=None,
                                 updatedAt=_now())
                    print(f"[RESOLVED] adopted media_id={mid} (draft_add)")
                    print("[6] state saved")
                    print(f"=== ALL DONE draft_media_id={mid} ===")
                    return 0
                # draft_update 场景：resolve 传旧 media_id 表示更新未生效，保留旧态
                if ptype == "draft_update" and mid == acc.get("draftMediaId"):
                    with StateRMW(state_path) as st:
                        a = st.account(appid)
                        a["pendingOperation"] = None
                        a["updatedAt"] = _now()
                    print(f"[RESOLVED] update not applied, keep old draft {mid} with old hash")
                    print("[6] state saved")
                    print(f"=== ALL DONE draft_media_id={mid} ===")
                    return 0
                return fail(f"resolve: unexpected media_id {mid} for pending {ptype}")
            # 无 resolve：报告 unknown，退出 2
            hint = (
                f"pending {ptype} status={pstatus}; manually check draft box, then rerun with "
                f"--resolve-media-id <id> ({'新草稿id' if ptype == 'draft_add' else '旧media_id表示更新未生效'})"
            )
            return unknown(hint)

        status = acc["status"]
        old_media_id = acc["draftMediaId"]
        old_hash = acc["contentHash"]

        # 快照与磁盘一致性（上传期间内容被改 => 中止本轮）
        if not snapshot_matches_disk(article_dir, md_path, cover_path, snap):
            cleanup_snapshot(article_dir)
            return fail("content changed during publish (snapshot mismatch), rerun")

        # ---------- 决策：复用 / 更新 / 新建 ----------
        if status == "drafted" and old_hash == content_hash and old_media_id:
            got = client.draft_get(old_media_id)
            if got is not None:
                print(f"[5] DRAFT OK media_id={old_media_id} (reuse, verified by draft/get)")
                with StateRMW(state_path) as st:
                    a = st.account(appid)
                    a["updatedAt"] = _now()
                print("[6] state saved")
                print(f"=== ALL DONE draft_media_id={old_media_id} ===")
                return 0
            print(f"[INFO] remote draft {old_media_id} gone (deleted or published), recreate")
            status, old_media_id = "not_drafted", None

        # 远程操作统一走"写前 pending -> 操作 -> 写后清理"模板
        op_type = "draft_update" if (status == "drafted" and old_media_id) else "draft_add"

        def write_pending() -> None:
            with StateRMW(state_path) as st:
                a = st.account(appid)
                a["pendingOperation"] = {
                    "type": op_type,
                    "targetHash": content_hash,
                    "status": "running",
                    "startedAt": _now(),
                }

        def clear_pending() -> None:
            with StateRMW(state_path) as st:
                a = st.account(appid)
                a["pendingOperation"] = None
                a["updatedAt"] = _now()

        def mark_unknown() -> None:
            with StateRMW(state_path) as st:
                a = st.account(appid)
                if a.get("pendingOperation"):
                    a["pendingOperation"]["status"] = "unknown"

        try:
            write_pending()

            print("[1] TOKEN OK")
            thumb_media_id = client.add_material_image(snap["cover"])
            print(f"[2] THUMB OK media_id={thumb_media_id}")

            html_snap = (snap["dir"] / "content.html").read_text(encoding="utf-8")
            img_map: dict[str, str] = {}
            for idx, ref in enumerate(snap["refs"], 1):
                img_local = snap["images"][idx - 1]
                url = client.uploadimg(img_local)
                img_map[ref] = url
                print(f"[3] IMG {idx}/{len(snap['refs'])} {ref} OK")
            for ref, url in img_map.items():
                html_snap = html_snap.replace(ref, url)
                html_snap = html_snap.replace(ref.replace("/", "\\"), url)
            print(f"[4] html after replace {len(html_snap)} chars")

            article = build_article(title, author, digest, html_snap, thumb_media_id, cfg)

            if op_type == "draft_update":
                client.draft_update(old_media_id, article, index=0)
                new_media_id = old_media_id
            else:
                new_media_id = client.draft_add(article)

            print(f"[5] DRAFT OK media_id={new_media_id}" + (" (updated)" if op_type == "draft_update" else ""))
            with StateRMW(state_path) as st:
                a = st.account(appid)
                a.update(
                    status="drafted",
                    draftMediaId=new_media_id,
                    contentHash=content_hash,
                    thumbMediaId=thumb_media_id,
                    pendingOperation=None,
                    updatedAt=_now(),
                )
        except WechatAPIError as e:
            # draft_update 40007 = 旧草稿已删除/已发表移除（media_id 失效）：
            # 自愈——重置账号态走下次 draft_add 新建（图已传完，不再让用户手工改 state）。
            # 仅针对 update 阶段的 40007；draft_add 阶段 40007 属异常照旧失败。
            if e.errcode == 40007 and op_type == "draft_update":
                clear_pending()
                cleanup_snapshot(article_dir)
                with StateRMW(state_path) as st:
                    a = st.account(appid)
                    a.update(status="not_drafted", draftMediaId=None, thumbMediaId=None,
                             pendingOperation=None, updatedAt=_now())
                print("[RESET] 旧 draft media_id 已失效（40007），账号态已重置为 not_drafted；重跑将走 draft_add 新建")
                return fail(f"{e.where} errcode={e.errcode}: {e}（已重置状态，重跑即新建）")
            clear_pending()
            cleanup_snapshot(article_dir)
            return fail(f"{e.where} errcode={e.errcode}: {e}")
        except WechatNetworkError as e:
            mark_unknown()
            return unknown(f"{e}; rerun with --resolve-media-id after manual check")

        # 产物日志（append 幂等，仅记录不作为状态来源）
        stamp = _now()
        with open(article_dir / "publish.log", "a", encoding="utf-8") as f:
            f.write(f"[publish] {stamp} account={appid} draft={new_media_id} "
                    f"mode={op_type} hash={content_hash[:12]}\n")
        cleanup_snapshot(article_dir)
        print("[6] state saved")
        print(f"=== ALL DONE draft_media_id={new_media_id} ===")
        return 0
    finally:
        acct_lock.release()


if __name__ == "__main__":
    sys.exit(main())
