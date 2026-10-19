/** P1-01：fallback 可恢复失败换候选，结构性错误直接抛 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/runtime/errors.js";

test("首候选成功即返回", async () => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "first", sessionId: "s" }));
  const script = `export const meta = { name: "fb_ok" }
const r = await fallback([() => agent("a"), () => agent("b")])
return r`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, "first");
});

test("可恢复失败切换下一候选（P1-01）", async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => {
    calls++;
    if (calls === 1) throw new Error("transient"); // 第 1 候选失败（retries=0，仅一次尝试）
    return { type: "text" as const, value: "second-candidate", sessionId: "s" };
  });
  const script = `export const meta = { name: "fb_switch" }
const r = await fallback([
  () => agent("c1", { retries: 0 }),
  () => agent("c2", { retries: 0 }),
])
return r`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, "second-candidate");
});

test("agent 耗尽 null + 闸门登记 → fallback 视为候选失败换下一个（闸门归因）", async () => {
  let calls = 0;
  const { runner } = makeRunner(async (prompt) => {
    calls++;
    if (prompt === "c1") throw new Error("exhausted"); // 耗尽后返回 null + 登记
    return { type: "text" as const, value: "c2-value", sessionId: "s" };
  });
  const script = `export const meta = { name: "fb_null" }
const r = await fallback([
  () => agent("c1", { retries: 0 }),
  () => agent("c2", { retries: 0 }),
])
return r`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, "c2-value");
  assert.equal(result.agents.length, 2);
});

test("全部候选失败 → fallback 显式吸收，返回 null（闸门登记被回滚，参考语义）", async () => {
  const { runner } = makeRunner(async () => {
    throw new Error("all candidates fail");
  });
  const script = `export const meta = { name: "fb_all" }
const r = await fallback([() => agent("a"), () => agent("b")])
return r`;
  // fallback 是显式降级机制：全部候选耗尽 → 回滚登记、返回 null，run 正常结束（结果为 null）
  const result = await runWorkflow(script, { agent: runner, agentRetries: 0 });
  assert.equal(result.result, null);
  assert.equal(result.agents[0]?.status, "failed");
  assert.equal(result.agents[1]?.status, "failed");
});

test("结构性错误不被 fallback 吞掉（P1-01 后半）", async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => {
    calls++;
    if (calls === 1) {
      throw new WorkflowError("bad script structure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    return { type: "text" as const, value: "never", sessionId: "s" };
  });
  const script = `export const meta = { name: "fb_struct" }
const r = await fallback([() => agent("a"), () => agent("b")])
return r`;
  await assert.rejects(
    runWorkflow(script, { agent: runner }),
    /bad script structure/,
  );
  assert.equal(calls, 1, "结构性错误不应重试到第二候选");
});

test("fallback 内的非函数元素报 TypeError", async () => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  await assert.rejects(
    runWorkflow('export const meta = { name: "a" }\nawait fallback(["x"])\nawait agent("a")', { agent: runner }),
    /非空函数数组/,
  );
});
