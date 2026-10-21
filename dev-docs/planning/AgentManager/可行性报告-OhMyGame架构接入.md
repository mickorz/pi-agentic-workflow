# 可行性报告：OhMyGame 式 Conversational Agent 架构接入（V2 / AM-P0 架构决策版）

> 版本：V2（2026-10-21，按外部评审修订）· V1 见 git 历史
> 依据：thirdparties/ohmygame@a68ea48 源码 + Pi SDK 1.3.0 类型核对 + 外部评审意见（已融合为本文主体结论）
> 需求来源：《参考OhMyGame-agentmanager需求.md》
> 状态：**修订版，供 AM-P0 开发直接引用**；开工前置 = WX-PT 完成（含旧路由可复现基线锁定）
> 结论：**可行，分层叠加而非推翻**——新增 Conversational Agent 层，现有 Dispatcher/Runtime/TaskControl/Gateway 保留为工具与守卫。

## V1 → V2 修订摘要

| # | V1 说法 | V2 修正 |
|---|---|---|
| 1 | `update_plan` 是 Pi 内置工具 | **错**：OhMyGame 用 `defineTool()` 自研（agent-tools.ts:190-220）；需自行实现 Plan Tool 与状态持久化 |
| 2 | R7：write/external 遇审批"复用现有审批链"（未展开） | 补全**执行前授权协议**（PendingAction 独立状态，见 §三）；明确与 Run 内 Checkpoint 是两道门 |
| 3 | Agent 异常时 fallback 旧 IntentRouter | **废弃自动回退**：Feature Flag 整条入口切换（legacy/agent），进入 Agent 即负责到底（防双重执行） |
| 4 | 持久 Session 乐观（上下文自动延续） | 补全**会话与任务生命周期模型**（三 ID 绑定 + 两个完成事件 + 主 Agent Token 记账），Session ≠ 任务系统 |

## 一、技术可行性验证（修正版）

| 所需能力 | 验证结果 | 证据 |
|---|---|---|
| 持久化会话 | ✅ SDK 原生 | `SessionManager.create/.open`（session-manager.d.ts:371）；OhMyGame conversations.ts:46/108 同款用法 |
| 自定义工具注册 | ✅ SDK 原生 | `createAgentSession({ customTools })` + SDK 导出 `defineTool()`，无需 Extension 机制 |
| 消息排队/执行中追问 | ✅ SDK 原生 | `session.prompt()` + `followUp()`（OhMyGame agent.ts:789 实际调用） |
| 任务计划（Plan） | 🔶 **需自研** | `update_plan` 为 OhMyGame 自研 defineTool（agent-tools.ts:190-220）；SDK 仅提供工具注册能力，Plan 状态管理与持久化由宿主实现 |
| 工具白名单 | ✅ SDK 原生 | `allowedToolNames` / `excludedToolNames`（agent-session.d.ts:140-155） |
| AgentManager 生命周期 | ✅ 可精简移植 | 六组状态 Map（agent.ts:484-499）——**宿主必须自建**（见 §四），SDK 不代管 |

## 二、三层状态模型（不建第二套执行引擎）

| 层级 | 管理什么 | 主要状态 | 持久化 |
|---|---|---|---|
| **Agent Plan** | LLM 规划的**逻辑步骤** | pending / in_progress / completed | 自研（Plan Tool 状态文件） |
| **Workflow Run** | **实际工作流执行** | running / waiting_checkpoint / completed / failed / cancelled / interrupted | 已有（manifest/journal/checkpoints） |
| **Agent Session** | 多轮对话与上下文 | 会话、历史消息、关联任务 | SDK SessionManager |

关键约束：

1. **Plan ≠ Run**：Agent Plan 只是 LLM 的执行计划与进度展示，不替代 Workflow Run 的确定性执行（V1 已明确，此处强化）。
2. **Plan 步骤必须关联 runId**：从真实 Workflow 结果同步更新步骤状态，**不允许 LLM 自行宣称任务完成**——完成判定只来自 `workflow.run.completed` 事件。
3. 已有 Node/Run/Journal 状态的 Workflow Runtime 不重造；Plan 只做编排视图。

