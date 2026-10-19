# P3 执行报告 — Event API + Web Ready + 真实项目验收（V1 完结）

```text
Phase: P3（V1 最终阶段）
Target HEAD before: ba4d59c（P2 提交）
Target HEAD after: 本阶段 commit（见 git log P3 提交）
Source pinned SHA: 3373d1ae9c5f4adeaaea5d223582532410fba8f3 (opencode-dynamicworkflows v0.11.2)
Pi SDK version: @earendil-works/pi-coding-agent@1.3.0
```

## 交付清单

| 类别 | 内容 |
|---|---|
| 事件系统 | `src/events/{types,emitter,jsonl-sink}.ts`：WorkflowEvent（schemaVersion 1）、sequence 每 run 严格递增、payload 脱敏+4KB 限制、JSONL append-only、游标读取、连续性校验 |
| 事件接入 | runtime 全链路发射：`run.started/completed/failed/cancelled`、`node.started/completed/failed/replayed`、`agent.session.created`、`checkpoint.requested/resolved`、`log.appended`；resume **事件序号续接**（同 runId 连续） |
| 引擎 API | `src/engine.ts`：`createWorkflowEngine()` → start/resume/getRun/listRuns/cancel/respondToCheckpoint/readEventsSince；有界事件缓冲（500）+ 持久层游标兜底 |
| CLI | run/resume 事件落盘 events.jsonl（与 stdout 同源） |
| 验收案例 | `examples/feature-development.js`（分析→修复→测试→审查→审批→保存） |
| 测试 | 单元 101（events 5 / engine 5 新增）；e2e 新增真实功能开发闭环 2 用例 |
| 文档 | web-api-contract.md、README 重写（V1 实态）、CLI/DSL 补事件章节 |

## 验收结论

| 项 | 结果 | 证据 |
|---|---|---|
| P3-01 CLI 输出与持久化事件同源、sequence 单调、节点身份稳定 | ✅ | events.test.ts + e2e 断言 events.jsonl sequence 1..N 连续、nodeId=runId:callIndex |
| P3-02 按 event cursor 重放内容一致 | ✅ | readEvents(dir, after) 游标续读 = 原序；engine.readEventsSince |
| P3-03 第三方 TS 无需 CLI 调用 Core | ✅ | engine.test.ts：createWorkflowEngine + fake runner 完整 start/审批/取消/快照 |
| P3-04 ≥1 次真实功能开发闭环完整通过 | ✅ | e2e（真实 glm-5.3-flash）：探索定位 bug→general 修复 add(a-b)→check(npm test)→verify 2 审查→checkpoint 等待→resume 批准→completed；修复后项目 npm test 真实通过 |
| P3-05 失败/恢复/审核拒绝不被包装成成功 | ✅ | 拒绝路径 e2e：resume 输入 n → CHECKPOINT_REJECTED → failed；拒绝 journal 确定性回放（再 resume 仍硬停）；闸门/取消事件正确（run.failed/run.cancelled） |
| P3-06 build/typecheck/unit/integration/e2e 与 README 一致 | ✅ | 全绿；README 命令实跑一致 |

```text
Test commands:
  npm run typecheck && npm run build   # 0 错误
  npm test                             # 101 pass / 0 fail
  PI_WORKFLOW_INTEGRATION=1 npm run test:integration   # 4 pass
  PI_WORKFLOW_INTEGRATION=1 npm run test:e2e
  # → ✔ resume-e2e（SIGKILL 后回放）
  # → ✔ P3-04 真实闭环（251s：分析/修复/测试/审查/审批全链）
  # → ✔ P3-05 拒绝路径（131s）

Offline tests: 101 passed / 0 failed
Real SDK tests: 4 integration + 3 e2e passed（macOS / Node v25.6.1 / cc-switch-zhipu-glm）
Known limitations:
  - Windows/Linux 仅有路径归一化/命令参数兼容处理，未实机验证（backlog）
  - respondToCheckpoint 为 engine 进程内通道；跨进程审批待 V2 Server
  - 事件 payload 上限 4KB（全量输出走 result.json/journal）
Push result: 已 push 到 origin/master
Gate: PASS
```

## V1 完成定义核对（执行文档 §13）

- ✅ `pi-workflow run examples/feature-development.js` 真实 Pi Agent SDK 功能开发链通过（e2e 证据保留于测试输出）
- ✅ CLI、journal、resume、人工审批可独立使用
- ✅ 恢复行为有故障注入证据（SIGKILL e2e）
- ✅ Core 不依赖 CLI（engine.ts 公共 API + 依赖方向约束）
- ✅ V2 可直接复用公共接口接 Web Server（docs/web-api-contract.md）
