# 微信智能 Workflow 调度系统 — 需求文档（V1.0）

> 文档类型：产品与系统需求（PRD / Requirements）  
> 状态：需求基线，供后续编写执行文档与技术设计；**本文件不包含具体实现任务拆分**  
> 日期：2026-10-20  
> 主项目：[`mickorz/pi-agentic-workflow`](https://github.com/mickorz/pi-agentic-workflow)  
> 参考组件：[`shenjiecode/pi-wechat-assistant`](https://github.com/shenjiecode/pi-wechat-assistant)、[`iamaamir/pi-bifrost`](https://github.com/iamaamir/pi-bifrost)

## 1. 项目背景与目标

### 1.1 背景

`pi-agentic-workflow` 已具备 JS Workflow 执行、Agent 子会话、编排原语、运行事件、Journal/Resume、Checkpoint 与应用服务接口。希望让用户不再通过 CLI 或网页手动指定 workflow 脚本，而是直接向微信 Bot 描述需求，由系统自动理解、匹配并执行已注册的 Workflow；执行中的 Agent 按任务难度、成本与模型可用性自动选择模型。

本项目将三个不同职责组合起来：

- **微信通信**：优先借鉴/复用 `pi-wechat-assistant` 的 iLink 通信与会话管理能力。
- **Workflow 选择**：新增自然语言意图识别与 Workflow Registry，负责“该执行哪条工作流”。
- **模型选择**：参考 `pi-bifrost` 的 tier 分类、模型池、选择策略与健康过滤，负责“某个 Agent 节点使用哪个模型”。
- **可靠执行**：复用 `pi-agentic-workflow`，负责“如何执行、验证、审批、恢复”。

### 1.2 V1 目标

1. 通过**一个扫码绑定的个人微信账号**发送中文自然语言任务，启动已注册的 Workflow。
2. 能区分普通聊天、执行任务、查询状态、取消任务、审批、参数补充和无法匹配等意图。
3. 用户不需要知道 JS 文件名或 `runId`；系统可根据上下文处理当前任务，存在歧义时主动澄清。
4. Workflow 内的不同 Agent 节点可自动选择不同成本/能力等级的模型，并记录实际选择结果。
5. 长任务脱离微信请求生命周期执行，支持状态查询、结果通知、失败定位、人工审批和中断恢复。
6. 模型路由、Workflow 路由和微信通信都通过明确的适配接口与执行核心解耦。

### 1.3 非目标（V1 不做）

- 不由用户的一句话自动生成并执行任意新 JS Workflow；仅允许运行管理员预先注册、审核的 Workflow。
- 不做公开 SaaS、多租户计费、多客户微信账号同时接入。
- 不以网页管理后台为前提；已有 Web 能力可复用，但不是 V1 交付条件。
- 不承诺微信会话永久有效或任意时间均可主动发送消息。
- 不实现任意模型失败后无条件重放执行，不承诺外部副作用 exactly-once。
- 语音、图片、多文件自动理解、群聊、多渠道接入放在后续版本；V1 以文本为核心，允许保留附件扩展字段。

## 2. 现有基础与兼容性边界

| 组件 | 已确认的能力 | 本项目处理方式 |
|---|---|---|
| `pi-agentic-workflow` | `createWorkflowEngine`、`RunApplicationService`、Checkpoint、Journal/Resume、事件、JS DSL | 保持现有运行时为执行核心，不再另建编排引擎 |
| `pi-wechat-assistant` | Pi Extension；iLink 登录/长轮询/发送消息，队列、会话状态、用户绑定、文件支持 | **不能假设 npm 安装后即可在独立 SDK 服务中直接调用**；需验证 Extension 集成或复用协议模块 |
| `pi-bifrost` | Pi Extension；`quick/general/frontier` tier、规则/分类器、模型池选择、健康回避、`bifrost/auto` | **不能假设子 Agent 的 `createAgentSession()` 自动使用其路由**；需进行 SDK 兼容验证并预留策略适配 |

仓库检查时，远端 `pi-agentic-workflow` `master` 已包含 V2-P0 应用服务层，Worker/HTTP-SSE 等功能在该版本文档中仍是后续事项。若实际开发分支已经完成，应以该分支现状和回归测试为准；不应仅凭旧需求文档判断未实现。

**架构原则**：Pi Extension 能否直接共用只是实现路径问题；对外暴露的 `BotAdapter`、`WorkflowRouter`、`ModelRouter`、`WorkflowDispatcher` 契约必须稳定。

## 3. 用户场景与交互规则

### UC-01 自然语言直接执行

用户：“帮我分析 `https://github.com/owner/repo` 的技术风险。”

- 系统识别任务类型，选择 `github-review`。
- 提取 `repoUrl` 与分析重点，校验参数及用户权限。
- 若允许立即执行，受理并回复 `runId`/任务名称；后台执行后通知结果。

### UC-02 参数缺失

用户：“帮我分析一个 GitHub 项目。”

- 命中候选 Workflow，但缺少必填仓库地址。
- Bot 追问“请提供仓库 URL”，保存待补参数；下一条消息补充后继续同一请求，不重新猜测完全不同的意图。

### UC-03 多轮引用上次任务

用户：“刚才那份审查报告再整理一下。”

- 优先定位该用户最近且符合上下文的已完成任务和产物。
- 匹配 `report-generation`，只读取有权访问的前序结果。
- 有多个“刚才的任务”时列出可辨认选项，不擅自决定。

### UC-04 任务控制

用户：“进度怎么样？”、“取消刚才的任务”、“批准这次发布”。

- 命中任务控制意图，不触发新的 Workflow。
- 查询或操作归属当前用户的任务；危险动作需识别具体 `runId`，涉及审批的必须携带正确的 Checkpoint/version。

### UC-05 无匹配和普通聊天

用户：“你好”、“介绍一下向量检索”，或请求一个尚未注册的自动化流程。

- 普通聊天交给 Chat Agent（如启用）；未支持的执行类请求明确告知不支持。
- **禁止**将低置信度、无匹配的请求强行映射到某个可写 Workflow。

### UC-06 节点级自动选模

一个 GitHub 审查 Workflow 内，“目录收集”走 `quick`、“架构分析”走 `general`、“安全审查”走 `frontier`；最终采用由路由器返回的真实物理模型 ID 执行，并留下可追溯决策记录。

## 4. 目标逻辑架构

```text
微信用户
   │
   ▼
WeChat Bot Gateway / BotAdapter
   │  消息认证、轮询、去重、回执、发送
   ▼
Conversation & Task Context
   │  当前意图、槽位参数、关联 runId、审批上下文
   ▼
Intent / Workflow Router
   ├─ 普通聊天 ──► Chat Agent（可选）
   ├─ 任务控制 ──► Task Control Service
   ├─ 澄清追问 ──► 微信回复
   └─ 执行任务
        ▼
Workflow Registry + Schema / Permission Guard
        │
        ▼
Workflow Dispatcher ──► RunApplicationService / WorkflowEngine
                                    │
                                    ▼
                              JS Workflow DSL
                                    │
                              Agent 节点请求
                                    ▼
                              ModelRouter
                                    │
                  Bifrost tier/rule/pool/reliability policy
                                    │
                                    ▼
                           PiAgentAdapter
                                    │
                             物理 LLM 模型

RunEvent / Checkpoint / Result
   ▼
Task Store + Notification Outbox
   ▼
WeChat Bot Gateway ──► 微信进度、审批、结果回复
```

此为逻辑职责，不规定必须拆成多少进程或 npm 包。

## 5. 需求优先级与规范用语

- **P0（MVP 必须）**：没有它无法形成安全、可测试的“微信 → Workflow → 模型 → 结果”闭环。
- **P1（可靠交付必须）**：实际长期使用所需的可恢复性、任务控制和反馈能力。
- **P2（后续迭代）**：扩大渠道、用户群和复杂度。
- “必须”代表验收条件；“应”代表推荐但允许有记录的替代方案。
- 下面采用接近 EARS 的触发条件表达：**当……时，系统必须……**。

## 6. 功能需求

### 6.1 微信通信与 Gateway（WG）

**WG-001 [P0]** 当用户发来文本消息时，Gateway 必须将其转换为统一消息格式：`channel`、`messageId`、`userId`、`conversationId`、`text`、`receivedAt`，并向上游交付。

**WG-002 [P0]** 当消息来源不是已绑定/授权用户时，系统必须拒绝执行，并不得暴露 Workflow、任务结果和本地文件。

**WG-003 [P0]** 当相同 `channel + messageId` 重复到达时，系统必须幂等处理，不得重复启动 Workflow 或重复提交审批决策。

**WG-004 [P0]** 当消息进入执行队列时，系统必须尽快确认受理；不得阻塞微信消息接收直到长任务完成。

**WG-005 [P0]** 当发送消息失败、会话失效或微信服务器拒绝推送时，系统必须记录失败并保留查询入口，不得将未送达显示为已通知。

**WG-006 [P1]** 当微信连接重启时，系统必须在认证状态允许的情况下恢复轮询游标/去重状态；不得无依据假定已收到的消息全部重发或全部丢失。

**WG-007 [P1]** 当用户主动停止 Bot 时，系统必须关闭 Gateway 接收，但不得把“停止 Bot”和“取消全部 Workflow”视为同一动作。

**WG-008 [P2]** 当更换微信接入实现或新增其他 IM 时，路由器和 Runtime 不应修改业务逻辑，仅适配新的 BotAdapter。

### 6.2 Workflow Registry（WR）

**WR-001 [P0]** 每条可执行 Workflow 必须拥有稳定 `id`、名称、描述、脚本路径、输入 Schema、示例话术及风险等级；可额外定义标签、所属项目、默认模型策略与允许用户。

**WR-002 [P0]** 只有管理员显式注册、启用并且路径属于允许目录的 Workflow 才能被路由和执行；LLM 生成的路径不得作为执行目标。

**WR-003 [P0]** 当注册 Workflow 时，系统必须验证唯一 ID、元数据完整性、脚本存在性与 Script/Schema 基本有效性；错误项不得进入可用注册表。

**WR-004 [P0]** 当 Registry 增减 Workflow 时，候选搜索必须基于最新有效注册表，不依赖在系统提示词中手工追加每条脚本全文。

**WR-005 [P1]** 当运行中的 Workflow 脚本或元数据被修改时，已有 Run 及其 Resume 必须继续遵守既有脚本/参数哈希限制；不允许悄然按新版本恢复旧 Run。

**WR-006 [P1]** 必须支持 Workflow 的禁用和权限撤销；已禁用项不得再接受新任务。既有 Run 的处置策略需明确且可审计。

### 6.3 意图识别与 Workflow 路由（IR）

**IR-001 [P0]** 当接收到普通微信文本时，系统必须首先将意图归类为 `chat`、`execute_workflow`、`clarify`、`task_control`、`unsupported` 中的一种，并输出结构化结果。

**IR-002 [P0]** 当意图是 `execute_workflow` 时，系统必须从 Registry 检索候选项，再结合用户消息与候选元数据判断最佳匹配；不得把全部 JS 源码直接交给模型执行决策。

**IR-003 [P0]** 路由结果必须包含 `intent`、`workflowId?`、`args?`、`confidence?`、`missingFields?`、`reason?`；所有字段均须服务端验证，不得因“模型返回有效 JSON”即视为可信。

**IR-004 [P0]** 当候选缺失、置信度不足或多个候选难以区分时，系统必须澄清或告知不支持，不得默选一个高风险 Workflow。

**IR-005 [P0]** 当匹配项必填参数缺失时，系统必须生成针对缺失参数的追问，并将已确认参数保存在会话状态中。

**IR-006 [P0]** 当收到参数补充消息时，系统必须优先处理已存在的待补参数任务；允许用户显式退出、重置或切换任务。

**IR-007 [P0]** 当 LLM 输出的 `workflowId` 不存在、参数不符合 JSON Schema 或用户无权调用时，系统必须拒绝调度。

**IR-008 [P0]** 当用户请求“查询、取消、批准、拒绝、恢复”等任务控制操作时，系统必须走 Task Control，而不是将其作为一个新的任意 Workflow。

**IR-009 [P1]** 当同一个用户存在多个可能指代的任务时，系统必须让用户选择具体对象；不得默认取消、审批或恢复不确定的 Run。

**IR-010 [P1]** 系统应允许定义可配置的候选检索、最低置信度、歧义判定和降级策略；检索方式初期可为关键词/描述，后续可增加 BM25 或向量检索。

### 6.4 工作流执行与任务控制（EX）

**EX-001 [P0]** 当经过 Schema、路径和权限校验的请求被接收时，系统必须通过现有 `RunApplicationService.start()` 或等效已有统一入口启动 Workflow，不得自行实现一套替代执行引擎。

**EX-002 [P0]** 每次新任务必须生成或获取稳定 `runId`，持久化 `userId/conversationId/workflowId/runId/args/status` 关联关系。

**EX-003 [P0]** 当 Workflow 运行时，消息收发服务必须允许继续接收其他消息；运行不得绑定单个微信回调或 TUI Turn 的生命周期。

**EX-004 [P0]** 当任务完成、失败或取消时，系统必须记录真实终态；不能仅因 Bot 收到正常 HTTP/IPC 应答就判定成功。

**EX-005 [P1]** 当用户查询任务状态时，系统必须读取真实 Run 状态，区分 `queued/running/completed/failed/cancelled/waiting_checkpoint/interrupted` 等适用状态，并兼容执行层实际支持的状态集合。

**EX-006 [P1]** 当用户申请取消任务时，系统必须核验目标任务的归属与当前状态，调用现有取消接口；不得误取消其他用户或其他 Run。

**EX-007 [P1]** 当出现 Workflow Checkpoint 时，系统必须向对应用户展示审批内容及任务标识；只有用户明确同意且校验版本/权限通过后才能审批。无回复不得默认通过。

**EX-008 [P1]** 当用户拒绝 Checkpoint 时，系统必须按现有 Runtime 的拒绝语义停止，不能通过 fallback 绕过。

**EX-009 [P1]** 当执行中断后请求恢复时，系统必须沿用既有 Journal/Resume 以及哈希校验；涉及潜在重复副作用时必须显式确认，不得自动补签确认。

**EX-010 [P1]** 当已有服务具备并发上限与资源限制时，Dispatcher 必须遵守该限额，超限须排队或明确反馈，不能无上限创建 Agent/Run。

### 6.5 模型路由（MR）

**MR-001 [P0]** 系统必须有与 Pi TUI 无关的 `ModelRouter` 契约，输入至少包含 `prompt`、`workflowId`、`nodeId`、`phase?`、`preferredTier?`、`explicitModel?`，输出实际物理 `provider/modelId`、`tier`、选择来源和理由。

**MR-002 [P0]** 模型路由必须支持至少 `quick`、`general`、`frontier` 三个能力等级；每个等级的模型池由用户配置，仓库不得偷偷固定某家供应商。

**MR-003 [P0]** 当 Agent 节点明确指定有效物理模型时，必须优先使用该模型；当节点仅指定 tier 时，必须在相应允许模型池内选择；否则使用 Workflow 策略或自动分类/默认 tier。

**MR-004 [P0]** 当模型不可用、未授权或不在允许模型池时，系统必须提供可解释的降级/失败结果，不得静默使用未授权模型。

**MR-005 [P0]** 当同一 Workflow 含不同难度节点时，ModelRouter 必须允许它们使用不同物理模型；不能只在整个 Run 开始时选择一次模型并强制贯穿全部节点。

**MR-006 [P0]** 当选择实际模型后，执行层必须将其传给已有 Pi Agent 适配器；运行记录至少能对应 `nodeId → requestedTier → actualModel → routeSource`。

**MR-007 [P0]** 集成之前必须验证 Bifrost Extension 在独立 `createAgentSession()` 下的加载和路由行为。若不满足，必须通过策略适配器复用其选模思想/可复用模块，而不是为了兼容强制重构 Workflow Core。

**MR-008 [P1]** 当启用自动分类器时，分类器只负责选 tier，不得绕过 Registry 选模型、工具权限或 Workflow 的安全策略。

**MR-009 [P1]** 当模型因失败被健康过滤时，路由器可以影响**后续新节点或新请求**的选择；对已执行且有副作用的节点不得自行换模重放。

**MR-010 [P1]** 当恢复已部分完成的 Run 时，必须保留/重放既有路由决策，避免同一执行节点仅因模型池配置变化产生不可解释的 Resume 行为；实际选择及调用身份要可追溯。

**MR-011 [P1]** 模型路由应记录耗时、Tokens、成本、选模原因与候选失败原因；可配置运行级或用户级预算上限，超预算时拒绝或等待明确确认。

**MR-012 [P1]** 应支持节点级路由策略覆盖（例如声明 tier），但保持已存在的 `agent({model})` 接口兼容；不得无迁移方案破坏历史 Workflow 脚本。

### 6.6 多轮会话与上下文（CV）

**CV-001 [P0]** 系统必须区分微信聊天会话、待补参数请求与 Runtime Run；它们不能都依赖同一个 Pi Agent 的内存上下文。

**CV-002 [P0]** 当用户完成一个参数槽位后，系统必须保存解析后的值，并在该任务结束、取消或超时后清理待补状态。

**CV-003 [P0]** 当用户问“刚才那个任务”时，仅在目标唯一且可确认时才自动关联；存在多个候选时追问。

**CV-004 [P1]** 服务重启后必须能够恢复用户与 Run 的映射、待处理通知和待审批元数据；允许丢弃无必要的完整聊天历史，不得丢失关键任务关联。

**CV-005 [P1]** 会话上下文必须设置保留期限、存储边界和数据清理机制；不得无期限将所有微信明文、文件、密钥写入日志。

### 6.7 结果通知与可观测性（NT）

**NT-001 [P0]** 当任务被接受时，Bot 必须返回可识别的任务标识、Workflow 名称和初始状态。

**NT-002 [P0]** 当任务成功时，Bot 必须尝试发送简要结论及结果获取方式；若产物超过微信文本限制，必须拆分摘要或提供安全的产物访问方式。

**NT-003 [P0]** 当任务失败时，Bot 必须向用户反馈可理解的失败概要，内部保留 `runId`、节点及错误详情以供排查。

**NT-004 [P1]** 通知必须使用持久化 Outbox 记录待发送、已发送、失败和重试状态；“工作流成功”与“微信消息送达”必须分别记录。

**NT-005 [P1]** 必须支持根据真实 Runtime Event/Journal 查询执行历史，并可按 `runId` 关联意图识别、Workflow 路由、模型路由与通知记录。

**NT-006 [P1]** 当微信不可推送时，用户发送“任务列表/查看任务”仍必须能够取回结果，不依赖主动通知一定到达。

### 6.8 权限、风险及数据安全（SC）

**SC-001 [P0]** Bot 只允许已认证绑定用户访问；执行目标仅能来自经过授权的 Registry；脚本目录、工作目录、文件参数需经过路径白名单及规范化检查。

**SC-002 [P0]** Workflow 必须标注风险等级，至少为 `read-only`、`write`、`external-side-effect`；写入、发布、删除、发送外部内容等高影响动作必须遵守明确的授权/审批规则。

**SC-003 [P0]** 微信消息、仓库文本与文档内容均属于不可信输入；不得直接作为系统指令覆盖注册表、权限、模型路由边界或执行策略。

**SC-004 [P0]** 认证 token、微信会话凭据、模型密钥不得进入 LLM 提示词、明文业务日志、测试样例或微信回复。

**SC-005 [P1]** 对调用频率、并发、单 Run 资源和模型成本设置可配置限额；对超限情况提供明确状态。

**SC-006 [P1]** 系统必须记录所有高风险审批的操作者、目标、决策、版本和时间，供审计与故障复盘。

**SC-007 [P1]** 当个人微信/iLink 通道不可用或失去授权时，必须可停用 Gateway，不得因此破坏 Runtime 中已有任务与持久化数据。

## 7. 核心数据契约（逻辑要求，非最终实现类型）

### 7.1 Registry 项示例

```json
{
  "id": "github-review",
  "name": "GitHub 项目审查",
  "description": "分析仓库架构、代码质量与技术风险",
  "workflowPath": "./workflows/github-review/workflow.js",
  "examples": ["分析这个 GitHub 仓库", "检查这个项目的技术风险"],
  "riskLevel": "read-only",
  "inputSchema": {
    "type": "object",
    "properties": {
      "repoUrl": {"type": "string", "description": "GitHub 仓库 URL"},
      "focus": {"type": "string"}
    },
    "required": ["repoUrl"],
    "additionalProperties": false
  }
}
```

### 7.2 Intent Router 输出示例

```json
{
  "intent": "execute_workflow",
  "workflowId": "github-review",
  "args": {"repoUrl": "https://github.com/owner/repo"},
  "missingFields": [],
  "confidence": 0.94,
  "reason": "用户请求分析 GitHub 项目的风险"
}
```

`confidence` 仅是模型辅助信号，不是授权或安全证明；阈值与歧义策略为配置项。

### 7.3 Model Router 输出示例

```json
{
  "tier": "frontier",
  "model": "provider/strong-model",
  "source": "classifier",
  "reason": "安全风险审查属于高复杂度分析"
}
```

上述模型名为占位符，必须使用 Pi 中已配置且受允许模型池约束的真实物理模型。

### 7.4 最低限度的持久化实体

- `BotMessageReceipt`：消息 ID、来源、接收状态、去重键、处理结论。
- `ConversationState`：用户、对话、待补参数、当前目标任务、状态有效期。
- `WorkflowRegistration`：ID、Schema、权限、风险、脚本路径、状态及版本。
- `TaskBinding`：微信用户与 Run/Workflow/参数/结果的关联。
- `ModelRoutingDecision`：nodeId、tier、真实 model、决策来源、版本及时间。
- `NotificationOutbox`：目标用户、消息摘要、送达尝试、重试与最终状态。
- `AuditRecord`：高风险动作的确认、审批、取消、恢复与异常。

具体数据库、表结构和 IPC/HTTP 形式在执行文档中决定。

## 8. 模型选择的边界与优先级

从高到低：

1. **安全/权限硬约束**：模型必须可用、授权、在允许池中，且满足数据与工具权限规则。
2. **节点显式物理模型**：现有 `agent(..., { model })` 不允许被静默覆盖；明确标注“策略允许替代”时才可变更。
3. **节点指定 tier**：在对应池中按 Bifrost 策略选物理模型。
4. **Workflow 默认策略**：例如审计默认 `frontier`，结构化提取默认 `quick`。
5. **自动分类 / 默认 tier**：由规则、分类器或默认路由完成。

路由决策应发生在节点执行前，且为可追溯的输入；**Journal 的回放身份必须与实际模型选择策略保持一致**。不能在恢复时重新分类后把历史调用默默变成另一个模型，也不能仅在日志写 “auto” 而不记录实际模型。

Bifrost 适配优先考虑可复用的分类/模型池/健康过滤能力；不应假设对 `pi-bifrost` 内部 `index.ts` 的直接依赖存在稳定的服务端公共 API。若采用 fork/vendor，需要记录许可证、上游版本、升级和兼容策略。

## 9. 跨模块重要状态语义

### 9.1 一条微信消息与一个 Run 不是同一概念

- 微信投递可能重复；用户一个请求可能多轮补参数后才启动 Run。
- 一个用户可以拥有多个历史 Run，但 V1 并发执行数服从现有资源限额。
- 微信 `/stop`（停止当前 Pi 生成/桥接）与 Workflow `cancel(runId)` 是不同动作，系统必须分别定义命令。

### 9.2 Checkpoint 不等于完成

- `waiting_checkpoint` 必须在微信端明显提示“等待用户决策”。
- 回复“批准”只能作用于已确认的具体待审批项，不能授权任意后续执行。
- 审批消息重复、延迟、过期版本必须被幂等或拒绝处理。

### 9.3 完成不等于已送达

- Runtime `completed` 表示执行完成。
- 微信通知 `sent` 只表示发送 API 接受/返回成功，不无条件等价于用户阅读。
- 超出发送窗口或通道失效时，通过任务查询机制补偿。

### 9.4 恢复不等于自动重复

- 维持现有脚本/args 哈希和 Journal 行为。
- 外部副作用无法单凭 Journal 完全保证 exactly-once；风险恢复必须显式确认。
- ModelRouter 的模型变动不能绕过 Replay 一致性和工具副作用审批。

## 10. 非功能性要求

| ID | 优先级 | 要求 |
|---|---|---|
| NFR-001 | P0 | TypeScript/Node.js，兼容主项目 Node.js 运行环境，尽量复用现有 Pi SDK |
| NFR-002 | P0 | 运行时、路由器、Gateway 独立可测，可注入 Fake Bot、Fake LLM、Fake WorkflowRunner |
| NFR-003 | P0 | 接收消息不等待长任务完成；Workflow/路由超时、取消及上游失败须有界且可观察 |
| NFR-004 | P0 | 路由器不得执行不在 Registry 允许名单内的脚本，也不得按自然语言扩大运行权限 |
| NFR-005 | P1 | 关键任务元数据持久化，服务重启后能够查询并恢复任务，不依赖进程内 Map 为唯一事实来源 |
| NFR-006 | P1 | 尽量保留原 Workflow DSL、Runner API、Journal 与事件格式兼容，变更需单独说明迁移影响 |
| NFR-007 | P1 | 敏感数据最小化存储、按需脱敏、明确日志与文件保留/清理策略 |
| NFR-008 | P1 | 模型路由可审计，含选模规则/分类来源/耗时/Token/成本，不虚构模型质量与节省比例 |

## 11. 兼容性验证与验收（必测）

### 11.1 三方组件兼容性验证

- **C-01 微信**：验证真实个人微信能扫码绑定、向 Bot 发文本、接收回复；记录 iLink 授权失效、主动发送受限和断线恢复表现。
- **C-02 Extension 生命周期**：验证 `pi-wechat-assistant` 是否只能从 Pi Extension 上下文接入；如独立 SDK 不支持，验证通信 Adapter 解耦方案能工作。
- **C-03 Bifrost**：验证通过 `createAgentSession()` 的独立 Agent 是否实际加载 Bifrost 扩展并进行 `tier → 物理模型` 选择；对比显式 `model` 与 `bifrost/auto` 语义。
- **C-04 隔离**：验证多 Agent 子会话不会重复初始化微信 Bot，不发生共享账号锁冲突。
- **C-05 Runtime**：验证对现有 RunApplicationService、Checkpoint、Journal/Resume 不造成回归。

### 11.2 核心端到端验收矩阵

| 编号 | 测试输入或故障 | 预期结果 |
|---|---|---|
| A01 | “分析 https://github.com/owner/repo” | 找到 `github-review`、校验参数、启动 Run |
| A02 | “分析一下 GitHub 项目” | 仅追问 `repoUrl`，未补齐前不启动 |
| A03 | 下一条只给 URL | 合并待补参数，启动原 Workflow |
| A04 | “你好” | 进入 chat，不意外启动 Workflow |
| A05 | “帮我执行不存在的流程” | 明确不支持，不运行任意脚本 |
| A06 | 相同微信 `messageId` 重复两次 | 只创建一个 Run，不重复审批 |
| A07 | 篡改 LLM 输出 workflowPath/id | Registry/白名单校验拒绝 |
| A08 | 一个 Workflow 包含 quick、general、frontier 节点 | 节点分别按路由结果使用真实模型且有记录 |
| A09 | 指定 `agent({model})` | 显式模型优先，自动路由不静默覆盖 |
| A10 | 某模型不可用或故障熔断 | 在允许池内按策略降级或明确失败，不偷偷切未授权模型 |
| A11 | Workflow 请求 Checkpoint | 微信展示审批，未批准前绝不继续 |
| A12 | 重复审批、错误 version 或跨用户审批 | 幂等或拒绝，不会重复推进 |
| A13 | “进度如何/取消刚才任务” | 正确定位和操作当前用户 Run |
| A14 | 多个 Run 均可能是“刚才的” | 必须先澄清，不误取消或审批 |
| A15 | Workflow 成功，但微信发送失败 | Run 为 completed、通知为 failed/pending，可主动查询结果 |
| A16 | 执行中断后重启并恢复 | 按既有 Journal/哈希/副作用确认语义恢复 |
| A17 | 微信停止或断线 | Gateway 可恢复/重连；已有 Run 的真实状态不伪造 |
| A18 | 超过并发或预算上限 | 明确排队、拒绝或请求确认，不无限启动 |

### 11.3 量化验收建议

- 建立**至少 40 条**人工标注的中文路由样例，覆盖普通聊天、可执行、缺参、歧义、任务控制、越权/无匹配；Workflow 路由准确率目标 ≥90%。
- 对“未授权执行、重复消息触发重复 Run、错误审批放行、恶意脚本路径执行”等安全负向用例，**必须 0 通过性漏洞**。
- 输入 Schema 校验、权限校验、显式选模优先级和 Run 状态映射的确定性测试必须全部通过。
- 不把固定模型成本节省百分比作为第一版验收门槛；采集基线后再评估 Bifrost 带来的成本、质量和时延变化。

## 12. 交付边界（用于后续执行文档分阶段）

以下是**功能里程碑，不是实现步骤**：

- **M0 组件可行性**：真实微信收发、Pi SDK 与 Bifrost 自动模型路由兼容性、与 Runtime API 的集成路径得到实测结论。
- **M1 最小闭环**：Registry、自然语言路由、参数补齐、自动选模、单一真实 Workflow 的微信启动与结果查询通过端到端验收。
- **M2 可靠性闭环**：审批/取消、通知 Outbox、异常状态、中断恢复、审计、限额及回归测试通过。
- **M3 扩展（V1 外）**：附件、更多 Workflow、多用户/多账号、多 IM 通道、可视化管理和业务级分析。

后续执行文档需要为每个阶段确定代码变更点、兼容性验证方式、自动测试、手工实测、失败回滚与提交验收条件。

## 13. 风险与待决策问题

| 编号 | 风险/决策 | 建议约束 |
|---|---|---|
| D-01 | 微信个人号 iLink 服务/账号接入能力可能变化，非一般用途的稳定企业消息 API | V1 仅绑定自有测试账号；通信层可替换；不对外承诺 SLA |
| D-02 | WeChat Extension 与独立服务存在生命周期差异 | M0 实测；长期不让 Runtime 依赖 Pi TUI 常驻 |
| D-03 | Bifrost Extension 不一定自动作用于 `createAgentSession()` | M0 实测；准备独立 `ModelRouter` 策略适配 |
| D-04 | 不同节点动态选模可能影响 Journal/Resume 身份哈希 | 先明确决策冻结/回放契约，避免自动路由变化导致不可解释行为 |
| D-05 | 本地 Workflow 拥有读写与 Shell 工具能力，微信输入存在提示注入风险 | Registry 白名单、用户鉴权、工具权限及高风险审批是硬边界 |
| D-06 | 微信消息推送失败、窗口/上下文 token 过期 | 持久化 Outbox + 用户主动查询，结果与送达分离 |
| D-07 | 并发用户与资源竞争、模型费用不可控 | V1 单用户，Run/Agent/Token/成本限额；多租户单独立项 |
| D-08 | Fork/vendor 三方 MIT 代码的维护和升级 | 记录许可证、原始出处、固定版本、回归测试和上游差异 |

**需要执行文档显式锁定的选择：**

1. M0 是采用“现成 Pi Extension + 新工具”的集成验证，还是直接验证独立微信 Adapter；建议两者都做薄验证，以后者为长期目标。
2. 模型路由是使用 Pi `bifrost/auto` 完整扩展方式，还是抽取 Bifrost 的纯策略逻辑；必须以真实 SDK 行为为依据。
3. V1 是否只允许 `read-only` Workflow 自动执行；建议默认如此，对 `write` / `external-side-effect` 强制执行前确认。
4. Task/Conversation/Outbox 的持久化采用何种存储；建议优先低运维成本且支持原子更新的本地存储。
5. 默认聊天功能启用与否、路由置信度门限、待补参数 TTL、通知重试期限如何配置；需在实现前固化默认值。

## 14. Definition of Done（整体验收出口）

只有同时满足以下条件，才可认定 V1 完成：

- [ ] 真实微信能收发消息，且只接受绑定用户，去重有效。
- [ ] 能通过自然语言匹配已注册 Workflow，自动提取、追问并校验参数。
- [ ] 普通聊天、歧义、无匹配、越权不误触发 Workflow。
- [ ] 能启动真实 JS Workflow，并准确映射 Run/结果/事件。
- [ ] 每个 Agent 节点可以根据明确优先级选择模型，并记录真实模型。
- [ ] Bifrost 与 Pi SDK 兼容性得到实测结论，选定的接入方式通过回归测试。
- [ ] 查询/取消/审批/拒绝/恢复遵守既有 Runtime 的安全与状态语义。
- [ ] 微信通知失败不会丢失任务结果，断线后可主动查询。
- [ ] 关键路由、任务、模型选择和审批有可定位、可脱敏的审计记录。
- [ ] 自动化测试、真实微信手测、文档及回滚策略满足执行文档约定的验收门槛。

---

## 15. 参考资料

1. [pi-agentic-workflow](https://github.com/mickorz/pi-agentic-workflow)：`src/engine.ts`、`src/application/run-service.ts`、`src/adapters/pi/pi-agent-adapter.ts`、`docs/DSL.md`、`docs/architecture/V2-runtime-server.md`。
2. [pi-wechat-assistant](https://github.com/shenjiecode/pi-wechat-assistant)：`src/wechat/`、`src/bridge/`、`src/extension/`、`docs/architecture.md`。
3. [pi-bifrost](https://github.com/iamaamir/pi-bifrost)：`README.md`、`index.ts`、`routing.ts`、`config.ts`、`docs/guide/routing-controls.md`。
4. [Pi 官方 SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)：`createAgentSession`、`resourceLoader` 与扩展装载机制。

> 此需求文档定义要实现的行为与验收出口。执行阶段应首先完成三方兼容性实验，然后以实测结果确定模块复用或适配的方式。若与实际当前分支代码有差异，应先形成差异清单，不直接覆盖既有 Runtime 能力。
