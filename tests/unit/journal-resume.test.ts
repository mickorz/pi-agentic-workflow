/** P2：journal 回放语义（P2-01/02/03/06/07 离线部分） */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";
import type { JournalEntry } from "../../src/runtime/types.js";

const THREE_NODE = `export const meta = { name: "three_node" }
phase("work")
const a = await agent("step-1", { label: "a" })
const b = await agent("step-2", { label: "b" })
const c = await agent("step-3", { label: "c" })
return [a, b, c]`;

/** 收集 journal 的运行辅助 */
async function runWithJournal(
  script: string,
  runnerArgs: { impl: (prompt: string) => Promise<unknown>; runId: string; cwd?: string; scriptPath?: string },
) {
  const journal = new Map<string, JournalEntry>();
  let calls = 0;
  const { runner } = makeRunner(async (prompt) => {
    calls++;
    return runnerArgs.impl(prompt);
  });
  const result = await runWorkflow(script, {
    agent: runner,
    runId: runnerArgs.runId,
    ...(runnerArgs.cwd ? { cwd: runnerArgs.cwd } : {}),
    ...(runnerArgs.scriptPath ? { scriptPath: runnerArgs.scriptPath } : {}),
    onAgentJournal: (entry) => journal.set(entry.key, entry),
  });
  return { journal, calls, run: result };
}

test("P2-01：已完成节点回放——resume 不再请求已提交节点", async () => {
  // 第一次运行：3 个 agent 全部执行并记 journal
  const first = await runWithJournal(THREE_NODE, {
    runId: "run-x1",
    impl: async (prompt) => ({ type: "text" as const, value: `v:${prompt}`, sessionId: "s" }),
  });
  assert.equal(first.calls, 3);
  assert.equal(first.journal.size, 3);

  // 模拟中断后 resume：同 journal 重跑（fake runner 若被调用则会计数）
  let resumeCalls = 0;
  const { runner: resumeRunner } = makeRunner(async () => {
    resumeCalls++;
    return { type: "text" as const, value: "should-not-run", sessionId: "s" };
  });
  const resumed = await runWorkflow(THREE_NODE, {
    agent: resumeRunner,
    runId: "run-x1",
    resumeJournal: first.journal,
  });
  assert.equal(resumeCalls, 0, "全部命中 journal，不应真实调用 runner");
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), ["v:step-1", "v:step-2", "v:step-3"]);
  assert.ok(resumed.agents.every((a) => a.replayed === true), "回放节点标记 replayed");
});

test("P2-02（runtime 面）：prompt 变化 → 哈希不匹配 → 重执行该节点", async () => {
  const first = await runWithJournal(THREE_NODE, {
    runId: "run-x2",
    impl: async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }),
  });
  const MODIFIED = THREE_NODE.replace("step-2", "step-2-changed");
  let resumeCalls = 0;
  const { runner } = makeRunner(async (p) => {
    resumeCalls++;
    return { type: "text" as const, value: `new:${p}`, sessionId: "s" };
  });
  const resumed = await runWorkflow(MODIFIED, {
    agent: runner,
    runId: "run-x2",
    resumeJournal: first.journal,
  });
  // step-2 起哈希变化：step-1 回放，step-2/3 重执行
  assert.equal(resumeCalls, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), ["v:step-1", "new:step-2-changed", "new:step-3"]);
});

