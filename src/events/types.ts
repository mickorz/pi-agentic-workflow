/**
 * Workflow Event 类型（P3，V1 执行文档 §4.3）
 *
 * 事件是 CLI 展示、JSONL 持久化与 V2 Web SSE 的**同源**数据面：
 *  - schemaVersion 稳定；sequence 每 run 严格递增（append-only 可回放）
 *  - nodeId 为 scope 稳定身份（runId:callIndex / runId:wfK:callIndex）
 *  - payload 经脱敏与大小限制（不携带密钥/全量输出）
 */

export const WORKFLOW_EVENT_SCHEMA_VERSION = 1;

/** 事件类型全集（有限、文档化） */
export type WorkflowEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "node.replayed"
  | "agent.session.created"
  | "checkpoint.requested"
  | "checkpoint.resolved"
  | "log.appended";

export interface WorkflowEvent<T = unknown> {
  schemaVersion: typeof WORKFLOW_EVENT_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  /** per-run 严格递增 */
  sequence: number;
  /** ISO-8601 */
  timestamp: string;
  type: WorkflowEventType;
  nodeId?: string;
  attempt?: number;
  payload?: T;
}

/** 事件消费方（runtime → engine/CLI/持久化） */
export type WorkflowEventSink = (event: WorkflowEvent) => void;

export function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<WorkflowEvent>;
  return (
    v.schemaVersion === WORKFLOW_EVENT_SCHEMA_VERSION &&
    typeof v.eventId === "string" &&
    typeof v.runId === "string" &&
    typeof v.sequence === "number" &&
    typeof v.timestamp === "string" &&
    typeof v.type === "string"
  );
}
