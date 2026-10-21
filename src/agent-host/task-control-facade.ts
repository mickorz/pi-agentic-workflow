/**
 * TaskControlFacade（AM-P0 T3；V2.1 §2.2）：AgentToolFacade 的结构化实现
 *
 * 五工具的内部薄封装（对齐现有 API，全部结构化返回——结果可被 LLM 继续决策）：
 *  - searchWorkflows：query 空 → registry.all() 完整能力清单；有 query → registry.search() 候选发现
 *  - executeWorkflow：read-only 构造 RoutePlan 直调 dispatcher.execute（绝不触发 IntentRouter）；
 *    高风险 → PendingActionStore.create 返 needsApproval（§3 执行前授权入口；确认走确定性通道，
 *    LLM 不得自授权——executeWorkflow 不存在 authorized 入参）
 *  - taskStatus/taskCancel/taskResume：TaskStore 归属校验后直操作 RunApplicationService
 *    结构化子集（TaskControlService），结果经 run-links 取真实产物引用（§5 不靠模型记忆）
 *
 * T4/T5 在此之上补：PendingAction 确认执行链 + RunLaunchAttempt 三阶段 + run-links 回填。
 */

import { PendingActionStore } from "./pending-action.js";
import { RunLinkStore } from "./run-launch.js";
import { LaunchCoordinator } from "./launch-flow.js";
import { computeArgsDigest, computeRegistryDigest } from "./digest.js";
import type {
  AgentToolFacade,
  TaskStatusResult,
  WorkflowExecuteResult,
  WorkflowSearchItem,
} from "./types.js";
import type { TaskBinding, RoutePlan } from "../contracts/wx.js";
import type { TaskControlService } from "../dispatch/task-control.js";
import type { TaskStore } from "../dispatch/task-store.js";
import type { WorkflowRegistry } from "../dispatch/registry.js";

export interface TaskControlFacadeDeps {
  registry: WorkflowRegistry;
  /** 启动通道（T5：预写 attempt → dispatcher.execute → link + run-links） */
  launcher: LaunchCoordinator;
  tasks: TaskStore;
  /** RunApplicationService 结构化子集（get/cancel/resume） */
  service: TaskControlService;
  /** §3 执行前授权存储 */
  pending: PendingActionStore;
  /** §5 Run 结果关联（终态真实产物引用） */
  runLinks: RunLinkStore;
  /** 入口渠道（TaskBinding.channel；P0 agent 模式仅微信） */
  channel?: "wechat" | "cli";
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function serviceCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

export class TaskControlFacade implements AgentToolFacade {
  private readonly channel: "wechat" | "cli";

  constructor(private readonly deps: TaskControlFacadeDeps) {
    this.channel = deps.channel ?? "wechat";
  }

  async searchWorkflows(query?: string): Promise<WorkflowSearchItem[]> {
    const regs = query && query.trim() ? this.deps.registry.search(query) : this.deps.registry.all(true);
    return regs.map((reg) => ({
      id: reg.workflowId,
      name: reg.name,
      description: reg.description,
      requiredArgs: ((reg.argsSchema as { required?: string[] }).required ?? []),
      riskLevel: reg.riskLevel,
    }));
  }

  async executeWorkflow(input: {
    userId: string;
    workflowId: string;
    args: unknown;
    agentTurnId: string;
    originMessageId: string;
  }): Promise<WorkflowExecuteResult> {
    const reg = this.deps.registry.get(input.workflowId);
    if (!reg) {
      return { error: `流程不存在或已下线：${input.workflowId}（可先用 workflow_search 获取可用清单）` };
    }
    if (reg.riskLevel === "read-only") {
      // RoutePlan 直调（不触发 IntentRouter）；dispatcher 内部重校验 Registry/Schema/守卫
      const plan: RoutePlan = {
        intent: "execute_workflow",
        action: "start_execution",
        workflowId: input.workflowId,
        args: (input.args ?? {}) as Record<string, unknown>,
        reason: "agent 工具直调（workflow_execute）",
        confidence: 1,
      };
      try {
        const r = await this.deps.launcher.execute(
          plan,
          { actor: input.userId, authorized: true, entrypoint: this.channel },
          { channel: this.channel, userId: input.userId, messageId: input.originMessageId },
          { agentTurnId: input.agentTurnId },
        );
        return { accepted: true, runId: r.runId, taskBindingId: r.taskBindingId, status: r.status };
      } catch (e) {
        return { error: errMessage(e) };
      }
    }
    // 高风险：创建执行前授权项（§3）。确认必须走确定性通道（用户明确批准），
    // 本工具链路上不存在 authorized=true 的通路——LLM 无法自授权。
    const action = this.deps.pending.create({
      userId: input.userId,
      workflowId: input.workflowId,
      args: input.args ?? {},
      argsDigest: computeArgsDigest(input.args),
      ...(input.agentTurnId ? { agentTurnId: input.agentTurnId } : {}),
      originMessageId: input.originMessageId,
      riskLevel: reg.riskLevel,
      registryDigest: computeRegistryDigest(this.deps.registry),
    });
    return { needsApproval: true, actionId: action.actionId };
  }

