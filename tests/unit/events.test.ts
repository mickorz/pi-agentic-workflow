/** P3-01/P3-02：事件同源、sequence 单调、游标回放一致 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { appendEvent, readEvents, validateEventSequence, eventsPath } from "../../src/events/jsonl-sink.js";
import { createEventEmitter } from "../../src/events/emitter.js";
import type { WorkflowEvent } from "../../src/events/types.js";

const SCRIPT = `export const meta = { name: "evt", phases: [{ title: "p1" }] }
phase("p1")
log("hello")
const a = await agent("one", { label: "n1" })
const b = await agent("two", { label: "n2" })
return [a, b]`;

test("事件全链路：run/node/session/log 类型齐全，sequence 严格递增（P3-01）", async () => {
  const events: WorkflowEvent[] = [];
  const { runner } = makeRunner(async (_p, options) => {
    options?.onSessionCreated?.("fake-session");
    return { type: "text" as const, value: "v", sessionId: "fake-session" };
  });
  await runWorkflow(SCRIPT, { agent: runner, runId: "run-evt", onEvent: (e) => events.push(e) });

  const types = events.map((e) => e.type);
  assert.ok(types.includes("run.started"), "run.started");
  assert.ok(types.includes("log.appended"), "log.appended");
  assert.ok(types.includes("node.started"), "node.started");
  assert.ok(types.includes("agent.session.created"), "agent.session.created");
  assert.ok(types.includes("node.completed"), "node.completed");
  const last = types[types.length - 1];
  assert.equal(last, "run.completed", "终态事件最后");

  const validation = validateEventSequence(events);
  assert.ok(validation.valid, `sequence 单调：${validation.issue}`);
  // 事件身份稳定：nodeId 与 agent record.id 同源
  const nodeStarted = events.find((e) => e.type === "node.started");
  assert.equal(nodeStarted?.nodeId, "run-evt:0");
});

test("失败：run.failed 事件；取消：run.cancelled 事件", async () => {
  const failEvents: WorkflowEvent[] = [];
  const { runner: failRunner } = makeRunner(async () => {
    throw new Error("boom");
  });
  await runWorkflow(SCRIPT, {
    agent: failRunner,
    runId: "run-f",
    agentRetries: 0,
    onEvent: (e) => failEvents.push(e),
  }).catch(() => null);
  assert.ok(failEvents.some((e) => e.type === "node.failed"));
  assert.equal(failEvents[failEvents.length - 1]?.type, "run.failed");

  const controller = new AbortController();
  const cancelEvents: WorkflowEvent[] = [];
  const { runner: hangRunner } = makeRunner(async (_p, options) => {
    controller.abort();
    return new Promise<never>((_, reject) => {
      if (options?.signal?.aborted) return reject(new Error("aborted"));
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  await runWorkflow(SCRIPT, {
    agent: hangRunner,
    runId: "run-c",
    signal: controller.signal,
    onEvent: (e) => cancelEvents.push(e),
  }).catch(() => null);
  assert.equal(cancelEvents[cancelEvents.length - 1]?.type, "run.cancelled");
});

test("checkpoint.requested/resolved 事件", async () => {
  const events: WorkflowEvent[] = [];
  const { runner } = makeRunner(async () => ({ type: "text" as const, value: "v", sessionId: "s" }));
  await runWorkflow(
    `export const meta = { name: "cp" }\nconst r = await checkpoint("deploy?", { default: true })\nawait agent("x")\nreturn r`,
    { agent: runner, runId: "run-cp", onEvent: (e) => events.push(e) },
  );
  assert.ok(events.some((e) => e.type === "checkpoint.requested"));
  assert.ok(events.some((e) => e.type === "checkpoint.resolved"));
});

test("payload 脱敏：敏感键值被替换（P3 事件安全）", async () => {
  const emitter = createEventEmitter("run-redact");
  const events: WorkflowEvent[] = [];
  const sink = (e: WorkflowEvent) => events.push(e);
  const emitter2 = createEventEmitter("run-redact", sink);
  emitter2.emit("node.completed", { payload: { api_key: "secret-value", nested: { password: "hunter2", ok: 1 } } });
  void emitter;
  const event = events[0] as { payload?: { api_key?: string; nested?: { password?: string; ok?: number } } };
  assert.equal(event.payload?.api_key, "[REDACTED]");
  assert.equal(event.payload?.nested?.password, "[REDACTED]");
  assert.equal(event.payload?.nested?.ok, 1);
});

test("JSONL 回放：按游标续读内容一致（P3-02）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-evt-"));
  try {
    // 全量事件写盘
    const events: WorkflowEvent[] = [];
    const { runner } = makeRunner(async () => ({ type: "text" as const, value: "v", sessionId: "s" }));
    await runWorkflow(SCRIPT, {
      agent: runner,
      runId: "run-replay",
      onEvent: (e) => {
        events.push(e);
        appendEvent(dir, e);
      },
    });

    // 全量读 = 原序一致
    const full = readEvents(dir);
    assert.deepEqual(
      full.events.map((e) => `${e.sequence}:${e.type}`),
      events.map((e) => `${e.sequence}:${e.type}`),
    );
    assert.ok(validateEventSequence(full.events).valid);

    // 游标续读：从 sequence 3 之后
    const after = readEvents(dir, 3);
    assert.equal(after.events[0]?.sequence, 4);
    assert.equal(after.events.length, events.length - 3);

    // 损坏行容忍
    fs.appendFileSync(eventsPath(dir), "{broken\n", "utf-8");
    const damaged = readEvents(dir);
    assert.equal(damaged.skipped, 1);
    assert.equal(damaged.events.length, events.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
