# pi-agentic-workflow V2 — Web 工作台开发执行文档

> 版本：V2.0 / 执行方案（待实施）  
> 日期：2026-10-19  
> 目标仓库：https://github.com/mickorz/pi-agentic-workflow  
> 语言：TypeScript；服务端 Node.js ≥22；前端 React + TypeScript + Vite  
> 产品范围：**单用户、本地优先、浏览器 UI，复用 Pi Agent Workflow Core**。  
> 本文档用于交给开发 Agent 按阶段实施；**不代表 V2 已开发或代码已提交**。

## 0. 基线事实与启动门禁

已通过 GitHub `master` 代码检查确认：

- 包版本 `0.1.0`；CLI 命令 `run/validate/list/status/resume/stop` 已有实现。
- 已有 `src/runtime/workflow-runtime.ts`、`src/adapters/pi/*`、`src/persistence/journal.ts`、`run-store.ts`、`src/checkpoint/terminal-provider.ts`。
- V1 的 `P0/P1/P2` 执行报告存在；`P2-report.md` 报告 91 个离线测试和 4 个真实 SDK 集成测试、1 个真实恢复 E2E 均通过（这是报告中的历史测试记录，**非本次重跑结果**）。
- `src/index.ts` 公开 `runWorkflow`、`PiAgentAdapter` 等，但当前 CLI 的 run/resume 状态持久化与信号逻辑集中在 `src/cli/shared.ts`。
- `src/persistence/run-store.ts` 当前有 `manifest.json`、`journal.jsonl`、`result.json`，尚未见 `events.jsonl` 模块。
- 当前代码树未发现 `P3-report.md`，因此**不能把 V1 P3 / Web Ready 视为已验证完成**。
- 当前 SDK 依赖为 `@earendil-works/pi-coding-agent`（`package.json` 声明 `^1.2.0`；P2 报告说明当时测试为 1.3.0）；**不得未经验证擅自改成其他 Pi SDK 包名**。

### V2 启动前检查（Gate-0）

1. `git status` 干净并记录 `git rev-parse HEAD`、SDK 解析版本、Node 版本、package-lock 状态。
2. `npm ci && npm run typecheck && npm run build && npm test`；记录结果，不得直接援引旧报告当作新验收。
3. 检查 CLI `run/list/status/resume/stop` 能正常工作；用 fake runner 跑回归，并按环境条件运行真实 Pi SDK smoke。
4. 对照下文契约做差异清单：事件流、独立 Run Service、审批请求持久化、进程生命周期和文件读写边界。
5. 如果 Gate-0 未通过，先修复 V1 回归阻断，再开始 Web 功能。

## 1. V2 产品目标与非目标

### 1.1 目标场景

本机启动 `pi-workflow web` 或 `npm run dev:web`，打开 `http://127.0.0.1:PORT`，用户可以：

1. 选择允许的项目工作目录以及工作流 JS 文件（从批准的根目录选择，禁止任意路径提交）。
2. 查看工作流信息，填写 JSON 参数，选择默认模型与并发、超时等选项；先校验再运行。
3. 在网页查看实时执行进度：Workflow / phase / agent / composite / checkpoint 层级、状态、耗时与 Token。
4. 查看节点的输入摘要、输出预览、错误、重试记录、Session ID；可切换详情/日志。
5. 对等待中的 checkpoint 明确批准或拒绝；支持取消、故障后恢复。
6. 浏览历史 Run，断开网页或刷新后仍能补齐事件、重建界面。
7. 与现有 V1 CLI 共存，不改变已有 DSL 语义与 Journal 安全条件。

### 1.2 明确不做

