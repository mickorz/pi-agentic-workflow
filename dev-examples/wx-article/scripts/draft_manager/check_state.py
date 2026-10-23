#!/usr/bin/env python3
"""文章状态确定性检查（只读：零写操作、零网络）——article pipeline 的检查地基。

需求文档 V1.2 第 4.1/4.2/5.1 节。由 article_inspect/article_prepare workflow 调用，
也可独立 CLI 使用。只读性由本脚本实现保证（无任何写文件/网络代码路径）。

用法：
  python3 check_state.py --article-dir <dir> [--account-slot N] [--config-dir <dir>]
  python3 check_state.py --locate <名称> --workspace <dir> [--account-slot N] [--config-dir <dir>]

输出：stdout 单个 JSON（UTF-8）。字段：
  ok          定位成功且目录合法（多候选/零命中时 ok=false，candidates 给出列表）
  article_dir / md{path,name} / frontmatter{title,description}
  yaml        {exists,title,digest,author,content_source,missing[]}
  imgs        {dir_exists, files, referenced}   files 不含 cover*；referenced 为正文引用数
  needs_insert   imgs 有图但正文引用数 < 图数（含 cover 前缀图排除）=> 需要插图
  cover       {state: root|imgs|none, path(相对 article_dir)}
  state       {exists, accounts:{appid:{status,draftMediaId,contentHash12}}}
  issues[]    阻断或提示（含多候选列表）
  prepare_ready  cover 就绪且 yaml title/digest 齐 且 md 唯一确定
定位规则（V1.2 4.2/5.1）：
  --article-dir 显式指定优先；--locate 在 workspace 一级子目录按名称包含匹配，
  唯一命中 => 完整检查；多候选/零命中 => ok=false 并列出候选，绝不猜。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

IMG_PREFIX_EXCLUDE = re.compile(r"^(article|draft|review)")
NAME_ILLEGAL = ("审稿", "图片引用清单", "大纲")
IMG_REF = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def find_config_root(start: Path) -> Path | None:
    d = start.resolve()
    while True:
        if (d / ".aws-article").exists():
            return d
        parent = d.parent
        if parent == d:
            return None
        d = parent


def load_yaml_fields(yaml_path: Path) -> dict:
    """受限字段读取（只认顶层 key: value 行，非通用 YAML 解析器）。"""
    out = {"exists": yaml_path.is_file(), "title": "", "digest": "", "author": "", "content_source": ""}
    if out["exists"]:
        for line in yaml_path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            m = re.match(r'^(title|digest|author|content_source)\s*:\s*["\']?(.+?)["\']?\s*$', line)
            if m:
                out[m.group(1)] = m.group(2)
    return out


def cover_state(article_dir: Path) -> dict:
    for name in ("cover.png", "cover.jpg", "cover.jpeg", "cover.webp"):
        if (article_dir / name).is_file():
            return {"state": "root", "path": name}
    imgs = article_dir / "imgs"
    if imgs.is_dir():
        for p in sorted(imgs.iterdir()):
            if p.is_file() and p.name.lower().startswith("cover"):
                return {"state": "imgs", "path": f"imgs/{p.name}"}
    return {"state": "none", "path": ""}


def inspect_dir(article_dir: Path, account_slot: int, config_dir: str | None) -> dict:
    """对确定的文章目录做完整只读检查。"""
    out: dict = {"mode": "article-dir", "article_dir": str(article_dir), "ok": False,
                 "candidates": [], "issues": [], "prepare_ready": False}
    if not article_dir.is_dir():
        out["issues"].append(f"article_dir not found: {article_dir}")
        return out

    # 正文（5.1 规则：唯一合法才自动）
    cands = [
        p for p in sorted(article_dir.glob("*.md"))
        if not IMG_PREFIX_EXCLUDE.match(p.name) and not any(b in p.name for b in NAME_ILLEGAL)
    ]
    if len(cands) != 1:
        out["issues"].append(
            f"md candidates={len(cands)}: " + ", ".join(p.name for p in cands) +
            "（需 content_source 或显式指定，缺一不可判）")
    # 歧义时不猜：只有唯一候选才确定正文，prepare_ready 才可能为 true
    md_path = cands[0] if len(cands) == 1 else None
    out["md"] = {"path": str(md_path) if md_path else "", "name": md_path.name if md_path else "",
                 "ambiguous": len(cands) > 1}
    md_text = md_path.read_text(encoding="utf-8-sig") if md_path else ""

    fm_title = fm_digest = ""
    m = re.match(r"^---\r?\n(.*?)\r?\n---", md_text, flags=re.S)
    if m:
        t = re.search(r'^title\s*:\s*"?(.+?)"?\s*$', m.group(1), flags=re.M)
        d = re.search(r'^description\s*:\s*"?(.+?)"?\s*$', m.group(1), flags=re.M)
        fm_title, fm_digest = (t.group(1) if t else ""), (d.group(1) if d else "")
    out["frontmatter"] = {"title": fm_title, "description": fm_digest}

    # yaml 元数据
    yaml_info = load_yaml_fields(article_dir / "article.yaml")
    missing = [k for k in ("title", "digest") if not yaml_info.get(k)]
    yaml_info["missing"] = missing
    out["yaml"] = yaml_info

    # 图片：imgs 文件数（不含 cover 前缀）vs 正文引用数
    imgs_dir = article_dir / "imgs"
    img_files = [p.name for p in sorted(imgs_dir.iterdir()) if p.is_file() and not p.name.lower().startswith("cover")] if imgs_dir.is_dir() else []
    refs = [r for r in (m.group(1).strip() for m in IMG_REF.finditer(md_text)) if not r.startswith("http")]
    referenced_imgs = [r for r in refs if r.startswith("imgs/")]
    out["imgs"] = {"dir_exists": imgs_dir.is_dir(), "files": len(img_files), "referenced": len(referenced_imgs)}
    out["needs_insert"] = bool(img_files) and len(referenced_imgs) < len(img_files)

    # 封面
    cov = cover_state(article_dir)
    out["cover"] = cov

    # 发布状态（account 隔离摘要）
    state_path = article_dir / "publish-state.json"
    accounts_summary: dict = {}
    if state_path.is_file():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            for appid, acc in (data.get("accounts") or {}).items():
                accounts_summary[appid] = {
                    "status": acc.get("status"),
                    "draftMediaId": acc.get("draftMediaId"),
                    "contentHash12": (acc.get("contentHash") or "")[:12],
                    "hasPending": bool(acc.get("pendingOperation")),
                }
        except (OSError, ValueError):
            out["issues"].append("publish-state.json corrupted (需人工处理)")
    out["state"] = {"exists": state_path.is_file(), "accounts": accounts_summary}

    # 图片引用完整性（正文引用的图必须真实存在）
    for r in refs:
        if not r.startswith("http") and not (article_dir / r.replace("\\", "/")).is_file():
            out["issues"].append(f"引用图缺失: {r}")

    # prepare 就绪判定
    out["prepare_ready"] = bool(
        cov["state"] != "none" and not missing and md_path is not None
        and not any(i.startswith(("引用图缺失", "publish-state")) for i in out["issues"])
    )
    if cov["state"] == "none":
        out["issues"].append("封面缺失：目录根无 cover.*，imgs/ 下也无 cover 前缀图")
    if missing:
        out["issues"].append(f"yaml 缺字段: {missing}（插图流程会补齐）")
    out["ok"] = md_path is not None
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--article-dir", default=None)
    ap.add_argument("--locate", default=None)
    ap.add_argument("--workspace", default=None)
    ap.add_argument("--account-slot", type=int, default=1)
    ap.add_argument("--config-dir", default=None)
    args = ap.parse_args()

    if args.article_dir:
        print(json.dumps(inspect_dir(Path(args.article_dir), args.account_slot, args.config_dir), ensure_ascii=False))
        return 0

    if args.locate:
        out: dict = {"mode": "locate", "query": args.locate, "ok": False, "candidates": [], "issues": [], "article_dir": ""}
        ws = Path(args.workspace) if args.workspace else None
        if ws is None:
            root = find_config_root(Path(__file__).parent)
            if root:
                cfg = root / ".aws-article" / "config.json"
                if cfg.is_file():
                    try:
                        ws = Path(json.loads(cfg.read_text(encoding="utf-8-sig")).get("article_workspace") or "")
                        ws = ws if str(ws) else None
                    except (OSError, ValueError):
                        ws = None
        if ws is None or not ws.is_dir():
            out["issues"].append("workspace 未指定且 config.json 无 article_workspace，无法按名称定位")
            print(json.dumps(out, ensure_ascii=False))
            return 0
        hits = sorted(p for p in ws.iterdir() if p.is_dir() and args.locate in p.name)
        if len(hits) == 1:
            res = inspect_dir(hits[0], args.account_slot, args.config_dir)
            res["mode"] = "locate"
            res["query"] = args.locate
            res["workspace"] = str(ws)
            print(json.dumps(res, ensure_ascii=False))
            return 0
        out["candidates"] = [str(h) for h in hits]
        out["issues"].append(f"locate 命中 {len(hits)} 个目录，需用户选择，绝不猜")
        print(json.dumps(out, ensure_ascii=False))
        return 0

    print(json.dumps({"ok": False, "issues": ["需 --article-dir 或 --locate+--workspace"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
