# AM-P0 执行计划 — Agent Host 最小闭环（V2.1）

> 版本：V2.1（2026-10-21，按外部评审第三轮修订：锁定三个底层契约）· V2/V1 见 git 历史
> 依据：《可行性报告》V2 + 外部评审三轮（已全部融入）
> 前置：WX-PT Part B/C 完成 + 旧路由基线锁定
> 范围：持久 Pi Agent Session + 五个 Workflow 工具 + 执行前授权状态机 + Feature Flag；不含 Plan Mode（AM-P1）
> 执行策略：T1 先行独立交付（契约 + Fake + 状态机），模块按契约实现，不一次性交给开发 Agent

## 修订摘要（V2 → V2.1，三个契约锁定）

| # | V2 问题 | V2.1 锁定决策 |
|---|---|---|
| 1 | “start 幂等键”实为不存在的能力（RunApplicationService 无 idempotencyKey，不能假装可复用） | **方案 B 起步**：启动不确定 → `unknown` 态禁止自动重试，人工核对；方案 A（改 RunApplicationService/WorkflowEngine/RunManifest 支持幂等键查回）列为后续升级，不提前重构 |
| 2 | “启动前预写 TaskBinding”与现有契约冲突（runId 必填且为 TaskStore 索引） | 三阶段实体：启动前 `RunLaunchAttempt` → 成功后现有 `TaskBinding`（不变）→ 恢复/完成 `run-links`；TaskStore 不接收假 runId |
| 3 | Inbox Journal 无原始消息，恢复不了（只是"知道丢了任务"） | 持久化完整入站消息快照（channel+messageId 标识）；启动时从 Journal 恢复不等旧 Inbox 去重；不确定副作用消息禁止重调 Agent |
| 4 | 串行队列 vs followUp 语义未定 | **P0 只实现消息排队**（每用户单活动 Turn，前一完成再 prompt）；followUp 延后（T2 单独验证后可启用） |

## V1 → V2 修订摘要

| # | V1 缺陷 | V2 修正 |
|---|---|---|
| 1 | `workflow_search` 调用不存在的 `registry.list()`；五工具与现有 API 不一致 | §2.2 精确对齐：`registry.all()/search()`；新增**结构化 TaskControl Facade**；execute 构造 RoutePlan 直调 dispatcher（绝不触发 IntentRouter） |
| 2 | PendingAction 字段不全，无原子状态转换 | §3 完整状态机 + 服务端执行快照 + 原子认领 + 启动幂等/不确定态处理 |
| 3 | Inbox 去重 ≠ 处理完成（崩溃丢任务） | §4 消息处理状态机（received/processing/completed/failed）+ 重启恢复 |
| 4 | 异步 Run 结果无衔接（模型凭记忆猜） | §5 三契约：execute 只返受理、status 返结构化真实结果、RunMonitor 可恢复执行关联 |
| 5 | Token 预算仅事后记账 | §6 双层：累计预算 + 单 Turn 硬限（请求/工具次数/时长/实时中止） |

## 0. 启动门禁（Gate-in）

1. WX-PT 通过标准全绿（Part B 真机 + Part C 抽验），`WX-PT-执行报告.md` 落盘。
2. 旧路由可复现基线锁定：`npm test` 全绿（149+）+ routing-samples 评测可重复出基线准确率。
3. submodule 就位；`npm run build` 干净；主 Agent 模型可用。

## 1. 架构与目录

```text
src/agent-host/
  agent-host.ts          # AgentHost：per-user 持久 Session + Turn 生命周期 + 同用户消息串行化
  agent-tools.ts         # 五工具 defineTool（薄封装 Facade，契约见 §2.2）
  task-control-facade.ts # 结构化 TaskControl Facade（runId 直操作，归属校验；新增）
  pending-action.ts      # 执行前授权状态机（§3，含执行快照与原子认领）
  run-link.ts            # Run 执行关联：启动幂等记录 + 完成产物引用（§4/§5，新增）
  inbox-journal.ts       # 消息处理状态机与重启恢复（§4，新增）
  agent-budget.ts        # 双层预算（§6）
src/dispatch/registry.ts   # 复用（all/search；无独立版本字段——重校验用元数据稳定哈希）
src/gateway/wechat-app.ts  # 修改：routingMode 分支 + Inbox 状态接线
src/cli/commands/wechat.ts # 修改：--routing-mode legacy|agent（缺省 legacy）
tests/unit/am-*.test.ts
dev-examples/wx-am-p0/     # 真机用例 + 测试注册表（含 AM-4 无害 write 流程）
```

数据：`.pi-agent-host/sessions/`（Pi Session）；`.pi-wechat/pending-actions.jsonl`；
`.pi-wechat/inbox-journal.jsonl`（含原始消息快照）；`.pi-wechat/run-attempts.jsonl`（启动关联三阶段）；
`.pi-wechat/run-links.jsonl`（Run 结果关联）。

