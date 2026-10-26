# pi-agentic-workflow — V1 CLI Runtime 开发执行文档

> 版本：V1.0（执行基线）  
> 日期：2026-10-19  
> 目标仓库：https://github.com/mickorz/pi-agentic-workflow  
> 参考仓库：https://github.com/mickorz/opencode-dynamicworkflows  
> 状态：**待执行；本文是计划，不代表功能已实现。**

## 0. 执行摘要

在 `pi-agentic-workflow` 中使用 **TypeScript + Node.js + Pi Agent SDK** 构建一个**独立 CLI Workflow JS Runtime**。用户运行 `pi-workflow run path/to/workflow.js`，由引擎解释编排 DSL，使用 Pi SDK 创建相互隔离的 Agent Session，调用模型及工具，并提供组合控制流、确定性检查、AI 验证、人工审批、运行日志与中断恢复。

**V1 只有 CLI，没有 Web UI、HTTP Server、数据库、分布式 Worker。** 但核心使用宿主无关 API 与结构化事件，方便 V2 使用 Web Server + SSE 调用相同引擎。

**迁移方式：先独立移植，后视稳定性抽取共享 Core。** 不修改参考仓库；不能把 OpenCode SDK 代码原样放进核心模块。兼容的目标是**核心 DSL 的语义兼容**，不是 OpenCode 内部 Session ID、UI 或配置文件格式完全兼容。

## 1. 范围与成功标准

### 1.1 V1 必须完成（MUST）

- 用 CLI 加载、校验并执行一个真实 `.js` Workflow 文件，传入 JSON 参数与工作目录。
- 实现 `agent()`，通过 Pi Agent SDK **进程内**执行、独立 Session、工具权限 profile、模型选择、事件、取消、用量统计。
- 支持 `phase()`、`log()`、`args`、`parallel()`、`sequence()`、`fallback()`、`race()`、`workflow()`、`check()`、`verify()`、`retry()`、`checkpoint()`。
- 支持确定性检查助手，例如 `fileExists()`、`commandSuccess()`；命令执行需遵守 cwd、超时、权限策略。
- 支持 Agent 超时、可恢复失败的有限重试、全局并发限制和 Abort 传播。
- 支持 Journal / Resume：已完成且可安全复用的节点回放、失效检测、待审批节点恢复；不要把“重放”误当作完全精确一次副作用。
- 生成机器可读 JSON/JSONL 事件与结果，提供 `run`、`validate`、`list`、`status`、`resume`；`stop` 仅保证终止当前活跃的本地运行，不暗示跨进程服务能力。
- 有 fake runner 单元测试 + 使用真实 Pi SDK、真实模型的可复现实测（依赖用户本地模型凭证）。
- CLI 与 Core 分离，Core 能独立被调用，不能依赖终端输入/输出。

### 1.2 可选但不能阻塞主线（SHOULD / LATER）

- `runTool()`：确定性工具节点；须先确认参考仓库最新 P4.1 契约，确认稳定后再纳入正式兼容矩阵。
- `pipeline()`：兼容旧 DSL 的可选工作；V1 不强制。
- `vision()`、`image()`、自动优化、A/B、Schedule、工作流图形编辑、多用户管理：**V1 不做**。
- `worktree` 隔离：优先验证共享 cwd 的安全性；如纳入 V1，必须明确文件冲突与隔离回收策略。

### 1.3 唯一最终验收案例

CLI 执行 `examples/feature-development.js`：分析现有项目 → 修改代码 → 运行编译/单元测试 → AI 独立审查 → 人工确认 → 保存结果。故意注入网络/模型错误、进程中断与审批等待，能够按约定恢复，且不会把失败错误标记成成功。

## 2. 开发前基线与工程约束

