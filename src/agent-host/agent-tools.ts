/**
 * 五工具（AM-P0 T3；V2.1 §2.2）：defineTool 薄封装 TaskControlFacade
 *
 * 约束：
 *  - 只做参数透传与结构化 JSON 返回（结果可被 LLM 继续决策；无中文话术包装）
 *  - userId/agentTurnId/originMessageId 从 TurnContextRef 取（服务端注入，不经 LLM 转述——
 *    LLM 无法冒充他人或伪造审计链）
 *  - executeWorkflow 无 authorized 入参：高风险只能得到 needsApproval（LLM 不得自授权）
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolFacade, TurnContextRef } from "./types.js";

export interface AgentToolsDeps {
  facade: AgentToolFacade;
  /** 每 per-user 会话一个；AgentHost 每 Turn 写入 */
  ctxRef: TurnContextRef;
}

/** 工具统一返回：结构化 JSON 文本（模型可继续决策） */
function jsonContent(value: unknown): { content: Array<{ type: "text"; text: string }>; details: undefined } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

export function createAgentTools(deps: AgentToolsDeps): ToolDefinition[] {
  const ctx = () => {
    if (!deps.ctxRef.current) {
      throw new Error("AM 工具上下文缺失：工具调用发生在 Turn 之外（不应发生）");
    }
    return deps.ctxRef.current;
  };

  const wrap = (
    run: (params: Record<string, unknown>) => Promise<unknown>,
  ): ToolDefinition["execute"] => {
    return async (_toolCallId, params) => jsonContent(await run(params as Record<string, unknown>));
  };

  return [
    {
      name: "workflow_search",
      label: "Workflow 检索",
      description:
        "查找可用的 Workflow。不带 query 返回完整能力清单（含每个流程的必填参数与风险等级）；" +
        "带 query 按关键词返回候选。不确定该用哪个流程时，先不带 query 看全量清单。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索关键词；缺省=完整清单" },
        },
      },
      execute: wrap((p) => deps.facade.searchWorkflows(typeof p.query === "string" ? p.query : undefined)),
    },
    {
      name: "workflow_execute",
      label: "Workflow 执行",
      description:
        "启动一个 Workflow。read-only 流程立即受理并返回 runId/taskBindingId（异步执行，用 task_status 查进度与结果）；" +
        "高风险流程返回 needsApproval 与 actionId，需用户在聊天中明确批准后才会执行（工具无法代替用户授权）。",
      parameters: {
        type: "object",
        properties: {
          workflowId: { type: "string", description: "流程 ID（来自 workflow_search 结果的 id）" },
          args: { type: "object", description: "流程参数（须满足该流程的 requiredArgs）" },
        },
        required: ["workflowId"],
      },
      execute: wrap(async (p) => {
        if (typeof p.workflowId !== "string") return { error: "workflowId 必填" };
        const c = ctx();
        return deps.facade.executeWorkflow({
          userId: c.userId,
          workflowId: p.workflowId,
          args: p.args ?? {},
          agentTurnId: c.agentTurnId,
          originMessageId: c.originMessageId,
        });
      }),
    },
    {
      name: "task_status",
      label: "任务状态",
      description:
        "查询任务的真实状态与结果（不凭记忆回答）。提供 runId 或 taskBindingId 之一；" +
        "终态任务会带 resultSummary/resultRef（真实产物引用）。",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          taskBindingId: { type: "string" },
        },
      },
      execute: wrap((p) =>
        deps.facade.taskStatus(ctx().userId, {
          ...(typeof p.runId === "string" ? { runId: p.runId } : {}),
          ...(typeof p.taskBindingId === "string" ? { taskBindingId: p.taskBindingId } : {}),
        }),
      ),
    },
    {
      name: "task_cancel",
      label: "任务取消",
      description: "取消一个进行中的任务（有操作后果；只能操作本人任务）。",
      parameters: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
      execute: wrap((p) => {
        if (typeof p.runId !== "string") return Promise.resolve({ ok: false, message: "runId 必填" });
        return deps.facade.taskCancel(ctx().userId, p.runId);
      }),
    },
    {
      name: "task_resume",
      label: "任务恢复",
      description:
        "恢复一个中断的任务。若返回 needsConfirm=true，表示恢复可能重复未确认的副作用，" +
        "必须先请用户回复「确认恢复」，再带 confirmSideEffects=true 重试；不要代替用户确认。",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          confirmSideEffects: { type: "boolean", description: "用户已明确回复「确认恢复」后才可置 true" },
        },
        required: ["runId"],
      },
      execute: wrap((p) => {
        if (typeof p.runId !== "string") return Promise.resolve({ ok: false, message: "runId 必填" });
        return deps.facade.taskResume(ctx().userId, p.runId, {
          confirmSideEffects: p.confirmSideEffects === true,
        });
      }),
    },
  ];
}
