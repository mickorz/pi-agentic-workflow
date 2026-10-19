/**
 * 共享类型定义（P0 子集；P1/P2 将扩展 CompositeRecord / WorkflowExecutionRecord / JournalEntry）
 */

/** 单个 agent 的 token 用量（由 Adapter 从 SDK 事件中提取） */
export interface AgentUsage {
  input?: number;
  output?: number;
  total?: number;
  /** 该次调用的货币成本（provider 上报时才有，美元） */
  cost?: number;
}

/** agent 记录状态 */
export type AgentRecordStatus = "running" | "ok" | "failed" | "aborted";

/** token 用量拆分（展示与统计用） */
export interface AgentUsageSplit {
  inputTokens?: number;
  outputTokens?: number;
}

/** 单个 agent 的执行记录（run 汇总返回） */
export interface AgentRecord {
  /** 形如 runId:callIndex 的稳定标识 */
  id: string;
  label: string;
  phase?: string;
  status: AgentRecordStatus;
  /** 该 agent 开始执行的绝对时间戳（毫秒） */
  startedAt?: number;
  tokens?: number;
  cost?: number;
  error?: string;
  durationMs?: number;
  model?: string;
  /** 本次调用的子会话 ID（adapter 建会话后回填） */
  sessionId?: string;
  /** 最后一次尝试的序号（1 起算） */
  attempt?: number;
  /** 总尝试次数（retries+1） */
  maxAttempts?: number;
  /** 本次尝试的起始时间戳（每次 attempt 重置） */
  attemptStartedAt?: number;
  /** 生效超时上限毫秒（null = 无上限） */
  timeoutMs?: number | null;
  /** 结果形态（text / structured） */
  outputType?: "text" | "structured";
  /** 最新一次真实执行的标识（runId:callIndex:attempt） */
  executionId?: string;
  /** 结果 2KB 截断预览（已脱敏） */
  outputPreview?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** workflow 脚本 meta 信封 */
export interface WorkflowMeta {
  /** 稳定 ID；缺省用 name */
  id?: string;
  name: string;
  description?: string;
  phases?: Array<{ title: string }>;
}

/** runWorkflow 的返回值 */
export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  /** 脚本 return 的值 */
  result: T;
  logs: string[];
  phases: string[];
  agents: AgentRecord[];
  agentCount: number;
  durationMs: number;
  runId: string;
}
