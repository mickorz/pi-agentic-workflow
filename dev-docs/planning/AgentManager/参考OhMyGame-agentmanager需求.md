我把 [WhiteTowerAI/ohmygame](https://github.com/WhiteTowerAI/ohmygame?utm_source=chatgpt.com) 的 Pi Agent 相关源码看了一遍。

我建议调整之前的技术方案：把 OhMyGame 作为主要架构参考，`pi-orch-extension` 参考复杂任务编排，`pi-jev` 则作为后续可选的语义工具检索组件。

因为 OhMyGame 解决的恰好是你现在缺少的东西：用户说一句自然语言，Agent 自己决定要做哪些事、调用哪些工具、怎样持续执行。&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



## 一、OhMyGame 是怎样处理任务的？

它没有使用你目前的五类 Intent → Workflow ID → 参数提取的单次路由模式。

它主要依赖 Pi SDK 已有的 Agent Loop，加上自己开发的 AgentManager、Tool、Plan 和会话管理。

用户输入自然语言

“帮我做一个塔防游戏”

AgentManager

管理会话、Turn、消息队列、取消及任务状态

Pi Agent Session

LLM 自主判断下一步行动

update_plan

生成及更新任务步骤

read / edit / write

读取、修改项目

generate_image

生成美术素材

game_use

操作游戏并验证

工具结果 → LLM 再决策 → 直到完成

实时更新计划、事件和界面

### 1. 用 AgentManager 处理会话和任务生命周期

源码：[src/daemon/agent.ts](https://github.com/WhiteTowerAI/ohmygame/blob/main/src/daemon/agent.ts?utm_source=chatgpt.com)

它的 `AgentManager` 维护了几组核心状态：

| 状态                 | 作用               |
| ------------------ | ---------------- |
| `#sessions`        | 当前对话的 Pi Session |
| `#activeTurns`     | 正在执行的请求          |
| `#planStates`      | 任务计划以及计划模式       |
| `#pendingPrompts`  | 排队等待处理的新消息       |
| `#steeringPrompts` | 执行中的用户干预         |
| `#approvals`       | 等待用户确认的操作        |

收到用户请求后，它复用对应的 Pi Session，然后调用 `session.prompt()`。

如果 Agent 还在执行，用户又发了一条新消息，系统可以使用 `session.followUp()` 排队，而不是简单拒绝。

这比你现在主要保存 `pendingPlan` 和最近任务 ID 的 ConversationStore 更完整。

### 2. 任务拆解是 LLM 自己决定的

源码：[src/daemon/agent-tools.ts](https://github.com/WhiteTowerAI/ohmygame/blob/main/src/daemon/agent-tools.ts?utm_source=chatgpt.com)

OhMyGame 注册了一个名为 `update_plan` 的 Tool。

其任务结构简化后大致是：

```
interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

interface PlanState {
  explanation?: string;
  steps: PlanStep[];
}
```

当 Agent 认为任务比较复杂，就调用 `update_plan` 来创建计划；完成一个步骤后，再调用工具更新状态。

它的系统提示词明确要求，多步骤任务应该维护计划，简单任务不需要。

这意味着 任务拆解主要由 LLM 决策，而不是靠提前把用户请求匹配到固定任务树。

### 3. 可以先规划，再审批执行

OhMyGame 还有一套 Plan Mode 状态：

```
type PlanMode =
  | "normal"
  | "planning"
  | "awaiting_approval"
  | "executing";
```

用户可以先让 Agent 规划，看到完整方案后再审批、要求修改或者取消。获得批准后，Agent 才进入执行模式。

相关实现位于 `AgentManager.approvePlan()`、`refinePlan()`、`cancelPlan()`。

这里有个容易混淆的细节：它的 PlanStep 主要是 Agent 的执行计划和进度展示，并不等同于你已有的持久化 Workflow Run、Node、Journal 和 Resume。

所以你不应该用 OhMyGame 的 Plan 系统替换自己的 Workflow Runtime。两者正好可以互补。

### 4. 完整保存对话上下文

源码：[src/daemon/conversations.ts](https://github.com/WhiteTowerAI/ohmygame/blob/main/src/daemon/conversations.ts?utm_source=chatgpt.com)

它使用：

```
SessionManager.create(...)
SessionManager.open(...)
```

创建并恢复持久化 Pi Session。

因此用户第二句话说“把刚才那个方案改成竖屏游戏”，Agent 可以利用之前的聊天上下文继续工作。

你当前的 `PiAgentAdapter` 使用单次 `SessionManager.inMemory()`，并在执行结束后释放。它适合隔离 Workflow 子 Agent，却不适合作为微信聊天的长期主 Agent。

## 二、三个开源项目应该分别学习什么？

| 项目                | 最值得学习                                             | 建议用途               |
| ----------------- | ------------------------------------------------- | ------------------ |
| OhMyGame          | 常驻 Pi Session、AgentManager、Tool Calling、Plan、消息队列 | 主要架构参考             |
| pi-orch-extension | 子 Agent 委派、角色分工、Goal Mode、验证循环                    | P2 以后参考            |
| pi-jev            | 语义工具发现、动态激活工具                                     | Workflow 数量增加后评测引入 |

这次源码检查还发现两个集成注意事项：

`pi-jev` 需要 TypeSafe Jev 服务或兼容端点。它的 `ToolRouter` 在服务不可用时，会回退到关键词候选检索，但不会自动激活候选工具。因此它不能无条件替代你的路由系统。

`pi-orch-extension` 当前使用 `@mariozechner/pi-*` 包，而你的项目和 OhMyGame 使用 `@earendil-works/pi-*`。需要先确认版本与扩展 API 的兼容性。另外，它的仓库根目录没有发现明确的 LICENSE 文件，建议先作为源码参考，不直接复制代码。

## 三、接下来应该怎么改造你的项目？

我建议保留你已经开发完成的可靠 Workflow Runtime，把它接到 OhMyGame 式的主 Agent 下面：

微信 / Web / CLI

Conversational Agent（新增）

持久 Session + Tool Calling + Plan

Workflow Tools（新增）

search / execute / status / cancel / resume

现有 Dispatcher + Workflow Runtime

权限、确定性执行、审批、Journal / Resume

### 第一阶段：先引入三个参考仓库

你现有 `thirdparties/` 使用 Git Submodule，可以继续沿用：

```
git submodule add https://github.com/WhiteTowerAI/ohmygame.git thirdparties/ohmygame

git submodule add https://github.com/TheoOliveira/pi-jev.git thirdparties/pi-jev

git submodule add https://github.com/AryanBhargavprojects/pi_ORCH_Extension.git thirdparties/pi-orch-extension
```

提交时固定各 Submodule 的 Commit，保证后续方案和测试都对应同一套代码。

### 第二阶段：按三个可验收阶段开发

| 阶段            | 内容                                         | 验收条件                 |
| ------------- | ------------------------------------------ | -------------------- |
| P0：Agent Host | 参考 OhMyGame 建立持久化会话，注册 Workflow Tools      | 微信自然语言可自主调用 Workflow |
| P1：Agent Plan | 加入 `update_plan`、多步骤执行、多轮上下文和任务状态反馈        | 一个请求可连续调用多个 Workflow |
| P2：增强路由       | 对比原生 Tool Calling 和 pi-jev，再考虑 subagent 编排 | 评测证明比基础方案有明显收益       |

其中 P0 应该优先采用 Pi SDK 原生 Tool Calling，不要立即引入 `pi-jev` 的额外服务依赖。

### 第三阶段：用公众号文章测试整个闭环

你的第一条验收用例可以直接是：

> 帮我找一下最近适合初学者学习的三个 AI Agent 技术话题，选择最有价值的一个，写成通俗易懂的公众号文章，并告诉我文章准备好了没有。

理想结果是 Agent 自主查询可用工具、研究资料、筛选选题、调用写作 Workflow、检查产物，然后把文章位置或内容回复到微信。出现需要外部发布的操作时，先请求授权。

最后一个非常重要的取舍： OhMyGame 的任务计划不保证崩溃后每个步骤都能确定性续跑，而你现有的 Workflow Runtime 已经实现了 Journal/Resume。因此最有价值的组合不是复制 OhMyGame 的任务执行层，而是借鉴它的智能交互层，把你自己的可靠执行引擎作为 Agent 的工具。

这样你的项目会同时拥有 Hermes/OhMyGame 式的自然语言交互，以及你目前已经投入大量时间实现的可审计、可恢复工作流执行能力。