## 2. 核心契约（T1 交付，模块实现依据）

### 2.1 AgentHost

- per-user Session 惰性创建/复用（SessionManager.open → create 兜底）。
- **同用户消息排队（P0 锁定语义）**：每用户单活动 Turn；新消息持久化排队，前一 Turn 完成后再
  `session.prompt()`。**不使用 followUp()**（Pi 在运中注入能力留 T2 单独验证后启用，
  P0 保证 agentTurnId/usage/Journal/业务结果对应关系最清晰）；不同用户可并行。
- Turn 执行中收到新消息 → 持久化排队；重启后 Session 恢复 + 未完成消息按 §4 恢复。
- TurnResult：`{conversationId, agentTurnId, replyText, usage}`。

### 2.2 五工具（接口精确对齐现有 API）

| 工具 | 入参 | 内部实现（对齐点） |
|---|---|---|
| `workflow_search` | `{ query?: string }` | query 空 → `registry.all(true)` **完整能力清单**；有 query → `registry.search()` **候选发现**。返回结构化：`[{id, name, description, requiredArgs, riskLevel}]`。**关键词检索不是唯一候选来源**——Agent 可先取全清单再自行判断 |
| `workflow_execute` | `{ workflowId, args }` | 构造 `RoutePlan`（intent=execute_workflow, action=start_execution）→ `dispatcher.execute(plan, {actor, authorized, entrypoint})`；**绝不触发 IntentRouter**。返回 `{runId, taskBindingId, status:"running", accepted:true}`——**只返受理，不返虚假最终结果**；高风险返 `{needsApproval, actionId}`（§3） |
| `task_status` | `{ runId? \| taskBindingId? }` | **TaskControl Facade**（新增结构化方法，非自然语言）：归属校验后读真实 Run，返回 `{status, resultSummary?, resultRef?, error?}` 结构化结果与产物引用（非中文话术） |
| `task_cancel` | `{ runId }` | Facade.cancel：归属校验 → 真实取消；有操作后果，**不因非 execute 就绕归属校验** |
| `task_resume` | `{ runId }` | Facade.resume：归属校验 + **副作用确认语义**（返需确认标记，确认词走确定性通道） |

### 2.3 启动关联三阶段实体（不与 TaskStore 契约冲突）

| 阶段 | 实体 | 内容 | 存储 |
|---|---|---|---|
| 启动前 | `RunLaunchAttempt`（新增） | attemptId、userId、workflowId、argsDigest、状态(launched/linked/unknown) | `.pi-wechat/run-attempts.jsonl` |
| 启动成功 | 现有 `TaskBinding`（**契约不变**）+ 可选 `agentTurnId?` | runId（真实）、taskBindingId | `.pi-wechat/tasks.jsonl`（现有） |
| 完成/恢复 | `run-links` 更新 | Run 终态、resultSummary、resultRef、attemptId 关联 | `.pi-wechat/run-links.jsonl` |

**TaskStore 不接收未取得 runId 的预写**（runId 必填且为索引）；RunMonitor 照旧按 runId 工作。

### 2.4 Feature Flag

`routingMode: "legacy" | "agent"`（WechatAppDeps + CLI `--routing-mode`，缺省 legacy）。
进入 agent 分支负责到底，失败报错不重路由；legacy 链路零改动。

## 3. 执行前授权状态机（PendingAction）

```text
pending ──确认──► executing ──启动完成──► executed
   │                 │
   ├─ rejected       └─ 不确定态（启动超时/崩溃）→ §3.3 恢复
   └─ expired（缺省 10 分钟）
```

### 3.1 服务端执行快照（受保护，确认时重读）

```typescript
interface PendingAction {
  actionId: string;            // 幂等键
  userId: string;
  workflowId: string;
  args: unknown;               // 完整参数（确认后从这里取，不依赖会话记忆）
  argsDigest: string;
  originMessageId: string;     // 原始消息（审计链）
  riskLevel: string;
  registryDigest: string;      // 注册元数据稳定哈希（Registry 无版本字段的替代）
  createdAt: string; expiresAt: string;
  status: "pending" | "executing" | "executed" | "rejected" | "expired";
  result?: { runId: string; taskBindingId: string };  // executed 后回填
}
```

### 3.2 原子认领与幂等确认

- **同一 actionId 只能有一个执行者获得启动资格**：pending → executing 原子转换（文件锁/单写者，
  同进程串行队列保证；P0 至少覆盖同进程并发确认）。
- **重复确认返回原始结果**：status=executed → 直接回 `{runId, taskBindingId}`，不得再次调
  `RunApplicationService.start()`。