1. 在目标仓库记录当前 `HEAD`、默认分支、工作区状态；不要假设仓库已经有实现代码。参考仓库检查 `src/agent/session-runner.ts`、`src/runtime/vm.ts`、`src/runtime/workflow-runtime.ts`、`src/runtime/node-contract.ts`、`src/adapters/opencode-session-adapter.ts`、`src/persistence/journal.ts`、`src/runtime/workflow-registry.ts` 及其测试。
2. **冻结来源 commit SHA**，创建 `docs/migration/source-map.md`：原文件、来源 SHA、复制/改造/不迁移、目标文件、行为变化、测试依据。不要只写“参考某个 repo 的 main”。
3. 阅读 Pi SDK 安装版本的实际 TypeScript 类型和示例，锁定经过真实验证的具体版本；`createAgentSession`、工具集合、模型配置、`subscribe/prompt/abort/dispose` 的准确参数必须以**所锁定版本源码和类型定义**为准。文档中的伪代码不可直接视为编译可用代码。
4. TypeScript `strict`；Node.js 22+（以锁定依赖兼容性为准）；ESM；`tsc` 构建；`node:test` + `tsx` 测试。CLI binary 名 `pi-workflow`。
5. 所有持久化目录默认 `.pi-workflows/` 并加入 `.gitignore`；环境凭证绝不写入事件/日志或 commit；日志须脱敏。
6. 推荐默认 `explore` 只读、`general` 可写，权限由工具执行层严格落实，不能只靠系统提示词。Bash 可绕过只读限制，需屏蔽/受限或使用隔离执行环境。VM 仅防误用，不构成处理不可信 JS 的安全沙箱。

## 3. 架构边界

```text
Workflow JS (.js)
      │
      ▼
Workflow Core (Parser/VM/DSL/Node Executor/Scheduler)
      │                  │
      │                  ├── Journal + Run Store
      │                  ├── Event Sink / Event Stream
      │                  └── Checkpoint Provider
      ▼
AgentSessionRunner (host-agnostic contract)
      │
      ▼
PiAgentAdapter → Pi Agent SDK → Model/Tools/Session

CLI Adapter → Runtime API + Event Sink + Terminal Checkpoint Provider
V2 Web     → same Runtime API + Event Stream + Web Checkpoint Provider
```

依赖规则：`runtime/` 禁止直接 import Pi SDK、CLI、readline；只有 `adapters/pi/` 可以调用 Pi SDK；`cli/` 不能自行实现调度、重试或恢复。持久化层与事件发布通过接口注入。

### 3.1 建议目录

```text
src/
  cli/             index.ts, commands/{run,validate,list,status,resume,stop}.ts
  runtime/         vm.ts, workflow-runtime.ts, node-contract.ts, scheduler.ts,
                   workflow-registry.ts, errors.ts, types.ts
  agent/           session-runner.ts
  adapters/pi/     pi-agent-adapter.ts, model-resolver.ts,
                   tool-profiles.ts, usage-mapper.ts, event-mapper.ts
  persistence/     journal.ts, run-store.ts, manifest.ts
  events/          types.ts, emitter.ts, jsonl-sink.ts
  checkpoint/      types.ts, terminal-provider.ts
  config/          loader.ts, schema.ts
  index.ts         public core API
examples/          smoke.js, parallel.js, quality-gates.js,
                   nested.js, feature-development.js
 tests/            unit/, integration/, e2e/, fixtures/
 docs/             architecture.md, DSL.md, CLI.md, migration/source-map.md,
                   acceptance.md, progress/{P0,P1,P2,P3}-report.md
```

## 4. 公共接口契约（落地时需用 TypeScript 定型）

### 4.1 Agent Runner

```typescript
interface AgentRunOptions {
  label?: string;
  model?: string;
  agentType?: "explore" | "general" | string;
  schema?: Record<string, unknown>;
  directory?: string;
  signal?: AbortSignal;
  onSessionCreated?: (sessionId: string) => void;
  onUsage?: (usage: AgentUsage) => void;
  onEvent?: (event: AgentEvent) => void;
}

type AgentExecutionResult =
  | { type: "text"; value: string; sessionId: string }
  | { type: "structured"; value: unknown; sessionId: string };

interface AgentSessionRunner {
  run(prompt: string, options?: AgentRunOptions): Promise<AgentExecutionResult>;
}
```

