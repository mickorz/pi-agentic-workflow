# Source Map — 参考仓库迁移映射

> 参考仓库：https://github.com/mickorz/opencode-dynamicworkflows
> 冻结来源 SHA：`3373d1ae9c5f4adeaaea5d223582532410fba8f3`（v0.11.2，2026-09-30）
> Pi SDK 锁定版本：`@earendil-works/pi-coding-agent@1.3.0`（npm ^1.2.0 实际解析）
> 状态：随 P0-P3 逐阶段更新

## 迁移映射表

| 参考源文件（@ SHA 3373d1a） | 处置 | 目标文件 | 行为变化 |
|---|---|---|---|
| `src/runtime/errors.ts` | 复制+改造 | `src/runtime/errors.ts` | 无变化（保留全部错误码供 P1/P2 使用） |
| `src/runtime/semaphore.ts` | 复制 | `src/runtime/semaphore.ts` | 无变化 |
| `src/runtime/vm.ts` | 复制+改造 | `src/runtime/vm.ts` | 无变化（确定性 PRELUDE / meta 字面量校验语义一致） |
| `src/runtime/node-contract.ts` | 复制+裁剪 | `src/runtime/node-contract.ts` | 无变化（compositeScope ALS 保留供 P1 race） |
| `src/runtime/agent-result.ts` | 复制+裁剪 | `src/runtime/agent-result.ts` | 仅保留展示预览（truncate/redact），journal prompt 截断 P2 再加 |
| `src/runtime/workflow-runtime.ts` | 改造（P0 子集 + P1 控制流） | `src/runtime/workflow-runtime.ts` | P1 补齐 fallback/race/workflow/check/verify/retry + helpers；workflow() 路径解析改为父脚本目录优先 |
| `src/agent/session-runner.ts` | 复制+改造 | `src/agent/session-runner.ts` | agentType 注释改为 explore/general 语义 |
| `src/adapters/opencode-session-adapter.ts` | **不迁移**（OpenCode 专属） | — | 由 `src/adapters/pi/pi-agent-adapter.ts` 等价实现（Pi SDK） |
| `src/persistence/journal.ts` | 不迁移（P2 重新实现） | — | P2 按目标仓库数据契约实现 |
| `src/runtime/workflow-registry.ts` | 不迁移（P1 视需要） | — | 名字引用 registry 属 P1 范围 |
| `src/isolation/worktree.ts` | 不迁移 | — | V1 不做 worktree 隔离（执行文档 §1.2） |
| `src/agent/model-tiers.ts` | 不迁移 | — | tier 解析由 `model-resolver.ts` 的 provider/modelId 解析替代 |
| `src/cli/`、`src/tui/`、`src/tools/`、`src/schedule/` | 不迁移 | — | 目标仓库 CLI 全新实现；TUI/Schedule 非目标 |

## Pi Adapter（全新实现，无对应参考文件）

| 目标文件 | 职责 | 依据 |
|---|---|---|
| `src/adapters/pi/tool-profiles.ts` | explore 只读白名单（read/grep/find/ls）/ general 可写（read/bash/edit/write） | Pi SDK `createAgentSession({ tools })` 白名单（05-tools 示例 + sdk.d.ts） |
| `src/adapters/pi/model-resolver.ts` | "provider/modelId" / 裸 id → Model；找不到抛错 | Pi SDK `ModelRuntime.getModel/getAvailable`（02-custom-model 示例） |
| `src/adapters/pi/pi-agent-adapter.ts` | Session 隔离（inMemory）、abort 接线、用量统计、结构化输出解析 | Pi SDK `SessionManager.inMemory` / `session.abort/dispose` / `message_end.usage` / `getLastAssistantText` |

## P1 裁剪清单（相对参考实现）

| 参考 capability | 状态 | 计划 |
|---|---|---|
| `agent()`（配额/超时/重试/中止/用量） | ✅ 已迁移（P0） | — |
| `parallel()/sequence()`（composite 三态/塌缩 null） | ✅ 已迁移（P0） | — |
| `phase()/log()/args/setConcurrency/console shim` | ✅ 已迁移（P0） | — |
| 阶段失败闸门（Bug1 语义） | ✅ 已迁移（P0） | — |
| `fallback()/race()`（局部中止面 + 闸门归因） | ✅ 已迁移（P1） | — |
| `workflow()` 子流程（自环/深度/structuredClone/共享配额） | ✅ 已迁移（P1，路径解析父脚本目录优先） | — |
| `check()/verify()/retry()` + `fileExists/commandSuccess` | ✅ 已迁移（P1） | — |
| schema 完整校验 | ✅ `src/adapters/pi/schema-validator.ts`（全新，JSON Schema 子集） | — |
| journal / resume / hashAgentCall | ❌ 未迁移 | P2 |
| `checkpoint()`（人工审批） | ❌ 未迁移 | P2 |
| 名字引用 registry | ❌ 不迁移 | backlog |
| `judgePanel()` / `pipeline()` | ❌ 不迁移 | backlog |
| worktree 隔离 | ❌ 不迁移 | 非 V1 目标 |

## 兼容性差异记录（docs/migration/compatibility.md 候选条目）

1. **agentType**：参考仓库 agentType 为 OpenCode agent 名（explore/general/自定义）；本仓库仅支持 explore/general，未知类型结构性报错（fail-fast，不静默降级）。
2. **sessionId**：本仓库为 adapter 生成的 UUID（in-memory session），与任何外部运行时 ID 无兼容保证（执行文档 §4.1 明确）。
3. **tier**：`ScriptAgentOptions.tier` 未迁移；模型选择只有 `model`（provider/modelId 或裸 id）与运行级 `--model`。
4. **结构化输出**：OpenCode 原生 `format: json_schema`；Pi 经 prompt 指令 + 本地解析实现（P1 补完整 JSON Schema 校验与有限修复）。
5. **sequence 语义**：与参考一致——agent 耗尽失败返回 null 会继续传递（sequence 不因此中断），由阶段失败闸门在 phase 边界/run 终检终止；抛出型可恢复失败立即停止序列。
