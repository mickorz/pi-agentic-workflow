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
  imgs        {dir_exists, files, referenced, wiki_embeds}   files 不含 cover*；referenced 为正文引用数(含 wiki 内嵌)；wiki_embeds 为 Obsidian 图片内嵌数
  imgs_numbering {applicable, missing[], out_of_range[], sections}  序号方案预检（全部唯一序号才适用）
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
import hashlib
import json
import re
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

IMG_PREFIX_EXCLUDE = re.compile(r"^(article|draft|review)")
NAME_ILLEGAL = ("审稿", "图片引用清单", "大纲", "配图建议")
IMG_REF = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
# Obsidian wiki 图片内嵌 ![[名.png]] / ![[名.png|300]]（容忍尺寸后缀）；与 IMG_REF 同源计数
WIKI_EMBED = re.compile(r"!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]")
# 与 insert_images.py 的 NUM_RE 保持一致（序号方案契约同源）
NUM_RE = re.compile(r"^(?:图\s*)?(\d{1,3})(?=[-_.\s]|$)")
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


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


def text_review_state(article_dir: Path) -> dict:
    """生图文字验收门（IMG-L T4）：image-manifest.json 中声明 expected_text 且 succeeded 的条目。

    分级（T0 取证实锤下游重命名致 manifest 路径断裂是现网常态，门必须容忍）：
      rejected / pending（含无审核记录）           → 阻断（issue 前缀 文字审核，计入 prepare_ready 阻断）
      approved 且 path 存在但 sha 不符             → 阻断（图被换过，审核绑定失效）
      approved 但 path 缺失（重命名断裂）          → 提示不阻断（证据链断裂属 T3 范畴）
    manifest 不存在 / 无 expected_text 条目 → 零影响（现网旧文章完全不受此门约束）。"""
    out: dict = {"present": False, "checked": 0, "blocking": [], "notes": []}
    manifest_path = article_dir / "image-manifest.json"
    if not manifest_path.is_file():
        return out
    try:
        doc = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        out["notes"].append("image-manifest.json 损坏，文字审核门跳过（需人工处理）")
        return out
    entries = doc.get("entries") or {}
    for e in entries.values():
        review = e.get("content_review")
        if not e.get("path") or e.get("status") != "succeeded" or not review:
            continue
        out["present"] = True
        out["checked"] += 1
        rid = e.get("id", "?")
        status = review.get("status", "pending")
        if status == "approved":
            f = article_dir / str(e["path"])
            if f.is_file():
                h = hashlib.sha256(f.read_bytes()).hexdigest()
                if h != review.get("image_sha256"):
                    out["blocking"].append(f"文字审核绑定失效: {rid}（图已变化，需重新 --approve-text）")
            else:
                out["notes"].append(f"文字审核路径断裂: {rid}（{e['path']} 不存在，疑似下游重命名；T3 范畴不阻断）")
        elif status == "rejected":
            out["blocking"].append(f"文字审核已拒绝: {rid}（重制请走 regenerate + 人工确认）")
        else:
            out["blocking"].append(f"文字审核待人工确认: {rid}（--approve-text / --reject-text）")
    return out


def png_size_of(path: Path) -> tuple[int, int] | None:
    """只读 PNG IHDR 尺寸（非 PNG/损坏返回 None）——与 cover_resize.read_png_size 同源逻辑。"""
    try:
        head = path.read_bytes()[:33]
    except OSError:
        return None
    if len(head) < 33 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    import struct
    return struct.unpack(">II", head[16:24])


def number_of(image: str) -> int | None:
    """从图片文件名提取序号：01-x.png / 1_x.png / 图1-x.png -> 1；无序号 -> None。"""
    m = NUM_RE.match(Path(image).stem)
    return int(m.group(1)) if m else None


