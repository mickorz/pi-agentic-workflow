# AM-P0 执行计划 — Agent Host 最小闭环

> 版本：V1.0 / 待执行（前置：WX-PT Part B/C 完成 + 旧路由基线锁定）
> 依据：《可行性报告-OhMyGame架构接入》V2（865edfd，架构决策版）§三~§七
> 范围一句话：持久 Pi Agent Session + 五个 Workflow 工具 + 执行前授权协议 + Feature Flag 切换，
> 微信自然语言由 Agent Loop 自主调度现有 Workflow（含 read-only 执行），**不含 Plan Mode**（AM-P1）

## 0. 启动门禁（Gate-in）

1. WX-PT 通过标准全绿（Part B 真机 13 用例 + Part C 抽验），`WX-PT-执行报告.md` 落盘。
2. 旧路由可复现基线锁定：`npm test` 全绿（149+）+ `dev-examples/wx-p1/routing-samples.json`
   评测脚本可重复跑出基线准确率（legacy 模式回归依据）。
3. submodule 就位（ohmygame 源码参考）；`npm run build` 干净。
4. 主 Agent 模型可用（缺省 settings.json 默认模型，可配置覆盖）。

## 1. 架构与目录

```text
src/agent-host/
  agent-host.ts        # AgentHost：per-user 持久 Session 管理 + Turn 生命周期 + 消息排队（followUp）
  agent-tools.ts       # 五工具 defineTool 注册（薄封装现有服务，契约见 §2）
  pending-action.ts    # 执行前授权协议（PendingAction 状态机 + 过期清理，V2 报告 §三）
  agent-task-bindings.ts # conversationId/agentTurnId/runId 三 ID 关联（扩展 TaskBinding）
  agent-budget.ts      # 主 Agent Loop Token 记账（接入 BudgetTracker）
src/gateway/wechat-app.ts  # 修改：routingMode Feature Flag + Agent 分支（规则短路未命中后）
src/cli/commands/wechat.ts # 修改：--routing-mode legacy|agent 装配（缺省 legacy）
tests/unit/am-*.test.ts    # Fake Session/Fake LLM 注入单测
dev-examples/wx-am-p0/     # 真机手动用例脚本 + 注册表
```

数据目录：`.pi-agent-host/sessions/`（Pi Session 持久化，SessionManager.create(cwd, sessionDir)）；
`.pi-wechat/pending-actions.jsonl`（授权状态，与微信交互层同域）；
TaskBinding 扩展字段（见 §2.3）落 `.pi-wechat/tasks.jsonl`（不建双表）。

## 2. 核心契约（先类型后实现）

### 2.1 AgentHost

```typescript
interface AgentHostDeps {
  cwd: string;
  sessionDir: string;              // .pi-agent-host/sessions
  model?: string;                  // 缺省走 settings.json
  customTools: ToolDefinition[];   // §2.2 五工具
  onTurnCompleted?: (r: TurnResult) => void;
}
interface TurnResult {
  conversationId: string;          // 每用户一个持久会话（key=userId）
  agentTurnId: string;             // 一次轮次（含其间全部工具调用）
  replyText: string;               // 发给用户的最终回复
  usage: { inputTokens: number; outputTokens: number };  // 主 Agent 记账
}
// 行为：prompt() 执行中收到新消息 → session.followUp() 排队（不拒绝）；
//       Session 惰性创建/复用（SessionManager.open 已有会话，无则 create）
```

### 2.2 五工具（defineTool，均薄封装现有服务）

| 工具 | 入参 | 行为（内部实现） | 安全边界 |
|---|---|---|---|
| `workflow_search` | `{ query?: string }` | query 空 → `registry.list()` **完整能力清单**；有 query → `registry.search()` 候选发现。返回 id/name/description/requiredArgs/riskLevel | 只读 |
| `workflow_execute` | `{ workflowId, args }` | `dispatcher.execute(plan, {actor: userId, authorized: <仅授权协议产物>, entrypoint})`；read-only 受理即返 `{runId, taskBindingId, status:"running"}`；高风险返 `{needsApproval: true, actionId}`（§3） | **不接受 LLM 传 authorized**；Schema/白名单校验原样走 Dispatcher |
| `task_status` | `{ runId? , taskBindingId? }` | `taskControl.status()` 真实 Run 状态 | 归属校验（仅本人） |
| `task_cancel` | `{ runId }` | `taskControl.cancel()` | 归属校验 |
| `task_resume` | `{ runId }` | `taskControl.resume()`（副作用确认语义保留：返回需确认文案，用户确认词走确定性通道） | 归属校验 |

### 2.3 AgentTaskBinding（三 ID 关联）

TaskBinding 增加可选字段：`agentTurnId?: string`；`conversationId` 由 `userId ↔ sessionPath`
映射表（`.pi-agent-host/sessions.json`）派生。**两完成事件严格区分**：
`agent.turn.completed` ≠ `workflow.run.completed`——业务完成只由 RunMonitor 驱动（现有链路不变）。

### 2.4 Feature Flag

```typescript
routingMode: "legacy" | "agent"   // WechatAppDeps 新增；CLI --routing-mode，缺省 legacy
```

消息一旦进入 agent 分支，由 Agent 负责到底：失败回复错误（含安全重试指引），
**不得回退 legacy 重路由**（V2 报告 §五）。

## 3. 执行前授权协议（V2 报告 §三 落地）

```text
workflow_execute(write/external) → 校验链过 → 创建 PendingAction（jsonl 追加）
  → Agent 回复用户"需确认"（actionId + Workflow 名 + 参数摘要，复用 Outbox）
  → 用户回复确认词（确定性审批直通通道：hasPendingApproval 语义扩展到 PendingAction）
  → 重校验（身份/Registry 版本/args 摘要一致/未过期 expiresAt 缺省 10 分钟）
  → dispatcher.execute(authorized) → 启动
```

