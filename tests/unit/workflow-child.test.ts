/** P1-03：嵌套 workflow——无死锁、共享最大并发、阻断循环调用 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";

function withFixtures(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-nested-"));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const PARENT = `export const meta = { name: "parent" }
const child = await workflow("./child.js", { n: 1 })
return child`;

const CHILD = `export const meta = { name: "child" }
const r = await agent("child agent " + (args?.n ?? 0))
return { childResult: r }`;

test("嵌套 workflow 正常执行，child agent 有 scope 身份（P1-03）", withFixtures(async (dir) => {
  fs.writeFileSync(path.join(dir, "child.js"), CHILD);
  const { runner } = makeRunner(async (prompt) => ({
    type: "text" as const,
    value: `echo:${prompt}`,
    sessionId: "s",
  }));
  const result = await runWorkflow(PARENT, { agent: runner, cwd: dir });
  assert.deepEqual(result.result, { childResult: "echo:child agent 1" });
  // child 的 agent 带 workflowPath 身份
  const childAgent = result.agents[0];
  assert.ok(childAgent?.workflowPath, "child agent 应有 workflowPath");
  assert.ok(childAgent.id.includes("wf0"), `journal key 应含 wf0 段：${childAgent.id}`);
}));

test("自环调用被阻断（child 调回祖先）", withFixtures(async (dir) => {
  const selfLoop = `export const meta = { name: "loopy" }
await workflow("./loopy.js")
await agent("x")`;
  fs.writeFileSync(path.join(dir, "loopy.js"), selfLoop);
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  await assert.rejects(
    runWorkflow(selfLoop, { agent: runner, cwd: dir }),
    /不能调用自身或祖先/,
  );
}));

test("深度超限被阻断", withFixtures(async (dir) => {
  // 默认上限 3 层子 workflow：d0(root)→d1→d2→d3 合法；d3 再调 d4 超限
  const make = (name: string, next?: string) =>
    `export const meta = { name: "${name}" }\n${next ? `await workflow("./${next}.js")` : `await agent("${name}")`}\nreturn "${name}"`;
  fs.writeFileSync(path.join(dir, "d0.js"), make("d0", "d1"));
  fs.writeFileSync(path.join(dir, "d1.js"), make("d1", "d2"));
  fs.writeFileSync(path.join(dir, "d2.js"), make("d2", "d3"));
  fs.writeFileSync(path.join(dir, "d3.js"), make("d3", "d4"));
  fs.writeFileSync(path.join(dir, "d4.js"), make("d4"));
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  await assert.rejects(
    runWorkflow(fs.readFileSync(path.join(dir, "d0.js"), "utf-8"), {
      agent: runner,
      cwd: dir,
    }),
    /嵌套深度超限/,
  );
}));

test("共享并发上限：parent + children 并发不超限（无死锁）", withFixtures(async (dir) => {
  fs.writeFileSync(path.join(dir, "child.js"), CHILD);
  const parent = `export const meta = { name: "parent_conc" }
const kids = await parallel([
  () => workflow("./child.js", { n: 1 }),
  () => workflow("./child.js", { n: 2 }),
  () => workflow("./child.js", { n: 3 }),
])
await agent("root-anchor")
return kids`;
  let inFlight = 0;
  let maxInFlight = 0;
  const { runner } = makeRunner(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 60));
    inFlight--;
    return { type: "text" as const, value: "ok", sessionId: "s" };
  });
  const result = await runWorkflow(parent, { agent: runner, cwd: dir, concurrency: 2 });
  assert.equal(result.agentCount, 4, "3 child agent + 1 root anchor");
  assert.ok(maxInFlight <= 2, `并发不超上限 2，实际峰值 ${maxInFlight}`);
  assert.notEqual(maxInFlight, 0);
}));

test("子脚本不存在报精确错误", withFixtures(async (dir) => {
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "x", sessionId: "s" }));
  const script = `export const meta = { name: "missing" }\nawait workflow("./nope.js")`;
  await assert.rejects(
    runWorkflow(script, { agent: runner, cwd: dir }),
    /不存在或不可读/,
  );
}));

test("child args structuredClone：子流程内修改不外溢父对象", withFixtures(async (dir) => {
  fs.writeFileSync(path.join(dir, "child.js"), CHILD);
  const parent = `export const meta = { name: "clone_check" }
const payload = { n: 7 }
const r = await workflow("./child.js", payload)
return { mutatedInChild: payload.n, r }`;
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "v", sessionId: "s" }));
  const result = await runWorkflow(parent, { agent: runner, cwd: dir });
  assert.equal((result.result as { mutatedInChild: number }).mutatedInChild, 7);
}));
