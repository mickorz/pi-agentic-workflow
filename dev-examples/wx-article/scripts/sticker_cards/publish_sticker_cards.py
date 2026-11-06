#!/usr/bin/env python3
"""publish_sticker_cards.py —— 小绿书卡片发布入口（T5：消费 T4 产物 + 授权指纹 + 调 publish.py）。

职责边界（2026-11-06 评审定案）：
- 只做：发布资格验证（Gate 1）、发布授权指纹（Gate 2）、构建参数、调用现有
  `draft_manager/publish.py --xiaolvshu`。**不重新实现微信发布逻辑**。
- 发布图片只消费 `_cards/output/01..NN.png`（经 verify_cards 验收的产物），
  通过 publish.py `--images-from` 传入，禁止重扫 assets/render 等目录（P0-3）。

两阶段授权（P0-2/P0-5）：
  阶段 A `--prepare`：Gate 1（verify_cards --require-approved）-> 计算发布授权指纹 ->
      写 _cards/publish-approval.json（PENDING_APPROVAL）-> 打印审批摘要（标题/配文/图序/账号）。
      工作流在此之后发起发布 checkpoint（skip_confirm 不能绕过——脚本层没有跳过授权的入口）。
  阶段 B `--execute --approval <指纹>`：重新 Gate 1（P0-1，审批期间内容可能被改）->
      重算当前实际指纹与 --approval 比对（标题/配文/图片/账号任一变化 => 授权失效拒绝，P0-2）->
      调 publish.py。DRAFTED 后 approval 置 CONSUMED（重复 --execute 拒绝，P0-4 第一层）；
      UNKNOWN 保持 PENDING（publish.py 同 Hash 复用机制防重复草稿，重跑 --execute 安全）。

授权指纹 = sha256(canonical_json{pages_sha256, manifest_sha256,
  images:[{no,sha256}...], title_sha256, content_sha256, account_slot})。
任何内容变化（含标题/配文/账号）都会改变指纹，必须重新 --prepare 审批。

退出码/终态（P0-4，复用 publish.py 状态机）：
  DRAFTED=0（=== PUBLISH DONE (DRAFTED) ===）/ FAILED=1 / UNKNOWN=2 / LOCKED=3；
  授权或资格错误=1（=== PUBLISH REJECTED ===）。

CLI：
  python3 publish_sticker_cards.py --pages <pages.json> --cards-dir <article_dir/_cards>
      [--title T] [--content C]           # 缺省读 pages.json 的 title/content
      [--account-slot N]                  # 缺省 1
      --prepare                           # 阶段 A：验证 + 指纹 + 审批摘要
      --execute --approval <指纹>          # 阶段 B：校验授权 + 调 publish.py
      [--mock] [--mock-store <path>] [--inject <场景>]   # 测试透传 publish.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PUBLISH_SCRIPT = Path(__file__).resolve().parents[1] / "draft_manager" / "publish.py"
VERIFY_SCRIPT = Path(__file__).resolve().parent / "verify_cards.py"


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _canonical(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(payload: dict) -> str:
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def gate1_verify(pages_path: Path, cards_dir: Path) -> tuple[bool, str]:
    """Gate 1：verify_cards --require-approved（独立进程，硬性规则全查）。"""
    r = subprocess.run(
        [sys.executable, str(VERIFY_SCRIPT), "--pages", str(pages_path),
         "--cards-dir", str(cards_dir), "--require-approved"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    tail = "\n".join(r.stdout.splitlines()[-6:])
    return r.returncode == 0, tail


def collect_fingerprint_payload(pages_path: Path, cards_dir: Path,
                                title: str, content: str, account_slot: int) -> dict:
    """收集当前实际状态构造指纹载荷（调用前必须已过 Gate 1）。"""
    manifest = json.loads((cards_dir / "cards-manifest.json").read_text(encoding="utf-8"))
    images = []
    for entry in manifest["pages"]:  # 页序 = pages.json 序（normalize 保证）
        img = cards_dir / entry["asset"]  # manifest asset 相对 _cards/（normalize 写入约定）
        images.append({"no": entry["no"], "sha256": sha256_of(img)})
    return {
        "pages_sha256": sha256_of(pages_path),
        "manifest_sha256": sha256_of(cards_dir / "cards-manifest.json"),
        "images": images,
        "title_sha256": sha256_text(title),
        "content_sha256": sha256_text(content),
        "account_slot": str(account_slot),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--cards-dir", required=True, help="article_dir/_cards")
    ap.add_argument("--title", default=None, help="小绿书标题；缺省读 pages.json title")
    ap.add_argument("--content", default=None, help="配文；缺省读 pages.json content")
    ap.add_argument("--account-slot", type=int, default=1)
    ap.add_argument("--prepare", action="store_true", help="阶段 A：资格验证 + 指纹 + 审批摘要")
    ap.add_argument("--execute", action="store_true", help="阶段 B：校验授权 + 调 publish.py")
    ap.add_argument("--approval", default=None, help="阶段 B 传入 --prepare 输出的授权指纹")
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--mock-store", default=None)
    ap.add_argument("--inject", default=None)
    ap.add_argument("--clear-pending", action="store_true",
                    help="人工恢复：确认上次未产生草稿，清除 publish.py pendingOperation")
    ap.add_argument("--resolve-media-id", default=None,
                    help="人工恢复：上次草稿实际已产生，补记 media_id（发布凭证不变）")
    ap.add_argument("--config-dir", default=None,
                    help="透传 publish.py（缺省自文章目录向上查找）")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cards_dir = Path(args.cards_dir)
    art_dir = cards_dir.parent
    pages_path = Path(args.pages).resolve()

    # ---------- 人工恢复通道（不消耗授权指纹，不创建新内容） ----------
    if args.clear_pending or args.resolve_media_id:
        ap_path = cards_dir / "publish-approval.json"
        approval = {}
        if ap_path.is_file():
            try:
                approval = json.loads(ap_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        try:
            pages_data = json.loads(pages_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            pages_data = {}
        title = approval.get("title") or pages_data.get("title", "")
        content = approval.get("content", "")
        rec_mock = ["--mock"] if args.mock else []
        if args.mock_store:
            rec_mock += ["--mock-store", args.mock_store]
        rec_cmd = [sys.executable, str(PUBLISH_SCRIPT),
                   "--article-dir", str(art_dir), "--xiaolvshu",
                   "--images-from", "_cards/output",
                   "--title", title, "--content", content,
                   # P1-1：沿用原审批账号槽位（approval 优先，避免退化到缺省 slot 账号错位）
                   "--account-slot", str(approval.get("account_slot", args.account_slot)), *rec_mock]
        if args.clear_pending:
            rec_cmd += ["--clear-pending"]
        else:
            rec_cmd += ["--resolve-media-id", args.resolve_media_id]
        r = subprocess.run(rec_cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300)
        if r.stderr.strip():
            print("[publish.py stderr] " + r.stderr.strip()[-300:])
        print("\n".join(r.stdout.splitlines()[-8:]))
        # P1-2：按 publish.py 实际结果返回，恢复失败不得误报成功
        if r.returncode == 0:
            print(f"=== PUBLISH DONE ({'CLEARED' if args.clear_pending else 'RESOLVED'}) ===")
            return 0
        print(f"=== PUBLISH DONE (RECOVERY_FAILED, rc={r.returncode}) ===")
        return r.returncode
        # P1-2：按 publish.py 实际结果返回，恢复失败不得误报成功
        if r.returncode == 0:
            print(f"=== PUBLISH DONE ({'CLEARED' if args.clear_pending else 'RESOLVED'}) ===")
            return 0
        print(f"=== PUBLISH DONE (RECOVERY_FAILED, rc={r.returncode}) ===")
        return r.returncode
    if bool(args.prepare) == bool(args.execute):
        print("[FAIL] 必须且只能选择一个阶段：--prepare 或 --execute")
        print("=== PUBLISH REJECTED ===")
        return 1

    # ---------- 阶段 A：Gate 1 + 指纹 + 审批摘要 ----------
    if args.prepare:
        ok, tail = gate1_verify(pages_path, cards_dir)
        print(tail)
        if not ok:
            print("[FAIL] Gate 1 发布资格未通过（全部 READY + 全部 APPROVED + manifest 一致）")
            print("=== PUBLISH REJECTED ===")
            return 1
        data = json.loads(pages_path.read_text(encoding="utf-8-sig"))
        title = (args.title if args.title is not None else data.get("title", "")).strip()
        content = (args.content if args.content is not None else data.get("content", "")).strip()
        if not title:
            print("[FAIL] 缺标题（--title 或 pages.json title）")
            print("=== PUBLISH REJECTED ===")
            return 1
        payload = collect_fingerprint_payload(pages_path, cards_dir, title, content,
                                              args.account_slot)
        fp = fingerprint(payload)
        approval = {
            "status": "PENDING_APPROVAL",
            "fingerprint": fp,
            "payload": payload,
            "title": title,
            "content": content,
            "account_slot": args.account_slot,
            "image_count": len(payload["images"]),
        }
        ap_path = cards_dir / "publish-approval.json"
        ap_path.write_text(json.dumps(approval, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[OK] Gate 1 通过。发布授权指纹: {fp}")
        print(f"     标题: {title}")
        print(f"     配文({len(content)}字): {content[:60]}{'...' if len(content) > 60 else ''}")
        print(f"     图片: {len(payload['images'])} 张（output/01..NN，全部 APPROVED）")
        print(f"     账号槽位: {args.account_slot}")
        print(f"[OK] 待审批文件 -> {ap_path}")
        print("[提示] 请人工确认以上内容；确认后以 --execute --approval <指纹> 发布。")
        print("=== PREPARE DONE ===")
        return 0

    # ---------- 阶段 B：授权校验 + 发布 ----------
    if not args.approval:
        print("[FAIL] --execute 需要 --approval <指纹>（来自 --prepare）")
        print("=== PUBLISH REJECTED ===")
        return 1
    ap_path = cards_dir / "publish-approval.json"
    if not ap_path.is_file():
        print("[FAIL] 无待审批文件（先运行 --prepare）")
        print("=== PUBLISH REJECTED ===")
        return 1
    approval = json.loads(ap_path.read_text(encoding="utf-8"))
    if approval.get("status") == "CONSUMED":
        print(f"[FAIL] 该授权已消费（此前已发布 draft={approval.get('draft_media_id')}），"
              f"重复发布会产生重复草稿。如需重发请重新 --prepare。")
        print("=== PUBLISH REJECTED ===")
        return 1
    if approval.get("status") != "PENDING_APPROVAL":
        print(f"[FAIL] 授权状态异常: {approval.get('status')}")
        print("=== PUBLISH REJECTED ===")
        return 1
    if args.approval.strip() != approval.get("fingerprint"):
        print("[FAIL] 授权指纹不匹配：内容在审批后发生变化（标题/配文/图片/账号），"
              "请重新 --prepare 审批")
        print("=== PUBLISH REJECTED ===")
        return 1


    # Gate 1 重验（P0-1：审批期间内容可能被改）
    ok, tail = gate1_verify(pages_path, cards_dir)
    print(tail)
    if not ok:
        print("[FAIL] 发布前重新验证未通过（P0-1）：内容已变化，原授权作废，请重新 --prepare")
        print("=== PUBLISH REJECTED ===")
        return 1
    # 指纹重验（verify 不覆盖标题/配文/账号）
    title = (args.title if args.title is not None else approval.get("title", "")).strip()
    content = (args.content if args.content is not None else approval.get("content", "")).strip()
    payload = collect_fingerprint_payload(pages_path, cards_dir, title, content,
                                          args.account_slot)
    if fingerprint(payload) != args.approval.strip():
        print("[FAIL] 当前实际状态与授权指纹不符（P0-2），授权作废，请重新 --prepare")
        print("=== PUBLISH REJECTED ===")
        return 1

    mock_args = []
    if args.mock:
        mock_args += ["--mock"]
        if args.mock_store:
            mock_args += ["--mock-store", args.mock_store]
    if args.inject:
        mock_args += ["--inject", args.inject]

    # 调 publish.py（参数数组直传，不经 shell；P0-3：--images-from output）
    cmd = [sys.executable, str(PUBLISH_SCRIPT),
           "--article-dir", str(art_dir), "--xiaolvshu",
           "--images-from", "_cards/output",
           "--title", title, "--content", content,
           "--account-slot", str(args.account_slot), *mock_args]
    if args.config_dir:
        cmd += ["--config-dir", str(Path(args.config_dir).resolve())]
    print("[发布] 调用 publish.py（xiaolvshu 模式，图片来自 _cards/output）")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300)
    except subprocess.TimeoutExpired:
        print("[HOLD] publish.py 超时 -> UNKNOWN（请人工核对草稿箱，勿直接重试；"
              "重跑 --execute 会走同 Hash 复用防重复草稿）")
        print("=== PUBLISH DONE (UNKNOWN) ===")
        return 2
    if r.stderr.strip():
        print("[publish.py stderr] " + r.stderr.strip()[-300:])
    tail = "\n".join(r.stdout.splitlines()[-8:])
    print(tail)

    m = re.search(r"draft_media_id=(\S+)", r.stdout)
    draft_id = m.group(1) if m else ""
    if r.returncode == 0 and "=== ALL DONE" in r.stdout:
        approval["status"] = "CONSUMED"
        approval["draft_media_id"] = draft_id
        ap_path.write_text(json.dumps(approval, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[OK] 发布小绿书成功: DRAFTED media_id={draft_id}（请到公众号后台草稿箱手动发表）")
        print("=== PUBLISH DONE (DRAFTED) ===")
        return 0
    if "[UNKNOWN]" in r.stdout or r.returncode == 2:
        # 保持 PENDING：publish.py 同 Hash 复用防重复草稿，重跑 --execute 安全
        print("[HOLD] 发布结果 UNKNOWN（草稿可能已创建）。publish.py 已进入 pending-unknown 保护："
              "人工核对草稿箱后，用 --clear-pending（确认未产生）或 --resolve-media-id <id>（已产生）恢复，"
              "再重跑 --execute 同指纹（publish.py 同 Hash 复用不会重复建草稿）")
        print("=== PUBLISH DONE (UNKNOWN) ===")
        return 2
    if "[LOCKED]" in r.stdout or r.returncode == 3:
        print("[FAIL] 文章目录被其他任务锁定（LOCKED），稍后重跑 --execute")
        print("=== PUBLISH DONE (LOCKED) ===")
        return 3
    fail_line = next((ln for ln in r.stdout.splitlines() if ln.startswith("[FAIL]")), "")
    print(f"[FAIL] 发布失败: {fail_line or '未知'}（草稿保留，修复后重跑 --execute 同指纹）")
    print("=== PUBLISH DONE (FAILED) ===")
    return 1


if __name__ == "__main__":
    sys.exit(main())
