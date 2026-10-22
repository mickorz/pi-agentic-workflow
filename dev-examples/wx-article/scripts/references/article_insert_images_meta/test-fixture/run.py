#!/usr/bin/env python3
"""insert_images.py 自检：双分支插入（一句话记住前 / 章节末尾）+ 未匹配章节 FAIL 路径。

用法：python3 dev-examples/wx-article/scripts/references/article_insert_images_meta/test-fixture/run.py
"""
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY_SCRIPT = (HERE / ".." / "scripts" / "insert_images.py").resolve()
MD = HERE / "sample-article.md"
MAP = HERE / "mapping.json"

PASS = 0
FAIL = 0


def ok(name: str) -> None:
    global PASS
    PASS += 1
    print(f"PASS: {name}")


def bad(name: str) -> None:
    global FAIL
    FAIL += 1
    print(f"FAIL: {name}")


# 每次重建 fixture（干净态，可重复执行）
(HERE / "imgs").mkdir(exist_ok=True)
(HERE / "imgs" / "vec-db.png").write_text("dummy")
(HERE / "imgs" / "rag.png").write_text("dummy")
MD.write_text(
    "# 从零学AI：测试文章\n\n"
    "## 01. 向量数据库：AI 的记忆检索柜\n\n"
    "正文一段。\n\n"
    "**一句话记住**：向量库是 AI 的外接记忆。\n\n"
    "## 02. RAG：让 AI 学会开卷考试\n\n"
    "正文一段，本节没有\"一句话记住\"行。\n",
    encoding="utf-8",
)
MAP.write_text(
    "[\n"
    '  {"image": "imgs/vec-db.png", "heading": "## 01. 向量数据库：AI 的记忆检索柜", "alt": "术语插画：向量库"},\n'
    '  {"image": "imgs/rag.png", "heading": "## 02. RAG：让 AI 学会开卷考试", "alt": "术语插画：RAG"},\n'
    '  {"image": "imgs/none.png", "heading": "## 09. 不存在的章节", "alt": "不该插入"}\n'
    "]\n",
    encoding="utf-8",
)

proc = subprocess.run(
    [sys.executable, str(PY_SCRIPT), "--article-dir", str(HERE), "--mapping-path", str(MAP)],
    capture_output=True, text=True,
)
out = proc.stdout + proc.stderr
rc = proc.returncode
print(out)

if "=== inserted 2 / 3" in out:
    ok("插入统计 2/3")
else:
    bad("插入统计期望 2/3")
if rc == 2:
    ok("未匹配章节退出码 2")
else:
    bad(f"退出码期望 2，实际 {rc}")

md_text = MD.read_text(encoding="utf-8-sig")
md_lines = md_text.splitlines()


def line_of(pattern: str) -> int:
    for i, line in enumerate(md_lines, 1):
        if pattern in line:
            return i
    return -1


if "![术语插画：向量库](imgs/vec-db.png)" in md_text:
    ok("章节1 图已插入")
else:
    bad("章节1 未插入")

line_img = line_of("imgs/vec-db.png")
line_mem = line_of("一句话记住")
if line_img > 0 and line_mem > 0 and line_img < line_mem:
    ok(f"图在 一句话记住 之前（img 行 {line_img} < 记住行 {line_mem}）")
else:
    bad(f"插入位置错误 img={line_img} mem={line_mem}")

if "![术语插画：RAG](imgs/rag.png)" in md_text:
    ok("章节2（无记住行）图已插入")
else:
    bad("章节2 未插入")

line_rag = line_of("imgs/rag.png")
line_h2 = line_of("## 02")
if line_rag > 0 and line_h2 > 0 and line_rag > line_h2:
    ok("章节2 图在章节末尾区域内")
else:
    bad(f"章节2 插入位置错误 rag={line_rag} h2={line_h2}")

if "imgs/none.png" in md_text:
    bad("不该插入的图出现了")
else:
    ok("未匹配图未写入")

if "[FAIL] heading not found" in out:
    ok("未匹配项列入 FAIL 行")
else:
    bad("未见 FAIL 行")

# 还原 fixture 为下次运行的干净输入（本次插入结果留在 sample-article.md 供人工查看，下次运行前重建）
print("----")
print(f"PASS={PASS} FAIL={FAIL}")
sys.exit(0 if FAIL == 0 else 1)
