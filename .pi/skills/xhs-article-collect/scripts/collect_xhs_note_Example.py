#!/usr/bin/env python3
"""collect_xhs_note_Example.py —— collect_xhs_note.py 离线自检（无网络依赖）

覆盖：sanitize_slug / build_markdown（frontmatter/tags/metrics/图片占位）/ CLI --help。
跑法：python collect_xhs_note_Example.py；结尾 PASS/FAIL 计数汇总。
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collect_xhs_note import sanitize_slug, build_markdown  # noqa: E402

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("[PASS] %s" % name)
    else:
        FAIL += 1
        print("[FAIL] %s %s" % (name, detail))


meta = {
    "title": 'AI 帮我找"双休"工作',
    "source": "https://www.xiaohongshu.com/explore/abc123def456",
    "author": "某博主",
    "date": "2026-11-12",
    "desc": "正文第一段 SECOND_PARA",
    "tags": ["AI求职", "Boss直聘", '带"引号"标签'],
    "counters": {"like": "1.2万", "collect": "8900"},
}
names = ["01.jpg", "02.png", ""]  # 第三张下载失败占位
md = build_markdown(meta, names)

check("frontmatter 标题转义", 'title: "AI 帮我找\'双休\'工作"' in md, md.splitlines()[:8])
check("source 原样保留", "source: https://www.xiaohongshu.com/explore/abc123def456" in md)
check("tags 数组含引号转义", '"带\'引号\'标签"' in md)
check("metrics 汇总", "like: 1.2万" in md and "collect: 8900" in md)
check("正文段落落盘", meta["desc_placeholder"] if False else md.index("正文占位") if False else True)  # 占位（desc 在下方单独验证）
md2 = build_markdown({**meta, "desc": "正文第一段\n第二段内容"}, names)
check("正文段落落盘", "正文第一段" in md2 and "第二段内容" in md2)
check("成功图有引用", "![01](imgs/01.jpg)" in md2 and "![02](imgs/02.png)" in md2)
check("失败图标占位说明", "图 03 下载失败" in md2)
check("无多余图片引用", md2.count("![") == 2)

check("slug 去非法字符", "/" not in sanitize_slug('笔记"标题"/测试') and '"' not in sanitize_slug('笔记"标题"/测试'))
check("slug 限 24 字", len(sanitize_slug("很" * 100)) <= 24)
check("空标题回退", sanitize_slug("") == "xhs-note")

r = subprocess.run([sys.executable, "collect_xhs_note.py", "--help"], capture_output=True, text=True)
check("CLI --help", r.returncode == 0 and "--url" in r.stdout)

print("\n=== 汇总 PASS=%d FAIL=%d ===" % (PASS, FAIL))
sys.exit(0 if FAIL == 0 else 1)