- 不做云端 SaaS、注册登录/团队账号、多租户、公共互联网部署、远程机器管理。
- 不做视觉拖拽 Workflow 编辑器、在线任意 JS 执行、自动生成 Workflow 的 Agent 聊天入口。
- 不做分布式队列、Kubernetes、PostgreSQL 必选部署、复杂 RBAC、多人同时编辑。
- 不迁移 OpenCode UI，不改变原项目 DSL 对外语义；不做 `vision/image` 新原语。
- **不把 Node `vm` 误称为恶意脚本隔离沙箱**；仅允许执行用户明确授权目录下的本地可信工作流。

### 1.3 成功标准

完整演示：浏览器选择 `examples/quality-gates.js`（或真实 feature workflow）→ 参数校验→启动→实时看节点→出现 checkpoint→网页批准→完成→刷新查看历史→中途故障的另一运行在明确风险确认后恢复。CLI 核心测试仍全部通过。

## 2. 架构与责任边界

```text
Browser (React + TS / Vite)
    │ HTTP REST (命令/查询) + SSE (实时事件/补传)
    ▼
Local Web Server (Fastify 推荐；小服务亦可 Hono/原生 HTTP)
    ├── HTTP routes + input schemas + auth/local origin guard
    ├── RunApplicationService  ← 唯一启动/取消/恢复入口
    ├── RunSupervisor       ← 本地进程/任务所有权、生命周期
    ├── CheckpointService   ← 持久化审批、一次性决策
    ├── EventStore          ← durable append-only JSONL + 重放游标
    └── ProjectFileService  ← 允许目录内文件列举与脚本校验
                │
                ▼
Existing Workflow Core + PiAgentAdapter
    ├── workflow-runtime.ts / vm.ts / node-contract.ts
    ├── journal.ts / run-store.ts
    └── @earendil-works/pi-coding-agent
```

**硬规则**：浏览器从不直接访问本机文件系统、模型密钥或 Pi SDK；Web Server 不在 HTTP Handler 内拼接执行策略；CLI 和 Web 调用相同 `RunApplicationService`。如果短期重构 CLI 风险较高，可以先给 CLI 保留兼容外壳，再逐步委托到该服务。

### 2.1 推荐部署与目录

为避免过早 Monorepo 复杂化，V2 可在现有单包中增加 `src/server/` 和 `web/`，保持单一锁文件和现有 npm 包入口；若构建确实需要独立 workspace，再用 ADR 说明迁移理由。

```text
src/
  runtime/                 # 现有 Core，最小修改
  adapters/pi/             # 现有 Pi SDK Adapter
  persistence/             # 原有 Journal + Run Store
  application/
    run-service.ts         # start/get/list/cancel/resume
    run-supervisor.ts      # 运行所有权与中断恢复协调
    checkpoint-service.ts  # 持久化审批
    event-publisher.ts     # 统一事件出口
  server/
    app.ts                 # HTTP app 工厂
    routes/{projects,workflows,runs,checkpoints}.ts
    sse.ts
    security.ts
  cli/                     # 现有 CLI + web 命令
  contracts/               # API、事件、状态的共享 TypeScript 类型
web/
  src/
    pages/{Dashboard,RunDetail,RunCreate}.tsx
    components/{RunList,WorkflowTree,NodeInspector,CheckpointPanel,EventLog}.tsx
    api/client.ts
    hooks/{useRunEvents,useRunQuery}.ts
    state/                 # 极少量 UI 状态
  vite.config.ts
  package.json             # 如单包独立前端构建需按实际组织
examples/
tests/{unit,integration,e2e}/
docs/progress/V2-*.md
```

### 2.2 进程模型（必须明确）

V2 最初使用**单机 Web Server + 本地 Worker 子进程**（建议优先）；不要将长生命周期的 Workflow 直接绑在单个 HTTP 请求生命周期内。Worker 在独立进程调用 Core，Server 负责调度、接收 IPC 事件、统一写 Run 状态。最大并行 Run 数设默认值并可配置（例如 2），每个 Run 内部仍使用 V1 并发上限。

