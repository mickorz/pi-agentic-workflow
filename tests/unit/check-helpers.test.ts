/** P1-04 + helpers：check 语义与 fileExists / commandSuccess */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/runtime/errors.js";

const okRunner = () => makeRunner(async () => ({ type: "text" as const, value: "ok", sessionId: "s" }));

test("check 通过返回 true（P1-04 正向）", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "check_ok" }
const gate = await check(() => 1 + 1 === 2, "math broken")
await agent("anchor")
return gate`;
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, true);
});

test("check false → CHECK_FAILED 可恢复失败；sequence 停止；闸门不放过（P1-04）", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "check_fail" }
const out = await sequence([
  () => agent("build", { label: "build" }),
  () => check(() => false, "编译失败"),
  () => agent("deploy"),
])
return out`;
  // check 抛 CHECK_FAILED（recoverable）→ sequence 停止返回 null → 脚本正常 return null
  // 但语义上工作流不得报告 success：sequence 停止日志 + 后续不执行
  const result = await runWorkflow(script, { agent: runner });
  assert.equal(result.result, null);
  assert.ok(result.logs.some((l) => l.includes("编译失败")), "应记录 check 失败");
  assert.equal(result.agents.length, 1, "deploy 不应执行");
});

test("check 条件自身 throw → 结构性错误（非验证未通过）", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "check_throw" }
await check(() => { throw new Error("checker bug") }, "msg")
await agent("anchor")`;
  await assert.rejects(
    runWorkflow(script, { agent: runner }),
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
});

test("check 非函数入参报结构性错误", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "check_type" }
await check("not a function")
await agent("anchor")`;
  await assert.rejects(runWorkflow(script, { agent: runner }), /函数条件/);
});

test("fileExists：相对 cwd 判定", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-fe-"));
  try {
    fs.writeFileSync(path.join(dir, "present.txt"), "x");
    const { runner } = okRunner();
    const script = `export const meta = { name: "fe" }
const a = fileExists("present.txt")
const b = fileExists("missing.txt")
const c = fileExists("")
await agent("anchor")
return { a, b, c }`;
    const result = await runWorkflow(script, { agent: runner, cwd: dir });
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { a: true, b: false, c: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("commandSuccess：退出码判定 + 超时视为失败", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "cs" }
const okCmd = await commandSuccess("exit 0")
const badCmd = await commandSuccess("exit 1")
const slowTimeout = await commandSuccess("sleep 5", 300)
await agent("anchor")
return { okCmd, badCmd, slowTimeout }`;
  const result = await runWorkflow(script, { agent: runner });
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { okCmd: true, badCmd: false, slowTimeout: false });
});

test("quality-gates 示例脚本可解析", async () => {
  const { parseWorkflowScript } = await import("../../src/runtime/vm.js");
  const content = fs.readFileSync(path.resolve("examples/quality-gates.js"), "utf-8");
  const { meta } = parseWorkflowScript(content);
  assert.equal(meta.name, "quality_gates");
});
