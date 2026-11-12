# 三渠道 chrome-use 复测 + xiaohongshu-mcp 本机可用性（2026-11-12）

> 背景：用户定案渠道权重改为三平台均等（小红书 30% / 公众号 30% / 抖音 30% / 其他 10%），要求复测三渠道登录需求（需登录的走"二维码发微信 bot"流程）并验证 xiaohongshu-mcp 本机可用性。

## 一、三渠道复测结论（chrome-use，全部无需扫码）

| 渠道 | 登录需求 | 实测证据 |
|---|---|---|
| 小红书 | **无需**（Chrome 已登录） | explore 页 avatar 存在、无登录按钮、feed 30 卡正常。**推翻 11-11「公司网络黑名单→纯人工导入」结论**（当时网络环境 vs 现在已不同） |
| 公众号 | 无需（文章页） | **新发现：搜狗微信在真实 Chrome 完全可用**（`weixin.sogou.com/weixin?type=2&query=` 无验证码、10 条/页）；旧"被拒"结论仅适用于抓取工具（web_reader）。文章页 `#activity-name/#js_name/#js_content` 全字段可读（实测 4787 字正文）。注意：搜狗 `/link` 跳转页分段拼 URL 防抓（`url += 'https://mp.'` 多段），eval fetch 跳转页后拼接全部片段即得真实文章链接 |
| 抖音 | 无需 | 视频页未登录可读：标题/互动计数器（复验 7704936204348900537 通过）。个别旧视频可能下架跳首页（7705269715614125339 已跳首页），属内容下架非渠道问题 |

**"发二维码到微信 bot"流程本次未触发**——三渠道 chrome-use 通道均直接可用。

## 二、xiaohongshu-mcp 本机可用性

- 子模块 `thirdparties/xiaohongshu-mcp`（xpzouying，Go）：**本机 build 成功**（go1.25.1，21MB 二进制）；默认端口 `:18060`；`deploy/macos/` 有 launchd 后台方案
- **API 使用前置**：需先完成它自己的一次扫码登录（`cmd/login` 流程，存 cookies.json）——它不共享用户 Chrome 的登录态
- **决策：暂不启用扫码**。chrome-use 通道已登录可采，content-intelligence 用不到 MCP；留作后续需要批量/结构化数据（如账号主页批量笔记）时再走一次扫码启用

## 三、已落地的修改

1. skill `SKILL.md`：权重改 30/30/30/10（旧 45/30/15 作废）；三平台速查行按实测更新
2. `references/platform-profiles.md`：权重行 + 章节顺序（小红书/公众号/抖音）+ 小红书发现渠道（chrome-use 优先，旧黑名单结论作废）+ 公众号发现渠道（搜狗微信可用 + 跳转拼接法）
3. 后续采公众号样本的标准路径：搜狗搜索 → eval 拿 h3 a 链接 → fetch `/link` 拼真实 URL → open 文章页提字段
