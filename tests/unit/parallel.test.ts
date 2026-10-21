/** P0-03：parallel 两分支真正执行时间重叠，返回次序稳定 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { delayedEchoRunner, makeRunner, echoRunner } from "../helpers/fake-runner.js";

const script = (topic: string) => `export const meta = { name: "parallel_test" }
const answers = await parallel([() => agent("${topic}"), () => agent("${topic}")])
return answers`;

test("并行分支执行时间重叠（非串行）", async () => {
  // 延迟 500ms：重叠窗口留足余量，避免 CI 慢机负载下假阴性（本地 150ms 曾在 macOS/ubuntu CI 挂）
  const { runner, calls } = delayedEchoRunner("slow-answer", 500);
  const result = await runWorkflow(script("topic"), { agent: runner });
  assert.equal(result.result[0], "slow-answer");
  assert.equal(result.result[1], "slow-answer");
  assert.equal(calls.length, 2);

  // 重叠判定：第二个调用的开始早于第一个调用的结束
  const [a, b] = calls;
  assert.ok(a && b, "两次调用");
  const overlapped = a && b && (b.startedAt < a.endedAt || a.startedAt < b.endedAt) && b.startedAt < a.endedAt;
  assert.ok(overlapped, `分支应重叠执行：a[${a?.startedAt}-${a?.endedAt}] b[${b?.startedAt}-${b?.endedAt}]`);
});

test("默认并发下限 2：3 核机器（cores-2=1）不串行化 parallel（CI macOS runner 回归）", async () => {
  // 回归背景：默认并发曾是 max(1, hardwareConcurrency-2)，3 核 CI runner → 1 → parallel 串行、race 挂死
  const orig = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: 3 }, configurable: true });
  try {
    const { runner, calls } = delayedEchoRunner("slow-answer", 200);
    const result = await runWorkflow(script("topic"), { agent: runner });
    assert.equal(result.result.length, 2);
    const [a, b] = calls;
    assert.ok(a && b && b.startedAt < a.endedAt, `3 核机器默认并发应≥2（分支重叠）：a[${a?.startedAt}-${a?.endedAt}] b[${b?.startedAt}-${b?.endedAt}]`);
  } finally {
    if (orig) Object.defineProperty(globalThis, "navigator", orig);
  }
});

test("返回次序按输入索引稳定（乱序完成）", async () => {
  // 第二个分支先完成（延迟 0ms），第一个后完成（延迟 120ms）
  const { runner } = makeRunner(async (prompt) => {
    const delay = prompt.includes("slow") ? 120 : 0;
    await new Promise((r) => setTimeout(r, delay));
    return { type: "text" as const, value: prompt.includes("slow") ? "SLOW" : "FAST", sessionId: "s" };
  });
  const mixed = `export const meta = { name: "parallel_order" }
const answers = await parallel([() => agent("slow branch"), () => agent("fast branch")])
return answers`;
  const result = await runWorkflow(mixed, { agent: runner });
  // 输出按输入索引排列：slow 在前，尽管它后完成
  assert.deepEqual(result.result, ["SLOW", "FAST"]);
});

test("可恢复失败塌缩为 null，不终止 run", async () => {
  let calls = 0;
  const { runner } = makeRunner(async (prompt) => {
    calls++;
    if (prompt === "fail") throw new Error("transient");
    return { type: "text" as const, value: "ok", sessionId: "s" };
  });
  const failing = `export const meta = { name: "parallel_fail" }
const answers = await parallel([() => agent("fail"), () => agent("ok")])
return answers`;
  const result = await runWorkflow(failing, { agent: runner, agentRetries: 0, continueOnAgentFailure: true });
  assert.equal(result.result[0], null);
  assert.equal(result.result[1], "ok");
});

test("不可恢复失败终止整个 run", async () => {
  const { runner } = makeRunner(async () => {
    const { WorkflowError, WorkflowErrorCode } = await import("../../src/runtime/errors.js");
    throw new WorkflowError("script bug", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  });
  await assert.rejects(
    runWorkflow(script("x"), { agent: runner }),
    /script bug/,
  );
});

test("parallel 传 Promise 数组而非函数数组报 TypeError", async () => {
  const { runner } = echoRunner("x");
  const wrong = `export const meta = { name: "parallel_wrong" }
const answers = await parallel([agent("a"), agent("b")])
return answers`;
  await assert.rejects(runWorkflow(wrong, { agent: runner }), /函数数组/);
});