## 三、执行前授权协议（与 Run 内 Checkpoint 严格区分）

两道独立门禁，缺一不可：

| 门禁 | 时机 | 机制 | 状态 |
|---|---|---|---|
| **执行前授权** | `RunApplicationService.start()` **之前** | PendingAction（本节新增） | 见下 |
| **Run 内 Checkpoint** | Workflow 运行中阶段审批 | 已有 CheckpointService/TaskControl | 不变 |

执行前授权流程（Dispatcher.execute 现有校验链的扩展，非 Agent 特有——Agent 只是新调用方）：

```text
Agent/用户请求执行 Workflow
        ↓
Registry / Schema / 权限 / 风险等级校验
        ↓
是否 write / external-side-effect？
  ├─ 否（read-only）→ 启动 Workflow
  └─ 是 → 创建 PendingAction（持久化）
              ↓ 微信请求用户确认（复用通知/审计/确认交互）
              ↓ 用户明确批准（确定性审批直通，非 LLM 传入）
              ↓ 重校验：身份 / 参数 / 权限 / **有效期** / Registry 版本
              ↓ 全部通过 → 启动 Workflow
```

PendingAction 持久化字段：`actionId`（幂等键）、`userId`、`workflowId`、`args 摘要`、
`createdAt`、`expiresAt`、`status(pending/approved/rejected/expired)`。

硬规则：

- **LLM 永远不能传入 `authorized: true`**——授权只能来自用户确认消息（确定性通道）。
- 批准时**重校验全部前置条件**（两步间隔内 Registry/参数可能已变），过期即作废。
- 复用现有 TaskControl 服务接口、通知、审计与确认交互，但状态与 Run 内 Checkpoint 分开。

## 四、会话与任务生命周期（Session ≠ 任务系统）

SDK 只保存对话历史；任务绑定、消息队列、审批状态、异常恢复、结果回填由宿主协调
（OhMyGame 六组状态 Map 正为此存在）。AM-P0 确定三 ID 绑定：

```typescript
interface AgentTaskBinding {
  conversationId: string;   // 持久 Agent 会话（每用户一个）
  agentTurnId: string;      // 一次 Agent 轮次（一问一答 + 其间全部工具调用）
  workflowRunId: string;    // 被启动的 Workflow Run（一个 Turn 可启动多个）
}
```

两个完成事件，严格区分：

- `agent.turn.completed`：Agent 对话轮次结束（回复已发）——**不代表业务任务完成**
- `workflow.run.completed`：被启动的 Workflow 真正执行完成（Run 终态落盘）

推论：`workflow_execute` 采用**受理即返回**（防 Loop 阻塞）时，Agent 回复"已启动"后 Run 仍在跑；
业务任务的完成只能由 `workflow.run.completed` 驱动（通知/Plan 状态同步）。**不得因 Agent 回复完成
而标记任务完成。**

Token 预算：主 Agent Loop 本身的消耗必须记账（进入 MR-011 预算体系），不能只在 Workflow 启动时记账。

## 五、入口切换与回退规则（废弃自动 fallback）

```typescript
routingMode: "legacy" | "agent"   // Feature Flag，整条消息入口切换
```

- 一条消息**一旦进入 Agent 路径，由 Agent 负责到底**：失败返回错误或允许安全重试，
  **不得把原始消息重新交给旧 IntentRouter**（Agent 可能已启动任务，二次路由 = 双重执行）。
- 仅当能**确定尚未产生任何副作用**时，才允许自动降级。
- 旧链路保留作为回归基线（WX-PT 审批直通场景等），legacy/agent 可 A/B 对照。

## 六、工具契约要点

