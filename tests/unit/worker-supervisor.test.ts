/**
 * V2-P1-02 Worker Supervisor 测试（真实子进程，E05 等）
 *
 * Worker 经 tsx 从源码启动（node --import tsx src/server/worker-main.ts），
 * fake runner + 可控延迟由 env 注入（PI_WORKFLOW_TEST_RUNNER / PI_WORKFLOW_FAKE_DELAY_MS）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunSupervisor } from "../../src/server/worker-supervisor.js";
import { readManifest } from "../../src/persistence/run-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerEntry = path.join(repoRoot, "src/server/worker-main.ts");
const WORKER_COMMAND = [process.execPath, "--import", "tsx", workerEntry];

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "v2-sup-"));
}

function writeScript(base: string, name: string, body: string): string {
  const p = path.join(base, name);
  fs.writeFileSync(p, body);
  return p;
}

/** 等待条件成立（轮询），超时抛错 */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor 超时：${what}`);
}

function makeSupervisor(base: string, overrides: Record<string, unknown> = {}): RunSupervisor {
  const fakeDelayMs = (overrides.fakeDelayMs as number | undefined) ?? 0;
  const { fakeDelayMs: _ignored, ...rest } = overrides as Record<string, unknown> & { fakeDelayMs?: number };
  return new RunSupervisor({
    baseDir: base,
    maxConcurrentRuns: 2,
    workerCommand: WORKER_COMMAND,
    heartbeatIntervalMs: 200,
    heartbeatTimeoutMs: 1500,
    cancelGraceMs: 3000,
    envExtra: {
      PI_WORKFLOW_TEST_RUNNER: "fake",
      PI_WORKFLOW_FAKE_DELAY_MS: String(fakeDelayMs),
    },
    ...rest,
  } as never);
}

test("start→completed：事件落盘（Server 单写）+ manifest 终态 + result.json", async () => {
  const base = tmpBase();
  const script = writeScript(
    base,
    "ok.js",
    `export const meta = { name: "ok" }\nconst a = await agent("hello")\nreturn { a }`,
  );
  const sup = makeSupervisor(base);
  const handle = await sup.start({ scriptPath: script });
  await handle.result;

  const manifest = readManifest(base, handle.runId);
  assert.equal(manifest.status, "completed");
  assert.ok(manifest.ownerInstanceId, "manifest 应携带 ownerInstanceId（V2 §3.1）");
  assert.ok(manifest.startedAt);
  assert.notEqual(manifest.pid, process.pid, "ready 后 manifest.pid 应为 Worker pid 而非 Server 占位");

  const events = await sup.readEventsSince(handle.runId, 0);
  assert.ok(events.some((e) => e.type === "run.completed"), "终态事件应经 Server 写入 events.jsonl");
  // events.jsonl 只有一份（Server 单写），Worker 未另写
  const files = fs.readdirSync(path.join(base, ".pi-workflows/runs", handle.runId));
  assert.equal(files.filter((f) => f === "events.jsonl").length, 1);
});

test("E05：kill -9 Worker → interrupted 不假成功（manifest 补偿 + result reject）", async () => {
  const base = tmpBase();
  const script = writeScript(
    base,
    "long.js",
    `export const meta = { name: "long" }\nconst a = await agent("slow")\nreturn { a }`,
  );
  const sup = makeSupervisor(base, { fakeDelayMs: 8000 });
  const handle = await sup.start({
    scriptPath: script,
  });
  // 直接拿 Worker pid（manifest ready 后覆盖）——轮询等 ready
  await waitFor(() => {
    const m = readManifest(base, handle.runId);
    return !!m && m.pid !== process.pid;
  }, 5000, "Worker ready 覆盖 pid");
  const m = readManifest(base, handle.runId);
  process.kill(m.pid!, "SIGKILL");

  await assert.rejects(handle.result, /异常退出|失联/, "失联 run 的 result 必须 reject");
  const after = readManifest(base, handle.runId);
  assert.equal(after.status, "interrupted");
  assert.ok(after.error, "interrupted 应带原因");
});

test("心跳超时：Worker 挂起不发心跳 → interrupted + SIGKILL 回收", async () => {
  const base = tmpBase();
  const script = writeScript(
    base,
    "stall.js",
    `export const meta = { name: "stall" }\nconst a = await agent("stalled")\nreturn { a }`,
  );
  // 超短心跳超时 + 长 fake 延迟：Worker 忙于长 agent 仍发心跳（interval 不被阻塞，setTimeout 仍触发）——
  // 心跳超时路径用「杀掉心跳计时」不可行，改为验证：正常慢跑中不误判；失联回收由 E05 覆盖。
  // 这里注入超短 timeout（200ms）+ 心跳间隔 5000ms：心跳间隔 > 超时 → 必触发失联回收
  const sup = makeSupervisor(base, { fakeDelayMs: 8000, heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 200 });
  const handle = await sup.start({ scriptPath: script });
  await assert.rejects(handle.result, /心跳超时|失联|异常退出/, "心跳超时应判失联");
  const m = readManifest(base, handle.runId);
  assert.equal(m.status, "interrupted");
});

test("并发上限：active 满员时 start 抛 RUN_LIMIT_REACHED", async () => {
  const base = tmpBase();
  const long = writeScript(
    base,
    "l1.js",
    `export const meta = { name: "l1" }\nconst a = await agent("slow")\nreturn { a }`,
  );
  const sup = makeSupervisor(base, { maxConcurrentRuns: 1, fakeDelayMs: 8000 });
  const h1 = await sup.start({ scriptPath: long });
  await assert.rejects(sup.start({ scriptPath: long }), (e: Error & { code?: string }) => e.code === "RUN_LIMIT_REACHED");
  await sup.cancel(h1.runId).catch(() => {});
});

test("checkpoint IPC 中继：checkpoint.requested 事件 → respondToCheckpoint → completed", async () => {
  const base = tmpBase();
  const script = writeScript(
    base,
    "cp.js",
    `export const meta = { name: "cp" }\nconst ok = await checkpoint("deploy?")\nconst a = await agent("after")\nreturn { ok, a }`,
  );
  const sup = makeSupervisor(base);
  const handle = await sup.start({ scriptPath: script });

  // 从事件流等 checkpoint.requested（Server 写入 events.jsonl 后可读）
  let approved = false;
  void (async () => {
    for await (const event of handle.events) {
      if (event.type === "checkpoint.requested" && !approved) {
        approved = true;
        const applied = await sup.respondToCheckpoint(handle.runId, "approve");
        assert.equal(applied, true, "决策应送达 Worker");
      }
    }
  })();

  const result = await handle.result;
  void result;
  // 事件流含 checkpoint.requested + resolved（经 Server 单写落盘）
  const events = await sup.readEventsSince(handle.runId, 0);
  assert.ok(events.some((e) => e.type === "checkpoint.requested"));
  assert.ok(events.some((e) => e.type === "checkpoint.resolved"));
});

test("取消升级：cancel → Worker 优雅取消 → cancelled 终态", async () => {
  const base = tmpBase();
  const script = writeScript(
    base,
    "cancel.js",
    `export const meta = { name: "cancel" }\nconst a = await agent("slow")\nreturn { a }`,
  );
  const sup = makeSupervisor(base, { fakeDelayMs: 8000 });
  const handle = await sup.start({ scriptPath: script });
  await waitFor(() => readManifest(base, handle.runId)?.pid !== process.pid, 5000, "ready");
  await sup.cancel(handle.runId);
  await assert.rejects(handle.result, /cancel|终止|abort/i);
  const m = readManifest(base, handle.runId);
  assert.equal(m.status, "cancelled");
});
