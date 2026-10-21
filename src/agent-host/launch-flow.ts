/**
 * LaunchCoordinator（AM-P0 T5；V2.1 §2.3 启动关联三阶段 / §3.3 方案 B）
 *
 * 包裹 Dispatcher.execute 的唯一启动通道（agent 链路）：
 *  1) 启动前：RunLaunchAttempt 预写（launched）——TaskStore 不接收假 runId（契约不变）
 *  2) 成功后：attempt.linked（回填真实 runId）+ run-links 落行（attemptId/agentTurnId 关联）
 *  3) 同步失败：attempt.discarded（确定性作废，区别于不确定态）
 *
 * 重启恢复（recoverStale）：崩溃窗口遗留 launched →
 *  - 能与 TaskBinding 对上（userId+workflowId+originMessageId+时间窗）→ 自动补 linked
 *    + run-links 补挂（Run 已真实存在，非重启动）
 *  - 对不上 → unknown + 告警回调，禁自动重试（人工比对 .pi-workflows/runs/ 后处置）
 */

import { RunLaunchStore, RunLinkStore } from "./run-launch.js";
import { computeArgsDigest } from "./digest.js";
import type { RunLaunchAttempt } from "./types.js";
import type { ExecutionAuthorization, ExecuteResult, RoutePlan } from "../contracts/wx.js";
import type { Dispatcher } from "../dispatch/dispatcher.js";
import type { TaskStore } from "../dispatch/task-store.js";

export interface LaunchCoordinatorDeps {
  attempts: RunLaunchStore;
  runLinks: RunLinkStore;
  dispatcher: Dispatcher;
  /** 恢复期自动补链的比对源 */
  tasks: TaskStore;
  /** 方案 B 告警：启动结果不确定（禁自动重试，人工核对） */
  onUnknown?: (attempt: RunLaunchAttempt) => void;
}

export interface LaunchCorrelation {
  agentTurnId?: string;
}

export interface RecoveryOutcome {
  /** 自动补链成功（Run 已真实存在，恢复期未发起新启动） */
  linked: RunLaunchAttempt[];
  /** 启动结果不确定：unknown + 告警，待人工核对 */
  unknown: RunLaunchAttempt[];
}

export class LaunchCoordinator {
  constructor(private readonly deps: LaunchCoordinatorDeps) {}

  /** 启动通道：预写 attempt → dispatcher.execute（重校验/唯一入口不变）→ link + run-links */
  async execute(
    plan: RoutePlan,
    auth: ExecutionAuthorization,
    origin: { channel: string; userId: string; messageId: string },
    corr: LaunchCorrelation = {},
  ): Promise<ExecuteResult> {
    const attempt = this.deps.attempts.prewrite({
      userId: origin.userId,
      workflowId: plan.workflowId ?? "",
      argsDigest: computeArgsDigest(plan.args ?? {}),
      ...(corr.agentTurnId ? { agentTurnId: corr.agentTurnId } : {}),
      originMessageId: origin.messageId,
    });
    let result: ExecuteResult;
    try {
      result = await this.deps.dispatcher.execute(plan, auth, origin);
    } catch (e) {
      this.deps.attempts.discard(attempt.attemptId); // 确定性失败：作废，不进 unknown
      throw e;
    }
    this.deps.attempts.link(attempt.attemptId, result.runId, result.taskBindingId);
    this.mergeRunLink(result.runId, {
      runId: result.runId,
      taskBindingId: result.taskBindingId,
      status: result.status,
      attemptId: attempt.attemptId,
      ...(corr.agentTurnId ? { agentTurnId: corr.agentTurnId } : {}),
    });
    return result;
  }

  /**
   * 启动恢复（服务启动时调用一次）：处理崩溃窗口遗留的 launched attempt。
   * 全程零启动——只做比对/补链/告警，绝不调 dispatcher 重启动。
   */
  recoverStale(): RecoveryOutcome {
    const linked: RunLaunchAttempt[] = [];
    const unknown: RunLaunchAttempt[] = [];
    for (const attempt of this.deps.attempts.staleLaunched()) {
      const binding = this.deps.tasks.list().find(
        (t) =>
          t.userId === attempt.userId &&
          t.workflowId === attempt.workflowId &&
          (!attempt.originMessageId || t.messageId === attempt.originMessageId) &&
          t.createdAt >= attempt.createdAt,
      );
      if (binding) {
        // Run 已真实存在：自动补链（非重启动）
        this.deps.attempts.link(attempt.attemptId, binding.runId, binding.taskBindingId);
        this.mergeRunLink(binding.runId, {
          runId: binding.runId,
          taskBindingId: binding.taskBindingId,
          status: binding.status,
          attemptId: attempt.attemptId,
          ...(attempt.agentTurnId ? { agentTurnId: attempt.agentTurnId } : {}),
        });
        linked.push(this.deps.attempts.get(attempt.attemptId)!);
      } else {
        // 启动结果不确定：unknown + 告警，禁自动重试（方案 B）
        this.deps.attempts.markUnknown(attempt.attemptId);
        this.deps.onUnknown?.(attempt);
        unknown.push(this.deps.attempts.get(attempt.attemptId)!);
      }
    }
    return { linked, unknown };
  }

  /** run-links 合并写入（保留既有行字段：agentTurnId/attemptId 不被终态回写抹掉） */
  private mergeRunLink(runId: string, patch: Record<string, unknown>): void {
    const prev = this.deps.runLinks.get(runId);
    this.deps.runLinks.upsert({
      ...(prev ?? {}),
      ...patch,
      runId,
    } as Parameters<RunLinkStore["upsert"]>[0]);
  }
}
