# WX-P5 执行报告 —— 微信聊天记录全量落盘 + wx-mock 引擎 Mac 适配

**日期**：2026-10-27
**目标**（用户需求 m00855/m00859）：所有 wechat bot 聊天记录保存下来方便复盘，按日期存储。

## 交付内容

### 1. ChatLog 聊天记录（核心功能）

- **新文件 `src/gateway/wechat/chat-log.ts`**：`ChatLog` 类按本地日期追加写 `<dataDir>/chat-logs/YYYY-MM-DD.jsonl`（文件归属按事件时间而非写入时间，跨零点迟到消息落在发生日）；`ChatLogEntry {ts, direction: in|out, userId, text, messageId?, status?: sent|failed}`；尽力而为——写失败静默吞，绝不影响收发主链路。
- **`src/gateway/wechat/bot-adapter.ts`** 埋点（选 adapter 层的理由：所有出站路径——agent 回复/legacy 路由/outbox 通知/审批卡/rebind 确认——都经 `bot.send()`；入站经轮询循环；一处埋点天然全量，新增发送路径无需记得记录）：
  - 入站：绑定过滤 + 非空文本之后、handler 之前记录（含 messageId，重投递会多行——复盘可见原始投递行为）；
  - 出站：`send()` 成功记 `sent`，抛错记 `failed` 后照常 rethrow（重试归 Outbox）。
- **`src/cli/commands/wechat.ts`**：adapter 构造传入 `chatLog: new ChatLog(dataDir)`（`wechat start` 唯一构造点，前台/PM2 服务/mock 模式全覆盖）。
- 新增 `tests/unit/chat-log.test.ts` 3 用例：按日期落盘 / adapter 双向埋点（含失败）/ 目录不可写不抛。

### 2. wx-mock 引擎 Mac 适配（Windows 专属命令修复）

见经验文档 `dev-docs/experience/2026-10-27-wx-mock-windows-only-taskkill-ping.md`：engine.py taskkill→killpg、mock-slow fixture ping sleep→node setTimeout、registry 计数测试基线 19/24。

## 验证记录

- 单测：chat-log 3/3；全量 `npm test` 487 pass + 计数基线修复后全绿。
- **Gate B（最新 mock 引擎自测，deterministic 全量 6 场景）**：route-smoke / keyword-conflict / param-extraction / execution-success / execution-failure / checkpoint-resume（修复后 4 步含 kill+resume 全过）全部 `=== ALL PASS ===`。
- 聊天记录内容抽检（route-smoke 与 checkpoint-resume 的独立 dataDir）：入站指令、出站启动回执、kill 后重启的「已中断，可回复恢复任务」通知均完整按时间序落盘 `chat-logs/2026-10-27.jsonl`。
- 集成模式两场景（approval-pass/reject，真实 LLM）未跑（本轮 deterministic 已覆盖服务链路；留里程碑抽检）。

## 遗留

- 生产 PM2 服务需 restart 才启用聊天记录（源码变更，运行时按进程启动加载）。
- 存量历史聊天无法回补（inbox-journal 已不存在；outbox.jsonl 只有出站侧）。
- integration 两场景待真机/LLM 环境跑基线。

**Commits**：见 git log（chat-log 功能 + wx-mock mac 适配 + 计数基线）。
