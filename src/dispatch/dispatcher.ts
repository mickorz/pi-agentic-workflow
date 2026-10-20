/**
 * Dispatcher（EX-001~004，§2.1 两段式）：
 *  plan()    —— 无副作用路由计划（不启动 Run/不写 TaskBinding/不发通知）
 *  execute() —— 显式执行：重新校验 Registry/参数/身份/风险 → RunApplicationService.start()
 *
 * 硬约束：
 *  - 执行唯一入口 RunApplicationService.start()（EX-001），禁止直调 engine
 *  - §2.1-5 执行前授权：riskLevel != read-only 且未 authorized → NOT_AUTHORIZED（不是"启动后等审批"）
 *  - dispatch 层禁止 import gateway（§2.1-3）
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { WorkflowRegistry } from "./registry.js";
import { IntentRouter } from "./intent-router.js";
import { TaskStore } from "./task-store.js";
import { validateJsonSchema } from "../adapters/pi/schema-validator.js";
import {
  DispatchError,
  type BotInboundMessage,
  type ConversationState,
  type ExecuteResult,
  type ExecutionAuthorization,
  type PlanInput,
  type RoutePlan,
  type TaskBinding,
} from "../contracts/wx.js";

/** 执行服务最小接口（生产=RunApplicationService；测试=fake） */
export interface ExecutionService {
  start(input: { scriptPath: string; args?: unknown; cwd?: string; model?: string }): Promise<{ runId: string }>;
}

/** 任务控制模块接口（生产=TaskController；测试=fake） */
export interface TaskControlPort {
  handle(message: BotInboundMessage): Promise<{ reply: string }>;
}

export interface DispatcherDeps {
  registry: WorkflowRegistry;
  router: IntentRouter;
  tasks: TaskStore;
  service: ExecutionService;
  /** 脚本白名单根（scriptPath 相对它 resolve） */
  scriptsRoot: string;
  /** run 级默认模型（ModelRouter.runDefaultModel()） */
  defaultModel?: string;
  /** P2（IR-008）：task_control 意图分发目标 */
  taskControl?: TaskControlPort;
  /** P2（MR-011/A18）：启动前守卫（预算等）；抛 DispatchError 即拒绝启动 */
  preStart?: (plan: RoutePlan, origin: { userId: string }) => void;
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  /** 两段式之一：路由计划（零执行副作用） */
  async plan(input: PlanInput): Promise<RoutePlan> {
    return this.deps.router.route(input.text);
  }

  /**
   * 两段式之二：显式执行。plan 不是永久授权——Registry 版本、脚本、参数、权限全部重校验。
   */
  async execute(
    plan: RoutePlan,
    auth: ExecutionAuthorization,
    origin: { channel: string; userId: string; messageId: string },
  ): Promise<ExecuteResult> {
    if (plan.intent !== "execute_workflow" || plan.action !== "start_execution" || !plan.workflowId) {
      throw new DispatchError("PLAN_EXPIRED", "计划不是可执行态（action != start_execution）");
    }
    // 重校验 1：Registry 仍在册且启用
    const reg = this.deps.registry.get(plan.workflowId);
    if (!reg) throw new DispatchError("WORKFLOW_NOT_FOUND", `流程已下线或不存在：${plan.workflowId}`);
    // 重校验 2：执行前授权（§2.1-5：高风险确认必须在 start 之前）
    if (reg.riskLevel !== "read-only" && !auth.authorized) {
      throw new DispatchError(
        "NOT_AUTHORIZED",
        `流程 ${plan.workflowId} 风险等级为 ${reg.riskLevel}，需要执行前显式授权（不允许先启动后确认）`,
      );
    }
    // 重校验 3：参数 Schema
    const args = plan.args ?? {};
    try {
      validateJsonSchema(args, reg.argsSchema);
    } catch (e) {
      throw new DispatchError("INVALID_ARGS", `参数校验未通过：${e instanceof Error ? e.message : String(e)}`);
    }
    // 重校验 4：启动前守卫（预算/频率等限额）
    this.deps.preStart?.(plan, origin);

    // 唯一启动入口
    const scriptPath = path.resolve(this.deps.scriptsRoot, reg.scriptPath);
    let runId: string;
    try {
      const started = await this.deps.service.start({
        scriptPath,
        args,
        ...(this.deps.defaultModel ? { model: this.deps.defaultModel } : {}),
      });
      runId = started.runId;
    } catch (error) {
      // EX-010/A18：并发上限 → 明确反馈话术（不无限创建 Run）
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "RUN_LIMIT_REACHED") {
        throw new DispatchError(
          "RUN_LIMIT",
          "已达并发上限，新任务暂不能启动。可发「任务列表」查看进行中的任务，或稍后再试。",
        );
      }
      throw error;
    }