规范：模型异常、Tool 异常、Abort、Schema 无效必须以带分类的错误报告，**不能正常返回 text 作为成功**；Session 无论成功失败都释放资源；取消完成必须等待 SDK 终止/清理确认。`sessionId` 是 Adapter 自有可定位标识，和 OpenCode ID 无跨运行时兼容保证。

### 4.2 Runtime API（目标，不要求 P0 一次实现完）

```typescript
interface WorkflowEngine {
  start(input: WorkflowInput): Promise<WorkflowHandle>;
  getRun(runId: string): Promise<RunSnapshot | null>;
  resume(runId: string): Promise<WorkflowHandle>;
  cancel(runId: string): Promise<void>; // only active local process in V1
  respondToCheckpoint(runId: string, checkpointId: string,
      decision: "approve" | "reject"): Promise<void>;
}

interface WorkflowHandle {
  runId: string;
  events: AsyncIterable<WorkflowEvent>;
  result: Promise<WorkflowRunResult>;
}
```

`start()` 应保证启动过程错误、运行中错误、事件结束和结果 Promise 的时序契约清晰。事件订阅不得因无人消费导致无限内存积累：持久化优先，异步消费提供有限队列或从持久化游标读取。

### 4.3 Workflow Event

```typescript
interface WorkflowEvent {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  sequence: number; // per-run strictly increasing
  timestamp: string; // ISO-8601
  type: string; // finite documented event union
  nodeId?: string;
  attempt?: number;
  payload?: unknown;
}
```

至少定义 `run.started/completed/failed/cancelled`、`node.started/completed/failed/replayed`、`agent.session.created`、`agent.tool.started/completed`、`checkpoint.requested/resolved`。事件需要稳定 `nodeId`、脱敏、安全序列化和版本号；实时 UI 与 JSONL 均消费同一事件类型。落盘为 append-only，严格按 sequence 可回放。

### 4.4 运行状态模型

`created → running → completed | failed | cancelled | waiting_checkpoint | interrupted`。

- `waiting_checkpoint` 为持久化非终态：CLI 无人值守时默认**暂停**，不可默认 approve。
- Crash 后通过运行记录判断 `interrupted`；不能假设任意 `running` 记录仍有活动进程。
- 状态修改必须持久化，明确原子写入或 append-only journal 的重建规则。

## 5. DSL 语义与兼容规则

| 原语 | 约定 |
|---|---|
| `agent(prompt, options)` | 每次调用独立子 Session，返回文本或已校验的结构化值 |
| `parallel([...])` | 并行、输出按输入索引排列；错误处理依现有版本契约，记录每一项终态 |
| `sequence([...])` | 顺序执行，前项结果传入后项，失败停止 |
| `fallback([...])` | 可恢复失败切换候选，结构性错误不被吞掉 |
| `race([...])` | 第一个**成功**分支获胜，取消其他候选，防止未完成副作用继续执行 |
| `workflow(ref,args)` | 子流程共享父级配额、Abort 和日志作用域；限制递归深度、路径穿越与自环 |
| `phase(name)` / `log(...)` | 只负责阶段和可观测性，不创建 Agent |
| `check(fn,msg)` | 程序确定性检查，失败和业务 false 明确映射 |
| `verify(value,opts)` | 独立审查 Agent；审查格式、阈值、业务否决有明确定义 |
| `retry(fn,opts)` | 限次重试，明确结构性错误/取消不可重试 |
| `checkpoint(prompt,opts)` | 人工审批，等待态持久化；拒绝是硬停止 |
| `args` | 经 JSON 可序列化输入，避免引入动态环境非确定性 |

**需要通过源码/测试锁定参考仓库真实行为**：组合原语是否将 recoverable failure 压为 `null`，`parallel()` 的部分失败策略，`check()` 的错误分类，`verify()` 的实际返回类型。不要为了让 P0 通过而默默改变旧 DSL 语义；有差异必须加入 `docs/migration/compatibility.md`。

## 6. CLI 目标契约