def numbering_precheck(img_files: list[str], md_text: str) -> dict:
    """配图序号预检（IMG-L 语义修订 2026-10-28：序号 = 章节号）。

    序号约定：正文图名前缀 NN = 对应第 N 个 ## 章节（与 insert_images 序号确定性映射、
    生图执行器命名约定同源）。跳号 = 对应章节无图，属合法状态（如引言章无图），
    因此 missing 不再作为阻断/中断依据，仅在 imgs_numbering 字段中如实输出供人工参考。
    - missing: 1..max 中的缺号（即无图的章节号清单）
    - out_of_range: 序号 > 章节数（## 计数，映射无处安放，仍为阻断）
    混入无序号图/序号重复 -> applicable=False（走语义匹配，不做此检查）。
    """
    sections = sum(1 for line in md_text.splitlines() if line.strip().startswith("##"))
    out = {"applicable": False, "missing": [], "out_of_range": [], "sections": sections}
    if not img_files or any(Path(n).suffix.lower() not in IMG_EXTS for n in img_files):
        return out
    nums = [number_of(n) for n in img_files]
    if any(n is None for n in nums) or len(set(nums)) != len(nums):
        return out
    out["applicable"] = True
    out["missing"] = sorted(set(range(1, max(nums) + 1)) - set(nums))  # type: ignore[arg-type]
    out["out_of_range"] = sorted(n for n in nums if n > sections)  # type: ignore[comparison-overlap]
    return out


