# DSL 兼容清单（相对 opencode-dynamicworkflows v0.11.2 @ 3373d1a）

> 目标是**核心 DSL 语义兼容**，不是 OpenCode 内部 ID/UI/配置格式兼容。
> 差异分类：✅ 语义一致 | 🔶 有意改进（已记录） | ❌ 未迁移（backlog/非目标）

| 原语/能力 | 状态 | 说明 |
|---|---|---|
| `agent()` 基础语义 | ✅ | 独立子会话、配额/超时/重试/中止/用量，行为一致 |
| agent 可恢复失败 → null + 阶段失败闸门 | ✅ | Bug1 闸门语义一致（含 continueOnAgentFailure 逃生口） |
| `parallel()` | ✅ | 函数数组校验、塌缩 null、按索引返回 |
| `sequence()` | ✅ | 三态判定；agent 耗尽 null 继续传递（闸门兜底），抛出型可恢复失败立即停止 |
| `fallback()` | ✅ | 串行竞争 + null+登记归因回滚；全部候选失败返回 null（显式降级吸收） |
| `race()` | ✅ | 首 success 胜出 + 局部中止面取消兄弟；全部失败 null |
| `check()` | ✅ | true/false/throw 三态语义一致（CHECK_FAILED 可恢复） |
| `verify()` | ✅ | 对抗式评审、投票阈值；schema 由本地校验器保证 |
| `retry()` | ✅ | 有界重试糖 |
| `fileExists()` / `commandSuccess()` | ✅ | 确定性 helpers |
| `workflow()` 子流程 | 🔶 | 语义一致（共享配额/中止/深度/自环检查）；**路径解析为父脚本目录优先、cwd 次之**（参考实现仅 cwd）——对 `pi-workflow run examples/nested.js` 场景更直观 |
| `phase()` / `log()` / `args` / `setConcurrency` / console shim | ✅ | 一致 |
| 结构化输出 `schema` | 🔶 | Pi 无原生 json_schema：prompt 指令 + 本地解析 + **完整 JSON Schema 子集校验**（P1-06）；失败可恢复重试 |
| `agentType` | 🔶 | 仅 explore/general；未知类型结构性报错（fail-fast，不静默降级） |
| `model` spec | ✅ | "provider/modelId" 或裸 id；找不到报错不静默回退 |
| `tier` 模型分层 | ❌ | 未迁移；由 provider/modelId 直接指定替代（P1 决策） |
| `pipeline()` | ❌ | 旧 DSL 兼容原语，backlog（V1 非必须） |
| `judgePanel()` | ❌ | 参考仓库扩展原语，backlog |
| `checkpoint()` | ⏳ | P2 实现人工审批 |
| journal / resume | ⏳ | P2 |
| 名字引用 registry（.opencode-workflows/workflows/） | ❌ | 未迁移；V1 仅显式路径（含父脚本目录解析） |
| worktree 隔离 `isolation: "worktree"` | ❌ | V1 非目标（执行文档 §1.2） |
| `onAgentUpdate`/`onCompositeUpdate`/TUI 观测回调 | ❌ | 由 P3 事件系统替代 |