```bash
pi-workflow validate ./examples/smoke.js
pi-workflow run ./examples/smoke.js
pi-workflow run ./workflows/develop.js --cwd . --args '{"feature":"login"}'
pi-workflow list
pi-workflow status <runId>
pi-workflow resume <runId>
pi-workflow stop <runId>     # V1 仅限本机活跃进程/明确控制通道
```

推荐附加 `--json` 输出供脚本消费；`--model` 配置运行时默认模型；`--concurrency`、`--timeout`、`--non-interactive`。CLI help 清楚描述默认值、配置优先级（CLI > workflow node > run config > project config > SDK default，具体按字段适配），并严格检查 `--args` JSON 格式。Windows/macOS/Linux 最少分别执行基础验证；路径、shell 命令与 SIGINT 行为需要平台测试。

退出码约定：0 = completed，非 0 = failed/cancelled/invalid/interrupted（细分稳定码写到 CLI 文档）。V1 不承诺 daemon 或 HTTP 远程 stop。

## 7. 数据与恢复契约

```text
.pi-workflows/runs/<runId>/
  manifest.json            # scriptHash/argsHash/source versions/cwd/status
  events.jsonl             # append-only events
  journal.jsonl            # per-node durable state transitions + results
  result.json              # final summary; atomic write
  agents/                  # optional sanitized per-agent summaries
```

**运行恢复最容易出错的地方**：动态分支和 `parallel()` 中“执行完成顺序”不等于“稳定节点身份”。要求基于确定性调用标识（如 scope path + sync allocation index + workflow instance identity）进行 Journal 匹配；回放需检查脚本 Hash / 参数 Hash / 兼容版本；遇到变更必须拒绝或明确采用全量重跑策略。不要将缺失 Journal 的副作用执行视为未发生。

所有写文件、命令、Git 操作存在“副作用发生但 Journal 尚未写入”窗口：V1 要提供检查/幂等策略或在不确定时**阻塞并要求人工确认**，禁止承诺严格 exactly-once。恢复时发出 `node.replayed` 和 `node.reexecuted`（如适用），可核对 token 不重复支出。

## 8. 分阶段执行计划

### P0 — CLI + Pi SDK + 基础 DSL

**任务**
1. 初始化 Node/TS ESM 项目、lint/typecheck/test/build、CLI bin、基本文档。
2. 冻结参考仓库和 Pi SDK 版本，完成 Source Map 与兼容风险清单。
3. 迁移 `vm` 解析/基础 runtime、semaphore、node-contract、agent-runner 接口；首阶段支持 `args`、`phase`、`log`、`agent`、`parallel`、`sequence`。
4. 开发 Pi Adapter：模型选择、Session 隔离、工具 profile、真实 prompt、取消/清理、错误和 token 统计。模型与工具 API 以安装版本类型为准。
5. CLI `run` + `validate`；smoke、parallel、sequence 示例；运行结果 JSON。
6. Fake runner 测试 + 有凭证时真实 Pi SDK 测试；明确无凭证时哪些用例被跳过，不得报告为通过。

**验收**
- P0-01：`validate` 拒绝错误 meta、非法脚本。
- P0-02：smoke 至少 1 个真实 Agent 完成，结果非空，Session 正确销毁。
- P0-03：parallel 两分支真正有执行时间重叠，返回次序稳定。
- P0-04：sequence 第二节点收到前项结果。
- P0-05：ex​​plore 工具在测试下不能实际写文件，general 在允许目录能够写入。
- P0-06：缺少模型/认证失败、Prompt 失败、手动取消都得到失败/取消态而非 success。
- P0-07：`npm run build`、`npm run typecheck`、`npm test` 全绿；CLI bin 安装后可调用。

**阶段交付**：`docs/progress/P0-report.md`（commit SHA、测试命令、通过/失败、真实模型与环境、已知限制），独立 commit/push。

### P1 — 控制流 + 自动验收

**任务**
1. 迁移 `fallback`、`race`、`workflow`、`check`、`verify`、`retry` 及确定性 helpers。
2. 实现子 Workflow 路径规范化、递归检测、共享总并发/配额与取消。
3. 实现 `schema` 输出约束、本地完整 JSON Schema 校验、解析失败分类及有限修复策略。
4. 检查 `parallel()` 内失败对整体状态的影响；Race 取消的子 Agent 不得继续干扰工作区。
5. 添加 `quality-gates.js`、`nested.js`、结构化输出、失败注入示例和测试。

