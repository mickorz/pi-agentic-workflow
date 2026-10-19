/** P1-05：verify 独立 Agent Session 审查，结果符合预定义语义 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";

test("verify：多数 real=true → real true；每个 reviewer 独立 session（P1-05）", async () => {
  const sessionIds = new Set<string>();
  let reviewerCalls = 0;
  const { runner } = makeRunner(async (prompt, options) => {
    assert.ok(prompt.includes("Adversarially review"), `reviewer prompt 形态：${prompt.slice(0, 40)}`);
    reviewerCalls++;
    const sid = `verify-session-${reviewerCalls}`;
    sessionIds.add(sid);
    options?.onSessionCreated?.(sid);
    return {
      type: "structured" as const,
      value: reviewerCalls === 1 ? { real: false, reason: "skeptical" } : { real: true, reason: "looks right" },
      sessionId: sid,
    };
  });
  const script = `export const meta = { name: "verify_test" }
const verdict = await verify("Paris is the capital of France", { reviewers: 3, threshold: 0.5 })
return verdict`;
  const result = await runWorkflow(script, { agent: runner });
  const v = result.result as { real: boolean; realCount: number; total: number };
  assert.equal(v.real, true, "2/3 real → true（阈值 0.5）");
  assert.equal(v.realCount, 2);
  assert.equal(v.total, 3);
  assert.equal(reviewerCalls, 3);
  assert.equal(sessionIds.size, 3, "每个 reviewer 独立 session");
});

test("verify：多数 real=false → real false", async () => {
  const { runner } = makeRunner(async () => ({
    type: "structured" as const,
    value: { real: false, reason: "refuted" },
    sessionId: "s",
  }));
  const script = `export const meta = { name: "verify_false" }
const verdict = await verify("the moon is made of cheese", { reviewers: 2, threshold: 0.5 })
return verdict`;
  const result = await runWorkflow(script, { agent: runner });
  const v = result.result as { real: boolean; realCount: number };
  assert.equal(v.real, false);
  assert.equal(v.realCount, 0);
});

test("verify：全部塌缩 null（reviewer 全失败）→ votes 空、real false", async () => {
  const { runner } = makeRunner(async () => {
    throw new Error("reviewers down");
  });
  const script = `export const meta = { name: "verify_allfail" }
const verdict = await verify("claim", { reviewers: 2 })
return verdict`;
  const result = await runWorkflow(script, { agent: runner, continueOnAgentFailure: true });
  const v = result.result as { real: boolean; total: number };
  assert.equal(v.real, false);
  assert.equal(v.total, 0);
});

test("verify：reviewers 非法值报 TypeError", async () => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  const script = `export const meta = { name: "verify_bad" }
const verdict = await verify("claim", { reviewers: 0 })
return verdict`;
  await assert.rejects(runWorkflow(script, { agent: runner }), /reviewers/);
});
