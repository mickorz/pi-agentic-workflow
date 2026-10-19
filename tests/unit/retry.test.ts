/** P1-07：retry 次数正确 + 可取消/不可恢复/可恢复的重试语义 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/runtime/errors.js";

test("retry 糖：attempts 耗尽返回最后一次结果（不抛错）", async () => {
  let attempts = 0;
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "anchor", sessionId: "s" }));
  const script = `export const meta = { name: "retry_sugar" }
let tries = 0
const r = await retry(
  (i) => { tries = i + 1; return "still-not-good" },
  { attempts: 3, until: (v) => v === "good" },
)
await agent("anchor")
return { r, tries }`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal((result.result as { r: string }).r, "still-not-good");
  assert.equal((result.result as { tries: number }).tries, 3);
});

test("retry until 通过即提前返回", async () => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  const script = `export const meta = { name: "retry_until" }
let tries = 0
const r = await retry(
  (i) => { tries = i + 1; return tries >= 2 ? "good" : "bad" },
  { attempts: 5, until: (v) => v === "good" },
)
await agent("anchor")
return { r, tries }`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal((result.result as { tries: number }).tries, 2);
});

test("agent 可恢复失败：重试次数精确（2 次重试 = 3 次尝试，P1-07）", async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => {
    calls++;
    if (calls < 3) throw new Error("flaky");
    return { type: "text" as const, value: "ok", sessionId: "s" };
  });
  const result = await runWorkflow(
    'export const meta = { name: "r" }\nconst v = await agent("x", { retries: 2 })\nreturn v',
    { agent: runner },
  );
  assert.equal(result.result, "ok");
  assert.equal(calls, 3);
  assert.equal(result.agents[0]?.attempt, 3);
  assert.equal(result.agents[0]?.maxAttempts, 3);
});

test("结构性错误零重试（P1-07）", async () => {
  let calls = 0;
  const { runner } = makeRunner(async () => {
    calls++;
    throw new WorkflowError("non-recoverable", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
  });
  await assert.rejects(
    runWorkflow('export const meta = { name: "r" }\nawait agent("x", { retries: 3 })', { agent: runner }),
    /non-recoverable/,
  );
  assert.equal(calls, 1);
});

test("取消不重试：abort 直接终（P1-07）", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { runner } = makeRunner(async (_p, options) => {
    calls++;
    return new Promise<never>((_, reject) => {
      if (options?.signal?.aborted) return reject(new Error("aborted"));
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => controller.abort(), 10);
    });
  });
  await assert.rejects(
    runWorkflow('export const meta = { name: "r" }\nawait agent("x", { retries: 3 })', {
      agent: runner,
      signal: controller.signal,
    }),
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.WORKFLOW_ABORTED,
  );
  assert.equal(calls, 1, "取消后不应重试");
});
