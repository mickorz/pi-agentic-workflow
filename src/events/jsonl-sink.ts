/**
 * JSONL 事件存储（append-only）与游标读取（P3-02：按 cursor 回放）
 */

import fs from "node:fs";
import path from "node:path";
import { isWorkflowEvent, type WorkflowEvent } from "./types.js";

export function eventsPath(runDir: string): string {
  return path.join(runDir, "events.jsonl");
}

/** 当前最大序号（resume 续接用；无文件/空文件为 0） */
export function lastEventSequence(runDir: string): number {
  const { events } = readEvents(runDir);
  return events.length > 0 ? (events[events.length - 1]?.sequence ?? 0) : 0;
}

/** 追加事件（同步写：事件的耐久点） */
export function appendEvent(runDir: string, event: WorkflowEvent): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(eventsPath(runDir), `${JSON.stringify(event)}\n`, "utf-8");
}

export interface EventsReadResult {
  events: WorkflowEvent[];
  /** 损坏/非法行数（读端容忍） */
  skipped: number;
}

/** 读取事件（可从 afterSequence 游标继续；保持文件顺序 = sequence 顺序） */
export function readEvents(runDir: string, afterSequence = 0): EventsReadResult {
  const file = eventsPath(runDir);
  if (!fs.existsSync(file)) return { events: [], skipped: 0 };
  const events: WorkflowEvent[] = [];
  let skipped = 0;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isWorkflowEvent(parsed) && parsed.sequence > afterSequence) {
        events.push(parsed);
      } else if (!isWorkflowEvent(parsed)) {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  events.sort((a, b) => a.sequence - b.sequence);
  return { events, skipped };
}

/** 校验事件流完整性：sequence 严格递增且从 1 连续 */
export function validateEventSequence(events: WorkflowEvent[]): { valid: boolean; issue?: string } {
  let expected = events[0]?.sequence ?? 1;
  for (const event of events) {
    if (event.sequence !== expected) {
      return { valid: false, issue: `sequence 断裂：期望 ${expected}，实际 ${event.sequence}` };
    }
    expected += 1;
  }
  return { valid: true };
}
