/**
 * CheckpointService —— 持久化审批记录与状态机（V2-P0-06）
 *
 * 存储：.pi-workflows/runs/<runId>/checkpoints.jsonl（append-only）
 *  - requested 行：{kind:"requested", checkpointId, nodeId, question, version, requestedAt}
 *  - decision  行：{kind:"decision", checkpointId, decision, decidedAt, decidedBy, version}
 * 读 = 折叠：同 checkpointId 的最后 requested 定 version；decision 附加状态。
 *
 * 规则（V2 §3.2）：
 *  - checkpointId = nodeId（V1 journal 稳定身份）
 *  - resume 后重问 → version 自增；决策必须携带匹配 expectedVersion
 *  - 重复决策：已决 → 返回既有结果（幂等）；版本不匹配 → CONFLICT
 *  - decisionBy V2 只能是 local-user
 */

import fs from "node:fs";
import path from "node:path";
import { runDir } from "../persistence/run-store.js";
import type { CheckpointRecordV2, RunDecision } from "../contracts/web.js";

interface RequestedLine {
  kind: "requested";
  checkpointId: string;
  nodeId: string;
  question: string;
  version: number;
  requestedAt: string;
}
interface DecisionLine {
  kind: "decision";
  checkpointId: string;
  decision: RunDecision;
  decidedAt: string;
  decidedBy: "local-user";
  version: number;
}
type Line = RequestedLine | DecisionLine;

export class CheckpointService {
  constructor(private readonly baseDir: string) {}

  private file(runId: string): string {
    return path.join(runDir(this.baseDir, runId), "checkpoints.jsonl");
  }

  private readLines(runId: string): Line[] {
    const file = this.file(runId);
    if (!fs.existsSync(file)) return [];
    const lines: Line[] = [];
    for (const raw of fs.readFileSync(file, "utf-8").split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Line;
        if (parsed && (parsed.kind === "requested" || parsed.kind === "decision")) lines.push(parsed);
      } catch {
        // 断裂行跳过（读端容忍）
      }
    }
    return lines;
  }

  /** 折叠出全部记录（最后 requested 为当前 version；decision 附加状态） */
  list(runId: string): CheckpointRecordV2[] {
    const byId = new Map<string, CheckpointRecordV2>();
    for (const line of this.readLines(runId)) {
      if (line.kind === "requested") {
        byId.set(line.checkpointId, {
          checkpointId: line.checkpointId,
          runId,
          nodeId: line.nodeId,
          question: line.question,
          status: "pending",
          version: line.version,
          requestedAt: line.requestedAt,
        });
      } else {
        const record = byId.get(line.checkpointId);
        if (record) {
          record.status = line.decision === "approve" ? "approved" : "rejected";
          record.decisionAt = line.decidedAt;
          record.decisionBy = line.decidedBy;
        }
      }
    }
    return [...byId.values()];
  }

  get(runId: string, checkpointId: string): CheckpointRecordV2 | null {
    return this.list(runId).find((r) => r.checkpointId === checkpointId) ?? null;
  }

  /** 登记一次请求（resume 重问 → version 自增）。返回当前记录 */
  recordRequested(runId: string, checkpointId: string, nodeId: string, question: string): CheckpointRecordV2 {
    const existing = this.get(runId, checkpointId);
    const version = (existing?.version ?? 0) + 1;
    const line: RequestedLine = {
      kind: "requested",
      checkpointId,
      nodeId,
      question,
      version,
      requestedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.file(runId)), { recursive: true });
    fs.appendFileSync(this.file(runId), `${JSON.stringify(line)}\n`, "utf-8");
    return {
      checkpointId,
      runId,
      nodeId,
      question,
      status: "pending",
      version,
      requestedAt: line.requestedAt,
    };
  }

  /**
   * 决策校验（不动执行，只校验并持久化决策意图）：
   *  - pending + version 匹配 → 追加 decision 行，返回 { ok: true, record }
   *  - 已决（同决策）→ 幂等返回 { ok: true, record, idempotent: true }
   *  - 已决（不同决策）或 version 不匹配 → { ok: false, reason: "CONFLICT" }
   *  - 不存在/非 pending → { ok: false, reason: "CHECKPOINT_NOT_PENDING" | "NOT_FOUND" }
   */
  applyDecision(
    runId: string,
    checkpointId: string,
    input: { decision: RunDecision; expectedVersion: number },
  ): { ok: true; record: CheckpointRecordV2; idempotent?: boolean } | { ok: false; reason: string } {
    const record = this.get(runId, checkpointId);
    if (!record) return { ok: false, reason: "NOT_FOUND" };
    if (record.status !== "pending") {
      const applied = record.status === "approved" ? "approve" : "reject";
      return applied === input.decision && record.version === input.expectedVersion
        ? { ok: true, record, idempotent: true }
        : { ok: false, reason: "CONFLICT" };
    }
    if (record.version !== input.expectedVersion) return { ok: false, reason: "CONFLICT" };
    const line: DecisionLine = {
      kind: "decision",
      checkpointId,
      decision: input.decision,
      decidedAt: new Date().toISOString(),
      decidedBy: "local-user",
      version: input.expectedVersion,
    };
    fs.appendFileSync(this.file(runId), `${JSON.stringify(line)}\n`, "utf-8");
    record.status = input.decision === "approve" ? "approved" : "rejected";
    record.decisionAt = line.decidedAt;
    record.decisionBy = "local-user";
    return { ok: true, record };
  }
}
