# agent 回执双发：onTurnCompleted 与 processed 分支双出口

- 日期：2026-10-21 · 阶段：AM-P0 真机（agent 模式）
- 位置：src/gateway/wechat-app.ts（handleInboundAgent × 构造器 onTurnCompleted 接线）

## 问题现象

真机 agent 模式下，每条消息的回复在微信里收到**两次完全相同**的文本；排队消息（drain 路径）不重复。

## 排查过程

1. 先怀疑 Outbox 并发双发（enqueueReply 内 `void flush` 与 5s 定时 flush 并发）——读 outbox.ts
   确认 `flush()` 有 in-flight 单飞保护（`if (this.inFlight) return this.inFlight`），排除。
2. 沿"每条回复产生几次入队"排查：Turn 完成路径有两处 enqueueReply——
   - AgentHost.runTurn → `deps.onTurnCompleted`（WechatApp 构造器接线：入账+enqueueReply）
   - `handleInboundAgent` processed 分支又手动 `enqueueReply(out.result.replyText)`
3. 排队消息只走 onTurnCompleted（drain 无 processed 分支），与"排队不重复、首条重复"现象吻合 → 定位。

## 根因

同一条回执存在**双出口**：onTurnCompleted 对**所有** Turn（含首条 processed）都会触发；
processed 分支又手动入队一次。T7 单测当时用 `bot.sent.some(...)` 断言（存在即可），
漏检重复 → 测试绿但真机双发。

## 解决方案

- 确立单一出口原则：**Turn 回执只经 onTurnCompleted 入队**（预算入账与 am.turn.completed
  审计一并挪入该回调，顺带修复了 drain 路径无审计的问题）；processed 分支只返回文本不再入队。
- 测试改为精确计数：`sent.filter(text).length === 1`（排队用例断言每条恰一次）。

## 预防/注意事项

- 回执/通知类副作用必须只有一个入队出口；旁路分支（确定性通道、排队 ack、错误回复）
  不在 Turn 生命周期内，仍可直接 enqueue，但不得与 onTurnCompleted 重叠。
- 断言"消息送达"时用**精确计数**而非 `some/includes`——存在性断言测不出重复发送。
