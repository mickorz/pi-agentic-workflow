#!/usr/bin/env python3
"""collect_mp_article_Example.py —— collect_mp_article.py 离线自检（无网络依赖）

覆盖：parse_content_html 块抽取 / sanitize_slug / build_markdown / CLI --help。
跑法：python collect_mp_article_Example.py；结尾 PASS/FAIL 计数汇总。
"""
import io
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collect_mp_article import parse_content_html, sanitize_slug, build_markdown  # noqa: E402

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("[PASS] %s" % name)
    else:
        FAIL += 1
        print("[FAIL] %s %s" % (name, detail))


SAMPLE_HTML = """
<section>
  <p>  传统求职：打开网页 → 翻几十页 → 手动打招呼。 </p>
  <p><strong>boss-agent-cli</strong> 让 Agent 代劳。</p>
  <img data-src="https://mmbiz.qpic.cn/abc123?wx_fmt=png" src="data:image/svg+xml,spacer">
  <h2>核心能力</h2>
  <ul><li>职位发现</li><li style="display:none">隐藏项</li></ul>
  <script>var x = "<p>script 里的假段落</p>";</script>
  <img src="https://mmbiz.qpic.cn/second.jpg">
</section>
"""

# 1. 块抽取：文本段与图片按文档顺序，script/style 内容与隐藏元素被跳过（display:none 不在 DOM 文本里的前提）
blocks = parse_content_html(SAMPLE_HTML)
texts = [v for k, v in blocks if k == "text"]
imgs = [v for k, v in blocks if k == "img"]
check("文本段含正文", any("传统求职" in t for t in texts), texts)
check("strong 内文本合并", any("boss-agent-cli" in t for t in texts))
check("script 假段落被跳过", not any("script 里的假段落" in t for t in texts))
check("图片按序抽到 2 张", len(imgs) == 2, imgs)
check("懒加载 data-src 优先", imgs and imgs[0].startswith("https://mmbiz.qpic.cn/abc123"), imgs)

# 2. slug 清洗
_s = sanitize_slug('一行 JSON：让 AI 生成"动"的架构图/试验')
check("slug 去非法字符", "/" not in _s and '"' not in _s and "：".join([]) == "" and _s.startswith("一行-JSON"), _s)
check("slug 限 24 字", len(sanitize_slug("很" * 100)) <= 24)
check("空标题回退", sanitize_slug("") == "mp-article")

# 3. markdown 组装：frontmatter 四件 + 图片占位与顺序一致
meta = {"title": '测试"标题"', "source": "https://mp.weixin.qq.com/s/x", "author": "某账号", "publish_time": "2026-11-13"}
md = build_markdown(meta, blocks, ["01.png", "02.jpg"])
check("frontmatter 引号转义", 'title: "测试\'标题\'"' in md, md.splitlines()[:6])
check("图片引用顺序", "![01](imgs/01.png)" in md and "![02](imgs/02.jpg)" in md)
check("正文段落在图片前", md.index("传统求职") < md.index("![01]"))

# 4. CLI --help 可跑（argparse 装配完整）
r = subprocess.run([sys.executable, "collect_mp_article.py", "--help"], capture_output=True, text=True)
check("CLI --help", r.returncode == 0 and "--url" in r.stdout)

# 5. 空正文防御
check("空 html 返回空 blocks", parse_content_html("") == [])

print("\n=== 汇总 PASS=%d FAIL=%d ===" % (PASS, FAIL))
sys.exit(0 if FAIL == 0 else 1)
