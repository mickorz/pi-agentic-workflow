#!/usr/bin/env python3
"""手动插图规范化：Obsidian wiki 图片内嵌 → 公众号标准 markdown 引用。

背景：手动插图（用户自己在 Obsidian 里 ![[图.png]] 插好）的文章不走自动插图
流程（check_state 已把 wiki 内嵌计入 referenced，needs_insert=false），但
publish 链（content_hash.image_refs / publish_html.convert_md）只认标准
![](...) 引用，wiki 内嵌会被当纯文本发出去。本脚本做两件事（确定性，零 LLM）：

1.  ![[名.png]] / ![[名.png|300]] → ![](imgs/名.png)
    - 封面（cover 前缀）→ ![文章封面](imgs/名.png)（与 insert_images.py 标记一致）
    - imgs/ 下找不到同名文件 → [FAIL] 退出（不猜、不复制别处图片）
    - 引用文件名含空格/括号（如 "03-x (1).png"）→ [FAIL] 预检中断
      （发布链 IMG_REF 正则 [^)] 会在首个 ) 截断，必须先重命名）
    - Obsidian 兼容：标准 markdown 引用在 Obsidian 中同样可渲染
2.  article.yaml 缺 title/digest 时补最小元数据（否则复查 prepare_ready=false 卡死）：
    - title = 正文 md 文件名（去 .md，与标题确定性优先级一致）
    - digest = 正文首个非空段落（去记号）截 120 字句读边界
    - author = AI奇点；content_source / publish_completed 一并补齐
    - 已有字段原样保留（只追加缺失键）

幂等：正文无 wiki 内嵌且元数据齐全 → [SKIP]，文件不动。
stdout 契约：[WIKI] / [SKIP] / [META] / [FAIL] / === ALL DONE rewritten=N meta=... ===
用法：python3 normalize_manual_images.py --article-dir <目录>
"""

import argparse
import re
import sys
from pathlib import Path
from typing import List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

IMG_PREFIX_EXCLUDE = re.compile(r"^(article|draft|review)")
NAME_ILLEGAL = ("审稿", "图片引用清单", "大纲", "配图建议")
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
WIKI_EMBED = re.compile(r"!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]")
IMG_REF = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
BAD_NAME_CHARS = (" ", "(", ")", "（", "）")  # IMG_REF 的 [^)] 会在首个 ) 截断
YAML_KEYS = ("title", "digest", "author", "content_source")
DIGEST_MAX = 120


def find_md(article_dir: Path) -> Optional[Path]:
    """与 check_state 同规则的唯一正文候选（排除元文档/引用清单等）。"""
    cands = [p for p in sorted(article_dir.glob("*.md"))
             if not IMG_PREFIX_EXCLUDE.match(p.stem) and not any(k in p.name for k in NAME_ILLEGAL)]
    return cands[0] if len(cands) == 1 else None


def strip_md_marks(text: str) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)          # 图片
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)      # 链接留文字
    text = re.sub(r"!?\[\[[^\]]*\]\]", "", text)              # wiki 链接/内嵌
    text = re.sub(r"^[#>\s-]+", "", text)                     # 行首记号
    text = text.replace("**", "").replace("*", "").replace("`", "")
    return text.strip()


def first_digest(md_text: str) -> str:
    for block in re.split(r"\n\s*\n", md_text):
        t = strip_md_marks(block)
        if t:
            for cut in ("。", "！", "？", "；"):
                if cut in t[:DIGEST_MAX]:
                    return t[:t.index(cut, 0, DIGEST_MAX) + 1]
            return t[:DIGEST_MAX]
    return ""


def load_yaml(yaml_path: Path) -> dict:
    out = {k: "" for k in YAML_KEYS}
    if yaml_path.is_file():
        for line in yaml_path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            m = re.match(r'^(title|digest|author|content_source)\s*:\s*["\']?(.+?)["\']?\s*$', line)
            if m:
                out[m.group(1)] = m.group(2)
    return out


