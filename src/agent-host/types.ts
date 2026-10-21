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

/**
 * Turn 上下文（T3）：工具执行时注入的会话/消息关联（五工具从 Facade 入参取，不经 LLM 转述）
 */
export interface TurnContext {
  userId: string;
  agentTurnId: string;
  /** 本轮消息 messageId（审计链：PendingAction.originMessageId / TaskBinding.messageId） */
  originMessageId: string;
}

/** 每 per-user 会话一个的可变上下文槽（AgentHost 每 Turn 写入；工具闭包读取） */
export type TurnContextRef = { current: TurnContext | undefined };

/** Turn 执行事件（§6 硬限实时检查的观察面） */
export type TurnEvent = { type: "llm_request" } | { type: "tool_call" };

/**
 * 会话抽象（T2）：per-user 持久会话的最小注入缝
 * 真实现见 pi-session.ts（Pi SDK createAgentSession + per-user SessionManager 文件）；
 * Fake 见 fakes.ts。P0 不使用 followUp()（§2.1 锁定语义）。
 */
export interface HostedAgentSession {
  /** 会话稳定标识（Pi = sessionId；重启后不变） */
  readonly conversationId: string;
  /** 单轮提示；返回最终回复与本轮用量 */
  prompt(text: string): Promise<{ replyText: string; usage: { inputTokens: number; outputTokens: number } }>;
  /** AgentHost 每 Turn 写入上下文（工具闭包经 ctxRef 读取；T3） */
  setTurnContext?(ctx: TurnContext): void;
  /** 观察本轮事件（§6 硬限实时检查；T6） */
  observe?(onEvent: (e: TurnEvent) => void): void;
  /** 实时用量（累计余量容差中止用；读不到就不被调用） */
  currentUsage?(): { inputTokens: number; outputTokens: number };
  /** 安全中止 Agent Loop（不影响已启动 Workflow；T6 硬限触发） */
  abort?(): void | Promise<void>;
  /** 释放底层资源（Host 关闭时调用；缺省无操作） */
  dispose?(): void;
}

/** 会话开启器：AgentHost 惰性创建/复用 per-user 会话（T2 注入缝） */
export type SessionOpener = (userId: string) => Promise<HostedAgentSession>;

/** 入站消息（gateway → AgentHost；§4 journal 快照来源） */
export interface AgentMessageInput {
  channel: string;
  messageId: string;
  userId: string;
  text: string;
  /** 缺省取当前时间 */
  receivedAt?: string;
}

/** handleMessage 结果：processed=本轮完成（含回执）；queued=前轮进行中已持久化排队；duplicate=同消息已见过 */
export type HandleOutcome =
  | { status: "processed"; result: TurnResult }
  | { status: "queued" }
  | { status: "duplicate"; state: MessageState };

/** 启动关联三阶段（§2.3）：启动前 RunLaunchAttempt → 成功后 TaskBinding（不变）→ 恢复/完成 run-links */
export type LaunchStatus = "launched" | "linked" | "unknown" | "discarded";

export interface RunLaunchAttempt {
  attemptId: string;
  userId: string;
  workflowId: string;
  argsDigest: string;
  agentTurnId?: string;
  /** 原始消息（恢复期与 TaskBinding.messageId 比对，自动补链依据） */
  originMessageId?: string;
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
  /** 发起本轮的 Agent Turn（run-links 关联；T5） */
  agentTurnId?: string;
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
  taskResume(
    userId: string,
    runId: string,
    options?: { confirmSideEffects?: boolean },
  ): Promise<{ ok: boolean; message: string; needsConfirm?: boolean }>;
}

/** AgentHost 依赖（T2 实现；FakeAgentSession 见 fakes.ts） */
export interface AgentHostDeps {
  cwd: string;
  /** per-user 会话文件目录（.pi-agent-host/sessions） */
  sessionDir: string;
  /** 持久化数据目录（journal 等；.pi-wechat） */
  dataDir: string;
  model?: string;
  customTools: ToolDefinition[];
  facade: AgentToolFacade;
  limits?: Partial<TurnLimits>;
  /** 会话开启器注入缝（缺省 PiSessionOpener：Pi SDK 持久会话） */
  openSession?: SessionOpener;
  /** 五工具工厂（T3）：每 per-user 会话一个 ctxRef，工具闭包读当前 Turn 上下文；缺省用 customTools */
  toolsFactory?: (ctxRef: TurnContextRef) => ToolDefinition[];
  /** 累计预算（§6 双层之一；缺省不限；生产接 BudgetTracker 适配） */
  cumulative?: import("./agent-budget.js").CumulativeBudget;
  /** 单 Turn 硬限轮询间隔（缺省 500ms；测试可调小） */
  budgetPollMs?: number;
  onTurnCompleted?: (r: TurnResult) => void;
  /** §4 恢复告警：processing 中断消息（不确定副作用，禁止重调 Agent；T4/T5 接入关联核查后细化） */
  onUncertainRecovery?: (e: InboxJournalEntry) => void;
}