- 确认时重校验：身份 / registryDigest 一致 / argsDigest 一致 / 未过期；任一不符作废并告知。

### 3.3 启动不确定态（方案 B：unknown 人工介入，P0 锁定）

> V2 原稿的"start 幂等键"实为不存在的能力（RunApplicationService/WorkflowEngine/RunManifest
> 均无 idempotencyKey），不能假装可复用。P0 采用最小安全策略：

- `RunLaunchAttempt` 状态机：`launched → linked（成功回填 runId）| unknown`。
- 启动后进程崩溃/超时且无法确认 → `unknown`：**禁止自动重试**，告警审计并等待人工核对
  （人工比对 `.pi-workflows/runs/` 后手动标记 linked 或作废）。
- 不保证自动恢复，但**避免盲目重复执行**——exactly-once 落在真实机制而非文档承诺。
- **方案 A（后续升级路径）**：执行服务支持幂等键并可查回 Run（需同步修订 RunApplicationService/
  WorkflowEngine/RunManifest 三处）；P0 验证 Agent 价值后再立项，不提前重构。

## 4. 消息处理状态机与恢复协议（含原始消息快照）

现有 `MessageInbox.accept()` 收到即持久化去重键 = **received ≠ processed**；且仅记 messageId
不足以恢复（无原始内容，恢复不了只是"知道丢了任务"）。修正：

- `inbox-journal.jsonl`：`{channel, messageId, userId, text, receivedAt, state:
  received|processing|completed|failed, agentTurnId?, updatedAt}`——**完整入站消息快照**。
- **启动恢复**：服务启动时从 Journal 取未完成（received/processing）消息重新入队处理，
  **不等消息重新通过旧 Inbox 去重**（去重键已存在会挡掉它）。
- 恢复前检查关联：Agent Turn 状态 / PendingAction / RunLaunchAttempt。
- **存在不确定副作用的恢复消息禁止重调 Agent 生成新执行决策**——只允许查状态类操作或告警。
- AM-6 幂等验收必须含 kill -9 异常恢复路径（正常去重通过不算数）。

## 5. 异步 Run 结果衔接（后续 Turn 不靠模型记忆）

三契约（§2.2 已含前两条）+ 第三条：

- `RunMonitor` 在 Run 终态时写 `run-links.jsonl`：`{runId, taskBindingId, agentTurnId, conversationId,
  status, resultSummary, resultRef(产物路径)}`——可恢复执行关联。
- 后续 Turn 的 `task_status` 工具读此关联返回**真实结果与产物引用**；Agent 引用"刚才的总结"时
  必须先查再答，禁止编造。
- P0 不做"Run 完成自动唤醒 Agent"（AM-P1）。

## 6. 双层 Token 预算

| 层 | 时机 | 机制 |
|---|---|---|
| 累计预算 | Turn 开始前检查；结束后按实际 usage 入账 | BudgetTracker 现有体系扩展 |
| **单 Turn 硬限** | 执行中实时 | 最大 LLM 请求次数（缺省 12）/ 最大工具调用次数（缺省 20）/ 最长运行时长（缺省 5 分钟）；可读实时 usage 时按剩余预算中止，预留 20% 超额容差；超限安全停止**不影响已启动 Workflow** |

## 7. 任务拆解（顺序执行，每任务一 commit；T1 先行独立交付）

