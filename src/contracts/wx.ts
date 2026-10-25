/**
 * wechat-dispatch 核心契约（P1 §2，需求 §7 数据契约）
 *
 * 五个持久化实体：BotMessageReceipt / ConversationState / WorkflowRegistration / TaskBinding / ModelRoutingDecision
 * Intent/Action 分离（P1 §2.1-2）；plan()/execute() 两段式签名（P1 §2.1-1）。
 * 本文件零 gateway / 零微信协议依赖（§2.1-3 跨入口复用禁合）。
 */

// ── Intent / Action（独立枚举，不得混用） ──

/** 意图：用户请求类别（IR-001 五类） */
export type Intent = "chat" | "execute_workflow" | "clarify" | "task_control" | "unsupported";
/** 动作：系统接下来的事 */
export type Action =
  | "start_execution"
  | "ask_clarification"
  | "refuse"
  | "perform_task_control"
  | "chat_reply";

/** 风险等级（LK-03：仅 read-only 允许自动执行） */
export type RiskLevel = "read-only" | "write" | "external-side-effect";

// ── 统一消息格式（WG-001） ──

export interface BotInboundMessage {
  channel: "wechat" | "cli";
  /** 绑定用户标识（WG-002 过滤依据） */
  userId: string;
  /** 幂等键：channel+messageId（WG-003） */
  messageId: string;
  text: string;
  receivedAt: string;
}

export interface BotMessageReceipt {
  messageId: string;
  channel: string;
  userId: string;
  /** received | duplicate | rejected | processed */
  status: "received" | "duplicate" | "rejected" | "processed";
  receivedAt: string;
  /** 关联任务（若产生 Run） */
  taskBindingId?: string;
}

// ── Workflow Registry（WR，§7.1） ──

export interface WorkflowRegistration {
  workflowId: string;
  /** 相对 scripts 根的路径（白名单内） */
  scriptPath: string;
  name: string;
  description: string;
  /** 参数 JSON Schema（缺字段追问依据，IR-005） */
  argsSchema: Record<string, unknown>;
  riskLevel: RiskLevel;
  enabled: boolean;
  /** 检索关键词（IR-002 候选匹配用，不含源码） */
  keywords: string[];
  /** 触发话术示例（LLM 路由提示 + 目录展示）；如 ['xxx 保存到灵感'] */
  examples?: string[];
  /** 跨字段「至少一」约束（VR S4.2）：声明后 facade 在创建 PendingAction 前做审批前预检，
   *  条目必须存在于 argsSchema.properties；如 ["article_dir", "vault_ref", "article_name"] */
  anyOfArgs?: string[];
  /** URL 确定性前置路由（设计V2 §3）：声明后，消息中「恰好一个」URL 的 host 命中
   *  任一域名（含子域）时，前置路由直连该 workflow 并以 url=<URL> 启动（不经 LLM）。
   *  域名集合精确匹配 + endsWith('.'+domain) 子域规则，不做模糊包含。 */
  urlDomains?: string[];
  /** 前置路由注入的参数名（缺省 "url"；必须存在于 argsSchema.properties） */
  urlArg?: string;
  /** P1a Phase W（方案 §3）：能力声明（如 "obsidian-write"）；注册面校验与 registryDigest 均纳入 */
  capabilities?: string[];
}

// ── 意图路由结果 ──

export interface RoutePlan {
  intent: Intent;
  action: Action;
  /** action=start_execution 时非空；经 Registry 白名单校验后的目标 */
  workflowId?: string;
  /** 服务端 Schema 校验后的参数 */
  args?: Record<string, unknown>;
  /** 缺失必填参数字段名（action=ask_clarification 时非空） */
  missingFields?: string[];
  /** 拒绝/澄清/聊天回复的理由或话术 */
  reason?: string;
  /** 路由置信度（0-1；门限 LK-05=0.75，且 confidence 不是授权） */
  confidence: number;
  /** 路由耗时毫秒与 token（可观测，RP 评测复用） */
  latencyMs?: number;
  tokens?: number;
}

// ── 会话状态（CV，§7） ──

