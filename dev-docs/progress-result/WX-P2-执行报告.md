# WX-P2 执行报告 — 可靠性闭环（M2）

> 阶段：WX-P2 · 日期：2026-10-20 · 基线 HEAD：744e1f3（WX-P1）
> 结论：**Gate PASS（代码与自动化验收全绿：146/146 单测 + 脚本套件 11/11；真机项移交 PT 手动验收，材料就绪）**

## 交付清单（T1~T8）

| 任务 | 模块 | 要点 |
|---|---|---|
| T1 任务控制 | `src/dispatch/task-control.ts` | 规则动词解析（列表/进度/取消/恢复/批准/拒绝，零 LLM 依赖）；用户归属过滤（跨用户拒绝+审计）；「刚才的」引用与多候选歧义澄清（IR-009）；取消走 service.cancel；经 Dispatcher `perform_task_control` 分发（IR-008） |
| T2 审批链路 | `run-monitor.ts` + `task-control.ts` | waiting_checkpoint → 审批卡（任务标识+事项+版本）经 Outbox；批准/拒绝走 decideCheckpoint(expectedVersion)；重复同义幂等（不再触碰执行侧）、版本冲突 CONFLICT、跨用户拒绝（A12 三变形）；拒绝按 Runtime 语义硬停（EX-008） |
| T3 Outbox | `src/notify/outbox.ts` | NotificationOutbox JSONL（pending/sent/failed + attempts/nextRetryAt）；指数退避重试；重试上限/24h 超龄放弃（LK-05）+ outbox.giveup 审计；重启加载退避清零（重启即补投机会）；并发防双发（in-flight 链）；「任务列表」主动查询补偿（NT-006） |
| T4 中断恢复 | `task-control.ts` resume | 先以 acknowledgeSideEffects=false 试探 → SIDE_EFFECTS_UNACKNOWLEDGED 时要求「确认恢复 tb-…」显式确认词 → true 重试（EX-009 不自动补签）；等待审批任务引导走审批；ModelRoutingLog 持久化（.pi-wechat/model-routes.jsonl，MR-010 回放一致） |
| T5 断线自愈 | `bot-adapter.ts` + `message-inbox.ts` | onSessionExpired → 指数退避重连（maxRetries/backoffMs/onStatus），超限停用不伪装在线；Inbox 去重持久化（inbox.jsonl，重启恢复游标语义）；stop() 只停 Bot 绝不触碰 Run（WG-007） |
| T6 限额 | `src/dispatch/limits.ts` | 三层：并发（service RUN_LIMIT_REACHED → RUN_LIMIT 友好话术）、消息频率（RateLimiter 滑动窗口+等待秒数）、Token 预算（BudgetTracker 持久化 budget.jsonl，preStart 守卫拒绝新启动，EX-010/SC-005/MR-011）；路由 tokens 经 onUsage 真实采集 |
| T7 重启恢复 | 全部 store + `wechat-app.ts` | TaskStore/ConversationStore（新增构造加载）/MessageInbox/Outbox/Audit/Budget/ModelRoutes 全文件态；WechatApp.start() 重启补扫（pollOnce 补审批、flush 补投滞留通知） |
| T8 审计与脱敏 | `src/audit/` | AuditLog（audit.jsonl：actor/action/target/outcome/detail）；byRun(runId) 串起意图→启动→选模→审批→通知（NT-005/WX-2）；redact() 六类模式（api-key/bearer/secret-field/凭据路径/长随机串）写入前强制脱敏（SC-004/NFR-007） |
| 装配 | `src/gateway/wechat-app.ts` + CLI | WechatApp 组合全链（幂等→限频→路由/执行/任务控制→Outbox→审计→监控循环）；`wechat start` 增 --rate-max/--budget-tokens；横幅明示「Ctrl-C 仅停 Bot」 |

## 验收矩阵

