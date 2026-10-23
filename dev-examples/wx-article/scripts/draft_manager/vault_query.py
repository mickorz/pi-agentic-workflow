#!/usr/bin/env python3
"""Obsidian vault 查询后端：list / read / search（只读：零写、零网络、零 LLM）。

P1a Phase R：dev-docs/design/2026-10-23-p1a-obsidian-service-执行方案.md §1/§4/§5
契约：stdout 单个 JSON（UTF-8）；退出码恒 0（ok 字段承载语义；仅崩溃才非 0）。
P0 vault_resolver.py 的定位契约与配置链不动；本脚本是新查询链（§5）。

用法：
  python3 vault_query.py --action list [--scope <目录|别名>] [--limit N]
  python3 vault_query.py --action read --path <vault相对路径.md>
  python3 vault_query.py --action search --query <词> [--mode name|content|both] [--scope ...] [--limit N]
  公共旗标：--vault-root <路径>（最高优先） --budget-ms <毫秒>（扫描预算，缺省 10000）

vault_root 优先级（§5，高→低）：
  --vault-root > 环境变量 OBSIDIAN_VAULT_ROOT > 仓库根 obsidian.config.json（键 vault_root/scope_aliases）
  > .aws-article/config.json（只读兼容，键同上）
  后两级：自 cwd 向上找，再自脚本位置向上找兜底。

查询契约（§4，统一列表）：
  列表/搜索 → {ok, total, truncated, items:[{path, title, snippet(≤120字), mtime}]}
  limit 缺省 20；排序 = 路径字典序（确定性，写进门禁）
  单文件 >2MB 跳过并计入 skipped_large；扫描预算（缺省 10s）超时 → truncated=true + truncated_reason=scan_budget
  read → 单文件 ≤512KB 全文返回，超限 ok:false 且 issues 带实际尺寸
  搜索大小写不敏感（name=路径/标题子串；content=正文子串；both=任一）

安全：rel 必须落在 vault 根内（Path.resolve() 后校验，拒 .. 与符号链接逃逸）；
  剪枝 .obsidian/imgs/assets 与隐藏项；不跟入符号链接；只枚举 .md。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PRUNE_DIRS = {".obsidian", "imgs", "assets"}
MAX_LIST_LIMIT = 200
DEFAULT_LIMIT = 20
LARGE_FILE_BYTES = 2 * 1024 * 1024        # §4：单文件 >2MB 跳过
READ_NOTE_LIMIT_BYTES = 512 * 1024        # §4：readNote ≤512KB 全文
SNIPPET_CHARS = 120                       # §4：snippet 单条 ≤120 字
SNIPPET_READ_BYTES = 8 * 1024             # snippet 只读文件头，不全量读
DEFAULT_BUDGET_MS = 10_000
MODE_CHOICES = ("name", "content", "both")


def out(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def fail(issues: list[str], **extra) -> dict:
    payload: dict = {"ok": False, "issues": issues}
    payload.update(extra)
    return payload


# ── 配置发现（§5 新链：obsidian.config.json > 兼容 .aws-article/config.json）──

def _read_config(cfg_path: Path) -> dict | None:
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def find_config(start: Path) -> tuple[Path, dict] | None:
    """自 start 向上逐级找 obsidian.config.json，再找 .aws-article/config.json。

    返回 (配置根, 配置内容)：obsidian.config.json 的配置根=其所在目录；
    .aws-article/config.json 的配置根=包含 .aws-article 的目录（writer 台账落这里）。
    """
    for cur in [start] + list(start.parents):
        p = cur / "obsidian.config.json"
        if p.is_file():
            data = _read_config(p)
            if data:
                return cur, data
    for cur in [start] + list(start.parents):
        p = cur / ".aws-article" / "config.json"
        if p.is_file():
            data = _read_config(p)
            if data:
                return cur, data
    return None


def resolve_vault_root(args_vault_root: str | None) -> tuple[Path, Path | None, dict, list[str]]:
    """返回 (vault_root 绝对路径, 配置根(可空), 配置内容, issues)。issues 非空 = 失败。"""
    issues: list[str] = []
    if args_vault_root:
        root = Path(args_vault_root).expanduser()
        if not root.is_dir():
            return Path(), None, {}, [f"--vault-root 不是目录：{args_vault_root}"]
        return root.resolve(), None, {}, issues
    env = os.environ.get("OBSIDIAN_VAULT_ROOT", "").strip()
    if env:
        root = Path(env).expanduser()
        if not root.is_dir():
            return Path(), None, {}, [f"OBSIDIAN_VAULT_ROOT 不是目录：{env}"]
        return root.resolve(), None, {}, issues
    for base in (Path.cwd(), Path(__file__).resolve().parent):
        found = find_config(base)
        if found:
            cfg_root, data = found
            vr = str(data.get("vault_root", "")).strip()
            if not vr:
                continue
            root = Path(vr).expanduser()
            if not root.is_dir():
                return Path(), None, {}, [f"配置 vault_root 不是目录：{vr}"]
            return root.resolve(), cfg_root, data, issues
    return (
        Path(),
        None,
        {},
        ["vault_root 未配置：请用 --vault-root / OBSIDIAN_VAULT_ROOT / obsidian.config.json（或兼容 .aws-article/config.json）"],
    )


# ── 通用校验 ──

def validate_rel(rel: str) -> list[str]:
    if not isinstance(rel, str) or not rel.strip():
        return ["path 必须是非空字符串"]
    r = rel.strip().replace("\\", "/")
    if r.startswith("/"):
        return ["path 必须是 vault 相对路径（不允许以 / 开头）"]
    parts = [p for p in r.split("/") if p != ""]
    if any(p in (".", "..") for p in parts):
        return ["path 不允许包含 . / .. 段"]
    return []


def safe_target(vault_root: Path, rel: str) -> tuple[Path | None, list[str]]:
    """目标绝对路径必须 resolve 后仍在 vault 根内（拒 .. 与符号链接逃逸）。"""
    rel_norm = rel.strip().replace("\\", "/")
    target = (vault_root / rel_norm)
    try:
        resolved = target.resolve()
        root_resolved = vault_root.resolve()
        if resolved != root_resolved and root_resolved not in resolved.parents:
            return None, [f"路径越界（resolve 后不在 vault 根内）：{rel_norm}"]
    except Exception:
        return None, [f"路径无法解析：{rel_norm}"]
    return resolved, []


def resolve_scope(vault_root: Path, scope: str | None, config: dict) -> tuple[Path | None, list[str]]:
    """scope → vault 内目录。别名（scope_aliases）优先于直接相对路径；大小写敏感。"""
    if not scope or not scope.strip():
        return vault_root, []
    scope_norm = scope.strip().replace("\\", "/")
    if scope_norm.startswith("/"):
        return None, [f"scope 必须是 vault 相对目录：{scope}"]
    if any(p in (".", "..") for p in scope_norm.split("/")):
        return None, [f"scope 不允许包含 . / .. 段：{scope}"]
    aliases = config.get("scope_aliases")
    mapped = ""
    if isinstance(aliases, dict):
        v = aliases.get(scope_norm)
        if isinstance(v, str) and v.strip():
            mapped = v.strip().replace("\\", "/")
    rel = mapped or scope_norm
    target, issues = safe_target(vault_root, rel)
    if issues:
        return None, issues
    assert target is not None
    if target.is_symlink() or not target.is_dir():
        return None, [f"scope 目录不存在（或不是真实目录）：{scope}"]
    return target, []


def iso_mtime(p: Path) -> str:
    try:
        ts = p.stat().st_mtime
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat(timespec="seconds")
    except OSError:
        return ""


# ── 扫描（list / search 共用；预算 + 大文件跳过 + 剪枝）──

def scan_notes(scan_root: Path, budget_deadline: float | None) -> tuple[list[Path], int, bool]:
    """返回 (md 文件绝对路径列表, skipped_large 数, 预算是否超时)。字典序排序保证确定性。"""
    found: list[Path] = []
    skipped_large = 0
    over_budget = False

    def walk(cur: Path) -> None:
        nonlocal over_budget, skipped_large
        if over_budget:
            return
        if budget_deadline is not None and time.monotonic() > budget_deadline:
            over_budget = True
            return
        try:
            entries = sorted(os.scandir(cur), key=lambda e: e.name)
        except OSError:
            return
        for entry in entries:
            if over_budget:
                return
            name = entry.name
            if name.startswith(".") or name in PRUNE_DIRS:
                continue
            p = Path(entry.path)
            if entry.is_symlink():
                continue  # 不跟入符号链接
            if entry.is_dir(follow_symlinks=False):
                walk(p)
            elif name.lower().endswith(".md") and entry.is_file(follow_symlinks=False):
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                if size > LARGE_FILE_BYTES:
                    skipped_large += 1  # §4：>2MB 跳过并计数
                    continue
                found.append(p)

    walk(scan_root)
    found.sort(key=lambda p: p.as_posix())
    return found, skipped_large, over_budget


def snippet_from_head(p: Path) -> str:
    try:
        with p.open("rb") as f:
            raw = f.read(SNIPPET_READ_BYTES)
        text = raw.decode("utf-8", errors="replace")
        return normalize_snippet(text)
    except OSError:
        return ""


def normalize_snippet(text: str) -> str:
    flat = " ".join(text.split())
    if len(flat) > SNIPPET_CHARS:
        return flat[:SNIPPET_CHARS]
    return flat


# ── 动作实现 ──

def do_list(vault_root: Path, args, config: dict) -> dict:
    scan_root, issues = resolve_scope(vault_root, args.scope, config)
    if issues:
        return fail(issues)
    assert scan_root is not None
    budget = args.budget_ms if args.budget_ms is not None else DEFAULT_BUDGET_MS
    deadline = time.monotonic() + (budget / 1000.0) if budget is not None else None
    files, skipped_large, over_budget = scan_notes(scan_root, deadline)
    total = len(files)
    limit = args.limit if args.limit is not None else DEFAULT_LIMIT
    page = files[:limit]
    items = []
    for p in page:
        rel = p.relative_to(vault_root).as_posix()
        items.append({
            "path": rel,
            "title": p.stem,
            "snippet": snippet_from_head(p),
            "mtime": iso_mtime(p),
        })
    truncated = len(page) < total or over_budget
    payload = {
        "ok": True,
        "vault_root": str(vault_root),
        "total": total,
        "truncated": truncated,
        "items": items,
        "limit": limit,
    }
    if over_budget:
        payload["truncated_reason"] = "scan_budget"
    if skipped_large:
        payload["skipped_large"] = skipped_large
    return payload


def do_read(vault_root: Path, args) -> dict:
    issues = validate_rel(args.path or "")
    if issues:
        return fail(issues)
    target, issues = safe_target(vault_root, args.path)
    if issues:
        return fail(issues)
    assert target is not None
    if target.is_symlink():
        return fail([f"目标是符号链接（拒绝）：{args.path}"])
    if not target.exists():
        return fail([f"笔记不存在：{args.path.strip()}"])
    if target.is_dir():
        return fail([f"目标是目录（read 只支持 .md 文件）：{args.path.strip()}"])
    if target.suffix.lower() != ".md":
        return fail([f"read 只支持 .md 文件：{args.path.strip()}"])
    size = target.stat().st_size
    if size > READ_NOTE_LIMIT_BYTES:
        return fail([f"笔记超过 readNote 上限：{size} 字节 > {READ_NOTE_LIMIT_BYTES}（512KB）"], path=args.path.strip(), size=size)
    content = target.read_bytes().decode("utf-8", errors="replace")
    return {
        "ok": True,
        "vault_root": str(vault_root),
        "path": target.relative_to(vault_root).as_posix(),
        "title": target.stem,
        "content": content,
        "size": size,
    }


def do_search(vault_root: Path, args, config: dict) -> dict:
    query = (args.query or "").strip()
    if not query:
        return fail(["query 必须是非空字符串"])
    mode = args.mode or "both"
    if mode not in MODE_CHOICES:
        return fail([f"mode 必须是 {'|'.join(MODE_CHOICES)}，收到 {mode}"])
    scan_root, issues = resolve_scope(vault_root, args.scope, config)
    if issues:
        return fail(issues)
    assert scan_root is not None
    budget = args.budget_ms if args.budget_ms is not None else DEFAULT_BUDGET_MS
    deadline = time.monotonic() + (budget / 1000.0) if budget is not None else None
    files, skipped_large, over_budget = scan_notes(scan_root, deadline)
    q = query.lower()
    matches = []
    for p in files:
        if deadline is not None and time.monotonic() > deadline:
            over_budget = True
            break
        rel = p.relative_to(vault_root).as_posix()
        name_hit = mode in ("name", "both") and q in rel.lower()
        content = ""
        content_hit = False
        idx = -1
        if mode in ("content", "both") or (mode == "name" and not name_hit):
            # name 模式不需要正文；只在需要时读正文（预算内）
            if mode in ("content", "both"):
                try:
                    content = p.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    content = ""
                idx = content.lower().find(q)
                content_hit = idx >= 0
        if not (name_hit or content_hit):
            continue
        if content_hit:
            start = max(0, idx - 40)
            snippet = normalize_snippet(content[start:])
        else:
            snippet = snippet_from_head(p)
        matches.append({
            "path": rel,
            "title": p.stem,
            "snippet": snippet,
            "mtime": iso_mtime(p),
        })
    matches.sort(key=lambda m: m["path"])
    total = len(matches)
    limit = args.limit if args.limit is not None else DEFAULT_LIMIT
    page = matches[:limit]
    payload = {
        "ok": True,
        "vault_root": str(vault_root),
        "query": query,
        "mode": mode,
        "total": total,
        "truncated": len(page) < total or over_budget,
        "items": page,
        "limit": limit,
    }
    if over_budget:
        payload["truncated_reason"] = "scan_budget"
    if skipped_large:
        payload["skipped_large"] = skipped_large
    return payload


def main() -> int:
    ap = argparse.ArgumentParser(description="Obsidian vault 查询后端（list/read/search，只读）")
    ap.add_argument("--action", required=True, choices=["list", "read", "search"])
    ap.add_argument("--path", default="", help="read：vault 相对路径（.md）")
    ap.add_argument("--query", default="", help="search：查询词（大小写不敏感）")
    ap.add_argument("--mode", default="both", choices=list(MODE_CHOICES))
    ap.add_argument("--scope", default="", help="vault 相对目录或 scope 别名（硬约束）")
    ap.add_argument("--limit", type=int, default=None, help="缺省 20，上限 200")
    ap.add_argument("--vault-root", default="", help="vault 根（优先级最高）")
    ap.add_argument("--budget-ms", type=int, default=None, help="扫描预算毫秒（缺省 10000）")
    args = ap.parse_args()

    if args.limit is not None and (args.limit < 1 or args.limit > MAX_LIST_LIMIT):
        out(fail([f"limit 必须在 1..{MAX_LIST_LIMIT}，收到 {args.limit}"]))
        return 0

    vault_root, _cfg_root, config, issues = resolve_vault_root(args.vault_root)
    if issues:
        out(fail(issues))
        return 0

    if args.action == "list":
        out(do_list(vault_root, args, config))
    elif args.action == "read":
        out(do_read(vault_root, args))
    else:
        out(do_search(vault_root, args, config))
    return 0


if __name__ == "__main__":
    sys.exit(main())
