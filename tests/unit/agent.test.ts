/** P0-06 + agent 语义：重试 / 取消 / 结构性错误 / 闸门（失败不得标记为成功） */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/runtime/errors.js";
import { makeRunner } from "../helpers/fake-runner.js";

const basic = 'export const meta = { name: "agent_test" }\nconst r = await agent("hello")\nreturn r';

test("可恢复失败自动重试后成功", async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => {
    calls++;
    if (calls < 3) throw new Error("transient network error");
    return { type: "text" as const, value: "final-answer", sessionId: "s" };
  });
  const result = await runWorkflow(basic, { agent: runner, agentRetries: 2 });
  assert.equal(result.result, "final-answer");
  assert.equal(result.agents[0]?.status, "ok");
  assert.equal(calls, 3);
});

test("重试耗尽 → 失败登记，run 终检闸门抛错（不静默成功）", async () => {
  const { runner } = makeRunner(async () => {
    throw new Error("model unavailable");
  });
  await assert.rejects(
    runWorkflow(basic, { agent: runner, agentRetries: 1 }),
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.WORKFLOW_FAILED,
  );
});

test("continueOnAgentFailure=true 恢复静默继续旧行为", async () => {
  const { runner } = makeRunner(async () => {
    throw new Error("model unavailable");
  });
  const result = await runWorkflow(basic, { agent: runner, agentRetries: 0, continueOnAgentFailure: true });
  assert.equal(result.result, null);
  assert.equal(result.agents[0]?.status, "failed");
});

test("结构性错误（脚本 bug 级）不重试直接抛", async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => {
    calls++;
    throw new WorkflowError("schema invalid", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  });
  await assert.rejects(
    runWorkflow(basic, { agent: runner, agentRetries: 3 }),
    /schema invalid/,
  );
  assert.equal(calls, 1, "结构性错误不应重试");
});

test("外部 signal abort → cancelled 而非 success（P0-06）", async () => {
  const controller = new AbortController();
  const { runner } = makeRunner(async (_p, options) => {
    // 模拟长任务：取消后再监听（已 aborted 的 signal 不会重播事件，需同步判干）
    controller.abort();
    return new Promise<never>((_, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  await assert.rejects(
    runWorkflow(basic, { agent: runner, signal: controller.signal }),
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.WORKFLOW_ABORTED,
  );
});

test("agent 超时 → AGENT_TIMEOUT 可恢复失败", async () => {
  const { runner } = makeRunner(async (_p, options) => {
    return new Promise<never>((_, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => reject(new Error("too late")), 5000);
    });
  });
  await assert.rejects(
    runWorkflow(basic, { agent: runner, agentTimeoutMs: 50, agentRetries: 0 }),
    /阶段失败闸门/,
  );
});

test("空 prompt 结构性错误（不进 runner）", async () => {
  const { runner, calls } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  await assert.rejects(
    runWorkflow('export const meta = { name: "a" }\nconst r = await agent("   ")\nreturn r', { agent: runner }),
    /非空 prompt/,
  );
  assert.equal(calls.length, 0);
});

test("纯计算脚本（无 agent 调用）被拒绝", async () => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  await assert.rejects(
    runWorkflow('export const meta = { name: "a" }\nreturn 1 + 1', { agent: runner }),
    /至少调用一次 agent/,
  );
});

test("phase 切换触发闸门：上一阶段失败在边界终止", async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => {
    calls++;
    if (calls === 1) throw new Error("phase 1 failure");
    return { type: "text" as const, value: "ok", sessionId: "s" };
  });
  const script = `export const meta = { name: "gate", phases: [{ title: "one" }, { title: "two" }] }
phase("one")
const a = await agent("first")   // 失败 → 登记
phase("two")                      // 边界 → 闸门终止
const b = await agent("second")
return { a, b }`;
  await assert.rejects(
    runWorkflow(script, { agent: runner, agentRetries: 0 }),
    /阶段失败闸门/,
  );
  assert.equal(calls, 1, "闸门后不应执行第二阶段 agent");
});

test("setConcurrency 参数校验", async () => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  await assert.rejects(
    runWorkflow('export const meta = { name: "a" }\nsetConcurrency(0)\nawait agent("x")', { agent: runner }),
    /正整数/,
  );
});

test("结构化输出（fake structured）透传", async () => {
  const { runner } = makeRunner(async () => ({
    type: "structured" as const,
    value: { score: 0.9 },
    sessionId: "s",
  }));
  const script = 'export const meta = { name: "struct" }\nconst r = await agent("judge", { schema: { type: "object" } })\nreturn r';
  const result = await runWorkflow(script, { agent: runner });
  assert.deepEqual(result.result, { score: 0.9 });
  assert.equal(result.agents[0]?.outputType, "structured");
});