export interface ConversationState {
  userId: string;
  /** 待补参数（IR-005：缺槽位时挂起） */
  pendingPlan?: RoutePlan & { workflowId: string };
  /** 最近一次任务引用（UC-03 "刚才的"） */
  lastTaskBindingId?: string;
  updatedAt: string;
  /** TTL 过期时间（LK-05：15 分钟） */
  expiresAt?: string;
}

// ── 任务绑定（EX，§7） ──

export interface TaskBinding {
  taskBindingId: string;
  runId: string;
  channel: string;
  userId: string;
  workflowId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "waiting_checkpoint" | "interrupted";
  createdAt: string;
  updatedAt: string;
  messageId: string;
  /** P2（EX-007）：已向用户通知过的审批请求版本（重启后防重复发卡） */
  approvalNotifiedVersion?: number;
  /** P2（NT-005/006）：终态摘要（通知失败后「任务列表」主动查询补偿） */
  summary?: string;
}

// ── 模型路由（MR，§7） ──

export type ModelTier = "quick" | "general" | "frontier";

export interface ModelRoutingDecision {
  nodeId: string;
  runId: string;
  requestedTier?: ModelTier;
  /** 节点显式物理模型（优先级最高，MR-003 不被覆盖） */
  requestedModel?: string;
  actualModel: string;
  routeSource: "explicit-model" | "node-tier" | "workflow-default" | "fallback" | "run-default";
  decidedAt: string;
}

// ── Dispatcher 两段式（§2.1-1） ──

export interface PlanInput {
  text: string;
  context?: { userId: string; channel: string; conversation?: ConversationState };
}

/** execute() 的执行前授权（§2.1-5：高风险确认必须在 start() 之前） */
export interface ExecutionAuthorization {
  actor: string;
  /** 高风险（write/external-side-effect）必须显式 authorized=true 才放行 */
  authorized: boolean;
  entrypoint: "wechat" | "cli";
}

export interface ExecuteResult {
  taskBindingId: string;
  runId: string;
  status: TaskBinding["status"];
}

export type ServiceErrorCodeWX =
  | "NOT_AUTHORIZED"
  | "WORKFLOW_NOT_FOUND"
  | "INVALID_ARGS"
  | "PLAN_EXPIRED"
  | "RUN_LIMIT";

// ── P2：通知 Outbox（NT-004~006） ──

export type OutboxKind = "receipt" | "completed" | "failed" | "cancelled" | "interrupted" | "approval" | "info";

/** 通知 Outbox 条目：完成（Run 终态）与送达（send 成功）分别记录（§9.3） */
export interface NotificationOutboxItem {
  outboxId: string;
  userId: string;
  kind: OutboxKind;
  text: string;
  /** 关联任务（NT-005 按 runId 串审计） */
  runId?: string;
  taskBindingId?: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  createdAt: string;
  sentAt?: string;
  lastError?: string;
  /** 下次可重试时间（退避后） */
  nextRetryAt?: string;
}

// ── P2：审计（SC-006，NFR-007/008） ──

export type AuditAction =
  | "intent.route"
  | "url.route.direct"
  | "run.start"
  | "run.cancel"
  | "run.resume"
  | "checkpoint.requested"
  | "checkpoint.approve"
  | "checkpoint.reject"
  | "model.route"
  | "limit.reject"
  | "outbox.giveup"
  | "gateway.reconnect"
  // AM-P0（agent 分支）
  | "am.turn.completed"
  | "am.turn.failed"
  | "am.pending.approve"
  | "am.pending.reject"
  | "am.pending.uncertain"
  | "am.launch.unknown"
  | "am.recovery.uncertain"
  | "am.resume.confirm"
  | "workflow.catalog";

export interface AuditRecord {
  auditId: string;
  at: string;
  /** 操作者（userId 或 "system"） */
  actor: string;
  action: AuditAction;
  target: {
    runId?: string;
    taskBindingId?: string;
    workflowId?: string;
    checkpointId?: string;
    version?: number;
    /** AM-P0：执行前授权/启动尝试/Turn 关联标识 */
    actionId?: string;
    attemptId?: string;
    agentTurnId?: string;
    conversationId?: string;
    messageId?: string;
  };
  outcome: "ok" | "rejected" | "failed";
  /** 已脱敏详情（SC-004：写入前必经 redact） */
  detail?: string;
}

export class DispatchError extends Error {
  constructor(
    readonly code: ServiceErrorCodeWX,
    message: string,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}
