# xiaohongshu-mcp 备选方案启用指南

- 日期：2026-11-12
- 定位：**小红书采集的备选通道**。主通道是 chrome-use（用户 Chrome 已登录，2026-11-12 复测通过，见 `dev-docs/research/2026-11-12-三渠道chrome-use复测与权重均等.md`）。本服务暂不启用、不登录；触发条件满足时按本文档启用。
- 上游：thirdparties/xiaohongshu-mcp 子模块（github.com/xpzouying/xiaohongshu-mcp，Go，基线 7797fd3，2026-10-23 接入）

## 1. 什么时候启用（触发条件）

| 场景 | 说明 |
|---|---|
| 批量结构化采集 | 账号主页批量笔记、搜索结果分页拉取、评论区批量导出——chrome-use 逐页 eval 效率低 |
| 稳定性需求 | chrome-use 依赖用户 Chrome 前台状态；MCP 是独立 Go 服务 + 自有 cookies，可后台常驻 |
| 发布/运营自动化（远期） | 服务自带 publish/comment/notification 工具（见 §4 工具清单），市场研究阶段**禁用**（见 §5 纪律） |

日常 content-intelligence 采样（每日几条到十几条）继续走 chrome-use，不动用本服务。

## 2. 本机现状（2026-11-12 验证）

- 子模块已 init：`thirdparties/xiaohongshu-mcp/`
- 构建通过：`go build -o /tmp/xhsmcp .`（go1.25.1 darwin/arm64，产物约 21MB）
- 服务默认端口 `:18060`（`-port` 可改）；`AUTH_TOKEN` 环境变量可加鉴权
- MCP 端点：`POST /mcp`（streamable HTTP MCP，go-sdk）
- **未登录**：无 cookies.json，API 调用会失败——需先走一次扫码登录（不共享用户 Chrome 登录态）

## 3. 启用步骤（未来执行手册）

```bash
cd thirdparties/xiaohongshu-mcp
go build -o /tmp/xhsmcp . && go build -o /tmp/xhslogin cmd/login/main.go
# 起服务（工作目录须可写 cookies.json）
/tmp/xhsmcp -port :18060 &
```

**登录（推荐走 MCP 工具，勿用 login 子命令弹浏览器）**：

1. MCP 调 `check_login_status` 确认未登录
2. MCP 调 `get_login_qrcode` → 返回 **Base64 二维码图片 + 超时时间**
3. Base64 解码存 PNG → 通过微信 bot 发给用户（`.pi-wechat/outbox.jsonl` 图片消息；用户定案流程：用户手动扫码）
4. 轮询 `check_login_status` 直到登录成功（cookies.json 落盘）
5. 验证：MCP 调 `search_feeds`/`get_feed_detail` 各一次

**常驻（可选）**：`deploy/macos/xhsmcp.plist`（launchd），替换二进制路径与含 cookies.json 的工作目录后 `ln -s … ~/Library/LaunchAgents/xhsmcp.plist && launchctl load`。

## 4. MCP 工具清单（18 个）

**研究采集可用**：`search_feeds`（搜索）、`get_feed_detail`（笔记详情）、`list_feeds`（feed 列表）、`user_profile`（用户主页）、`check_login_status`

**登录管理**：`get_login_qrcode`、`delete_cookies`（重置登录）

**发布/互动类（市场研究禁用）**：`publish_content`、`publish_with_video`、`post_comment_to_feed`、`reply_comment_in_feed`、`like_feed`、`favorite_feed`、`get_my_profile`、`get_unread_count`、`list_notifications`、`reply_notification`、`like_notification`

## 5. 纪律与风险

1. **互动/发布工具对非自有账号一律禁用**——与公众号"禁止点赞换数字"同纪律（污染用户账号、触发平台风控）
2. cookies 过期 → `check_login_status` 失败 → `delete_cookies` 后重走 §3 扫码流程
3. 子模块更新：`git submodule update --remote thirdparties/xiaohongshu-mcp`（留意上游 breaking change，重跑一次 search/get_detail 验证）
4. 服务只绑 127.0.0.1 场景使用；如需远程访问必须带 AUTH_TOKEN 且不走公网裸端口