  async taskStatus(
    userId: string,
    ref: { runId?: string; taskBindingId?: string },
  ): Promise<TaskStatusResult> {
    if (!ref.runId && !ref.taskBindingId) {
      return { runId: "", status: "invalid", error: "需要提供 runId 或 taskBindingId 之一" };
    }
    const binding = this.findBinding(ref);
    if (!binding) {
      return { runId: ref.runId ?? "", status: "not_found", error: "任务不存在（可用最近任务的 taskBindingId 查询）" };
    }
    if (binding.userId !== userId) {
      // 归属校验：拒绝且不泄露任务细节（AM-12）
      return { runId: binding.runId, status: "forbidden", error: "无权访问该任务" };
    }
    // 真实状态：优先 RunApplicationService 实况；run-links 兜底（服务不可达/重启窗口）
    let snapshot: Awaited<ReturnType<TaskControlService["get"]>> = null;
    try {
      snapshot = await this.deps.service.get(binding.runId);
    } catch {
      // 快照不可得时退回关联记录与本地绑定状态
    }
    const link = this.deps.runLinks.get(binding.runId);
    const status = snapshot?.snapshot.effectiveStatus ?? link?.status ?? binding.status;
    const result: TaskStatusResult = { runId: binding.runId, status };
    const summary = link?.resultSummary ?? summarizeResult(snapshot?.snapshot.result);
    if (summary) result.resultSummary = summary;
    if (link?.resultRef) result.resultRef = link.resultRef;
    if (status === "failed") result.error = "任务失败（可用 task_resume 重试需确认副作用，或重新发起）";
    return result;
  }

  async taskCancel(userId: string, runId: string): Promise<{ ok: boolean; message: string }> {
    const binding = this.findBinding({ runId });
    if (!binding) return { ok: false, message: `任务不存在：${runId}` };
    if (binding.userId !== userId) return { ok: false, message: "无权操作该任务" };
    if (TERMINAL.has(binding.status)) {
      return { ok: false, message: `任务已处于终态（${binding.status}），无需取消` };
    }
    try {
      await this.deps.service.cancel(runId);
    } catch (e) {
      return { ok: false, message: errMessage(e) };
    }
    this.deps.tasks.update(runId, { status: "cancelled" });
    return { ok: true, message: `已取消任务 ${runId}（taskBindingId=${binding.taskBindingId}）` };
  }

  async taskResume(
    userId: string,
    runId: string,
    options?: { confirmSideEffects?: boolean },
  ): Promise<{ ok: boolean; message: string; needsConfirm?: boolean }> {
    const binding = this.findBinding({ runId });
    if (!binding) return { ok: false, message: `任务不存在：${runId}` };
    if (binding.userId !== userId) return { ok: false, message: "无权操作该任务" };
    try {
      await this.deps.service.resume(runId, { acknowledgeSideEffects: options?.confirmSideEffects === true });
    } catch (e) {
      if (serviceCode(e) === "SIDE_EFFECTS_UNACKNOWLEDGED") {
        // EX-009：副作用确认词走确定性通道；工具只提示，不代确认
        return {
          ok: false,
          needsConfirm: true,
          message: "该任务中断时存在未确认副作用，恢复可能重复执行部分操作；请回复「确认恢复」后重试",
        };
      }
      return { ok: false, message: errMessage(e) };
    }
    this.deps.tasks.update(runId, { status: "running" });
    return { ok: true, message: `已恢复任务 ${runId}，可用 task_status 查看进度` };
  }

  private findBinding(ref: { runId?: string; taskBindingId?: string }): TaskBinding | undefined {
    return this.deps.tasks.list().find((t) =>
      ref.runId ? t.runId === ref.runId : t.taskBindingId === ref.taskBindingId,
    );
  }
}

/** Run 产物摘要：仅取可文本化前缀（结构化保留在 run-links/Run 记录中） */
function summarizeResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result.slice(0, 200);
  try {
    const s = JSON.stringify(result);
    return s ? s.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}
