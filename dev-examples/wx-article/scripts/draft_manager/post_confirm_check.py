#!/usr/bin/env python3
"""确认点 2 收到"确认"后的标准检查脚本（2026-11-24 黎曼猜想篇教训固化）。

背景：确认点 2 的语义是"用户已在预览工作台完成编辑（可能保存）+ 导出 layout.html，
聊天确认即可发布"。agent 收到确认后必须先跑本脚本，按输出行动，
禁止不查产物状态就直接开浏览器重复导出（2026-11-24 被用户当场指出的错误）。

用法：
  python post_confirm_check.py --article-dir <文章目录绝对路径>

检查内容：
  1. 正文 sha vs 上次确认记录（.post-confirm-state.json）：UNCHANGED / CHANGED / FIRST_RUN
  2. layout.html vs 正文 mtime：FRESH（比正文新）/ STALE（比正文旧）/ MISSING

输出契约（stdout 文本，下游依赖这些字面量）：
  [CHECK] 正文: UNCHANGED|CHANGED|FIRST_RUN
  [CHECK] layout.html: FRESH|STALE|MISSING
  [OK]/[WARN]/[FAIL] 行 + 下一步动作说明
  === READY TO PUBLISH ===   （退出码 0，可继续 publish；含 NEED_RECHECK 提醒）
  === NEED ACTION ===        （退出码 1，需先处理再重跑本脚本）

退出码 0 时脚本会把当前正文 sha 写入 state 文件（记录"本次已核实的正文状态"）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

STATE_FILE = ".post-confirm-state.json"


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--article-dir", required=True)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    adir = Path(args.article_dir)
    md_candidates = sorted(
        [p for p in adir.glob("*.md") if not p.name.startswith(("article", "draft", "review", "大纲", "截图"))],
        key=lambda p: p.stat().st_mtime,
    )
    if not md_candidates:
        print("[FAIL] 未找到正文 md 候选")
        print("=== NEED ACTION ===")
        return 1
    md = md_candidates[-1]  # 最新修改的候选
    layout = adir / "layout.html"
    state_path = adir / STATE_FILE

    # 1) 正文 sha vs 上次确认记录
    cur_sha = sha256_of(md)
    last_sha = None
    if state_path.exists():
        try:
            last_sha = json.loads(state_path.read_text(encoding="utf-8")).get("last_confirmed_sha")
        except (json.JSONDecodeError, OSError):
            last_sha = None
    if last_sha is None:
        body_state = "FIRST_RUN"
    elif cur_sha == last_sha:
        body_state = "UNCHANGED"
    else:
        body_state = "CHANGED"
    print(f"[CHECK] 正文: {body_state} ({md.name})")

    # 2) layout.html vs 正文 mtime
    if not layout.exists():
        layout_state = "MISSING"
    elif layout.stat().st_mtime > md.stat().st_mtime:
        layout_state = "FRESH"
    else:
        layout_state = "STALE"
    print(f"[CHECK] layout.html: {layout_state}")

    exit_code = 0

    # 判定与动作
    if layout_state == "MISSING":
        print("[FAIL] layout.html 缺失：请用户在预览工作台点「导出渲染 HTML」（优先），")
        print("       或确认正文无改动后由 agent 经浏览器通道补导出；处理完重跑本脚本。")
        exit_code = 1
    elif layout_state == "STALE":
        print("[FAIL] layout.html 比正文旧：正文在导出后又变了。请用户重新点「导出渲染 HTML」，")
        print("       处理完重跑本脚本。")
        exit_code = 1
    elif body_state == "CHANGED":
        print("[WARN] 正文相比上次确认检查有改动，但 layout.html 比正文新（覆盖了改动），可直接 publish。")
        print("[ACTION] 发布前必须：①重跑 check_state.py；②更新 humanizer-scan-cache.json 中 hash 变化的章并复核。")
    elif body_state == "FIRST_RUN":
        print("[OK] 首次检查：layout.html 覆盖当前正文，可直接 publish（本次正文 sha 已记录为基准）。")
    else:
        print("[OK] 正文无改动，layout.html 覆盖当前正文，可直接 publish。")

    if exit_code == 0:
        state_path.write_text(
            json.dumps({"last_confirmed_sha": cur_sha, "updated_at": str(md.stat().st_mtime)}, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"[OK] 正文 sha 已记录 -> {STATE_FILE}")
        print("=== READY TO PUBLISH ===")
    else:
        print("=== NEED ACTION ===")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
