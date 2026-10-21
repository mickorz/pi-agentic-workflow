# V2 Web 接入契约（基于 V1 Runtime 公共 API）

> V1 不实现 Web Server；本文定义 V2 如何复用同一套引擎与事件协议。
> 引擎入口：`createWorkflowEngine(config)` → `WorkflowEngine`（src/engine.ts，随包导出）。
>
> **V2 已交付**：HTTP/SSE 服务与 React 工作台见 [web-getting-started.md](web-getting-started)。
> REST 端点/DTO/错误码的机器可读真源：
> - 静态快照：[api/web-openapi.json](api/web-openapi.json)（构建期生成）
> - 运行时活文档：`GET /api/openapi.json`（需 token，与实现同源永不过期）
> - 契约源码：`src/server/contract.ts`（`API_ROUTES` / DTO / `ApiErrorCode`）

## 能力映射

| V2 Web 能力 | V1 API |
|---|---|
| 启动 run | `engine.start(input)` → `WorkflowHandle { runId, events, result }` |
| 订阅事件流（SSE） | `handle.events`（AsyncIterable）实时段 + `engine.readEventsSince(runId, cursor)` 断线续读 |
| 人工审批 | `engine.respondToCheckpoint(runId, "approve" \| "reject")`；请求方订阅 `checkpoint.requested` 事件 |
| 查询历史 | `engine.listRuns()` / `engine.getRun(runId)`（含事件游标与校验） |
| 取消 | `engine.cancel(runId)`（进程内；跨进程需 V2 进程模型：单 Engine 宿主进程） |
| 恢复 | `engine.resume(runId)`（journal 回放 + 事件序号续接） |

## SSE 事件流映射

```
GET /runs/:id/events?after=<sequence>   → text/event-stream
data: {"schemaVersion":1,"runId":...,"sequence":N,"type":"node.completed",...}
```

- `after` 即事件游标（`RunSnapshot.events.lastSequence`）。
- 事件 append-only 落盘 events.jsonl，服务重启后从持久层续读，不丢事件。
- 内存订阅有界（500 条缓冲），慢消费者必须转游标模式。

## 契约要点

1. **同源**：CLI 输出、JSONL、SSE 消费同一 `WorkflowEvent`（schemaVersion 1）。
2. **审批不自动通过**：`checkpoint.requested` 后 run 挂起为 `waiting_checkpoint`，仅 `respondToCheckpoint` 可推进。
3. **状态机**：`created → running → completed | failed | cancelled | waiting_checkpoint | interrupted`；Web 展示用 `getRun().effectiveStatus`（死进程补偿）。
4. **V2 进程模型**：Web Server 进程内持有一个 Engine 实例（cancel 语义限本进程）；多实例部署需引入 run 所有权路由（V2 设计范围）。
