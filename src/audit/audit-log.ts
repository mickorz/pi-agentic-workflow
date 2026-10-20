/**
 * AuditLog（SC-006，NFR-007/008）：关键操作审计落盘
 *  - 追加式 .pi-wechat/audit.jsonl；每行一条 AuditRecord
 *  - 写入前强制 redact（SC-004：凭据不入日志）
 *  - byRun(runId) 按 runId 串起：意图 → 路由 → 选模 → 审批 → 通知（NT-005，WX-2）
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuditAction, AuditRecord } from "../contracts/wx.js";
import { redact } from "./redact.js";

export interface AuditInput {
  actor: string;
  action: AuditAction;
  target?: AuditRecord["target"];
  outcome?: AuditRecord["outcome"];
  detail?: string;
}

export class AuditLog {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "audit.jsonl");
  }

  /** 追加一条审计（detail 先脱敏再落盘） */
  record(input: AuditInput): AuditRecord {
    const entry: AuditRecord = {
      auditId: `au-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      actor: input.actor,
      action: input.action,
      target: input.target ?? {},
      outcome: input.outcome ?? "ok",
      ...(input.detail !== undefined ? { detail: redact(input.detail) } : {}),
    };
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf-8");
    return entry;
  }

  list(): AuditRecord[] {
    if (!fs.existsSync(this.file)) return [];
    const out: AuditRecord[] = [];
    for (const raw of fs.readFileSync(this.file, "utf-8").split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as AuditRecord;
        if (parsed?.auditId && parsed.action) out.push(parsed);
      } catch {
        // 断裂行跳过（读端容忍）
      }
    }
    return out;
  }

  /** WX-2（NT-005）：按 runId 串起全链路审计 */
  byRun(runId: string): AuditRecord[] {
    return this.list().filter((r) => r.target.runId === runId);
  }
}
