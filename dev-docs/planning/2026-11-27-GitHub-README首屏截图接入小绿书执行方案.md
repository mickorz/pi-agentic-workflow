# GitHub README 首屏截图接入小绿书执行方案（2026-11-27 定稿）

> 背景：xiaolvshu 的 GitHub 仓库输入（2026-11-12 接入）目前截图素材只从仓库内 assets 取，
> 封面是文字 cover-hook。本方案让"第一张卡片直接用真实 README 首屏截图"，提升开源项目类
> 小绿书的第一眼真实感（对齐 2026-11-19 偏好：真实素材优先，AI 图克制）。
> 状态：**已实施完成（2026-11-27，T0/T1/T2 全过）**，执行报告见
> dev-docs/progress-result/AP-S1R-GitHub-README封面-执行报告.md。

## 一、MVP 技术方案

**chrome-use + README DOM 定位 + 首屏区域截图**，不新增浏览器自动化框架，
不新增独立截图脚本，不改发布逻辑。

### 工作流程

1. 输入 GitHub 仓库链接 -> clone 到 `<文章目录>/引用/<repo>/`（现状不变）
2. **新增**：chrome-use 打开仓库页 -> 定位 README 渲染容器 -> 滚动到顶部 ->
   截取 README 正文首屏 -> 存 PNG
3. 素材落位：`_cards/assets/github-readme-first-screen.png`
4. 页面规划：存在该截图时第一页强制 role=cover + layout=screenshot-with-caption
5. 原有小绿书生产链照旧：build -> render -> normalize -> verify -> 审图 -> 发布

### 截图范围（关键）

只截 README 渲染区域（从项目标题/Logo/徽标/介绍开始），**不含仓库页文件列表**。

DOM 定位候选（按优先级，定位后必须校验可见性/内容/尺寸，不假设 DOM 恒定）：

| 优先级 | 选择器 | 用途 |
|---|---|---|
| P0 | `#readme` | README 容器 |
| P1 | `[data-testid="readme"]` | 测试标记容器 |
| P2 | `article.markdown-body` | Markdown 正文 |
| P3 | `.markdown-body` | 备用 |

截图几何：宽度取 README 正文实际宽度；高度先取 900 CSS px（一个视口量），
后续按实际效果调整。不强行拉伸、不裁掉 README 文字。

## 二、接入改动（四处，不新增文件）

| 文件 | 改动 |
|---|---|
| `.pi/skills/xiaolvshu/SKILL.md` | GitHub 输入流程增加 chrome-use README 截图步骤 |
| `dev-examples/wx-article/scripts/wechat_sticker_cards.js` | Stage 1 规划提示词增加 README 截图强制第一页约束 |
| `dev-examples/wx-article/scripts/sticker_cards/components.py` | `_render_screenshot` kicker 按 role 分流（cover 用 KICKERS["cover"]，其余 evidence）；封面截图页不显示 Fig. 序号 |
| `.pi/skills/xiaolvshu/references/pitfalls.md` | 增加 README 定位、截图失败、尺寸规范条目 |

第一页 pages.json 形态（复用现有 schema，零新枚举）：

```json
{
  "no": 1, "role": "cover", "source": "html",
  "layout": "screenshot-with-caption", "well_ratio": "4x3",
  "image_fit": "contain",
  "asset": "_cards/assets/github-readme-first-screen.png",
  "copy": { "title": "项目名称", "caption": "项目一句话定位" }
}
```

workflow 规划约束（存在 github-readme-first-screen.png 时）：
必须作第一页素材 / 第一页 role=cover / layout=screenshot-with-caption /
asset 指向该截图 / 不允许放到后续页 / 不允许 AI 重绘替换。
不存在时保持原有封面规划流程（本地文章零影响）。

## 三、实施顺序

- **T0 chrome-use 技术验证**（先行，选一个公开仓库实测）：
  ① 打开仓库页 ② 识别 README 渲染区域 ③ 截图从 README 内容开始、不含文件列表
  ④ 标题/Logo/徽标保留 ⑤ 宽度 >=720px 文字清晰 ⑥ 输出固定 PNG 路径可被
  prep_screenshots.py 识别 ⑦ **重点：能否把指定区域截图保存到本地文件路径**
- **T1 接入**：SKILL.md GitHub 输入流程 + workflow 规划提示词
- **T2 组件适配**：components.py kicker 分流，跑完整渲染/normalize/verify 冒烟

## 四、验收清单（T0 过后逐项勾）

1. 使用 chrome-use 已登录浏览器打开 GitHub 仓库
2. 能够正确识别 README 渲染区域
3. 截图顶部从 README 内容开始，不包含仓库文件列表
4. README 标题、Logo、徽标等首屏内容得到保留
5. 截图宽度至少 720px，文字清晰
6. 输出固定 PNG 路径并能被 prep_screenshots.py 识别
7. pages.json 第一页使用 README 截图
8. 最终 output/01.png 确实是 README 截图
9. README 截图失败时原有 GitHub 文章流程仍能继续（降级路径）