| 任务 | 内容（V2 增补加粗） | 验收锚点 |
|---|---|---|
| T1 契约与 Fake（先行） | §2~§6 全部类型 + `FakeAgentSession` + **TaskControl Facade 接口** + **run-link/inbox-journal 契约** + **PendingAction 状态机纯逻辑单测** | 状态机全转换路径单测绿；agent-host 不 import gateway |
| T2 AgentHost | Session 生命周期 + **同用户消息排队（单活动 Turn，§2.1 锁定语义）** + **重启恢复** | 单测：同用户两条消息排队串行且顺序正确；重启后 Session 恢复 |
| T3 五工具 | 按 T1 契约实现（registry.all/search、RoutePlan 直调、Facade） | 每工具正/负例；结果可被 LLM 继续决策（结构化） |
| T4 PendingAction | §3 全量：快照/原子认领/幂等确认/**方案 B 不确定态（unknown 禁自动重试+告警）** | 并发确认只一个 Run；重复确认返原始结果；kill -9 重启进入 unknown 不盲目重启动 |
| T5 启动关联 | **RunLaunchAttempt 三阶段（§2.3）：启动前预写 attempt → 成功后 TaskBinding（不变）→ run-links 回填** | 崩溃注入：启动后回填前 kill → 恢复标记 unknown+人工核对，不重复启动 |
| T6 双层预算 | §6 | 超 Turn 硬限安全停，已启 Run 不受影响 |
| T7 WechatApp | routingMode 分支 + **inbox-journal 接线** + legacy 隔离 | legacy 零变化回归；agent 分支处理状态可恢复 |
| T8 CLI | `--routing-mode` | 冒烟横幅 |
| T9 测试 | 全量回归 + §8 真机 + **真实 LLM Tool Calling + 故障注入** | AM-1~AM-14 |

## 8. 测试矩阵

### 单测

T1~T8 锚点全绿；PendingAction 状态机全路径；故障注入（kill -9 窗口）覆盖 §3.3/§4/§5。

### 真机手动用例（`--routing-mode agent`）

| # | 用例 | 预期 | 对应验收 |
|---|---|---|---|
| AM-1 | 含糊中文路由（**可控测试网页**，勿用 example.com） | search→execute 受理回执 | 验收 1 |
| AM-2 | 连续指令"刚才那个再翻译成英文" | 上下文复用真实结果 | 验收 2 |
| AM-3 | 两任务分别查进度 | 不混淆 | 验收 3 |
| AM-4 | 授权协议（**预注册无害 write 测试流程**） | 确认→启动；不确认过期 | 验收 5 |
| AM-5 | 诱导 LLM 自授权 | 无法绕过 | 验收 5 |
| AM-6 | 重复消息幂等（**含 kill -9 异常恢复**） | 单次执行 | 验收 4 |
| AM-7 | 模型故障 | 报错不重路由不重复启动 | 验收 4 |
| AM-8 | **并发批准同一 PendingAction** | 只一个 Run | 幂等 |
| AM-9 | **启动后绑定落盘前崩溃** | 恢复不盲目重启动 | 幂等 |
| AM-10 | **同用户两消息同时到达** | 串行无并发冲突 | 串行化 |
| AM-11 | **超调用次数/预算** | 安全停止，已启 Run 不受影响 | 硬限 |
| AM-12 | **查询他人 runId** | 拒绝不泄露 | 归属 |
| AM-13 | **多个待审批项并存** | 明确选择不误批 | 授权 |
| AM-14 | **引用已结束任务结果** | 取真实产物再继续 | 衔接 |

### 基线对照与观测指标（后续投入决策依据）

除 AM-1~AM-14 功能/安全用例外，**必须留存真实 LLM 的工具调用轨迹**（每 Turn 的工具序列、
参数、结果、耗时），并对比 legacy/agent 双模式（同批输入，legacy 基线 = routing-samples 评测
现成数据）：

| 观测指标 | 含义 |
|---|---|
| 任务成功率 | 正确选择并完成 Workflow 的比例（核心：Agent 是否真比旧 IntentRouter 更能理解需求） |
| 延迟 | 端到端响应与工具链耗时 |
| Token 消耗 | 含主 Agent Loop 与工具内 LLM 调用 |
| 人工干预次数 | 授权确认/纠错/恢复介入次数 |

**这四项数据决定是否继续投入 AM-P1/AM-P2**（评审结论，作为执行报告必答项）。

## 9. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| Agent Loop 时延 | 受理回执先行 + Outbox 异步 | routingMode=legacy 一键回退 |
| Session 膨胀 | 轮次上限（50）+ 单用户单 Session（TTL P1） | 重建 sessions/ |
| SDK usage API 偏差 | T6 核对 AgentSession usage 事件 | 估算值+审计告警 |
| 状态机复杂度引入新 bug | T1 纯逻辑先行 + 全路径单测 + 故障注入 | 各 jsonl 独立可清 |

## 10. 交付物

1. 代码（§1 目录）+ 149+ 与新增 AM 单测全绿。
2. `AM-P0-执行报告.md`：V2 验收链路逐项证据（**微信 NL → Agent 判断 → 多工具 → 真实结果 →
   理解后续消息 → 可靠继续；不重复执行、不绕授权**）+ §8 四项观测指标对比 + 遗留问题。
   **表述约束（必须保留）**：方案 B 保证的是"启动结果不确定时不自动重复执行"，
   **不是严格 exactly-once**——不得把安全停止（unknown 人工介入）误表述为自动恢复成功。
3. 手动测试指南（AM-1~14）并入 guides/；进度日志同步；经验沉淀。

## 11. 明确不做（AM-P1+）

Plan Mode/update_plan、Run 完成自动唤醒 Agent、会话 summary/TTL 完整策略、pi-jev、subagent 编排、
Web/CLI 入口 agent 模式。

## 12. 引用

- V2 报告：dev-docs/planning/AgentManager/可行性报告-OhMyGame架构接入.md（865edfd）
- 现有 API：src/dispatch/registry.ts（all/search）、task-control.ts（自然语言接口——P0 不动）、
  gateway/message-inbox.ts（received 语义）、run-monitor.ts
- 外部评审意见（2026-10-21，五项 P0 修正已全部融入）