进程边界契约：Server 启动 Worker 后持久化 runId、ownerInstanceId、workerPid、启动时间；Worker 必须有 ready/heartbeat/event/terminal 消息；Server 重启后不可误把 PID 被重用的其他进程当成本次 Worker。对已有 CLI 进程可只读发现历史 Run，**不得发送不经验证的停止信号**。

在 P0 验证进程模型后如需改为 in-process，必须以 ADR 证明：长任务不阻塞 API、页面断线不取消、Server 重启会正确 `interrupted`、可取消/回收 Pi 会话。否则保持 Worker 方案。

## 3. 核心接口契约（先类型与测试，再写 UI）

### 3.1 Application API

```ts
type RunDecision = "approve" | "reject";
interface StartRunInput {
  projectId: string;          // 预先登记的项目标识，非任意绝对路径
  workflowPath: string;       // 项目根下相对路径
  args?: unknown;
  model?: string;
  concurrency?: number;
  timeoutMs?: number | null;
  retries?: number;
}
interface RunHandle { runId: string; status: RunStatus }
interface RunApplicationService {
  start(input: StartRunInput): Promise<RunHandle>;
  get(runId: string): Promise<RunSnapshot | null>;
  list(query?: RunListQuery): Promise<PaginatedRuns>;
  cancel(runId: string): Promise<RunSnapshot>;
  resume(runId: string, input: { acknowledgeSideEffects: boolean }): Promise<RunHandle>;
  decideCheckpoint(runId: string, checkpointId: string,
    input: { decision: RunDecision; expectedVersion: number }): Promise<RunSnapshot>;
}
```

**严格不以 `resume --yes` 替代 Web 审批**：网页 Resume 必须先清楚展示副作用重复风险，用户主动确认；后端验证已确认，再开始。对等待 checkpoint 的恢复与 crash 后恢复应区分，以免混用确认语义。

### 3.2 Run 状态与审批状态

延续 V1：`created/running/completed/failed/cancelled/waiting_checkpoint/interrupted`。可新增 `queued/cancelling`，但必须在 V2 增量 Schema 中列明并支持旧 manifest 读取；不得破坏现有 CLI 状态。

Checkpoint 单独建记录：`checkpointId/runId/nodeId/question/status(pending|approved|rejected)/version/decisionAt/decisionBy`；`decisionBy` V2 只能是 `local-user`。HTTP 决策须携带 `expectedVersion`，重复提交返回已有结果或版本冲突，**不能重复唤醒 Worker**。

### 3.3 标准事件协议

```ts
interface WorkflowEventV1 {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  seq: number;                // 同一 Run 严格递增，从 1 起
  timestamp: string;          // ISO 8601 UTC
  type:
    | "run.created" | "run.started" | "run.completed" | "run.failed"
    | "run.cancelled" | "run.interrupted"
    | "phase.started"
    | "node.started" | "node.updated" | "node.completed"
    | "node.failed" | "node.cancelled" | "node.replayed"
    | "checkpoint.requested" | "checkpoint.approved" | "checkpoint.rejected";
  nodeId?: string;
  parentNodeId?: string;
  payload: Record<string, unknown>;
}
```

- `seq` 在同一 Run 内单调递增；`eventId` 唯一。**先安全持久化，再向 SSE 推送**；客户端允许按 seq 去重。
- 文件布局增加 `.pi-workflows/runs/<runId>/events.jsonl`。Run 结果以 manifest/journal 为事实依据，事件为 UI 投影/重放日志；不能让 UI 事件直接决定 Resume 跳过哪些 Agent。
- 提供 `GET /api/runs/:id/events?after=<seq>`，可增量分页；SSE `id: <seq>`、支持 `Last-Event-ID`；连接时先补传后订阅，避免“补传与实时订阅之间漏事件”。
- 页面断线/刷新后用 snapshot + events 重新构建状态；重放事件应可幂等，未知未来事件类型安全忽略并记录诊断。
- **脱敏默认打开**：Token、摘要可显示；密钥、Cookie、环境变量、完整私有文件内容、原始 tool 参数/响应不能直接推给浏览器。原文详情如需查看须走显式受控 API。
- 事件要能表达工作流层级：workflowScopePath/compositePath/phase、节点顺序和执行 attempt。若 V1 只有 AgentRecords 而没有 composite callback，P0 需补充最小观测 Hook，不能靠解析 CLI 文本构造流程树。

