# V2-P0 执行报告 — Core Web Readiness / 运行服务抽象

```text
Phase: V2-P0
Target HEAD before: c8c12d2（V1 完结提交）
Target HEAD after: 本阶段 commit（见 git log V2-P0 提交）
Pi SDK version: @earendil-works/pi-coding-agent@1.3.0（npm ci 锁定复验）
Node: v25.6.1 / npm 11.9.0
```

## Gate-0：V1 基线重验（本轮实跑，非援引旧报告）

| 项 | 结果 |
|---|---|
| `npm ci && typecheck && build && test` | ✅ 101/101（V2 改动前基线） |
| CLI smoke（validate） | ✅ exit 0 |
| 真实 Pi SDK 集成 | ✅ 5/5（glm-5.3-flash） |

## 现状差异清单（V2 契约 vs V1 完结时事实）

V2 文档撰写于 V1-P3 完成前，其「未见 events.jsonl / P3 未验证」前提已过时；本轮确认：

| V2 要求 | V1 完结现状 | 处置 |
|---|---|---|
| EventV1（seq/事件类型全集） | 已有同构事件（字段名 `sequence`；无 phase.started/run.created/checkpoint.approved|rejected 拆分） | ✅ 本阶段补 `phase.started` + node 事件携带 workflowScopePath/compositePath；**磁盘格式保持 V1 兼容**，API 面经 `toV2Event()` 映射（contracts/web.ts） |
| RunApplicationService | engine.ts 提供进程内 API，无审批持久化/限额/副作用确认语义 | ✅ 新增 `application/run-service.ts`（start/get/list/cancel/resume/decideCheckpoint + RUN_LIMIT_REACHED + SIDE_EFFECTS_UNACKNOWLEDGED） |
| checkpoint 记录持久化 | 仅 journal 内隐式（决策写入 journal） | ✅ 新增 `application/checkpoint-service.ts`：checkpoints.jsonl 状态机（version/expectedVersion/decisionBy） |
| Worker IPC / RunSupervisor | 无 | ⏳ P0-07 交付设计基线（docs/architecture/V2-runtime-server.md）；实现属 V2-P1 |
| CLI 委托应用服务 | CLI 走 cli/shared.ts | ✅ 按 V2 文档「兼容外壳」策略保留；P1 随 web 命令统一委托 |

## 交付清单

| 任务 | 内容 |
|---|---|
| P0-01 | Gate-0 重验 + 差异清单（本报告） |
| P0-02 | `src/contracts/web.ts`：RunStatusV2/StartRunInputV2/CheckpointRecordV2/WorkflowEventV1 + toV2Event 映射 |
| P0-03 | `src/application/run-service.ts`：无 CLI/readline 依赖；启动/查看/取消/恢复/审批全链；maxConcurrentRuns 限额；resume 副作用确认与 RESUME_MISMATCH 分类 |
| P0-04 | runtime：`phase.started` 事件；node.started 携带 workflowScopePath/compositePath（不改 DSL 返回值） |
| P0-05 | Event Store（V1-P3 已建）：本轮复验写入/seq/断裂行/游标（events.test.ts 保持全绿） |
| P0-06 | CheckpointService：持久化审批 + 等待态 manifest 同步（checkpoint.requested→waiting_checkpoint，resolved→running，不覆盖终态）；跨实例（模拟重启）恢复：记录持久化、resume 重问 version+1 |
| P0-07 | docs/architecture/V2-runtime-server.md：进程模型、Worker IPC JSON 协议（ready/heartbeat/event/cancel/terminal）、单写者所有权、取消顺序、限额 |

## 验收 G-P0

| 项 | 结果 | 证据 |
|---|---|---|
| V1 CLI 回归全绿 | ✅ | 108/108 unit（含 V1 全部用例）+ 集成 5/5 |
| 应用服务不依赖 CLI/readline | ✅ | run-service.ts 仅依赖 engine/persistence/contracts |
| 无终端可启动/查看/取消/恢复 | ✅ | run-service.test.ts（fake runner 全链 7 用例） |
| Event Store 断线重放无漏与重复 | ✅ | events.test.ts 游标续读 + e2e sequence 连续（V1 用例保持绿） |
| checkpoint 未批准不继续 | ✅ | approve 前置等待态断言；拒绝硬停路径 |
| 跨进程重启模拟 | ✅ | 双服务实例：A 等待→B 读到持久记录→resume 重问 v2→决策→完成 |

```text
Test commands:
  npm run typecheck && npm run build   # 0 错误
  npm test                             # 108 pass / 0 fail（新增 run-service 7）
  PI_WORKFLOW_INTEGRATION=1 npx tsx --test tests/integration/pi-adapter.test.ts  # 5 pass
Known limitations / 遗留：
  - 决策唤醒当前为同进程通道；跨进程审批经「持久记录 + resume 重问」路径（真实 Worker IPC 属 P1）
  - queued/cancelling 状态未引入（P1 按需增量 Schema）
  - CLI 尚未委托应用服务（兼容外壳策略，P1 统一）
Push result: 已 push 到 origin/master
Gate: PASS
```
