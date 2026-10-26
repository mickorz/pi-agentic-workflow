# pi-agentic-workflow V2-P0 手动测试指南

> 日期：2026-10-20 · 配套脚本：`dev-examples/manual-test/v2-service-demo.ts`、`v2-extra-cases.ts`
> 覆盖：V2-P0 应用服务层（RunApplicationService / CheckpointService / V1→V2 事件映射契约）
> 前置：已按总指南完成 `npm ci && npm run build && npm link`（V2 服务为进程内 API，无终端 CLI；
> Web Server 属 V2-P1，未实现）
> 约定：模型一律不传（走 `~/.pi/agent/settings.json` 默认模型）；命令在**仓库根目录**执行。

## 0. 被测对象与 API 面

| API | 行为 | 关键错误码 |
|---|---|---|
| `start(input)` | 无终端启动 workflow run | `RUN_LIMIT_REACHED`（活跃 running 占额度，等待态不占） |
| `get(runId)` | 快照 + checkpoint 记录列表 | — |
| `list()` | 历史 run 列表（含 effectiveStatus 死进程补偿） | — |
| `cancel(runId)` | 服务层取消（进程内 abort → 终态 cancelled） | `RUN_NOT_FOUND` |
| `resume(runId, opts)` | waiting_checkpoint 重新询问；interrupted 需副作用确认 | `RUN_NOT_FOUND` / `RUN_STILL_ACTIVE` / `CONFLICT` / `RESUME_MISMATCH` / `SIDE_EFFECTS_UNACKNOWLEDGED` |
| `decideCheckpoint(runId, cpId, input)` | 持久化状态机（expectedVersion 乐观锁）+ 引擎唤醒 | `CONFLICT` / `CHECKPOINT_NOT_PENDING` |

产物目录与 V1 同构：`<baseDir>/.pi-workflows/runs/<runId>/{manifest.json,journal.jsonl,events.jsonl,result.json,checkpoints.jsonl}`。

## 1. 主链路（demo 脚本，7 步断言）

```bash
npx tsx dev-examples/manual-test/v2-service-demo.ts
```

| 步骤 | 验证点 | 预期 |
|---|---|---|
| 1 start | 无终端启动 | runId 打印 |
| 2 等待审批 | manifest→waiting_checkpoint + checkpoints.jsonl 记录 | `状态=waiting_checkpoint ... v1 status=pending` |
| 3 错误版本 | expectedVersion 不匹配 | `✓ CONFLICT` |
| 4 批准→完成 | 决策唤醒 + 终态 + journal/events 计数 | `状态=completed，journal=3，events=11` |
| 5 幂等重放 | 同决策同版本再提交 | `✓ status=approved（不重复唤醒）` |
| 6 V2 事件映射 | seq 连续 + checkpoint.requested | 前 6 条事件列表 |
| 7 并发限额 | 活跃 run 占额度（等待态不占） | `✓ RUN_LIMIT_REACHED` |

终行 `✅ V2-P0 应用服务手动测试全部通过`（exit 0）即通过。

## 2. 拒绝族与恢复族（extra 脚本，8 项断言）

```bash
npx tsx dev-examples/manual-test/v2-extra-cases.ts
```

| 断言 | 场景 | 预期 |
|---|---|---|
| 1 | resume 不存在的 runId | `RUN_NOT_FOUND` |
| 2 | running 中的 run 被 resume | `RUN_STILL_ACTIVE` |
| 3 | 服务层 cancel | 终态 `cancelled` |
| 4 | interrupted run + 脚本变更后 resume | `RESUME_MISMATCH` |
| 5a | interrupted run（journal≥1）未确认副作用 resume | `SIDE_EFFECTS_UNACKNOWLEDGED` |
| 5b | 确认后恢复 | 回放已提交节点 + 剩余节点真实执行 → `completed`（journal 3 行） |
| 6 | completed run 再 resume | `CONFLICT`（已完成不可恢复） |
| 7 | 对无 checkpoint 的 run 提交决策 | `CHECKPOINT_NOT_PENDING`（含 NOT_FOUND 映射） |

实现说明：interrupted 态由脚本直接 `updateManifest(status:"interrupted")` 模拟（对应真实场景
"启动进程被强杀、pid 已死"）；步骤 5b 的恢复轨迹应看到 `journal=1 → 2 → 3`（回放 + 真实执行）。

终行 `PASS=8 FAIL=0` + `OK V2-P0 补充用例全部通过` 即通过。

## 3. checkpoints.jsonl 状态机人工抽验（可选）

checkpoints.jsonl 仅由 V2 CheckpointService 写入（V1 CLI 审批 run 不产生该文件）；
demo/extra 的 base 目录为临时目录跑完即删，人工查看用专用探针：

```bash
npx tsx dev-examples/manual-test/v2-checkpoint-view.ts
```

预期输出：

- requested 行：`{"kind":"requested","checkpointId":"...:1","version":1,...}`
- 批准后追加 decision 行：`{"kind":"decision","decision":"approve","version":1,...}`
  （decision.version 与提交的 expectedVersion 一致；resume 重新询问时 version 递增，
  对应总指南 F3 的 v1→v2 重问语义）——即 decideCheckpoint 乐观锁的数据基础。

## 4. 测试记录表

> 2026-10-20 全量执行通过（demo 7 步 + extra 8 断言 + 状态机抽验），含一次产品缺陷修复：
> 同进程 cancel→resume 复用已 abort 的 controller 导致恢复即 cancelled（见 §5）。

| 用例 | 结果(P/F) | 证据 | 备注 |
|---|---|---|---|
| demo 步骤 1–7 | P | `✅ V2-P0 应用服务手动测试全部通过` | |
| extra 断言 1–8 | P | `PASS=8 FAIL=0` | |
| checkpoints 状态机抽验 | P | pending v1 → approved v2，version 递增 | |

## 5. 已修复缺陷（本次测试发现）

**同进程 cancel→resume 恢复即 cancelled**（src/engine.ts）：engine 的活跃 run 表在 run 结束后
不删除（cancel 幂等依赖），resume 时 `attach()` 复用旧 state——controller 已 abort、事件缓冲
已消费，新执行拿到已 aborted 的 signal 立即终止为 cancelled。V1 CLI 不受影响（resume 是新进程，
active 表为空），V2 长驻服务必踩。修复：`engine.resume` 在重建执行前 `active.delete(runId)`
丢弃旧执行态。回归：108 单元测试 + demo 7 步 + extra 8 断言全过。

## 6. 常见问题

- **`RUN_STILL_ACTIVE` 但进程已退出**：V2 服务同进程内 pid 永远存活（服务自己）；
  跨进程恢复请用 V1 CLI `pi-workflow resume`（死进程自动补偿 interrupted）。
- **模型不生效**：不传 model 时走 `~/.pi/agent/settings.json` 的 `defaultProvider`/`defaultModel`；
  临时换模型给脚本第二参数传 `provider/modelId`。
- **resume 后立即 cancelled**：早期版本的同进程 resume 缺陷，已修复（见 §5）；
  若仍出现请确认 dist 已重新 build（`npm run build`，全局命令符号链接自动生效）。
