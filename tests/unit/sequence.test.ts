/** P0-04：sequence 第二节点收到前项结果；可恢复失败停止序列 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";

test("纯函数链：前项结果传入后项", async () => {
  const { runner } = makeRunner(async (prompt) => ({ type: "text" as const, value: prompt, sessionId: "s" }));
  const script = `export const meta = { name: "seq_test" }
const out = await sequence([
  () => "step1",
  (prev) => prev + "-step2",
  (prev) => prev + "-step3",
])
await agent("anchor")  // run 级至少一次 agent dispatch
return out`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, "step1-step2-step3");
});

test("agent + 纯函数混合：第二节点收到第一节点 agent 结果", async () => {
  const { runner, calls } = makeRunner(async (prompt) => ({
    type: "text" as const,
    value: `echo:${prompt}`,
    sessionId: "s",
  }));
  const script = `export const meta = { name: "seq_agent" }
const out = await sequence([
  () => agent("first"),
  (prev) => agent("got:" + prev),
])
return out`;
  const result = await runWorkflow(script, { agent: runner });
  // 第一个 agent 返回 echo:first，第二个 prompt 收到 "got:echo:first"
  assert.equal(result.result, "echo:got:echo:first");
  assert.equal(calls[1]?.prompt, "got:echo:first");
});

test("中段 agent 耗尽 → null 传递，闸门在 run 终检终止（参考语义）", async () => {
  let agentCalls = 0;
  const { runner } = makeRunner(async () => {
    agentCalls++;
    if (agentCalls === 2) throw new Error("transient mid-chain failure");
    return { type: "text" as const, value: `v${agentCalls}`, sessionId: "s" };
  });
  const script = `export const meta = { name: "seq_fail" }
const out = await sequence([
  () => agent("a"),
  () => agent("b"),
  () => agent("c"),
])
return out`;
  // agent 耗尽失败返回 null（不抛错）→ sequence 继续传递 null → 阶段失败闸门在 run 终检终止
  await assert.rejects(
    runWorkflow(script, { agent: runner, agentRetries: 0 }),
    /阶段失败闸门/,
  );
  assert.ok(agentCalls >= 2, `至少执行到失败节点，实际调用 ${agentCalls} 次`);
});

test("抛出型可恢复失败：序列立即停止，后续节点不执行", async () => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "ok", sessionId: "s" }));
  const script = `export const meta = { name: "seq_throw" }
const out = await sequence([
  () => "a",
  () => { throw new Error("recoverable node failure") },
  () => { log("THIRD-NODE-EXECUTED"); return "c" },
])
await agent("anchor")
return out`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, null);
  assert.ok(!result.logs.some((l) => l.includes("THIRD-NODE-EXECUTED")), "第三个节点不应执行");
  assert.ok(result.logs.some((l) => l.includes("sequence[1] 失败")), "应记录序列停止日志");
});

test("空数组与非函数元素报 TypeError", async () => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  await assert.rejects(
    runWorkflow('export const meta = { name: "a" }\nconst r = await sequence([])\nawait agent("x")\nreturn r', {
      agent: runner,
    }),
    /非空函数数组/,
  );
  await assert.rejects(
    runWorkflow('export const meta = { name: "a" }\nconst r = await sequence(["not-fn"])\nawait agent("x")\nreturn r', {
      agent: runner,
    }),
    /非空函数数组/,
  );
});
