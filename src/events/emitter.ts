/**
 * 事件发射器：sequence 单调分配 + 脱敏 + 大小限制
 */

import { randomUUID } from "node:crypto";
import { WORKFLOW_EVENT_SCHEMA_VERSION, type WorkflowEvent, type WorkflowEventType, type WorkflowEventSink } from "./types.js";
import { redactValue, truncateUtf8ByBytes } from "../runtime/agent-result.js";

/** 单事件 payload 的字节预算（防事件膨胀） */
const PAYLOAD_LIMIT_BYTES = 4096;

export interface EventEmitter {
  emit(type: WorkflowEventType, options?: { nodeId?: string; attempt?: number; payload?: unknown }): void;
}

export function createEventEmitter(runId: string, sink?: WorkflowEventSink, startSequence = 0): EventEmitter {
  let sequence = startSequence;
  return {
    emit(type, options = {}) {
      sequence += 1;
      const event: WorkflowEvent = {
        schemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
        eventId: `${runId}:${sequence}`,
        runId,
        sequence,
        timestamp: new Date().toISOString(),
        type,
        ...(options.nodeId !== undefined ? { nodeId: options.nodeId } : {}),
        ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
        ...(options.payload !== undefined ? { payload: sanitizePayload(options.payload) } : {}),
      };
      sink?.(event);
    },
  };
}

/** 脱敏 + 4KB 截断（序列化失败退化为 String）；返回脱敏后的副本 */
function sanitizePayload(payload: unknown): unknown {
  try {
    const redacted = redactValue(payload);
    const serialized = JSON.stringify(redacted);
    if (serialized === undefined) return { preview: truncateUtf8ByBytes(String(payload), PAYLOAD_LIMIT_BYTES) };
    if (serialized.length <= PAYLOAD_LIMIT_BYTES) return redacted;
    return { preview: truncateUtf8ByBytes(serialized, PAYLOAD_LIMIT_BYTES) };
  } catch {
    return { preview: truncateUtf8ByBytes(String(payload), PAYLOAD_LIMIT_BYTES) };
  }
}

export { randomUUID };