    const now = new Date().toISOString();
    const binding: TaskBinding = {
      taskBindingId: `tb-${randomUUID().slice(0, 8)}`,
      runId,
      channel: origin.channel,
      userId: origin.userId,
      workflowId: reg.workflowId,
      status: "running",
      createdAt: now,
      updatedAt: now,
      messageId: origin.messageId,
    };
    this.deps.tasks.append(binding);
    return { taskBindingId: binding.taskBindingId, runId, status: binding.status };
  }

  /** Gateway 主循环用的消息→计划→（可能）执行 编排；返回给通知层的回复文本 */
  async handleMessage(
    message: BotInboundMessage,
    conversation: { get(userId: string): ConversationState | undefined; setPendingPlan(userId: string, p: ConversationState["pendingPlan"]): void; clear(userId: string): void },
    options?: { authorized?: boolean },
  ): Promise<{ reply: string; plan: RoutePlan; executeResult?: ExecuteResult }> {
    const state = conversation.get(message.userId);
    const pending = state?.pendingPlan;
    // 有挂起的补参计划：本条消息视作参数补充（CV-002）
    if (pending) {
      const merged = mergeArgs(pending.args ?? {}, parseLooseArgs(message.text));
      const required = ((this.deps.registry.get(pending.workflowId)?.argsSchema as { required?: string[] }).required ?? []);
      const missing = required.filter((k) => !(k in merged) || merged[k] === undefined || merged[k] === "");
      if (missing.length === 0) {
        conversation.clear(message.userId);
        const complete: RoutePlan = { ...pending, args: merged, action: "start_execution", missingFields: [] };
        const result = await this.execute(
          complete,
          { actor: message.userId, authorized: options?.authorized === true, entrypoint: message.channel === "wechat" ? "wechat" : "cli" },
          message,
        );
        return { reply: `已启动 ${pending.workflowId}（任务 ${result.taskBindingId}）`, plan: complete, executeResult: result };
      }
      conversation.setPendingPlan(message.userId, { ...pending, args: merged, missingFields: missing });
      return { reply: `还差参数：${missing.join(", ")}`, plan: { ...pending, args: merged, missingFields: missing } };
    }

    const plan = await this.plan({ text: message.text });
    switch (plan.action) {
      case "perform_task_control": {
        // IR-008：查询/取消/批准/拒绝/恢复走 Task Control，不进 Workflow 路由
        if (this.deps.taskControl) {
          const out = await this.deps.taskControl.handle(message);
          return { reply: out.reply, plan };
        }
        return { reply: "任务控制暂不可用。", plan };
      }
      case "start_execution": {
        const reg = this.deps.registry.get(plan.workflowId!);
        // read-only 自动执行；高风险需 options.authorized（Gateway 会先发确认卡）
        const result = await this.execute(
          plan,
          { actor: message.userId, authorized: reg?.riskLevel === "read-only" || options?.authorized === true, entrypoint: message.channel === "wechat" ? "wechat" : "cli" },
          message,
        );
        return { reply: `已启动 ${plan.workflowId}（任务 ${result.taskBindingId}）`, plan, executeResult: result };
      }
      case "ask_clarification": {
        if (plan.workflowId) conversation.setPendingPlan(message.userId, { ...plan, workflowId: plan.workflowId });
        return { reply: plan.reason ?? "需要补充信息", plan };
      }
      case "chat_reply":
        return { reply: plan.reason ?? "（chat 关闭，仅支持工作流指令）", plan };
      case "refuse":
      default:
        return { reply: plan.reason ?? "暂不支持该请求", plan };
    }
  }
}

function mergeArgs(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...patch };
}

/** "k=v k2=v2" 或 JSON 文本 → 参数对象（宽松解析，供补参轮使用） */
function parseLooseArgs(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // 落入 kv 解析
    }
  }
  const out: Record<string, unknown> = {};
  for (const pair of trimmed.split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}