## 4. HTTP API（MVP）

| Method | Endpoint | 功能 | 重要约束 |
|---|---|---|---|
| GET | `/api/health` | 服务健康 | 无敏感配置 |
| GET | `/api/projects` | 已允许项目列表 | 不返回任意用户目录 |
| GET | `/api/projects/:id/workflows` | JS Workflow 列表 | 安全路径归一化；禁止穿越/符号链接越权 |
| POST | `/api/workflows/validate` | 解析 meta 和参数校验 | 不执行 JS |
| POST | `/api/runs` | 启动 | 请求幂等键；限制参数大小；返回 202 + runId |
| GET | `/api/runs` | 历史分页/过滤 | 游标或页码，不全量返回大型日志 |
| GET | `/api/runs/:id` | Run Snapshot | 缺失 404 |
| GET | `/api/runs/:id/events` | 增量事件历史 | after/limit 上限 |
| GET | `/api/runs/:id/stream` | SSE | 重连补传；心跳 |
| POST | `/api/runs/:id/cancel` | 取消 | 幂等且验证 owner |
| POST | `/api/runs/:id/resume` | 恢复 | 要求副作用风险确认，校验 hash |
| GET | `/api/runs/:id/checkpoints` | 待审批清单 | 只读 |
| POST | `/api/runs/:id/checkpoints/:checkpointId/decision` | 批准/拒绝 | expectedVersion + 幂等，拒绝后硬停 |

建议 OpenAPI 3.1 或可导出的 Zod Schema 作接口真源；前端从契约复用类型。错误格式统一 `{ code, message, details?, requestId }`，错误类型涵盖 `INVALID_INPUT/RUN_NOT_FOUND/CONFLICT/RESUME_MISMATCH/CHECKPOINT_NOT_PENDING/FORBIDDEN_PATH/RUN_LIMIT_REACHED`。

## 5. Web 页面与交互

### 5.1 页面 A：Dashboard / Run History

- 顶部：项目切换、启动新工作流、服务状态。
- 主体：执行中的 Run、等待人工审批的 Run、历史列表。
- 展示：名称、状态、创建时间、持续时间、成功/失败节点数、Token（有来源才显示）、最新错误。
- 过滤：状态、项目、时间；支持空数据和加载错误。

### 5.2 页面 B：New Run

- 只选择已授权的项目和工作流 JS。
- 展示 `meta.name`、description；可填 JSON args、模型、并发、timeout/retries。
- 前端格式校验 + 服务端强校验；启动按钮防连点，POST 配幂等键。
- 文件编辑**不在 V2 MVP**；不允许浏览器传脚本源码直接运行。

### 5.3 页面 C：Run Detail（核心页面）

建议**树形时间线优先，DAG 连线图可作为后续增强**：V1 节点的并行/嵌套标识与静态 DAG 未必一一对应，先保证可读和正确。

区域：左侧 Workflow/phase/agent/composite 层级树；右侧 Node Inspector；下部事件流。实时状态 `queued/running/succeeded/failed/cancelled/replayed/waiting` 需明确定义映射，不能将 `null` 业务结果直接视为失败。节点详情包括 label、model、attempt、duration、token/cost（有数据才显示）、sessionId、输出预览、错误链和 replay 标记。

取消按钮只在可取消状态出现；已完成 Run 只读；刷新保持树节点定位（URL 查询或前端状态）。

### 5.4 页面 D：Checkpoint

