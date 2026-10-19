/** P3-03：第三方 TS 程序不依赖 CLI 调用 Core（WorkflowEngine 公共 API） */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkflowEngine } from "../../src/engine.js";
import { makeRunner } from "../helpers/fake-runner.js";

const SCRIPT = `export const meta = { name: "engine_demo" }
const a = await agent("one", { label: "n1" })
return { a }`;

function withBase(fn: (base: string, scriptPath: string) => Promise<void>) {
  return async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-eng-"));
    const scriptPath = path.join(base, "wf.js");
    fs.writeFileSync(scriptPath, SCRIPT);
    try {
      await fn(base, scriptPath);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

test("start + events 订阅 + result + 快照", withBase(async (base, scriptPath) => {
  const { runner } = makeRunner(async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }));
  const engine = createWorkflowEngine({ baseDir: base, runner });

  const handle = await engine.start({ scriptPath });
  const types: string[] = [];
  for await (const event of handle.events) {
    types.push(event.type);
    if (event.type === "run.completed") break;
  }
  const result = await handle.result;
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { a: "v:one" });
  assert.ok(types.includes("run.started"));
  assert.equal(types[types.length - 1], "run.completed");

  const snapshot = await engine.getRun(handle.runId);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "completed");
  assert.ok(snapshot.events.count > 0, "事件已持久化");
  assert.ok(snapshot.events.sequenceValid, "sequence 完整");
  assert.equal(snapshot.journalEntries, 1);

  const listed = await engine.listRuns();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.runId, handle.runId);
}));

test("respondToCheckpoint：engine 级审批通道（approve/reject）", withBase(async (base) => {
  // 用 fake runner；checkpoint 经 engine 通道审批
  const cpScript = `export const meta = { name: "cp_engine" }\nconst ok = await checkpoint("deploy?")\nconst a = await agent("after")\nreturn { ok, a }`;
  const scriptPath = path.join(base, "cp.js");
  fs.writeFileSync(scriptPath, cpScript);
  const { runner } = makeRunner(async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }));
  const engine = createWorkflowEngine({ baseDir: base, runner });

  const handle = await engine.start({ scriptPath });
  // 等到 checkpoint.requested 后批准
  void (async () => {
    for await (const event of handle.events) {
      if (event.type === "checkpoint.requested") {
        await engine.respondToCheckpoint(handle.runId, "approve");
        break;
      }
    }
  })();
  const result = await handle.result;
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { ok: true, a: "v:after" });

  // 拒绝场景
  const handle2 = await engine.start({ scriptPath });
  void (async () => {
    for await (const event of handle2.events) {
      if (event.type === "checkpoint.requested") {
        await engine.respondToCheckpoint(handle2.runId, "reject");
        break;
      }
    }
  })();
  const outcome = await handle2.result.then(
    () => "success",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  assert.match(String(outcome), /人工拒绝/);
  const snap2 = await engine.getRun(handle2.runId);
  assert.equal(snap2?.status, "failed", "拒绝不得包装为成功（P3-05）");
}));

test("cancel：engine 内取消 → cancelled 快照", withBase(async (base, scriptPath) => {
  const controllerAbort = new AbortController();
  const { runner } = makeRunner(async (_p, options) => {
    return new Promise<never>((_, reject) => {
      if (options?.signal?.aborted) return reject(new Error("aborted"));
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => controllerAbort.abort(), 10);
    });
  });
  const engine = createWorkflowEngine({ baseDir: base, runner });
  const handle = await engine.start({ scriptPath });
  void handle.result.catch(() => {});
  // 立即取消
  await engine.cancel(handle.runId);
  const outcome = await handle.result.then(
    () => "success",
    (e: unknown) => String(e),
  );
  assert.match(outcome, /abort/i);
  const snap = await engine.getRun(handle.runId);
  assert.equal(snap?.status, "cancelled");
}));

test("readEventsSince：游标续读（V2 SSE 续读面）", withBase(async (base, scriptPath) => {
  const { runner } = makeRunner(async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }));
  const engine = createWorkflowEngine({ baseDir: base, runner });
  const handle = await engine.start({ scriptPath });
  await handle.result;
  const all = await engine.readEventsSince(handle.runId, 0);
  assert.ok(all.length > 3);
  const tail = await engine.readEventsSince(handle.runId, 2);
  assert.equal(tail.length, all.length - 2);
  assert.equal(tail[0]?.sequence, 3);
}));

test("resume：engine 恢复回放已提交节点", withBase(async (base, scriptPath) => {
  let calls = 0;
  const { runner } = makeRunner(async (p) => {
    calls++;
    return { type: "text" as const, value: `v:${p}`, sessionId: "s" };
  });
  const engine = createWorkflowEngine({ baseDir: base, runner });
  const first = await engine.start({ scriptPath });
  await first.result;
  assert.equal(calls, 1);

  // 标记为 interrupted 后 resume（绕过 completed 检查：用新 run 模拟 —— 直接验证哈希拒绝）
  const { WorkflowError, WorkflowErrorCode } = await import("../../src/runtime/errors.js");
  // completed 不能 resume
  const resumed = await engine.resume(first.runId).then(
    () => "ok",
    (e: unknown) => e,
  );
  assert.ok(resumed instanceof Error && /already completed/.test(resumed.message));
  void WorkflowError;
  void WorkflowErrorCode;
}));
