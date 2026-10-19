/** P1-02：race 仅成功分支获胜，失败分支不获胜，其余分支收到取消 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";

test("首个成功分支获胜，其余分支被取消（P1-02）", async () => {
  const aborted: boolean[] = [];
  const { runner } = makeRunner(async (prompt, options) => {
    if (prompt === "fast") {
      return { type: "text" as const, value: "FAST-WINS", sessionId: "s-fast" };
    }
    // slow 分支：挂起直到被 abort（验证 race 局部中止面）
    return new Promise<never>((_, reject) => {
      if (options?.signal?.aborted) {
        aborted.push(true);
        reject(new Error("aborted"));
        return;
      }
      options?.signal?.addEventListener("abort", () => {
        aborted.push(true);
        reject(new Error("aborted"));
      });
    });
  });
  const script = `export const meta = { name: "race_win" }
const r = await race([() => agent("slow"), () => agent("fast")])
return r`;
  const result = await runWorkflow(script, { agent: runner, agentTimeoutMs: null });
  assert.equal(result.result, "FAST-WINS");
  assert.equal(aborted.length, 1, "slow 分支应收到取消");
});

test("失败分支不获胜：慢成功分支最终胜出", async () => {
  const { runner } = makeRunner(async (prompt) => {
    if (prompt === "fail-fast") throw new Error("immediate failure");
    await new Promise((r) => setTimeout(r, 80));
    return { type: "text" as const, value: "slow-success", sessionId: "s" };
  });
  const script = `export const meta = { name: "race_fail_first" }
const r = await race([() => agent("fail-fast", { retries: 0 }), () => agent("slow-ok", { retries: 0 })])
return r`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, "slow-success");
});

test("全部候选失败 → 返回 null", async () => {
  const { runner } = makeRunner(async () => {
    throw new Error("everyone fails");
  });
  const script = `export const meta = { name: "race_all_fail" }
const r = await race([() => agent("a", { retries: 0 }), () => agent("b", { retries: 0 })])
return r`;
  const result = await runWorkflow(script, { agent: runner, continueOnAgentFailure: true });
  assert.equal(result.result, null);
});

test("agent 耗尽 null + 登记 → 不视为胜出（闸门归因）", async () => {
  const { runner } = makeRunner(async (prompt) => {
    if (prompt === "null-winner") throw new Error("exhausted");
    await new Promise((r) => setTimeout(r, 60));
    return { type: "text" as const, value: "real-winner", sessionId: "s" };
  });
  const script = `export const meta = { name: "race_null" }
const r = await race([() => agent("null-winner", { retries: 0 }), () => agent("real", { retries: 0 })])
return r`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, "real-winner");
});

test("结构性错误在 race 中直接上抛", async () => {
  const { runner } = makeRunner(async () => {
    const { WorkflowError, WorkflowErrorCode } = await import("../../src/runtime/errors.js");
    throw new WorkflowError("structural", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  });
  const script = `export const meta = { name: "race_struct" }
const r = await race([() => agent("a")])
return r`;
  await assert.rejects(runWorkflow(script, { agent: runner }), /structural/);
});