| 项 | 结果 | 证据 |
|---|---|---|
| A11 审批卡 / 未批准不推进 | ✅ | wx-reliability.test.ts A11（版本去重不重发） |
| A12 重复幂等 / 错误 version / 跨用户 | ✅ | A12a/b/c（幂等零调用；CONFLICT 拒绝+审计 rejected；跨用户拒绝+审计 actor） |
| A13 查询/取消归属 | ✅ | A13（真实状态读取；u2 越权取消被拒） |
| A14 多候选澄清 | ✅ | A14（列 tb- 清单，零误操作） |
| A15 完成≠送达 | ✅ | A15（通知 failed + 绑定 completed + 摘要 + 列表补偿 + giveup 审计） |
| A16 中断恢复 | ✅ | A16/A16b（显式确认词；确认后 ack=true；等待审批引导审批；决策日志重启一致） |
| A17 断线自愈 | ✅ | A17a~d（Inbox 跨实例去重；全链路单 Run；stop≠cancel；重连成功重置/超限停止） |
| A18 三层限额 | ✅ | A18a/b/c（并发话术+审计；频率等待秒；预算拒绝零启动） |
| WX-1 重启恢复 | ✅ | 双 WechatApp 同 dataDir：补投成功、审批卡不重发、映射完整、审批可继续 |
| WX-2 审计串链 | ✅ | byRun 含 intent.route→run.start→checkpoint.requested→checkpoint.approve→outbox.giveup |
| WX-3 日志脱敏 | ✅ | audit.jsonl 无 sk-/token/凭据路径明文；非敏感不误伤 |
| 回归 | ✅ | **146/146**（126 旧 + 20 新）；tsc/build 通过；脚本套件 11/11 |
| 真机（微信渠道） | 🔶 移交 PT | 手动指南 `dev-docs/guides/2026-10-21-wx-p2-manual-test.md`（B01~B13 + 状态抽验） |

## DoD（§14）勾选（P2 范围内）

- [x] 查询/取消/审批/拒绝/恢复遵守既有 Runtime 安全与状态语义（A11~A16 + §9 四条语义落测试）
- [x] 微信通知失败不丢任务结果，断线后可主动查询（Outbox + 列表补偿）
- [x] 关键路由、任务、模型选择和审批有可定位、可脱敏的审计记录（WX-2/WX-3）
- [ ] 真实微信收发/真机手测（PT 明早执行；代码路径已全 fake 覆盖）

## 关键决策与踩坑

1. **审批幂等前置检查**：重复同义审批在调用执行侧**之前**由 checkpoint 状态短路（decideCheckpoint 零调用），比「调了再靠服务端幂等」更稳（A12a 断言 service.decisions.length===1）。
2. **Outbox 重启退避清零**：进程重启本身即一次自然重试机会，否则上次失败退避会阻塞重启补投（WX-1 曾因此 FAIL，修复后通过）。
3. **flush 并发防双发**：enqueueReply 即时投递与循环投递并发时曾可能双发；in-flight promise 链 + flushOutbox 收敛循环（无进展即停）解决。
4. **bot-adapter 真机路径 latent bug**：P1 遗留 thirdparties 相对路径多一层（../../../../→../../../）且 clientFactory 注入前仍强制加载真机凭据；本次修复（真机验收前置项）。
5. **smartLLM 测试坑**：假 LLM 若匹配整个 prompt 会命中提示词规则文本（含「取消」），必须只取「用户消息：」首行判断。
6. **预算口径（NFR-008 允许）**：tokens 先采集（路由 onUsage 真实值 + fake 注入测试），成本估算延后，不虚构数据。

## 遗留（转 PT / P3）

- 真机 B01~B13 手动验收 + DoD 全表勾选（明早，指南已备）。
- Outbox 终态重发（用户重连后主动 push 补偿）目前靠「任务列表」查询，符合 D-06 预案。
- 成本（¥/USD）统计与按工作流分组预算 → P3（MR-011 完整化）。