test("P2-03：parallel 乱序完成不会错误匹配 journal key", async () => {
  const PARALLEL = `export const meta = { name: "par" }
const [a, b] = await parallel([
  () => agent("slow", { label: "slow" }),
  () => agent("fast", { label: "fast" }),
])
return [a, b]`;
  // 第一次：slow 延迟 100ms，fast 立即——完成顺序与输入顺序相反
  const first = await runWithJournal(PARALLEL, {
    runId: "run-x3",
    impl: async (p) => {
      if (p === "slow") await new Promise((r) => setTimeout(r, 100));
      return { type: "text" as const, value: p === "slow" ? "SLOW" : "FAST", sessionId: "s" };
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(first.run.result)), ["SLOW", "FAST"]);
  // resume：全部命中（key 按 scope 调用序号分配，与完成顺序无关）
  let resumeCalls = 0;
  const { runner } = makeRunner(async () => {
    resumeCalls++;
    return { type: "text" as const, value: "x", sessionId: "s" };
  });
  const resumed = await runWorkflow(PARALLEL, { agent: runner, runId: "run-x3", resumeJournal: first.journal });
  assert.equal(resumeCalls, 0, "乱序完成不影响 key 匹配");
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.result)), ["SLOW", "FAST"]);
});

test("P2-06：取消传播——resume 后 signal abort 同样生效", async () => {
  const controller = new AbortController();
  const first = await runWithJournal(THREE_NODE, {
    runId: "run-x4",
    impl: async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }),
  });
  const { runner } = makeRunner(async (_p, options) => {
    controller.abort();
    return new Promise<never>((_, reject) => {
      if (options?.signal?.aborted) return reject(new Error("aborted"));
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  // 修改脚本使第 3 节点重执行（回放前两个）
  const MODIFIED = THREE_NODE.replace("step-3", "step-3-new");
  await assert.rejects(
    runWorkflow(MODIFIED, { agent: runner, runId: "run-x4", resumeJournal: first.journal, signal: controller.signal }),
    /aborted/i,
  );
});

test("P2-07：回放节点 token 不重复计为新消耗", async () => {
  const first = await runWithJournal(THREE_NODE, {
    runId: "run-x5",
    impl: async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }),
  });
  const firstTokens = first.run.agents.reduce((s, a) => s + (a.tokens ?? 0), 0);
  assert.equal(firstTokens, 0); // fake runner 不报 usage

  // 回放运行：agents 无 tokens 增量（未调 runner）
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  const resumed = await runWorkflow(THREE_NODE, { agent: runner, runId: "run-x5", resumeJournal: first.journal });
  const resumedTokens = resumed.agents.reduce((s, a) => s + (a.tokens ?? 0), 0);
  assert.equal(resumedTokens, 0, "回放不产生新 token 消耗");
  assert.ok(resumed.agents.every((a) => a.replayed), "全部回放");
});

test("child workflow 的 journal key 含 wf 段且可回放", async () => {
  const CHILD = `export const meta = { name: "c" }\nconst r = await agent("child-call", { label: "ca" })\nreturn r`;
  const PARENT = `export const meta = { name: "p" }\nconst c = await workflow("./child.js")\nconst root = await agent("root-call", { label: "ra" })\nreturn [c, root]`;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdir(join(tmpdir(), `pi-wf-j-${Date.now()}`), { recursive: true });
  await writeFile(join(dir, "child.js"), CHILD);
  await writeFile(join(dir, "parent.js"), PARENT);

  const first = await runWithJournal(
    await (await import("node:fs/promises")).readFile(join(dir, "parent.js"), "utf-8"),
    { runId: "run-x6", cwd: dir, scriptPath: join(dir, "parent.js"), impl: async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }) },
  );
  assert.equal(first.calls, 2);
  const childKey = [...first.journal.keys()].find((k) => k.includes(":wf0:"));
  assert.ok(childKey, `child key 应含 :wf0: 段：${[...first.journal.keys()].join(", ")}`);

  // resume 全回放
  let resumeCalls = 0;
  const { runner } = makeRunner(async () => {
    resumeCalls++;
    return { type: "text" as const, value: "x", sessionId: "s" };
  });
  const resumed = await runWorkflow(PARENT, {
    agent: runner,
    runId: "run-x6",
    resumeJournal: first.journal,
    cwd: dir,
    scriptPath: join(dir, "parent.js"),
  });
  assert.equal(resumeCalls, 0);
});
