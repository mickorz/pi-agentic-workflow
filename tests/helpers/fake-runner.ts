/**
 * 测试用 fake runner 工厂（在 AgentSessionRunner 注入缝处替换 Pi SDK）
 */

import type { AgentSessionRunner, AgentRunOptions, AgentExecutionResult } from "../../src/agent/session-runner.js";

export interface CallLog {
  prompt: string;
  options: AgentRunOptions | undefined;
  /** 相对 fakeRunner 内部时钟的起始/结束时间戳（毫秒） */
  startedAt: number;
  endedAt: number;
}

function makeRunner(impl: (prompt: string, options: AgentRunOptions | undefined) => Promise<AgentExecutionResult>) {
  const calls: CallLog[] = [];
  const runner: AgentSessionRunner = {
    async run(prompt, options) {
      const startedAt = Date.now();
      const result = await impl(prompt, options);
      calls.push({ prompt, options, startedAt, endedAt: Date.now() });
      return result;
    },
  };
  return { runner, calls };
}

/** 立即返回固定文本的 runner */
export function echoRunner(text: string) {
  return makeRunner(async (_prompt) => ({ type: "text" as const, value: text, sessionId: `fake-${Math.random()}` }));
}

/** 固定延迟后返回（用于并行重叠验证） */
export function delayedEchoRunner(text: string, delayMs: number) {
  return makeRunner(async (_prompt, options) => {
    await sleep(delayMs, options);
    return { type: "text" as const, value: text, sessionId: `fake-${Math.random()}` };
  });
}

/** 总是抛错的 runner（可指定抛 N 次后成功，模拟瞬时故障） */
export function flakyRunner(failTimes: number, message = "simulated transient failure") {
  let calls = 0;
  return makeRunner(async () => {
    calls++;
    if (calls <= failTimes) throw new Error(message);
    return { type: "text" as const, value: `recovered-after-${failTimes}`, sessionId: "fake-retry" };
  });
}

/** 结构化输出 runner */
export function structuredRunner(value: unknown) {
  return makeRunner(async () => ({ type: "structured" as const, value, sessionId: "fake-structured" }));
}

/** 抛结构性（不可恢复）错误的 runner：用 WorkflowError 模拟 */
export function structuralFailureRunner() {
  return makeRunner(async () => {
    const { WorkflowError, WorkflowErrorCode } = await import("../../src/runtime/errors.js");
    throw new WorkflowError("structural failure (script bug)", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  });
}

/** 记录调用并把序号回显 */
export function countingRunner() {
  let n = 0;
  const factory = makeRunner(async (prompt) => {
    n++;
    return { type: "text" as const, value: `${prompt}#${n}`, sessionId: `fake-count-${n}` };
  });
  return { ...factory, get count() { return n } };
}

export { makeRunner };

export function sleep(ms: number, options?: AgentRunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    options?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}
