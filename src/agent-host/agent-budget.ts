/**
 * 双层 Token 预算（AM-P0 T1 纯逻辑；V2.1 §6）
 *
 * 累计预算：Turn 开始前检查、结束后按实际 usage 入账（接既有 BudgetTracker 体系）
 * 单 Turn 硬限：LLM 请求次数 / 工具调用次数 / 运行时长，执行中实时检查；
 *   超限安全停止（不影响已启动 Workflow——停止的只是 Agent Loop）
 */

import type { TurnLimits } from "./types.js";
import { DEFAULT_TURN_LIMITS } from "./types.js";

export interface CumulativeBudget {
  /** 剩余可用 tokens（负数=已超）；无累计限制时返回 Infinity */
  remaining(userId: string): number;
  /** Turn 结束按实际 usage 入账 */
  settle(userId: string, totalTokens: number): void;
}

export type ExceedReason = "llm_requests" | "tool_calls" | "duration";

export class TurnBudget {
  private readonly limits: TurnLimits;
  private readonly cumulative: CumulativeBudget;
  private llmRequests = 0;
  private toolCalls = 0;
  private startedAt = 0;
  private active = false;

  constructor(cumulative: CumulativeBudget, limits?: Partial<TurnLimits>) {
    this.cumulative = cumulative;
    this.limits = { ...DEFAULT_TURN_LIMITS, ...limits };
  }

  /** Turn 开始：累计预算检查（不足则拒绝开始） */
  begin(userId: string): { ok: boolean; remaining: number } {
    const remaining = this.cumulative.remaining(userId);
    return { ok: remaining > 0, remaining };
  }

  /** 标记活跃（计时起点）；同一 TurnBudget 实例只允许一个活动 Turn */
  activate(): void {
    this.active = true;
    this.startedAt = Date.now();
  }

  onLlmRequest(): void {
    this.llmRequests++;
  }

  onToolCall(): void {
    this.toolCalls++;
  }

  /** 单 Turn 硬限检查（每次 LLM 请求/工具调用后调用）；返回 null=未超限 */
  exceeded(): ExceedReason | null {
    if (!this.active) return null;
    if (this.llmRequests > this.limits.maxLlmRequests) return "llm_requests";
    if (this.toolCalls > this.limits.maxToolCalls) return "tool_calls";
    if (Date.now() - this.startedAt > this.limits.maxDurationMs) return "duration";
    return null;
  }

  /** Turn 结束：停计时 + usage 入账累计预算 */
  settle(userId: string, usage: { inputTokens: number; outputTokens: number }): void {
    this.active = false;
    this.cumulative.settle(userId, usage.inputTokens + usage.outputTokens);
  }
}

/** 内存累计预算（测试用；生产接 BudgetTracker） */
export class InMemoryCumulativeBudget implements CumulativeBudget {
  private readonly used = new Map<string, number>();
  constructor(private readonly maxPerUser: number) {}
  remaining(userId: string): number {
    return this.maxPerUser - (this.used.get(userId) ?? 0);
  }
  settle(userId: string, totalTokens: number): void {
    this.used.set(userId, (this.used.get(userId) ?? 0) + totalTokens);
  }
}

/** 不限累计预算（缺省；单 Turn 硬限仍生效） */
export class UnlimitedCumulativeBudget implements CumulativeBudget {
  remaining(): number {
    return Infinity;
  }
  settle(): void {}
}

/** 累计余量容差检查（§6：可读实时 usage 时按剩余预算中止，预留 20% 超额容差） */
export function overCumulativeTolerance(
  cumulative: CumulativeBudget,
  userId: string,
  usedTokens: number,
  tolerance = 1.2,
): boolean {
  const remaining = cumulative.remaining(userId);
  if (!Number.isFinite(remaining)) return false;
  return usedTokens > remaining * tolerance;
}
