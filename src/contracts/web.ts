/**
 * V2 Web 契约类型与 V1 事件映射（V2 执行文档 §3）
 *
 * 原则：磁盘上的 V1 事件（schemaVersion 1，字段 sequence）保持不变（CLI/Journal 兼容）；
 * Web/API 消费面经 toV2Event() 映射为 WorkflowEventV1（seq / run.created / checkpoint.approved|rejected）。
 */

import type { WorkflowEvent } from "../events/types.js";

export type RunStatusV2 =
  | "created"
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_checkpoint"
  | "interrupted";

export type RunDecision = "approve" | "reject";

export interface CheckpointRecordV2 {
  checkpointId: string;
  runId: string;
  nodeId: string;
  question: string;
  status: "pending" | "approved" | "rejected";
  /** 每次重新请求（resume 后重问）自增；决策须携带匹配的 expectedVersion */
  version: number;
  requestedAt: string;
  decisionAt?: string;
  decisionBy?: "local-user";
}

export interface StartRunInputV2 {
  projectId: string;
  workflowPath: string;
  args?: unknown;
  model?: string;
  concurrency?: number;
  timeoutMs?: number | null;
  retries?: number;
}

/** V2 标准事件协议（API/SSE 面） */
export interface WorkflowEventV1 {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  seq: number;
  timestamp: string;
  type:
    | "run.created"
    | "run.started"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "run.interrupted"
    | "phase.started"
    | "node.started"
    | "node.updated"
    | "node.completed"
    | "node.failed"
    | "node.cancelled"
    | "node.replayed"
    | "checkpoint.requested"
    | "checkpoint.approved"
    | "checkpoint.rejected"
    | "agent.session.created"
    | "log.appended";
  nodeId?: string;
  payload: Record<string, unknown>;
}

/** V1 磁盘事件 → V2 API 事件（同源映射，不改盘上格式） */
export function toV2Event(event: WorkflowEvent, options?: { created?: boolean }): WorkflowEventV1 {
  const base = {
    schemaVersion: 1 as const,
    eventId: event.eventId,
    runId: event.runId,
    seq: event.sequence,
    timestamp: event.timestamp,
    ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
    payload: (event.payload ?? {}) as Record<string, unknown>,
  };
  if (options?.created) {
    return { ...base, type: "run.created", payload: { ...base.payload, origin: "web" } };
  }
  switch (event.type) {
    case "checkpoint.resolved": {
      const approved = (event.payload as { approved?: boolean } | undefined)?.approved !== false;
      return { ...base, type: approved ? "checkpoint.approved" : "checkpoint.rejected" };
    }
    case "run.failed": {
      // 中断（死进程补偿）在应用层标注为 run.interrupted；事件原样保留 run.failed
      return { ...base, type: "run.failed" };
    }
    default:
      return { ...base, type: event.type };
  }
}