| 工具 | 契约要点 |
|---|---|
| `workflow_search` | **不得只照搬 Registry 关键词检索**：至少提供 (a) 完整能力清单列举（无过滤），(b) 关键词/描述候选发现；否则用户表达未命中关键词时 Agent 仍找不到目标——直接违背"智能路由"目标 |
| `workflow_execute` | 内部 = `dispatcher.execute()`（校验链不变）；read-only 受理即返 runId；高风险走 §三 授权协议；**不接受 LLM 传 authorized** |
| `task_status` | 按 runId/tb- 查询真实 Run 状态（EX-005 语义），多 Run 不混淆 |
| `task_cancel` / `task_resume` | 归属校验 + 现有 TaskControl 语义（resume 需副作用确认） |

## 七、AM-P0 范围与验收（修订）

范围（对 V1 的增补加粗）：

1. AgentHost + 持久化 Conversation Session（每用户一 Session）
2. 注册 workflow_search / workflow_execute / task_status 等工具（§六契约）
3. **确定性审批直通前置 + 执行前授权协议（§三）**
4. **AgentTaskBinding 三 ID 关联、幂等与状态回传（§四）**
5. **Feature Flag 入口切换，旧链路回归测试保留（§五）**
6. Dispatcher 权限与 Schema 校验原样复用

验收（不止"选对 Workflow"，五条全过）：

- [ ] 含糊中文自然语言 → 正确 Workflow + 自动抽参调用
- [ ] 同会话理解"刚才那个""换成另一个"等连续指令
- [ ] 启动两个 Workflow 后分别查询进度，不混淆 Run
- [ ] 模型失败 / 服务重启 / 重复消息 → **不重复执行副作用任务**
- [ ] 写入/外部操作执行前请求授权，未经授权绝不启动

前置：**WX-PT 完成**（Part B 真机 + 旧路由基线锁定，尤其审批直通场景）。

## 八、风险清单（V1 承接，R7 已升级为 §三协议）

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 成本（每条开放消息一次 Agent Loop） | 高 | MR-011 扩展至 Agent 层（§四 Token 记账）；短指令规则短路不进 Loop |
| R2 | 时延（多步任务分钟级） | 中 | 受理回执 + Outbox 异步通知（已有） |
| R3 | 工具面暴露 | 高 | allowedToolNames 硬白名单 + customTools 注册制 |
| R4 | 高危指令绕过守卫 | 高 | 确定性短路前置（B02 教训）+ §三授权协议 |
| R5/R6 | pi-orch 无 LICENSE / pi-jev 服务依赖 | 低 | 仅参考 / P2 再引入 |
| R7 | 授权与 Checkpoint 混淆 | ~~中~~→**已升级为 §三 协议** | PendingAction 独立状态机 |
| R8 | 会话上下文膨胀 | 中 | 会话 TTL/轮次上限/summary 重建（AM-P1） |

## 九、待决策项（V2 剩余）

1. Agent 主模型选型：独立配置项（缺省 settings.json 默认）——建议保持。
2. ~~IntentRouter 去留~~ → 已由 §五 Feature Flag 方案替代（P0 并存 A/B，P1 视稳定性退役）。
3. 会话粒度：每用户一持久 Session（§四 已按此设计，如需按任务拆分再议）。
4. ~~execute 同步语义~~ → 已定：受理即返（§四 推论）。

## 十、引用

- 《需求》：dev-docs/planning/AgentManager/参考OhMyGame-agentmanager需求.md
- OhMyGame：src/daemon/{agent.ts, agent-tools.ts, conversations.ts}（update_plan 自研证据：agent-tools.ts:190-220）
- Pi SDK 1.3.0：agent-session.d.ts（customTools/allowedToolNames/prompt）、session-manager.d.ts、index.d.ts（defineTool）
- 本项目：experience/deterministic-instruction-llm-routing-pitfall.md（§五/§三 依据）、dispatcher.ts（执行前校验链现状）
- 外部评审意见（2026-10-21，四项修正已全部融入）