**验收**
- P1-01：recoverable fallback 改走下一节点，脚本/配置错误直接抛出。
- P1-02：race 仅成功分支获胜，失败分支不获胜，其余分支收到取消。
- P1-03：嵌套 workflow 无死锁、共享最大并发、阻断循环调用。
- P1-04：check 编译失败时工作流不会报告 success。
- P1-05：verify 使用独立 Agent Session，审查结果符合预定义语义。
- P1-06：Schema 缺字段/类型错误被拒绝，而非仅校验最顶层必填键。
- P1-07：可取消、不可恢复与可恢复失败的重试次数正确。

**阶段交付**：`docs/progress/P1-report.md`、DSL 兼容清单、独立 commit/push。

### P2 — Journal / Resume / Checkpoint

**任务**
1. 建立 manifest、journal、run store、运行状态恢复；实现原子/追加式持久化策略。
2. 处理稳定节点 key、脚本变更、参数变化、失败/中断/未完成节点的恢复规则。
3. checkpoint Provider 抽象 + 终端 Provider；`--non-interactive` 必须暂停或按明确策略拒绝，**绝不自动通过**。
4. CLI `list`、`status`、`resume`、本进程 `stop`；SIGINT/SIGTERM 状态写入与清理。
5. 加入副作用窗口检查/人工确认示例。

**验收**
- P2-01：首次执行成功两个节点后强制杀进程，resume 不再次请求已安全提交节点。
- P2-02：脚本或参数 Hash 变化明确拒绝复用旧 Journal。
- P2-03：并行分支乱序完成不会错误匹配 Journal key。
- P2-04：中断在文件写入后、Journal 记录前，不得静默重执行危险副作用。
- P2-05：人工批准继续；拒绝明确停止；无终端交互进入等待态。
- P2-06：cancel、timeout、child workflow 均正确传递中止与最终状态。
- P2-07：恢复后已缓存节点的模型 token 消耗不重复计算为新消耗。

**阶段交付**：`docs/progress/P2-report.md`、故障注入脚本及恢复证据、独立 commit/push。

### P3 — Event API + Web Ready + 真实项目验收

**任务**
1. 完整事件 schema、JSONL store、事件游标/回放、Run Snapshot。
2. 导出 `WorkflowEngine` 公共 API；CLI 只消费 API，不碰私有状态。
3. 补齐 `--json`、错误码、配置文档、Windows/macOS/Linux 兼容性说明。
4. 运行真实 `feature-development.js`（只针对隔离的测试项目）；做重复性测试和模拟故障。
5. 补充 V2 Web 接入契约：Server 如何启停 Run、订阅事件、审批和查询历史；**不实现 Web Server**。

**验收**
- P3-01：CLI 输出与持久化事件同源，sequence 单调、节点身份稳定。
- P3-02：运行结束后可以按 event cursor 重放，内容一致。
- P3-03：第三方 TS 程序无需依赖 CLI 就能调用 Core。
- P3-04：至少 1 次真实功能开发闭环完整通过；保留原始运行证据。
- P3-05：失败/恢复/审核拒绝均不被包装成成功。
- P3-06：build/typecheck/unit/integration/e2e 与 README 操作步骤一致。

**阶段交付**：`docs/progress/P3-report.md`、完整 V1 Acceptance Report、V2 API 契约、独立 commit/push。

## 9. 自动测试矩阵

