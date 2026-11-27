# AP-S1R — GitHub README 首屏截图封面 执行报告（2026-11-27）

> 方案：`dev-docs/planning/2026-11-27-GitHub-README首屏截图接入小绿书执行方案.md`
> 目标：GitHub 仓库输入的小绿书，第一张卡片直接用真实 README 首屏截图（替代纯文字封面），
> 对齐 2026-11-19"真实素材优先"偏好。不新增浏览器框架、不新增截图脚本、不改发布逻辑。

## 结论

**T0/T1/T2 全部完成，方案落地。** chrome-use 钉元素截图法验证通过；
四处改动（SKILL.md / workflow 提示词 / components.py / pitfalls.md）全部落盘；
全链冒烟 + Example 回归 103 断言 0 FAIL。

## T0 chrome-use 技术验证（markitdown 实测）

| 验收项 | 结果 |
|---|---|
| 已登录浏览器打开 GitHub 仓库 | PASS（chrome_devtools 通道） |
| 识别 README 渲染区域 | PASS（`article.markdown-body` 命中；`#readme`/`[data-testid=readme]` 在 2026-11 GitHub react 版已不存在，选择器逐级回落） |
| 截图从 README 内容开始、不含文件列表 | PASS |
| 标题/Logo/徽标/介绍保留 | PASS（MarkItDown 标题 + pypi/downloads 徽标 + Important 提示框 + 支持格式列表） |
| 宽度 >=720px 文字清晰 | PASS（1646x1800 @dpr2，zai 读图确认文字锐利） |
| 固定 PNG 路径保存 + prep_screenshots 识别 | PASS（`[OK] 1646x1800 square`、`=== ALL DONE ===`、0 项需人工确认） |
| pages.json 第一页使用 README 截图 | PASS（T2 冒烟覆盖） |
| output/01.png 确实是 README 截图 | PASS（zai 读图：kicker=封面 · COVER，截图完整无变形，图注无 Fig 序号） |
| 失败降级不影响原流程 | PASS（设计保证：文件不存在→按原 cover-hook 规划，提示词与 SKILL.md 双落点） |

### T0 过程中的三个坑（已沉淀 pitfalls #23）

1. **视口直截混入侧栏**：>=1012px 视口 README 与 Contributors/Languages 侧栏并排；
   缩窄视口又 reflow（@800px README 列塌到 423px）。
2. **遮罩方案必失败**：GitHub 页面有 `isolation:isolate` 包裹层（div.logged-out.env-production），
   body 级白遮罩 z-index 再高也被整体压住 → 全白图。
3. **最终解法——钉元素截图法**：article 设 `position:fixed(0,0)` + 实测宽度 x 900px +
   `overflow:hidden` + 白底，html/body `overflow:hidden` 关滚动条，视口 emulate 同尺寸 @dpr2，
   视口截图即纯 README。不用遮罩、不裁剪、不碰 PNG 解码（呼应 pitfalls #21）。

## 改动清单（4 文件）

| 文件 | 改动 |
|---|---|
| `.pi/skills/xiaolvshu/SKILL.md` | A 节 GitHub 输入新增"README 首屏截图"步骤：钉元素截图法要点 + 失败降级路径 |
| `dev-examples/wx-article/scripts/wechat_sticker_cards.js` | Stage 1 规划提示词：github-readme-first-screen.png 存在时强制第一页 role=cover + screenshot-with-caption + 禁重绘/后置；不存在走原 cover-hook |
| `dev-examples/wx-article/scripts/sticker_cards/components.py` | `_render_screenshot`：kicker 按 role 分流（cover→"封面 · Cover"，其余→"实证 · Evidence"）；封面截图页不输出 Fig. 序号 |
| `.pi/skills/xiaolvshu/references/pitfalls.md` | 新增 #23（选择器漂移/侧栏混入/层叠陷阱/空白图自检） |

第一页 pages.json 形态（冒烟实际用例，schema v2 全过）：
`role=cover, layout=screenshot-with-caption, well_ratio=4x3, image_fit=contain, asset=_cards/assets/github-readme-first-screen.png`。

## 验证记录

1. **全链冒烟**（临时目录，markitdown 截图 2 页：README 封面 + text-card）：
   validate_pages → build_html → render.mjs --no-embed（2 页 1080x1440）→ normalize →
   verify_cards，`汇总 OK=8 FAIL=0`、`=== CARDS VERIFIED ===`；
   index.html 含"封面 · Cover"、无 "Fig.0"；01.png zai 视觉核验通过。
2. **Example 回归**：validate_pages 20/20 + build_html 29/29 + normalize_cards 24/24 +
   verify_cards 10/10 + prep_screenshots 20/20 = **103 断言 0 FAIL**。
3. 语法检查：components.py ast 解析过；workflow DSL 顶层 return 为引擎包装既有形态（与 HEAD 一致）。

## 遗留与后续

- 真机端到端（真实文章目录 + 正式发布入箱）待下一篇 GitHub 选题自然覆盖；
  届时按 SKILL.md A 节新步骤走即可，无需额外验证脚本。
- 900px 截图高度为首版默认值，若某仓库首屏在标题处截断观感不佳，规划时可在
  截图步骤调高度（非代码改动，操作参数）。
- dev-examples/github-readme-shot/（T0 截图产物）已加入 .gitignore，不随仓库提交。
