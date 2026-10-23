#!/usr/bin/env python3
"""Vault 逻辑引用 → 本机路径 确定性解析（只读：零写、零网络、零 LLM）。

执行方案 V1.2 §S2：dev-docs/design/2026-10-23-vault-resolver-执行方案.md
契约：stdout 单个 JSON（UTF-8）；退出码恒 0（ok 字段承载语义；仅崩溃才非 0）。

用法：
  python3 vault_resolver.py --ref <逻辑引用> [--scope <vault相对目录>] [--want dir|file|article|any] [--vault-root <路径>]
  python3 vault_resolver.py --print-vaults

vault_root 优先级（高→低）：--vault-root > 环境变量 OBSIDIAN_VAULT_ROOT > .aws-article/config.json 的 vault_root（自 cwd 向上找，键可选 scope_aliases）
匹配策略：
  ref 不含 /：① 精确名称（目录名 或 .md 文件名去扩展名全等）→ ② 唯一部分匹配（大小写敏感，两机一致语义）
  ref 含 /：只允许精确匹配，不退化名称搜索；逐段用实际目录项做大小写敏感比对（防 Win/mac 大小写不敏感 FS 行为分叉）
scope 硬约束：所有策略（含精确路径）的 resolved_rel 都必须在 scope 目录之下
want=article：目录正文唯一 → 返回目录；.md 命中且父目录正文唯一 → 返回父目录；不唯一列候选，绝不猜
  正文判定复用 check_state.py 排除规则（IMG_PREFIX_EXCLUDE / NAME_ILLEGAL）
安全：Path.resolve() 后必须仍在 vault 根内（拒 .. 与符号链接逃逸）；搜索不跟入符号链接
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

IMG_PREFIX_EXCLUDE = re.compile(r"^(article|draft|review)")
NAME_ILLEGAL = ("审稿", "图片引用清单", "大纲", "配图建议")
PRUNE_DIRS = {"imgs", "assets", ".obsidian"}
WANT_CHOICES = ("dir", "file", "article", "any")


def out(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def result(ref: str = "", want: str = "any") -> dict:
    return {
        "ok": False,
        "vault_root": "",
        "ref": ref,
        "match": "",
        "want": want,
        "path_type": "",
        "resolved_path": "",
        "resolved_rel": "",
        "md": "",
        "candidates": [],
        "issues": [],
    }


# ── 配置发现 ──

def find_config_root(start: Path) -> Path | None:
    """自 start 向上找含 .aws-article/ 的目录（与 check_state.py 同款约定，但起点为 cwd）。"""
    d = start.resolve()
    while True:
        if (d / ".aws-article").exists():
            return d
        parent = d.parent
        if parent == d:
            return None
        d = parent


def load_config() -> dict:
    root = find_config_root(Path.cwd())
    if not root:
        return {}
    cfg = root / ".aws-article" / "config.json"
    if not cfg.is_file():
        return {}
    try:
        data = json.loads(cfg.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def resolve_vault_root(arg_root: str | None) -> tuple[Path | None, dict, list[str]]:
    """优先级：--vault-root > OBSIDIAN_VAULT_ROOT > config.json vault_root。"""
    config = load_config()
    raw = arg_root or os.environ.get("OBSIDIAN_VAULT_ROOT") or (config.get("vault_root") or None)
    if not raw:
        return None, config, [
            "vault_root 未配置：设环境变量 OBSIDIAN_VAULT_ROOT，或在 .aws-article/config.json 写 vault_root 字段",
            "不确定根在哪可先运行 --print-vaults 人工挑选（运行时不做自动发现）",
        ]
    p = Path(str(raw)).expanduser()
    if not p.is_dir():
        return None, config, [f"vault_root 路径不存在或不是目录: {p}"]
    return p.resolve(), config, []


# ── 遍历与匹配 ──

def is_body_md(name: str) -> bool:
    """正文唯一判定（复用 check_state.py:36-37 排除规则）。"""
    return name.lower().endswith(".md") and not IMG_PREFIX_EXCLUDE.match(name) and not any(b in name for b in NAME_ILLEGAL)


def body_mds(dirp: Path) -> list[str]:
    """目录下合法正文 md 文件名（排序稳定）。"""
    try:
        names = [e.name for e in os.scandir(dirp) if e.is_file(follow_symlinks=False)]
    except OSError:
        return []
    return sorted(n for n in names if is_body_md(n))


def walk_entries(start: Path):
    """产出 (path, is_dir)。剪枝：隐藏项、imgs/assets/.obsidian；不跟入/产出符号链接。"""
    stack = [start]
    while stack:
        cur = stack.pop()
        try:
            entries = list(os.scandir(cur))
        except OSError:
            continue
        for e in entries:
            if e.name.startswith("."):
                continue
            if e.is_symlink():
                continue
            if e.is_dir(follow_symlinks=False):
                if e.name in PRUNE_DIRS:
                    continue
                p = Path(e.path)
                yield p, True
                stack.append(p)
            else:
                yield Path(e.path), False


def rel_of(root: Path, p: Path) -> str:
    return p.resolve().relative_to(root).as_posix()


def resolve_exact_path(root: Path, rel: str) -> tuple[Path | None, list[str]]:
    """精确路径解析：逐段与实际目录项做大小写敏感比对。不退化名称搜索。"""
    cur = root
    for seg in rel.split("/"):
        if not seg or seg in (".", ".."):
            return None, [f"路径含非法段（拒越界）: {seg!r}"]
        try:
            entries = {e.name for e in os.scandir(cur)}
        except OSError:
            return None, [f"路径不存在: {rel}（含 / 的引用只做精确匹配，不退化名称搜索）"]
        if seg in entries:
            cur = cur / seg
            continue
        case_hits = sorted(n for n in entries if n.lower() == seg.lower())
        if case_hits:
            return None, [f"路径段大小写不一致: '{seg}'，实际存在 '{case_hits[0]}'（引用大小写须与实际一致）"]
        return None, [f"路径不存在: {rel}（含 / 的引用只做精确匹配，不退化名称搜索）"]
    return cur, []


def within_root(root: Path, p: Path) -> bool:
    """安全校验：resolve 后必须仍在 vault 根内（拒符号链接逃逸）。"""
    try:
        rp = p.resolve()
        return rp == root or root in rp.parents
    except OSError:
        return False


def want_accepts(is_dir: bool, want: str) -> bool:
    if want == "dir":
        return is_dir
    if want == "file":
        return not is_dir
    return True  # any / article（article 语义后处理，目录与 md 均可命中）


def name_search(root: Path, start: Path, ref: str, want: str) -> tuple[Path | None, str, list[str], list[str]]:
    """名称匹配：精确（含 .md 去 extends 名）→ 唯一部分匹配。返回 (target, match, issues, candidates)。"""
    raw: list[tuple[Path, bool, bool]] = []  # (path, is_dir, is_exact)
    for p, is_dir in walk_entries(start):
        names = [p.name] if (is_dir or not p.name.lower().endswith(".md")) else [p.name, p.stem]
        if any(n == ref for n in names):
            raw.append((p, is_dir, True))
        elif any(ref in n for n in names):
            raw.append((p, is_dir, False))
    kept = [t for t in raw if want_accepts(t[1], want)]
    exact = [t for t in kept if t[2]]
    if len(exact) >= 2:
        return None, "", [f"精确名称命中 {len(exact)} 个，需用户选择，绝不猜"], [rel_of(root, p) for p, _, _ in exact]
    if len(exact) == 1:
        return exact[0][0], "exact_name", [], []
    partial = [t for t in kept if not t[2]]
    if len(partial) >= 2:
        return None, "", [f"部分匹配命中 {len(partial)} 个，需用户选择（或重发完整 vault 相对路径），绝不猜"], [
            rel_of(root, p) for p, _, _ in partial
        ]
    if len(partial) == 1:
        return partial[0][0], "unique_partial", [], []
    if raw:
        kinds = "、".join(sorted({"文件" if not d else "目录" for _, d, _ in raw}))
        rels = sorted(rel_of(root, p) for p, _, _ in raw)
        return None, "", [f"名称命中{kinds}但不满足 want={want}: {rels}"], []
    return None, "", [f"零命中: {ref}（可重发完整 vault 相对路径，或用 --print-vaults 确认根）"], []


def resolve_scope(root: Path, scope: str, config: dict) -> tuple[Path | None, str, list[str]]:
    """scope 解析（别名表 scope_aliases 确定性映射一次）→ 精确路径目录。"""
    aliases = config.get("scope_aliases") or {}
    if not isinstance(aliases, dict):
        aliases = {}
    real = str(aliases.get(scope, scope))
    path, issues = resolve_exact_path(root, real)
    if path is None:
        try:
            tops = sorted(e.name for e in os.scandir(root) if e.is_dir(follow_symlinks=False) and not e.name.startswith("."))
        except OSError:
            tops = []
        issues.append(f"scope 不存在: {scope}；顶层目录候选: {tops}")
        return None, real, issues
    if not path.is_dir():
        return None, real, [f"scope 不是目录: {scope}"]
    return path, real, []


# ── 主流程 ──

def normalize_ref(raw: str) -> tuple[str, list[str]]:
    ref = (raw or "").strip()
    if ref.startswith("《") and ref.endswith("》") and len(ref) >= 2:
        ref = ref[1:-1].strip()
    ref = ref.replace("\\", "/")
    if not ref:
        return "", ["空引用"]
    if ref.startswith("/"):
        return "", ["引用必须为 vault 相对路径（不允许绝对路径）"]
    if any(seg in (".", "..") for seg in ref.split("/")):
        return "", ["引用含越界段（..），已拒绝"]
    return ref, []


def apply_article(root: Path, target: Path, res: dict) -> dict:
    """want=article 语义：目录正文唯一→目录；.md 命中且父目录正文唯一→父目录；不唯一列候选。"""
    if target.is_dir():
        mds = body_mds(target)
        if len(mds) == 1:
            res.update(ok=True, path_type="dir", resolved_path=str(target), resolved_rel=rel_of(root, target), md=mds[0])
            return res
        if not mds:
            res["issues"].append(f"目录无合法正文 md（排除规则后）: {rel_of(root, target)}")
            return res
        res["issues"].append(f"目录正文 md 不唯一（{len(mds)} 个），绝不自动选第一个；可用 md 文件名精确定位")
        res["candidates"] = mds
        return res
    # 文件命中
    name = target.name
    if not is_body_md(name):
        res["issues"].append(f"命中的 md 非正文文件（排除规则）: {name}")
        return res
    parent = target.parent
    mds = body_mds(parent)
    if mds == [name]:
        res.update(ok=True, path_type="dir", resolved_path=str(parent), resolved_rel=rel_of(root, parent), md=name)
        return res
    res["issues"].append(f"父目录正文 md 不唯一（{len(mds)} 个），绝不自动选第一个")
    res["candidates"] = mds
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description="Vault 逻辑引用确定性解析（只读）")
    ap.add_argument("--ref", default=None)
    ap.add_argument("--scope", default=None)
    ap.add_argument("--want", default="any", choices=WANT_CHOICES)
    ap.add_argument("--vault-root", default=None)
    ap.add_argument("--print-vaults", action="store_true")
    args = ap.parse_args()

    if args.print_vaults:
        print_vaults()
        return 0

    res = result(want=args.want)
    if not args.ref:
        res["issues"].append("缺少 --ref")
        out(res)
        return 0
    ref, norm_issues = normalize_ref(args.ref)
    res["ref"] = ref
    if norm_issues:
        res["issues"] = norm_issues
        out(res)
        return 0

    root, config, root_issues = resolve_vault_root(args.vault_root)
    if root is None:
        res["issues"] = root_issues
        out(res)
        return 0
    res["vault_root"] = str(root)

    scope_dir: Path | None = None
    if args.scope:
        scope_norm = (args.scope or "").strip().replace("\\", "/").strip("/")
        res["scope"] = scope_norm
        scope_dir, scope_real, scope_issues = resolve_scope(root, scope_norm, config)
        if scope_dir is None:
            res["issues"] = scope_issues
            out(res)
            return 0

    target: Path | None = None
    if "/" in ref:
        target, issues = resolve_exact_path(root, ref)
        if target is None:
            res["issues"] = issues
            out(res)
            return 0
        res["match"] = "exact_path"
        if scope_dir is not None:
            target_rel = rel_of(root, target)
            scope_rel_real = rel_of(root, scope_dir)
            if not target_rel.startswith(scope_rel_real + "/"):
                res["issues"].append(
                    f"scope 硬约束: 解析结果 {target_rel} 不在 scope {res['scope']} 之下"
                )
                out(res)
                return 0
        is_dir = target.is_dir()
        if not want_accepts(is_dir, args.want):
            res["issues"].append(f"命中{'目录' if is_dir else '文件'}不满足 want={args.want}: {rel_of(root, target)}")
            out(res)
            return 0
    else:
        search_root = scope_dir if scope_dir is not None else root
        target, match, issues, candidates = name_search(root, search_root, ref, args.want)
        res["match"] = match
        res["issues"] = issues
        res["candidates"] = candidates
        if target is None:
            out(res)
            return 0

    # 安全校验（含符号链接逃逸；scope 分支已在上面保证前缀）
    if not within_root(root, target):
        res["issues"].append(f"越界拒绝: {ref} 解析结果逃出 vault 根（符号链接或路径注入）")
        out(res)
        return 0

    if args.want == "article":
        res = apply_article(root, target, res)
        out(res)
        return 0

    res.update(ok=True, path_type="dir" if target.is_dir() else "file",
               resolved_path=str(target), resolved_rel=rel_of(root, target))
    out(res)
    return 0


def print_vaults() -> None:
    """一次性人工挑根辅助（运行时不做自动发现；仅列 obsidian.json 注册项）。"""
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        cfg_path = Path(appdata) / "obsidian" / "obsidian.json" if appdata else None
    elif sys.platform == "darwin":
        cfg_path = Path.home() / "Library" / "Application Support" / "obsidian" / "obsidian.json"
    else:
        cfg_path = Path.home() / ".config" / "obsidian" / "obsidian.json"
    if not cfg_path or not cfg_path.is_file():
        out({"ok": False, "vaults": [], "issues": [f"未找到 obsidian.json: {cfg_path}（可手动指定根）"]})
        return
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
        vaults = data.get("vaults") or {}
        rows = [
            {"name": name, "path": (v or {}).get("path", ""), "open": bool((v or {}).get("open"))}
            for name, v in vaults.items()
        ]
        rows.sort(key=lambda r: r["name"])
        out({"ok": True, "vaults": rows,
             "note": "仅一次性人工挑根辅助：嵌套 vault/多副本须人工选定唯一同步根写入 vault_root，运行时不自动发现"})
    except (OSError, ValueError) as e:
        out({"ok": False, "vaults": [], "issues": [f"obsidian.json 解析失败: {e}"]})


if __name__ == "__main__":
    sys.exit(main())