def inspect_dir(article_dir: Path, account_slot: int, config_dir: str | None) -> dict:
    """对确定的文章目录做完整只读检查。"""
    out: dict = {"mode": "article-dir", "article_dir": str(article_dir), "ok": False,
                 "candidates": [], "issues": [], "prepare_ready": False}
    if not article_dir.is_dir():
        out["issues"].append(f"article_dir not found: {article_dir}")
        return out

    # 正文（5.1 规则：唯一合法才自动；article.yaml 有 content_source 时确定性指定优先）
    yaml_info = load_yaml_fields(article_dir / "article.yaml")
    yaml_cs = yaml_info.get("content_source", "")
    cands = [
        p for p in sorted(article_dir.glob("*.md"))
        if not IMG_PREFIX_EXCLUDE.match(p.name) and not any(b in p.name for b in NAME_ILLEGAL)
    ]
    if yaml_cs:
        # 显式指定：按 content_source 精确匹配；命中即唯一，不命中报错不猜
        md_path = next((p for p in cands if p.name == yaml_cs), None)
        if md_path is None:
            out["issues"].append(f"content_source={yaml_cs} 在目录中无对应 md 文件")
            out["md"] = {"path": "", "name": "", "ambiguous": False}
            md_text = ""
        else:
            out["md"] = {"path": str(md_path), "name": md_path.name, "ambiguous": False}
            md_text = md_path.read_text(encoding="utf-8-sig")
    elif len(cands) != 1:
        out["issues"].append(
            f"md candidates={len(cands)}: " + ", ".join(p.name for p in cands) +
            "（需 content_source 或显式指定，缺一不可判）")
        out["md"] = {"path": "", "name": "", "ambiguous": len(cands) > 1}
        md_path = None
        md_text = ""
    else:
        md_path = cands[0]
        out["md"] = {"path": str(md_path), "name": md_path.name, "ambiguous": False}
        md_text = md_path.read_text(encoding="utf-8-sig")

    fm_title = fm_digest = ""
    m = re.match(r"^---\r?\n(.*?)\r?\n---", md_text, flags=re.S)
    if m:
        t = re.search(r'^title\s*:\s*"?(.+?)"?\s*$', m.group(1), flags=re.M)
        d = re.search(r'^description\s*:\s*"?(.+?)"?\s*$', m.group(1), flags=re.M)
        fm_title, fm_digest = (t.group(1) if t else ""), (d.group(1) if d else "")
    out["frontmatter"] = {"title": fm_title, "description": fm_digest}

    # yaml 元数据
    missing = [k for k in ("title", "digest") if not yaml_info.get(k)]
    yaml_info["missing"] = missing
    out["yaml"] = yaml_info

    # 图片：imgs 文件数（不含 cover 前缀）vs 正文引用数
    imgs_dir = article_dir / "imgs"
    img_files = [p.name for p in sorted(imgs_dir.iterdir()) if p.is_file() and not p.name.lower().startswith("cover")] if imgs_dir.is_dir() else []
    refs = [r for r in (m.group(1).strip() for m in IMG_REF.finditer(md_text)) if not r.startswith("http")]
    referenced_imgs = [r for r in refs if r.startswith("imgs/")]
    # 手动插图（Obsidian wiki 内嵌）：按文件名解析到 imgs/，计入引用数；解析不到的后续报引用图缺失
    wiki_targets = [t for t in (m.group(1).strip() for m in WIKI_EMBED.finditer(md_text))
                    if t.lower().endswith(tuple(IMG_EXTS))]
    wiki_refs, wiki_missing = [], []
    for t in wiki_targets:
        base = t.replace("\\", "/").split("/")[-1]
        if (imgs_dir / base).is_file():
            wiki_refs.append("imgs/" + base)
        else:
            wiki_missing.append(t)
    referenced_imgs = referenced_imgs + wiki_refs
    out["imgs"] = {"dir_exists": imgs_dir.is_dir(), "files": len(img_files), "referenced": len(referenced_imgs),
                   "wiki_embeds": len(wiki_targets)}
    out["needs_insert"] = bool(img_files) and len(referenced_imgs) < len(img_files)

    # 配图序号预检（IMG-L：序号=章节号，跳号=无图章节合法，不再阻断；越界仍阻断）
    numbering = numbering_precheck(img_files, md_text)
    out["imgs_numbering"] = numbering
    if numbering["applicable"] and numbering["missing"]:
        out["issues"].append("无图章节提示: " + "、".join(f"{n:02d}" for n in numbering["missing"]) + "（章节无配图，不阻断）")
    if numbering["applicable"] and numbering["out_of_range"]:
        out["issues"].append("配图序号越界: " + "、".join(str(n) for n in numbering["out_of_range"])
                              + f" 超出章节数 {numbering['sections']}")

    # 封面
    cov = cover_state(article_dir)
    # 封面优先级提示（2026-10-27 坑：根 cover.* 会顶掉 imgs/ 手动封面）
    if cov["state"] == "root":
        imgs_dir = article_dir / "imgs"
        imgs_cov = [p.name for p in sorted(imgs_dir.iterdir())
                    if imgs_dir.is_dir() and p.is_file() and p.name.lower().startswith("cover")] if imgs_dir.is_dir() else []
        if imgs_cov:
            out["issues"].append(
                f"封面优先级提示: 根目录 cover.* 优先，imgs/ 下另有 {len(imgs_cov)} 张 cover 前缀图将被忽略"
                f"（用手动封面请移走根目录文件）")
    # 封面尺寸探针（53401 预警；PNG 才能只读探测）
    if cov["state"] != "none":
        sz = png_size_of(article_dir / cov["path"])
        if sz:
            w, h = sz
            cov["size"] = [w, h]
            cov["exact_235"] = (w * 20 == h * 47)
            if not cov["exact_235"]:
                ratio = w / h
                if abs(ratio - 2.35) <= 0.01:
                    out["issues"].append(
                        f"封面比例提示: {w}x{h}={ratio:.4f} 接近但非精确 2.35:1（publish 将自动缩放）")
                else:
                    out["issues"].append(
                        f"封面比例提示: {w}x{h}={ratio:.4f} 偏离 2.35:1（历史 16:9 曾通过；遇 53401 需换精确 2.35:1 封面）")
        else:
            cov["size"] = None
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

    # 图片引用完整性（正文引用的图必须真实存在；wiki 内嵌解析不到同名文件同样算缺失）
    for r in refs:
        if not r.startswith("http") and not (article_dir / r.replace("\\", "/")).is_file():
            out["issues"].append(f"引用图缺失: {r}")
    for t in wiki_missing:
        out["issues"].append(f"引用图缺失: ![[{t}]]")

    # 文字验收门（T4）：阻断级 issue 计入 prepare_ready；notes 仅提示
    tr = text_review_state(article_dir)
    out["text_review"] = tr
    out["issues"].extend(tr["blocking"])
    out["issues"].extend(tr["notes"])

    # prepare 就绪判定
    out["prepare_ready"] = bool(
        cov["state"] != "none" and not missing and md_path is not None
        and not any(i.startswith(("引用图缺失", "publish-state", "文字审核待", "文字审核已", "文字审核绑定")) for i in out["issues"])
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
