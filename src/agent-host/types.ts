/**
 * AM-P0 共享契约类型（T1 先行交付；T2~T8 模块按此实现，不得自定义执行语义）
 * 依据：AM-P0-执行计划 V2.1 §2~§6
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 入口模式（§2.4 Feature Flag）：legacy = 旧 IntentRouter 链路；agent = Conversational Agent */
export type RoutingMode = "legacy" | "agent";

/** Agent 轮次结果（§2.1） */
export interface TurnResult {
  conversationId: string;
  agentTurnId: string;
  replyText: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** 启动关联三阶段（§2.3）：启动前 RunLaunchAttempt → 成功后 TaskBinding（不变）→ 恢复/完成 run-links */
export type LaunchStatus = "launched" | "linked" | "unknown";

export interface RunLaunchAttempt {
  attemptId: string;
  userId: string;
  workflowId: string;
  argsDigest: string;
  agentTurnId?: string;
  status: LaunchStatus;
  runId?: string;
  taskBindingId?: string;
  createdAt: string;
  linkedAt?: string;
}

/** Run 结果关联（§5）：RunMonitor 终态回写，后续 Turn 经 task_status 读取（不靠模型记忆） */
export interface RunLink {
  runId: string;
  taskBindingId?: string;
  agentTurnId?: string;
  conversationId?: string;
  status: string;
  resultSummary?: string;
  resultRef?: string;
  attemptId?: string;
  updatedAt: string;
}

/** 执行前授权（§3）：与 Run 内 Checkpoint 互不替代 */
export type PendingActionStatus = "pending" | "executing" | "executed" | "rejected" | "expired";

export interface PendingAction {
  actionId: string;
  userId: string;
  workflowId: string;
  /** 服务端执行快照：完整参数（确认后从这里取，不依赖会话记忆） */
  args: unknown;
  argsDigest: string;
  originMessageId: string;
  riskLevel: string;
  /** Registry 无版本字段的替代：注册元数据稳定哈希（确认时重校验一致性） */
  registryDigest: string;
  createdAt: string;
  expiresAt: string;
  status: PendingActionStatus;
  /** executed 后回填（重复确认幂等返回原始结果） */
  result?: { runId: string; taskBindingId: string };
}

/** 消息处理状态机（§4）：received ≠ processed；含完整原始消息快照供重启恢复 */
export type MessageState = "received" | "processing" | "completed" | "failed";

export interface InboxJournalEntry {
  channel: string;
  messageId: string;
  userId: string;
  text: string;
  receivedAt: string;
  state: MessageState;
  agentTurnId?: string;
  updatedAt: string;
}

/** 单 Turn 硬限（§6）：执行中实时检查；超限安全停止不影响已启动 Workflow */
export interface TurnLimits {
  maxLlmRequests: number;
  maxToolCalls: number;
  maxDurationMs: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxLlmRequests: 12,
  maxToolCalls: 20,
  maxDurationMs: 300_000,
};

/** 五工具契约（§2.2；T3 按此实现，内部薄封装现有服务） */

export interface WorkflowSearchItem {
  id: string;
  name: string;
  description: string;
  requiredArgs: string[];
  riskLevel: string;
}

export type WorkflowExecuteResult =
  | { accepted: true; runId: string; taskBindingId: string; status: string }
  | { needsApproval: true; actionId: string }
  | { error: string };

export interface TaskStatusResult {
  runId: string;
  status: string;
  resultSummary?: string;
  resultRef?: string;
  error?: string;
}

/** 工具Facade：T3 实现（registry.all/search + dispatcher.execute + TaskControl 结构化）；Fake 见 fakes.ts */
export interface AgentToolFacade {
  searchWorkflows(query?: string): Promise<WorkflowSearchItem[]>;
  executeWorkflow(input: {
    userId: string;
    workflowId: string;
    args: unknown;
    agentTurnId: string;
    originMessageId: string;
  }): Promise<WorkflowExecuteResult>;
  taskStatus(userId: string, ref: { runId?: string; taskBindingId?: string }): Promise<TaskStatusResult>;
  taskCancel(userId: string, runId: string): Promise<{ ok: boolean; message: string }>;
  taskResume(userId: string, runId: string): Promise<{ ok: boolean; message: string; needsConfirm?: boolean }>;
}

/** AgentHost 依赖（T2 实现；FakeAgentSession 见 fakes.ts） */
export interface AgentHostDeps {
  cwd: string;
  sessionDir: string;
  model?: string;
  customTools: ToolDefinition[];
  facade: AgentToolFacade;
  limits?: Partial<TurnLimits>;
  onTurnCompleted?: (r: TurnResult) => void;
}