- 独立醒目但不过度阻挡的等待审批面板；显示问题、Run、节点、进入等待的时间。
- 用户必须明确点击批准/拒绝；没有“默认通过”、没有浏览器消失即自动批准。
- 决策前确认 Run 仍 waiting，`expectedVersion` 正确；冲突需刷新。
- 服务端不可只调用 `confirm()` Promise 解决当前内存请求：**等待态必须可跨进程/页面刷新持久化，服务端启动时可重新关联或走 Resume**。

## 6. 安全与可信执行边界（V2 阻断门禁）

1. 仅监听 `127.0.0.1`，启动随机高熵本地访问 token 或等价安全机制；所有变更操作需验证会话 token 与 Origin，禁止跨站请求伪造。SSE 也必须受保护，不通过 URL query 透传 token。
2. Web 不具备运行任意目录的能力；项目目录显式配置白名单，服务端使用 realpath 校验 root/symlink，阻断 `..` 穿越。
3. 工作流 JS 属于用户信任的本地脚本；不接受网络上传的任意脚本；`node:vm` **不是安全沙箱**。若以后对公网、多用户或不可信输入开放，必须单独设计 OS/容器隔离，不在 V2 MVP 范围。
4. 工作流工具能读写本地文件，网页应该明确显示工作目录、模型、工具权限；默认 explore 只读，不为方便展示取消权限检查。
5. 对浏览器返回的数据做最小化和脱敏；文本按纯文本渲染，不使用未经净化的 HTML；限制输出大小及日志保留天数。
6. 事件中不包含 Pi 的凭证或原始环境变量；禁止把 `~/.pi/agent/auth.json` 传给前端。
7. Worker 数量、Run 并发、日志尺寸、Agent 总数都要有限额；防止本地机器被任务耗尽。
8. `stop/cancel` 不应仅凭 PID 杀进程；要校验所有权、启动身份、活跃 Worker 映射，优先发 IPC 取消并设置优雅退出超时。

## 7. 执行阶段与 Gate（按顺序实施）

### V2-P0：Core Web Readiness / 运行服务抽象

**目标**：补齐 V1 未验证的 P3 事件面，把 CLI 专属编排搬到应用服务，做到不通过终端也能从 Node 程序管理 Run。

任务：
- P0-01 冻结 V1 基线、现状差异报告、记录 SDK 与 CLI 测试。
- P0-02 定义 RunApplicationService、RunSnapshot、EventV1、CheckpointDecision 契约。
- P0-03 从 `src/cli/shared.ts` 提取可复用执行服务；保留旧 CLI 行为和退出码。
- P0-04 Runtime 增加 `onEvent`/节点观测 Hook，记录独立子流程、composite、checkpoint 事件；不得改变 DSL 返回值。
- P0-05 增加 JSONL Event Store：append、seq 原子分配、断裂行恢复、分页、按 runId 读取。
- P0-06 增加 checkpoint 请求记录与状态机；协调等待、决策、恢复。至少在应用服务层用 fake runner 完成跨进程重启模拟。
- P0-07 设计单一 Run 写入所有权规则与资源限额；确定 Worker IPC 协议。

验收 `G-P0`：V1 CLI 回归全绿；应用服务不依赖 CLI/readline；无真实 Web 页面也可启动/查看/取消/恢复；Event Store 断线重放无漏与重复；checkpoint 未批准不继续。

### V2-P1：本地 Web Server + Worker Supervisor

任务：
- P1-01 建立服务器 app 工厂、环境配置、健康检查、启动命令 `pi-workflow web`。
- P1-02 Worker 子进程执行 Core；IPC ready/heartbeat/event/cancel/terminal；并发限制与失联清理。
- P1-03 项目白名单及安全文件枚举、workflow 解析校验。
- P1-04 REST 路由：projects/workflows/runs/status/list/start/cancel/resume/checkpoint。
- P1-05 SSE + 断线重连、Last-Event-ID、历史补传和顺序保证。
- P1-06 本地 token、Origin 校验、CORS 默认拒绝、Schema 校验、Rate/Size limits。
- P1-07 OpenAPI 或共享契约类型、错误码、CLI兼容测试。