def yaml_line(key: str, value: str) -> str:
    return f'{key}: "{value.replace(chr(34), chr(39))}"'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--article-dir", required=True)
    args = ap.parse_args()
    article_dir = Path(args.article_dir).expanduser().resolve()
    if not article_dir.is_dir():
        print(f"[FAIL] article-dir 不存在: {article_dir}")
        return 1

    md_path = find_md(article_dir)
    if md_path is None:
        print(f"[FAIL] 正文 md 候选不唯一或缺席: {article_dir}")
        return 1
    md_text = md_path.read_text(encoding="utf-8-sig")
    imgs_dir = article_dir / "imgs"

    # 0) 文件名预检：空格/括号会被全链 IMG_REF 正则 [^)] 截断（2026-10-27 坑，越早中断越好）
    ref_names = [r.strip().replace("\\", "/").split("/")[-1]
                 for r in (m.group(1) for m in IMG_REF.finditer(md_text))]
    ref_names += [t.strip().replace("\\", "/").split("/")[-1]
                  for t in (m.group(1).strip() for m in WIKI_EMBED.finditer(md_text))
                  if t.lower().endswith(tuple(IMG_EXTS))]
    bad = sorted({n for n in ref_names if any(c in n for c in BAD_NAME_CHARS)})
    if bad:
        for n in bad:
            print(f"[FAIL] 图片文件名含空格/括号，发布链正则会在首个 ')' 截断: {n}（请重命名文件并同步正文引用）")
        print("=== ALL DONE rewritten=0 meta=aborted ===")
        return 1

    # 1) wiki 图片内嵌 → 标准引用
    rewritten, failed = 0, 0

    def repl(m: "re.Match") -> str:
        nonlocal rewritten, failed
        target = m.group(1).strip()
        base = target.replace("\\", "/").split("/")[-1]
        if base.lower().endswith(tuple(IMG_EXTS)) and (imgs_dir / base).is_file():
            alt = "文章封面" if base.lower().startswith("cover") else ""
            rewritten += 1
            print(f"[WIKI] ![[{target}]] -> imgs/{base}")
            return f"![{alt}](imgs/{base})"
        if base.lower().endswith(tuple(IMG_EXTS)):
            failed += 1
            print(f"[FAIL] imgs/ 下找不到 {base}（wiki 内嵌解析失败，请确认图片位置）")
        return m.group(0)  # 非图片 wiki 链接原样保留

    new_text = WIKI_EMBED.sub(repl, md_text)
    if failed:
        print(f"=== ALL DONE rewritten={rewritten} meta=aborted ===")
        return 1
    if rewritten:
        md_path.write_text(new_text, encoding="utf-8")
    else:
        print("[SKIP] 未发现 Obsidian 图片内嵌（正文已是标准引用）")

    # 2) 补最小 article.yaml（已有字段不动，只追加缺失键）
    yaml_path = article_dir / "article.yaml"
    fields = load_yaml(yaml_path)
    if not fields["title"] or not fields["digest"]:
        title = fields["title"] or md_path.stem
        digest = fields["digest"] or first_digest(md_text) or title
        patch = {"title": title, "digest": digest,
                 "author": fields["author"] or "AI奇点",
                 "content_source": fields["content_source"] or md_path.name}
        lines = []
        if yaml_path.is_file():
            kept = [ln for ln in yaml_path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
                    if not any(ln.startswith(k + ":") for k in patch)]
            lines = kept
        lines += [yaml_line(k, patch[k]) for k in YAML_KEYS if patch[k]]
        lines.append("publish_completed: false")
        yaml_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[META] 补齐 article.yaml: title={patch['title']} digest={len(patch['digest'])} 字")
        meta = "patched"
    else:
        print("[META] article.yaml 元数据齐全，保持不动")
        meta = "kept"

    print(f"=== ALL DONE rewritten={rewritten} meta={meta} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
