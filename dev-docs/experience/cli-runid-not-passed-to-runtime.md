# cli-runid-not-passed-to-runtime.md

## 问题现象

P2 e2e 故障注入测试中，SIGKILL 强杀 CLI 子进程后执行 `pi-workflow resume`，journal 中已有的 2 个节点**没有被回放**，3 个节点全部重新调用真实模型（token 重复支出），断言 `n1.replayed === true` 失败。

## 排查过程

1. 单元测试中直接构造 `resumeJournal` 传给 `runWorkflow` 回放正常 → runtime 回放逻辑本身没问题。
2. 对比 journal 文件内的 key 与 resume 运行时生成的 record.id：`run-abc123:0` vs `run-xyz789:0`——**runId 不一致**。
3. 追踪发现 `src/cli/shared.ts` 的 `executeWorkflowRun` 创建 manifest 时生成了 `manifest.runId`（用于目录名），但调用 `runWorkflow(script, options)` 时**没有传 `runId` 选项**，runtime 内部又自行生成了一个新的 `run-<timestamp36>`。

## 根因

同一概念（runId）存在**两个生成源**：manifest 生成一个（决定持久化目录与 journal 落盘位置），runtime 内部缺省又生成一个（决定 journal key）。两者不同步时，journal 条目的 key 与 resume 时计算的 key 永不匹配，回放完全失效且无任何报错（静默全量重执行）。

## 解决方案

`executeWorkflowRun` 调用 `runWorkflow` 时显式传 `runId: manifest.runId`，保证单源。修复后 e2e 通过：`n1(replayed), n2(replayed), n3`。

## 预防/注意事项

- **身份字段必须单源化**：凡是"决定持久化寻址"的标识（runId、scope keySegment、executionId），只能有一个生成方，其余位置透传。
- 回放类功能必须有"回放命中率"断言的 e2e（本例正是靠 e2e 断言暴露了单元测试测不出的接线 bug）。
- 类似模式：`structuredClone` 边界、AsyncLocalStorage 传播——都是"单测 fake 得太干净、集成才见真"的高发区。
