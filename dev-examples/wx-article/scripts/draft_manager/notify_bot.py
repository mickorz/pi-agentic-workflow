#!/usr/bin/env python3
"""微信 Bot 消息通知（outbox 投递）：向 .pi-wechat/outbox.jsonl 追加 pending 通知，
由常驻微信服务每 5s flush 经 BotAdapter 发给绑定用户（复用 NT outbox 重试状态机）。

尽力而为：缺绑定用户 / 缺数据目录 => [SKIP] 退出 0，绝不阻塞发布流程。
写入端与服务的读取端通过"单行 JSON 追加 + 折叠读取"解耦（见 src/notify/outbox.ts）。

用法：
  python notify_bot.py --text "..." [--kind info|completed|failed|interrupted] [--user <id>] [--data-dir <dir>]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

VALID_KINDS = ("info", "completed", "failed", "interrupted", "receipt", "cancelled", "approval")


def default_data_dir() -> Path:
    # notify_bot.py 位于 <repo>/dev-examples/wx-article/scripts/draft_manager/，
    # 服务数据目录为 <repo>/.pi-wechat
    return Path(__file__).resolve().parents[4] / ".pi-wechat"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--kind", default="info")
    ap.add_argument("--user", default=None)
    ap.add_argument("--data-dir", default=None)
    args = ap.parse_args()

    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    bound_file = data_dir / "bound-user.json"
    user = args.user
    if not user and bound_file.is_file():
        try:
            user = json.loads(bound_file.read_text(encoding="utf-8")).get("userId")
        except (OSError, ValueError):
            user = None
    if not user:
        print("[SKIP] wechat notify: no bound user")
        return 0

    outbox = data_dir / "outbox.jsonl"
    item = {
        "outboxId": "ob-" + uuid.uuid4().hex[:8],
        "userId": user,
        "kind": args.kind if args.kind in VALID_KINDS else "info",
        "text": args.text,
        "status": "pending",
        "attempts": 0,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
    }
    try:
        with open(outbox, "a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"[SKIP] wechat notify: outbox append failed: {e}")
        return 0
    print(f"[OK] notified kind={item['kind']} -> {user[:20]}...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