| 组别 | 覆盖点 | 运行类型 |
|---|---|---|
| VM | meta、禁用非确定性函数、非法 JS、脚本边界 | unit |
| DSL | agent、parallel、sequence、fallback、race、workflow | unit |
| Scheduler | 限流、共享限额、超时、取消、无死锁 | unit |
| Adapter | 真实 Session、模型选取、工具 profile、错误状态、用量 | integration |
| Verification | check/verify/retry、Schema 无效和模型拒绝 | unit + integration |
| Persistence | 成功回放、脚本变更、并行乱序、损坏日志 | unit + e2e |
| Failure | SDK 请求失败、工具失败、SIGINT、强杀、异常重启 | e2e |
| Checkpoint | approve/reject/无终端/恢复审批 | e2e |
| Event | 事件完整、去重/序列、存储回放、脱敏 | unit + e2e |
| CLI | 参数与退出码、Windows 路径、help、安装后的 bin | e2e |

测试报告必须区分 **fake runner 通过**、**真实 SDK 通过**、**未运行**、**失败**，不得合并汇报“全部通过”。实际联网测试固定模型/环境并记录运行用量；CI 无密钥只执行离线测试。

## 10. 关键风险与对应措施

| 风险 | 处置 |
|---|---|
| Pi SDK API 与示例变化 | 先锁版本、查看 installed types、真实 smoke 后再做大规模迁移 |
| 只读 Agent 通过 shell 写文件 | 最小工具集合 + 执行层权限校验，不信任 Prompt 限制 |
| `node:vm` 不是安全沙箱 | V1 只支持本地可信 Workflow JS；V2 多用户必须使用强隔离执行器 |
| Resume 导致副作用重复 | stable node identity + journal commit + 幂等/检查/人工拦截 |
| Race 分支取消后继续改文件 | SDK abort + 等待终止确认 + 明确共享 cwd 写冲突禁用/警告 |
| Pi 模型不支持结构化输出 | Adapter 本地解析/JSON Schema 完整校验/有限修复；不得报假成功 |
| 事件和日志泄露 prompt/secrets | 事件 schema 明确脱敏字段，默认不存认证密钥和敏感工具结果 |
| CLI 和 Web 耦合 | Provider/Store/Event/Engine 接口分层，CLI 仅适配 |
| 过度迁移旧版功能 | 严格遵守 MUST 清单，其余进入 backlog |

## 11. 执行纪律 / 开发 Agent 指令

- 依 **P0 → P1 → P2 → P3** 串行推进；不跳过前一阶段的测试门禁。
- 每阶段开始前先写源代码证据与最小改动计划；实现后执行 typecheck/build/tests，并且输出阶段报告。
- 每阶段提交独立 commit；如有仓库写权限且用户授权，push 到目标仓库。**不要声称 push 成功，必须附实际 commit 和远端结果**。
- 只修改目标仓库；参考仓库只读。避免批量删除、强制覆盖远端或重写历史。
- 遇到 API 不兼容，先记录事实与复现方法，再最小化兼容处理；严禁编造已经验证的 SDK 功能。
- 新增重要能力必须先有契约测试（尤其恢复、取消和权限）。
- 最终输出：实施文件清单、迁移映射、公开 API、执行命令、测试矩阵、真实运行证据、未完成项、V2 接入说明。

## 12. 明确非目标（V1）

不开发 React/Web、浏览器端 JS 执行、HTTP/SSE 服务实现、多人身份与权限、分布式调度、远程 Worker、可视化拖拽、数据库后端、Marketplace、自动生成/优化 Workflow、通用多租户安全沙箱。V2 可使用 V1 Runtime 的公共 API 和事件协议增加这些能力。

## 13. 验收结论模板（每阶段填写）

```text
Phase: P0/P1/P2/P3
Target HEAD before:
Target HEAD after:
Source pinned SHA:
Pi SDK version:
Implemented paths:
Test commands:
Offline tests: passed / failed / skipped
Real SDK tests: passed / failed / not run (reason)
Key evidence:
Known limitations:
Commit SHA:
Push result:
Gate: PASS / FAIL
```

---

**最终完成定义：** `pi-workflow run examples/feature-development.js` 能通过真实 Pi Agent SDK 完成功能开发链；CLI、日志、Journal、Resume 和人工审批可独立使用；恢复行为有故障注入证据；Core 不依赖 CLI，V2 可以直接把同一套公共接口接到 Web Server。未达到这些要求，即使简单 smoke 通过，也不能宣布 V1 完成。
