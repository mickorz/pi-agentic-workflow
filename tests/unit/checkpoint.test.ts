/** P2-05：checkpoint —— 批准继续 / 拒绝硬停 / 无通道等待态 / 回放确定性 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/runtime/errors.js";
import type { JournalEntry } from "../../src/runtime/types.js";

const SCRIPT = `export const meta = { name: "cp" }
phase("review")
const before = await agent("prepare", { label: "prep" })
const ok = await checkpoint("批准部署到生产？")
const after = await agent("deploy", { label: "deploy" })
return { before, ok, after }`;

const echoRunner = () => makeRunner(async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }));

test("人工批准继续（P2-05）", async () => {
  const { runner } = echoRunner();
  const result = await runWorkflow(SCRIPT, {
    agent: runner,
    confirm: async () => true,
  });
  assert.equal((result.result as { ok: unknown }).ok, true);
  assert.ok(result.agents.some((a) => a.kind === "checkpoint" && a.status === "ok"));
});

test("人工拒绝硬停止：CHECKPOINT_REJECTED，后续不执行", async () => {
  const { runner } = echoRunner();
  await assert.rejects(
    runWorkflow(SCRIPT, { agent: runner, confirm: async () => false }),
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.CHECKPOINT_REJECTED,
  );
});

test("拒绝不可被 fallback 吞掉（硬停止语义）", async () => {
  const { runner } = echoRunner();
  const script = `export const meta = { name: "cp_fb" }
const r = await fallback([
  () => checkpoint("try 1"),
  () => agent("never"),
])
return r`;
  await assert.rejects(
    runWorkflow(script, { agent: runner, confirm: async () => false }),
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.CHECKPOINT_REJECTED,
  );
});

test("无交互通道且无显式默认 → 等待态（绝不自动通过，P2-05）", async () => {
  const { runner } = echoRunner();
  const err = await runWorkflow(SCRIPT, { agent: runner }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof WorkflowError && err.code === WorkflowErrorCode.CHECKPOINT_WAITING, `期望等待态错误，得到 ${String(err)}`);
});

test("脚本级显式默认值在无通道时生效（headless 策略）", async () => {
  const { runner } = echoRunner();
  const script = `export const meta = { name: "cp_default" }
const ok = await checkpoint("headless 场景", { default: "auto-approved-by-script" })
await agent("after")
return ok`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, "auto-approved-by-script");
});

test("回放确定性：已批准决策免问重放；拒绝回放为硬停", async () => {
  const journal = new Map<string, JournalEntry>();
  const { runner } = echoRunner();
  // 第一次：批准
  await runWorkflow(SCRIPT, {
    agent: runner,
    runId: "run-cp",
    confirm: async () => true,
    onAgentJournal: (e) => journal.set(e.key, e),
  });
  // resume：无需通道（journal 命中）——deploy 节点也已 journal
  let confirmCalls = 0;
  const resumed = await runWorkflow(SCRIPT, {
    agent: runner,
    runId: "run-cp",
    resumeJournal: journal,
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  assert.equal(confirmCalls, 0, "checkpoint 命中 journal 不再询问");
  assert.ok((resumed.result as { after: string }).after);

  // 拒绝回放：改 journal 中该 checkpoint 的 result 为 false → resume 确定性重现拒绝
  const cpKey = [...journal.keys()].find((k) => journal.get(k)?.result === true && k.includes(":1"));
  assert.ok(cpKey, "找到 checkpoint key");
  const rejectedJournal = new Map(journal);
  rejectedJournal.set(cpKey, { ...journal.get(cpKey)!, result: false });
  await assert.rejects(
    runWorkflow(SCRIPT, { agent: runner, runId: "run-cp", resumeJournal: rejectedJournal }),
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.CHECKPOINT_REJECTED,
  );
});

test("checkpoint 计入 agent 配额", async () => {
  const { runner } = echoRunner();
  const script = `export const meta = { name: "cp_quota" }
await checkpoint("one", { default: true })
await checkpoint("two", { default: true })
await agent("x")`;
  const result = await runWorkflow(script, { agent: runner, maxAgents: 3 });
  assert.equal(result.agentCount, 3);
  await assert.rejects(
    runWorkflow(script, { agent: runner, maxAgents: 2 }),
    /超限/,
  );
});
