---
name: url2md
description: 下载网页文章转 Markdown 并抓取全部图片到本地（支持 Next.js CDN 代理图解码、正文裁剪、图片本地化引用、质量自检）。当用户要求"下载这个网页/文章"、"保存网页为 md"、"抓取文章和图片"、"网页转 markdown"、"收集这篇文章做素材"时使用。
---

# url2md — 网页文章转 Markdown + 图片本地化

把一篇网页文章（含全部配图）下载保存为：正文 Markdown（frontmatter 含来源/采集日期）+ 本地 `imgs/` 图片目录。标准库 Python 实现，零依赖。

## 用法

```bash
python3 <skill目录>/scripts/fetch_url2md.py --url <文章URL> --out-dir <目标目录> \
    [--title 覆盖标题] [--zh-title 中文标题] [--img-subdir imgs] [--max-images 30]
```

- `--out-dir`：目标目录（如 Obsidian 单篇目录 `E:/Obsidian/newsky/60_Workspace/写作/单篇/<日期>`）
- `--title`：覆盖标题（缺省从页面 `<title>` 提取并清理站点后缀）
- `--zh-title`：中文标题。**原文非中文时必传**（调用前 LLM 先根据原文拟定中文标题）——翻译副本将以此命名
- 退出码：0 全部成功；1 存在 MISSING 图片引用（部分下载时正文仍已写出）

## 产出结构

```text
<out-dir>/
├── <标题-slug>.md         # 原文（非中文页保留原文，永不改动）
├── <中文标题>.md          # 非中文页的翻译副本（LLM 翻译填充）
└── imgs/
    └── img-NN.png/jpg     # 按正文出现顺序编号（两份 md 共用）
```

## 处理逻辑（已实测沉淀）

1. 下载 HTML（UA 头）；正文容器优先 `<article>`，剔除 script/style/nav/footer/header。
2. 图片：`<img src>` → **Next.js 代理 URL 解码**（`/_next/image?url=<encodeURIComponent 原图>` → 原图地址）→ 去重 → 下载（magic bytes 校验 PNG/JPEG；**<5KB 视为装饰图自动跳过**）→ `imgs/img-NN.<ext>`。
3. Markdown 转换：h1→h2（文章标题已是 H1）、h2/h3、li→列表项、img→本地引用（保留 alt）、段落分隔。
4. 正文裁剪：起点=首个标题行或含文章主标题的行；结尾=页脚关键词（related content / subscribe / cookie / sign in / join the discussion / was this page helpful）。
5. 自检（stdout 逐项 [OK]/[FAIL]）：图片引用全部本地存在（MISSING → 退出码 1）、无残留块级 HTML 标签、正文 >1000 字符。
6. **语言检测与翻译副本**（原文非中文时）：脚本检测中文字符占比，非中文则——
   - 原文 md **原样保留**（英文 slug 文件名）；
   - 自动复制一份**中文命名副本**（`<zh-title>.md`，内容暂为原文，标记待翻译）；
   - stdout 输出 `[LANG]` 三行提示。
   **调用方（LLM）随后必须**：将副本全文逐段忠实翻译为中文——保留 frontmatter 的 source/collected、
   title 改为中文标题、正文逐段翻译、**图片引用（imgs/ 相对路径）保持不变**（同目录有效）。
   原文文件永远不改动。

## 适用与不适用

- 适用：静态/SSR 渲染的文章页（博客、研究长文、新闻）；**已实测**：anthropic.com 研究页（Next.js + CDN 代理图，16 张图全量抓取成功）。
- 不适用：纯 SPA 无 SSR 内容（页面 HTML 里没有正文）、需要登录的页面、动态懒加载图片（首屏外图片不在初始 HTML 中）——这类先人工确认页面源码含正文再使用。

## 注意

- 下载行为只读公开网页，无登录态；批量抓取请尊重站点版权与频率。
- frontmatter 的 `collected` 使用当前日期（工具脚本，非确定性重放场景）。
- 脚本路径以 skill 目录为基准：`scripts/fetch_url2md.py`。
