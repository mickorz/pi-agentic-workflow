/**
 * PendingAction 确认执行链（AM-P0 T4；V2.1 §3 全量）
 *
 * 确定性通道（用户聊天中明确「批准」/「拒绝」，由 gateway T7 接线，不经 LLM）：
 *  - confirm：原子认领（重校验 身份/registryDigest/argsDigest/有效期）→ 从服务端快照
 *    构造 RoutePlan 直调 dispatcher（authorized=true：用户已明确批准；LLM 无此通路）
 *    → complete 回填 {runId, taskBindingId}
 *  - 重复确认：claim 已 executed → 幂等返回原始结果，不再次启动
 *  - 确定性启动失败（同步异常：并发限额等）：unclaim 退回 pending，可再次确认
 *  - 方案 B（§3.3）：executing 悬置（claim 后进程中断）= 启动结果不确定 → recoverStuck
 *    仅告警，禁自动重试；T5 结合 RunLaunchAttempt 区分 linked/unknown 后人工核对
 */

import { PendingActionStore } from "./pending-action.js";
import { LaunchCoordinator } from "./launch-flow.js";
import { computeArgsDigest, computeRegistryDigest, sha256Hex } from "./digest.js";
import { OBSIDIAN_OP_KIND } from "./task-control-facade.js";
import type { PendingAction } from "./types.js";
import type { RoutePlan } from "../contracts/wx.js";
import type { WorkflowRegistry } from "../dispatch/registry.js";

export interface PendingFlowDeps {
  pending: PendingActionStore;
  registry: WorkflowRegistry;
  /** 启动通道（T5：预写 attempt → execute → link + run-links） */
  launcher: LaunchCoordinator;
  channel?: "wechat" | "cli";
  /** 方案 B 告警：executing 悬置（启动结果不确定，禁自动重试，待人工核对） */
  onUncertain?: (action: PendingAction) => void;
}

export type ConfirmOutcome =
  | { ok: true; runId: string; taskBindingId: string; alreadyExecuted?: boolean }
  | {
      ok: false;
      reason: "not_found" | "validation_failed" | "expired" | "rejected" | "busy" | "launch_failed";
      message: string;
      /** 幂等分支外的重复确认结果（already_executed 时带原始结果） */
      result?: { runId: string; taskBindingId: string };
    };

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 审批提示卡（VR #12）：服务端确定性生成——workflowId + 解析目标 + actionId 三要素，
 * 不依赖 Agent 自行描述（LLM 遗漏/描述错目标都不影响用户看到真实执行对象）。
 */
export function renderPendingActionApproval(action: PendingAction): string {
  // P1a Phase W（方案 §2.3）：Obsidian 写操作卡片只显示操作类型 + digest 前 8 位 + 预览 ≤80 字，
  // 不回显全文（全文仅存机内 PendingAction 快照）。
  const obsidianLines: string[] = [];
  const kind = OBSIDIAN_OP_KIND[action.workflowId];
  if (kind) {
    const args = (action.args ?? {}) as Record<string, unknown>;
    const content = typeof args.content === "string" ? args.content : "";
    const digest = sha256Hex(content).slice(0, 8);
    const preview = content.replace(/\s+/g, " ").trim().slice(0, 80);
    obsidianLines.push(`操作：${kind === "create" ? "创建笔记" : "追加内容"}（内容摘要 ${digest}）`);
    if (preview) obsidianLines.push(`预览：${preview}`);
  }
  return [
    "⏳ 待审批流程",
    `流程：${action.workflowId}`,
    ...(action.resolvedTarget ? [`目标：${action.resolvedTarget}`] : []),
    ...obsidianLines,
    `编号：${action.actionId}`,
    "",
    "回复「批准」执行；回复「拒绝」取消（多项待审批可用「批准 序号」）。",
  ].join("\n");
}

export class PendingActionService {
  private readonly channel: "wechat" | "cli";

  constructor(private readonly deps: PendingFlowDeps) {
    this.channel = deps.channel ?? "wechat";
  }

  /** 该用户待审批清单（AM-13 多项并存：通道层按序号/名称消歧） */
  listFor(userId: string): PendingAction[] {
    return this.deps.pending.pendingFor(userId);
  }

  /** 确认并执行（确定性通道入口；从服务端快照取参，不依赖会话记忆） */
  async confirm(actionId: string, userId: string): Promise<ConfirmOutcome> {
    const action = this.deps.pending.get(actionId);
    if (!action) return { ok: false, reason: "not_found", message: "待审批项不存在或已处理" };

    const claim = await this.deps.pending.claim(actionId, {
      userId,
      registryDigest: computeRegistryDigest(this.deps.registry),
      argsDigest: computeArgsDigest(action.args),
    });
    if (!claim.ok) {
      if (claim.reason === "already_executed") {
        if (claim.result) return { ok: true, ...claim.result, alreadyExecuted: true }; // 幂等：返回原始结果，不再启动
        return { ok: false, reason: "busy", message: "该授权已执行但结果记录缺失（需人工核对）" };
      }
      if (claim.reason === "already_claimed") {
        return { ok: false, reason: "busy", message: "该授权正在执行中（如长时间无结果将进入人工核对）" };
      }
      if (claim.reason === "not_found") {
        return { ok: false, reason: "not_found", message: "待审批项不存在或已处理" };
      }
      return {
        ok: false,
        reason: claim.reason,
        message: "detail" in claim ? claim.detail : "确认未通过重校验",
      };
    }

    // 认领成功：从快照构造 RoutePlan 直调（不触发 IntentRouter）
    const plan: RoutePlan = {
      intent: "execute_workflow",
      action: "start_execution",
      workflowId: claim.action.workflowId,
      args: (claim.action.args ?? {}) as Record<string, unknown>,
      reason: "执行前授权确认（PendingAction 快照）",
      confidence: 1,
    };
    try {
      const r = await this.deps.launcher.execute(
        plan,
        { actor: userId, authorized: true, entrypoint: this.channel },
        { channel: this.channel, userId, messageId: claim.action.originMessageId },
        { agentTurnId: claim.action.agentTurnId },
      );
      this.deps.pending.complete(actionId, { runId: r.runId, taskBindingId: r.taskBindingId });
      return { ok: true, runId: r.runId, taskBindingId: r.taskBindingId };
    } catch (e) {
      // 确定性同步失败：退回 pending（可再次确认）；进程中断不确定态不在本分支
      this.deps.pending.unclaim(actionId);
      return { ok: false, reason: "launch_failed", message: `启动失败：${errMessage(e)}` };
    }
  }

  /** 拒绝（本人；确定性通道） */
  rejectAction(actionId: string, userId: string): { ok: boolean; message: string } {
    const action = this.deps.pending.get(actionId);
    if (!action) return { ok: false, message: "待审批项不存在" };
    if (action.userId !== userId) return { ok: false, message: "非本人授权项" };
    if (action.status !== "pending") return { ok: false, message: `该授权已处于 ${action.status} 状态` };
    this.deps.pending.reject(actionId);
    return { ok: true, message: `已拒绝 ${action.workflowId} 的执行请求` };
  }

  /**
   * 启动恢复扫描（方案 B）：executing 悬置 = claim 后进程中断，启动结果不确定。
   * 仅逐条告警，禁自动重试/自动完成；状态保持 executing 待人工核对
   * （T5 接入 RunLaunchAttempt 后可区分 linked/unknown 细化处置）。
   */
  recoverStuck(): PendingAction[] {
    const stuck = this.deps.pending.listByStatus("executing");
    for (const action of stuck) this.deps.onUncertain?.(action);
    return stuck;
  }
}
