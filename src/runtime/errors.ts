/**
 * workflow 运行时错误类型（P0 最小集，P1/P2 将扩充 checkpoint/check 相关码）
 */

export enum WorkflowErrorCode {
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  AGENT_FAILED = "AGENT_FAILED",
  /** 人工拒绝 checkpoint（P2 引入） */
  CHECKPOINT_REJECTED = "CHECKPOINT_REJECTED",
  /** check() 确定性验证未通过（P1 引入） */
  CHECK_FAILED = "CHECK_FAILED",
  /** 阶段失败闸门：agent 重试耗尽后 workflow 在下一 phase 边界终止 */
  WORKFLOW_FAILED = "WORKFLOW_FAILED",
  /** checkpoint 无人工通道且无显式默认值：进入等待态（持久化非终态，绝不自动通过） */
  CHECKPOINT_WAITING = "CHECKPOINT_WAITING",
  /** 脚本或参数哈希变化，拒绝复用旧 journal */
  RESUME_MISMATCH = "RESUME_MISMATCH",
  /** command() 子进程超时（SIGTERM→SIGKILL 后仍未退出） */
  COMMAND_TIMEOUT = "COMMAND_TIMEOUT",
  /** command() 子进程无法启动（可执行文件不存在等，确定性配置错误） */
  COMMAND_SPAWN_FAILED = "COMMAND_SPAWN_FAILED",
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  /** recoverable=true 的失败在 parallel 中塌缩为 null，且可被重试 */
  readonly recoverable: boolean;

  constructor(message: string, code: WorkflowErrorCode, options: { recoverable: boolean }) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable;
  }
}

/** 把任意抛出物包装为 WorkflowError；未知错误视为可恢复（网络抖动等） */
export function wrapError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  if (error instanceof Error && (error.name === "AbortError" || /\babort(?:ed)?\b/i.test(error.message))) {
    return new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowError(message, WorkflowErrorCode.AGENT_FAILED, { recoverable: true });
}
