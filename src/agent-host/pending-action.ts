/**
 * 执行前授权状态机（AM-P0 T1 纯逻辑；V2.1 §3）
 *
 * pending ──claim(原子认领)──► executing ──complete──► executed
 *   │                              │
 *   ├─ reject                     └─（启动不确定归 RunLaunchAttempt unknown 域，不在此处理）
 *   └─ expire（超时）
 *
 * 硬规则：
 *  - 同一 actionId 只能有一个执行者获得启动资格（claim 单调 pending→executing）
 *  - 重复确认（claim 已 executed 项）幂等返回原始 result，不得再次启动
 *  - 确认时重校验：userId / registryDigest / argsDigest / 有效期，任一不符作废
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PendingAction, PendingActionStatus } from "./types.js";

export interface CreatePendingActionInput {
  userId: string;
  workflowId: string;
  args: unknown;
  argsDigest: string;
  agentTurnId?: string;
  originMessageId: string;
  riskLevel: string;
  registryDigest: string;
  /** VR S4.2：审批前预检解析目标（审批卡展示；未声明 anyOfArgs 的流程无此字段） */
  resolvedTarget?: string;
  ttlMs?: number;
}

export type ClaimResult =
  | { ok: true; action: PendingAction }
  | { ok: false; reason: "not_found" | "already_claimed" | "already_executed"; result?: PendingAction["result"] }
  | { ok: false; reason: "rejected" | "expired" | "validation_failed"; detail: string };

const FILE = "pending-actions.jsonl";

export class PendingActionStore {
  private readonly file: string;
  private readonly byId = new Map<string, PendingAction>();
  /** 同进程串行队列（P0 并发保证；跨进程由 jsonl 追加序 + 状态单调性兜底） */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, FILE);
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, "utf8").trim().split(/\r?\n/)) {
        if (!line) continue;
        const rec = JSON.parse(line) as PendingAction;
        this.byId.set(rec.actionId, rec); // 末条生效（状态更新追加式）
      }
    }
  }

  private serialize(action: PendingAction): void {
    fs.appendFileSync(this.file, `${JSON.stringify(action)}\n`, "utf8");
    this.byId.set(action.actionId, action);
  }

  private enqueue<T>(fn: () => T): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  create(input: CreatePendingActionInput): PendingAction {
    const now = new Date().toISOString();
    const action: PendingAction = {
      actionId: `pa-${randomUUID().slice(0, 8)}`,
      userId: input.userId,
      workflowId: input.workflowId,
      args: input.args,
      argsDigest: input.argsDigest,
      ...(input.agentTurnId ? { agentTurnId: input.agentTurnId } : {}),
      originMessageId: input.originMessageId,
      riskLevel: input.riskLevel,
      registryDigest: input.registryDigest,
      ...(input.resolvedTarget ? { resolvedTarget: input.resolvedTarget } : {}),
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + (input.ttlMs ?? 10 * 60_000)).toISOString(),
      status: "pending",
    };
    this.serialize(action);
    return action;
  }

  /** 该用户是否存在待授权项（dispatcher 确定性直通判定） */
  hasPending(userId: string): boolean {
    return this.pendingFor(userId).length > 0;
  }

  pendingFor(userId: string): PendingAction[] {
    // 2026-10-27 真机教训（审批死循环）：过期项若不滤除会永远占据列表首位，
    // 用户后续每次「批准」都绑到死项 → claim 只会回「授权已过期」→ 永久卡死。
    // 过滤在 pendingFor 层做（hasPending/审批卡/确定性通道全部受益），claim 处的过期兜底保留。
    const now = new Date().toISOString();
    return [...this.byId.values()].filter(
      (a) => a.userId === userId && a.status === "pending" && a.expiresAt > now,
    );
  }

  /** 原子认领：确认（重校验）→ executing。重复确认已 executed 项返回原始结果（幂等） */
  claim(
    actionId: string,
    check: { userId: string; registryDigest: string; argsDigest?: string },
  ): Promise<ClaimResult> {
    return this.enqueue(() => this.claimSync(actionId, check));
  }

  private claimSync(actionId: string, check: { userId: string; registryDigest: string; argsDigest?: string }): ClaimResult {
    const action = this.byId.get(actionId);
    if (!action) return { ok: false, reason: "not_found" };
    if (action.status === "executed") return { ok: false, reason: "already_executed", result: action.result };
    if (action.status === "executing") return { ok: false, reason: "already_claimed" };
    if (action.status === "rejected") return { ok: false, reason: "rejected", detail: "该授权已被拒绝" };
    if (action.expiresAt < new Date().toISOString()) {
      this.serialize({ ...action, status: "expired" });
      return { ok: false, reason: "expired", detail: "授权已过期" };
    }
    if (action.userId !== check.userId) return { ok: false, reason: "validation_failed", detail: "非本人授权" };
    if (action.registryDigest !== check.registryDigest)
      return { ok: false, reason: "validation_failed", detail: "注册表已变化，需重新发起" };
    if (check.argsDigest !== undefined && action.argsDigest !== check.argsDigest)
      return { ok: false, reason: "validation_failed", detail: "参数已变化，需重新发起" };
    this.serialize({ ...action, status: "executing" });
    return { ok: true, action: this.byId.get(actionId)! };
  }

  /** 启动完成回填（executing → executed）；重复 complete 幂等 */
  complete(actionId: string, result: { runId: string; taskBindingId: string }): void {
    const action = this.byId.get(actionId);
    if (!action || action.status === "executed") return;
    this.serialize({ ...action, status: "executed", result });
  }

  reject(actionId: string): void {
    const action = this.byId.get(actionId);
    if (!action || action.status !== "pending") return;
    this.serialize({ ...action, status: "rejected" });
  }

  /**
   * 确定性启动失败回退（executing → pending）：仅同步异常路径（如并发限额拒绝），
   * 可再次确认；进程中断的不确定态不走这里（由 recoverStuck 告警 + 人工核对）。
   */
  unclaim(actionId: string): void {
    const action = this.byId.get(actionId);
    if (!action || action.status !== "executing") return;
    this.serialize({ ...action, status: "pending" });
  }

  /** 过期清理：pending/executing 超时 → expired；返回清理数 */
  expireDue(now = new Date().toISOString()): number {
    let n = 0;
    for (const action of this.byId.values()) {
      if ((action.status === "pending" || action.status === "executing") && action.expiresAt < now) {
        this.serialize({ ...action, status: "expired" });
        n++;
      }
    }
    return n;
  }

  get(actionId: string): PendingAction | undefined {
    return this.byId.get(actionId);
  }

  listByStatus(status: PendingActionStatus): PendingAction[] {
    return [...this.byId.values()].filter((a) => a.status === status);
  }
}
