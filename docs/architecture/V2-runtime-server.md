# V2 运行时与服务器架构（P0-07 设计基线）

> 状态：V2-P0 落地应用服务与契约；Worker 子进程模型在 V2-P1 实施，本文为其设计基线（ADR 形式）。
> 相关：docs/web-api-contract.md（V1 引擎 API 映射）、V2 执行文档 §2.2/§6。

## 1. 进程模型

```text
Browser ── HTTP/SSE ──▶ Web Server（单用户本机）
                         ├── RunApplicationService（唯一启停/恢复/审批入口）
                         ├── RunSupervisor（Worker 生命周期与所有权）
                         └── EventStore（events.jsonl 同源持久化）
                                │ IPC（stdio JSON 行协议）
                                ▼
                          Worker 子进程 × N（上限 maxConcurrentRuns，默认 2）
                                └── Workflow Core + PiAgentAdapter（V1 原样）
```

- 长生命周期 Workflow **不绑定 HTTP 请求**：页面断开/刷新不影响 Worker。
- Server 重启：不主动杀 Worker；按 manifest+pid+启动时间校验后**只读发现**，误杀防护（§3）。

## 2. Worker IPC 协议（JSON lines over stdio）

| 方向 | 消息 | 说明 |
|---|---|---|
| S→W | `{"type":"start","runId","scriptPath","args",...}` | 唯一启动指令 |
| S→W | `{"type":"cancel","runId"}` | 优雅取消（Worker 内 AbortController） |
| W→S | `{"type":"ready","pid","runId"}` | Worker 完成初始化 |
| W→S | `{"type":"heartbeat","runId","ts"}` | 每 5s；Server 侧 30s 阈值判失联 |
| W→S | `{"type":"event","event":WorkflowEvent}` | Runtime onEvent 直传（Server 统一写 events.jsonl，先持久化后 SSE） |
| W→S | `{"type":"checkpoint","checkpointId","question","version"}` | 审批请求（同步写 checkpoints.jsonl） |
| W→S | `{"type":"terminal","runId","status","error?"}` | 终态（completed/failed/cancelled/waiting_checkpoint） |

Server→Worker 审批：`{"type":"checkpointDecision","checkpointId","decision"}`；Worker 校验持久记录后回执。

## 3. Run 写入所有权规则

1. **单写者**：每个 runId 同一时刻至多一个活跃 Worker；Server 持 `runId → {workerPid, startedAt, ownerInstanceId}` 映射，启动前持久化到 manifest。
2. **身份校验**：任何 stop/cancel 不凭裸 PID：必须 `manifest.pid === 活跃映射 pid` 且 `startedAt` 匹配且心跳活跃；PID 复用不误判。
3. **IPC 优先**：取消顺序 = IPC cancel → 10s 优雅超时 → SIGTERM → 3s → SIGKILL；对非本 Server 启动的历史进程（如 CLI 遗留）只读发现，不发送信号。
4. **事件单写**：events.jsonl 由 Worker 产出、Server 统一追加（Worker 经 IPC 上送）；避免双进程写同文件。
5. **资源限额**：maxConcurrentRuns（默认 2，RUN_LIMIT_REACHED）、单 run V1 既有 maxAgents/concurrency 限额、日志保留 eventRetentionDays（清理任务 V2-P1）。

## 4. 当前实现状态（V2-P0）

- `RunApplicationService`（src/application/run-service.ts）：in-process 执行 + 持久化审批 + 限额 + 副作用确认——接口与 Worker 模型一致，P1 将 `engine` 执行点替换为 Supervisor 调度，API 不变。
- `CheckpointService`：checkpoints.jsonl append-only 状态机（pending/approved/rejected + version + expectedVersion）。
- 事件：V1 磁盘格式不变；API 面经 `toV2Event()` 映射（seq / checkpoint.approved|rejected / run.created）。
- P0 门禁内以「服务实例重建」模拟跨进程重启（等待审批记录与 resume 重问已验证）；真实子进程心跳/失联清理在 P1 验收。