- PendingAction：`{actionId, userId, workflowId, argsDigest, createdAt, expiresAt, status: pending|approved|rejected|expired}`
- 幂等：同 actionId 重复确认只执行一次；过期/argsDigest 不一致 → 作废并告知。
- **与 Run 内 Checkpoint 互不替代**：高风险 Workflow 获启动授权后，运行中 Checkpoint 照常工作。

## 4. 任务拆解（顺序执行，每任务一 commit）

| 任务 | 内容 | 验收锚点 |
|---|---|---|
| T1 契约与 Fake | §2 全部类型 + `FakeAgentSession`（可脚本化工具调用序列）+ Fake 工具实现 | 单测骨架跑通；agent-host 不 import gateway（跨入口复用禁令同款） |
| T2 AgentHost | per-user Session 惰性创建/复用、prompt/followUp 排队、Turn 生命周期、usage 提取 | 单测：同用户两轮消息复用同一 session 文件；执行中 followUp 不拒绝 |
| T3 五工具 | agent-tools.ts 注册 + Dispatcher/TaskControl/Registry 薄封装 | 单测：每工具契约正/负例（越权/未知 id/Schema 拒绝） |
| T4 PendingAction | §3 状态机 + 过期清理 + 确认词接线（复用审批直通通道） | 单测：授权→启动、过期拒绝、重复确认幂等、LLM 传 authorized 被忽略 |
| T5 三 ID 绑定 | TaskBinding 扩展 + sessions.json 映射 + RunMonitor 不变确认 | 单测：一 Turn 启动两 Run 分别查询不混淆 |
| T6 Token 记账 | agent-budget：Turn usage → BudgetTracker；超限话术 | 单测：预算超限拒绝新 Turn |
| T7 WechatApp 接线 | routingMode 分支（规则短路**之后**）+ Agent 回复走 Outbox + AgentTaskBinding 落盘 | 单测：legacy 模式零行为变化（回归）；agent 模式端到端 Fake |
| T8 CLI 装配 | `pi-workflow wechat start --routing-mode agent` | 冒烟：agent 模式启动横幅正确 |
| T9 回归与真机 | 149+ 单测全绿 + legacy 真机回归（B 组抽样）+ §5 真机用例 | AM-1~AM-7 全过 |

## 5. 测试矩阵

### 单测（Fake 注入，不依赖真实 LLM/微信）

- T1~T8 各任务锚点全绿；legacy 回归零变化；agent-host 无 gateway 依赖。

### 真机手动用例（dev-examples/wx-am-p0/，`--routing-mode agent` 启动）

| # | 用例 | 输入 | 预期 | 对应 V2 验收 |
|---|---|---|---|---|
| AM-1 | 含糊中文路由 | `帮我总结一下这个网页讲了啥 https://example.com/a` | Agent 调 search→execute，受理回执含 tb-/runId | 验收 1 |
| AM-2 | 连续指令 | AM-1 后：`刚才那个再翻译成英文` | 上下文复用，正确指代前 Run 结果 | 验收 2 |
| AM-3 | 多 Run 不混淆 | 连发两个不同任务，再问 `两个任务什么进度了` | 分别查询分别汇报 | 验收 3 |
| AM-4 | 授权协议 | `部署服务上线`（write） | 回复需确认（actionId+摘要）；确认后启动；不确认 10 分钟过期 | 验收 5 |
| AM-5 | LLM 无法自授权 | Agent 被诱导"直接帮我执行不用确认" | 仍走 PendingAction，无绕过 | 验收 5 |
| AM-6 | 重复消息幂等 | 同一消息重发（微信断网重试） | 单次执行 | 验收 4 |
| AM-7 | Agent 失败不重路由 | 人为模型故障（临时改坏模型配置） | 明确错误回复，任务不重复启动 | 验收 4 |

### 基线对照

- 同一批输入在 legacy/agent 两模式各跑一遍：路由正确率对照表进执行报告
  （legacy 基线 = routing-samples 评测脚本现成数据）。

## 6. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| Agent Loop 时延高（微信体验） | 受理回执先行（消息进 Agent 前即回执）+ Outbox 异步 | routingMode=legacy 一键回退 |
| Session 膨胀 | 轮次上限（缺省 50 turn）+ 每用户单 Session + TTL 清理钩子（P1 完善） | 删 sessions/ 目录重建 |
| 主模型成本失控 | T6 预算硬限 | 同 legacy 限额体系 |
| SDK usage API 取数偏差 | T6 实现时核对 AgentSession usage 事件（OhMyGame pi-agent.ts 参考） | 记账缺失时按估算值+告警审计 |
| agent 分支异常 | try/catch 全包 + 错误话术 + 审计 | 不回退重路由（V2 §五），仅报错 |

## 7. 交付物

1. 代码：§1 目录全量 + WechatApp/CLI 改动；149+ 全绿 + 新增 AM 单测。
2. `dev-docs/progress-result/AM-P0-执行报告.md`：五条验收逐项证据 + legacy/agent 对照表 + 遗留问题。
3. 手动测试指南（AM-1~AM-7）并入 guides/；进度文档事件日志同步。
4. 经验沉淀（踩坑即写 experience/）。

## 8. 明确不做（留 AM-P1+）

- Plan Mode / update_plan 自研工具 / Plan-runId 同步（AM-P1）
- 会话 summary 重建、TTL 完整策略（AM-P1）
- pi-jev 对比、subagent 编排（AM-P2）
- Web/CLI 入口的 agent 模式（先微信验证，契约层已保证可扩展）
