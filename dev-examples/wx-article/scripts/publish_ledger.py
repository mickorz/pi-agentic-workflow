#!/usr/bin/env python3
"""发布历史登记（xiaolvshu 与文章线共用）。

发布/入箱成功后登记一条发布记录（含类型标签），跨篇聚合到 vault 中央索引，
后续发布同类型内容时可查历史互相引用话题标签。

索引文件：<vault>/60_Workspace/写作/单篇/发布索引.json
vault root 从 --article-dir 自动推断（含 /60_Workspace/写作/单篇/ 前缀），
也可用 --vault-root 显式指定。

用法：
  登记：python publish_ledger.py add --article-dir <dir> --title <标题> \
          --kind sticker|article --types "AI做游戏,开源项目" [--media-id <id>] [--notes "..."]
  查询：python publish_ledger.py list [--type <类型>]

输出契约：逐行 [OK]/[FAIL]；add 成功尾部 "=== LEDGER SAVED ==="；list 尾部 "=== ALL DONE ==="。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

MARKER = "60_Workspace/写作/单篇"


def ledger_path(article_dir: Path, vault_root: str | None) -> Path:
    if vault_root:
        return Path(vault_root) / MARKER / "发布索引.json"
    s = str(article_dir).replace("\\", "/")
    if MARKER in s:
        base = s.split(MARKER)[0].rstrip("/")
        return Path(base + "/" + MARKER + "/发布索引.json")
    raise SystemExit("[FAIL] 无法推断 vault root：路径不含 " + MARKER + "，请用 --vault-root 指定")


def load(p: Path) -> dict:
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"[FAIL] 索引文件损坏（{e}），先手动修复或删除后重试")
            sys.exit(1)
    return {"entries": []}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["add", "list"])
    ap.add_argument("--article-dir")
    ap.add_argument("--title")
    ap.add_argument("--kind", choices=["sticker", "article"])
    ap.add_argument("--types", help="逗号分隔的类型标签，如 AI做游戏,开源项目")
    ap.add_argument("--media-id", default="")
    ap.add_argument("--notes", default="")
    ap.add_argument("--type", dest="filter_type", help="list：按类型过滤")
    ap.add_argument("--vault-root")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if not args.article_dir:
        print("[FAIL] add/list 都需要 --article-dir")
        return 1
    adir = Path(args.article_dir)
    lp = ledger_path(adir, args.vault_root)
    data = load(lp)

    if args.cmd == "add":
        if not args.title or not args.kind or not args.types:
            print("[FAIL] add 需要 --title、--kind、--types（逗号分隔标签）")
            return 1
        types = [t.strip() for t in args.types.split(",") if t.strip()]
        entry = {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "title": args.title,
            "kind": args.kind,
            "types": types,
            "article_dir": str(adir).replace("\\", "/"),
            "media_id": args.media_id,
            "notes": args.notes,
        }
        # 同 media_id 去重（重跑不重复登记）
        if args.media_id and any(e.get("media_id") == args.media_id for e in data["entries"]):
            print(f"[SKIP] media_id 已登记过: {args.media_id}")
            print("=== LEDGER SAVED ===")
            return 0
        data["entries"].append(entry)
        lp.parent.mkdir(parents=True, exist_ok=True)
        lp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[OK] 已登记 #{len(data['entries'])}: {args.title} | 类型: {', '.join(types)}")
        print(f"[OK] 索引 -> {lp}")
        print("=== LEDGER SAVED ===")
        return 0

    # list
    entries = data["entries"]
    if args.filter_type:
        entries = [e for e in entries if args.filter_type in e.get("types", [])]
    if not entries:
        print(f"[OK] 暂无记录" + (f"（类型: {args.filter_type}）" if args.filter_type else ""))
    for e in entries:
        print(f"[{e['date']}] ({e['kind']}) {e['title']} | 类型: {', '.join(e.get('types', []))}")
    print(f"共 {len(entries)} 条" + (f"（过滤: {args.filter_type}）" if args.filter_type else ""))
    print("=== ALL DONE ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