验收 `G-P1`：curl 能启动真实 Pi Agent Run，SSE 顺序收到事件；停止和恢复状态正确；Server 重启后历史可读；重复 start（同幂等键）只创建一次；恶意路径与跨站请求被拒；未授权连接不能读取事件。

### V2-P2：React Web 工作台

任务：
- P2-01 Vite/React/TS 基础工程、API client、路由与布局。
- P2-02 Dashboard（Run 列表、状态、筛选、自动刷新/订阅）。
- P2-03 New Run 表单（项目、工作流、参数、模型、并发、校验和启动）。
- P2-04 Run Detail 分层树、Node Inspector、事件时间线、任务用量。
- P2-05 `useRunEvents`：SSE 重连、offset、去重、snapshot 合并、页面刷新恢复。
- P2-06 Checkpoint 审批面板，冲突和拒绝路径。
- P2-07 取消/恢复 UX：状态防误操作、副作用窗口警告、明确确认。
- P2-08 响应式布局、空状态、错误状态、键盘可用性、最小可访问性。

验收 `G-P2`：真实浏览器从 New Run 到完成全过程；至少包含 agent + parallel + verify + checkpoint；中断网络刷新后状态重建不丢；同一等待审批只生效一次；浏览器关闭不终止后台 Worker。

### V2-P3：端到端质量、安全与交付

任务：
- P3-01 Playwright 浏览器 E2E（Mock Worker + 真实 SDK 两级）。
- P3-02 故障注入：SIGKILL Worker、Server 重启、断网、SSE 重复/乱序、journal 尾行损坏、审批重复点击。
- P3-03 兼容性回归：V1 CLI、旧 Run manifest/journal 读取、原 DSL 用例。
- P3-04 安全测试：Origin/token、路径穿越、XSS、日志脱敏、body 大小、Run 数量限制。
- P3-05 跨平台：Windows/macOS/Linux 最少构建与基本 smoke；涉及子进程信号的测试需平台特化。
- P3-06 一键运行文档、配置示例、README、OpenAPI、故障排查、操作演示脚本。
- P3-07 对比基线记录：功能回归、启动时间、事件端到端延迟、长时间运行内存、日志增长。

验收 `G-P3`：全部门禁通过；能生成可复现测试报告与演示证据；不会破坏现有 CLI；性能数据真实采集不编造。

## 8. 最少测试矩阵（编号用于执行报告）

| ID | 类型 | 场景 | 判定 |
|---|---|---|---|
| E01 | Unit | Event Store 写入/读取/seq | 严格递增，断裂尾行可诊断 |
| E02 | Unit | Snapshot + 重放 | 刷新后同状态，无双计数 |
| E03 | Unit | Run 状态机非法迁移 | 明确拒绝 |
| E04 | Unit | Checkpoint 重复决策/版本冲突 | 仅一次生效 |
| E05 | Unit | Worker 崩溃 | Run interrupted，不假成功 |
| E06 | Integration | CLI 旧命令 | 旧验收全通过 |
| E07 | Integration | start 幂等键 | 仅创建一个 Run |
| E08 | Integration | SSE 断连重试 | 不丢事件，前端去重 |
| E09 | Integration | cancel 级联 | Worker/Agent 结束，资源释放 |
| E10 | Integration | resume hash mismatch | 拒绝恢复 |
| E11 | Integration | 恢复副作用确认缺失 | 不执行 |
| E12 | Security | 未授权请求/跨 Origin | 拒绝 |
| E13 | Security | path traversal/symlink | 拒绝越权 |
| E14 | Browser E2E | Dashboard → New Run → Detail | 状态正确 |
| E15 | Browser E2E | checkpoint approve/reject | 两种路径正确 |
| E16 | Browser E2E | reload/reconnect | UI 可恢复 |
| E17 | Real SDK E2E | Pi Agent 真正完成完整 workflow | 真实结果、Token 与状态核验 |
| E18 | Regression | P0-P2 原核心测试 | 无退化 |

