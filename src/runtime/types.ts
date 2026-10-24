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
  /** 展示身份（scope 链 label 数组）；root 的 agent 无此字段 */
  workflowPath?: string[];
  /** 稳定身份（scope 链 keySegment 数组） */
  workflowScopePath?: string[];
  /** 组合链（cmpN id 数组；纯展示用） */
  compositePath?: string[];
  /** 节点类型标记：缺省为普通 agent；checkpoint 节点用于区分「等待人工」与执行中 */
  kind?: "checkpoint" | "command";
  /** resume 时从 journal 免费回放（未真实调 LLM） */
  replayed?: boolean;
}

/** journal 条目：key 为 runId:callIndex（child 为 runId:wfK:callIndex）
 *  hash/result 仅在成功时写入；失败 attempt 只进 executions。 */
export interface JournalEntry {
  hash: string;
  result: unknown;
  model?: string;
  label?: string;
  /** 所属子 workflow 的实例显示名 */
  workflowLabel?: string;
  phase?: string;
  agentType?: string;
  /** 原始 prompt（4KB 截断，仅展示用；不参与 hash 身份） */
  prompt?: string;
  sessionId?: string;
  outputType?: "text" | "structured" | "unknown";
  executionId?: string;
  attempt?: number;
  startedAt?: number;
  durationMs?: number;
  usage?: AgentUsageSplit;
}

/** workflow 脚本 meta 信封 */
export interface WorkflowMeta {
  /** 稳定 ID；缺省用 name */
  id?: string;
  name: string;
  description?: string;
  phases?: Array<{ title: string }>;
}

/** command() 节点参数：确定性子进程执行（不经 LLM） */
export interface CommandSpec {
  /** 可执行文件（PATH 解析或绝对路径；Windows 下 .cmd/.bat 需 cmd.exe /c 或绝对路径，因 spawn 不走 shell） */
  executable: string;
  /** 参数数组（逐项直传，无 shell 注入面） */
  args: string[];
  /** 超时毫秒；超时 SIGTERM→3s 后 SIGKILL，抛 COMMAND_TIMEOUT（可恢复） */
  timeoutMs?: number;
  /** 子进程工作目录（相对 shared.cwd 解析；缺省 shared.cwd） */
  cwd?: string;
  /** 追加/覆盖进程环境变量（合并在 process.env 之上） */
  env?: Record<string, string>;
  /** 展示名（缺省 executable + args 截断） */
  label?: string;
  /** stdout/stderr 各自捕获上限字节数（缺省 256KB；超出截断置 truncated） */
  maxOutputBytes?: number;
}

/** command() 节点结果 */
export interface CommandResult {
  /** 进程退出码；被信号杀死时为 -1（signal 字段标明信号名） */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 任一输出流达到捕获上限被截断 */
  truncated: boolean;
  durationMs: number;
  /** 进程被信号终止时携带（如 SIGTERM） */
  signal?: string;
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
