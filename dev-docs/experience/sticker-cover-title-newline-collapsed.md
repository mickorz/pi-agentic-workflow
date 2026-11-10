# 小绿书封面标题换行符被注入器吞掉（esc vs esc_multiline）

## 问题现象

2026-11-10 mcode-stack 小绿书首跑：pages.json 封面 copy.title 按三行设计写入（`MiniMax 团队自用\nClaude Code 工作流\n全开源了`），渲染出的封面却是自然折行——"Claude Code" 品牌名被拆在两行（`…自用 Claude / Code 工作流…`），与 `--chars` 自适应字号的三行设计不符。

## 排查过程

- 读 `sticker_cards/components.py`：`_render_cover` 里 `lines = title.split("\n")` 算出 `--chars`（自适应字号按最长行），但 `<h1>` 渲染用的是 `esc(title)`——只做 HTML 转义，`\n` 原样进 HTML 后被浏览器折叠成空格
- 同文件里 `esc_multiline()` 本来就是干这个的（`\n`→`<br>`），text-card 的 big 和 quote 已在用，唯独封面 title、截图页/清单页 h1 用了 `esc()`

## 根因

封面组件算了断行元数据（`--chars`）却没把换行真正渲染出来：规划层以为"三行设计"生效，注入层把它折回自然流排版。长 Latin 词（Claude Code）在自然折行处被硬拆。

## 解决方案

`components.py` 三处 `esc(title)` → `esc_multiline(title)`：封面 `gz-cover__title`、screenshot-with-caption 的 `h-display`、checklist 的 `h-display`。对不含换行的输入，`esc_multiline` 输出与 `esc` 逐字节相同（replace 不存在的子串是 no-op），存量模板/fixture 行为零变化——五套件 109 断言回归全绿。

## 预防/注意事项

- 给"多行文案"字段接组件时，凡页面语义允许手工断行的 display 级字段（标题/金句/大字），一律走 `esc_multiline`；`esc()` 只留给单行小字
- h-display 是固定 124px（约 7 个汉字宽/行），封面靠 `--chars` 自适应、h-display 不自适应——长文案必须由规划层手工断行或缩短，注入器不会缩字号（模板注释明言"每张卡自行 inline 调字号"）
- 审图若发现"品牌名被拆行/文字疑似截断"，先对照 pages.json 原文与组件实现，再判是内容问题还是注入器问题