**验收规则**：所有确定性测试必须全过；真实 SDK E2E 若因外部凭证/网络无法运行，标记 `BLOCKED` 并给出复现方法，**不得宣称最终 Gate PASS**。浏览器 E2E 必须保存截图/trace，并对关键状态做断言而非只看截图。

## 9. 交付与提交要求

每个阶段单独 commit + push（仅在执行者有授权仓库写权限时），保留：

- `docs/progress/V2-P0-report.md` 至 `V2-P3-report.md`：实际改动、提交 SHA、测试命令、通过数量、失败与遗留风险、截图/trace 所在路径。
- `docs/architecture/V2-runtime-server.md`：进程/事件/Run 所有权和数据流。
- `docs/api/web-openapi.yaml`（或共享 API Schema 的导出结果）。
- `docs/security/web-threat-model.md`：本地威胁边界和测试记录。
- `docs/web-getting-started.md`：安装、启动、配置允许项目、常见问题。
- 一份 `V2-acceptance-matrix.md`：E01–E18 各条 `PASS/FAIL/BLOCKED` 及证据路径。

禁止做法：跳过 P0 直接做 UI；改 DSL 来迁就 UI；浏览器直接提交任意 JS 执行；把 PID 存在当运行身份；自动批准 checkpoint；无确认恢复副作用；用旧报告代替本轮验收；未获授权修改或覆盖用户项目。

## 10. 配置与启动（目标接口，不代表已存在）

`pi-workflow.config.json` 示例：

```json
{
  "web": {
    "host": "127.0.0.1",
    "port": 4317,
    "maxConcurrentRuns": 2,
    "projectRoots": ["./projects", "./examples"],
    "eventRetentionDays": 30
  }
}
```

目标命令：

```bash
npm ci
npm run build
pi-workflow web --host 127.0.0.1 --port 4317
# 在浏览器打开本机地址，按服务启动输出的安全访问方式访问
```

配置、端口和脚本命令最终需经 P1 实现确认，不应在尚未落地前写进正式用户 README 当作已可用能力。

## 11. 阶段任务分配给开发 Agent 的指令模板

```text
目标：仅执行 pi-agentic-workflow V2-P<N>，不要跨阶段开发。
1. 先阅读本文档、当前仓库 CLAUDE.md、已交付阶段报告、最新代码。
2. 记录 pinned HEAD、SDK/Node/npm 版本与现有功能事实。
3. 按 P<N> Task IDs 实现；严守已有 V1 DSL/CLI 兼容。
4. 补充单测、集成测试、必要的真实 Pi SDK / 浏览器 E2E。
5. 执行本阶段 Gate；失败则修复并重测，不得只改报告。
6. 将结果写 docs/progress/V2-P<N>-report.md，附命令、数据、证据及阻断项。
7. Gate PASS 且有仓库写权限才 commit/push；报告 commit SHA 与 git status。
8. 若发现影响架构的冲突，先写 ADR；不得私自放宽审批、恢复或安全边界。
```

## 12. 技术决策总结

- **默认采用：React + TypeScript + Vite / Node.js + Fastify / SSE / JSONL / Pi Adapter**。
- **Web 与 CLI 共享一个 Runtime/Application Service**；Web 只增加服务、UI 和持久化审批接口。
- **任务真实执行在本机受控 Worker**；Web 页面离线不打断任务。
- **P0 补齐事件及应用服务契约是 V2 的第一道门禁**，它并未在当前 GitHub 代码树中得到完成证明。
- **单用户本地优先而非公共互联网部署**，降低第一版 Web 化的实施与安全复杂度。
