/** V2-P0：RunApplicationService —— 无终端启动/查看/取消/恢复/审批 + 跨实例（模拟重启）恢复 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunApplicationService, ServiceError } from "../../src/application/run-service.js";
import { makeRunner } from "../helpers/fake-runner.js";

const CP_SCRIPT = `export const meta = { name: "svc_cp" }
const a = await agent("prepare", { label: "prep" })
const ok = await checkpoint("deploy to prod?")
const b = await agent("after", { label: "after" })
return { a, ok, b }`;

const SIMPLE = `export const meta = { name: "svc_simple" }\nconst r = await agent("one")\nreturn r`;

function withBase(fn: (base: string) => Promise<void>) {
  return async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-svc-"));
    try {
      await fn(base);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

const echoRunner = () =>
  makeRunner(async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }));

test("start/get/list：无终端完整生命周期", withBase(async (base) => {
  const scriptPath = path.join(base, "wf.js");
  fs.writeFileSync(scriptPath, SIMPLE);
  const service = createRunApplicationService({ baseDir: base, runner: echoRunner().runner });

  const { runId } = await service.start({ scriptPath, cwd: base });
  await waitFor(async () => (await service.get(runId))?.snapshot.status === "completed");
  const detail = await service.get(runId);
  assert.ok(detail);
  assert.equal(detail.snapshot.status, "completed");
  assert.equal(detail.snapshot.journalEntries, 1);
  const listed = await service.list();
  assert.equal(listed.length, 1);
}));

test("checkpoint：等待态 → decideCheckpoint 批准 → 完成（E04 主路径）", withBase(async (base) => {
  const scriptPath = path.join(base, "cp.js");
  fs.writeFileSync(scriptPath, CP_SCRIPT);
  const service = createRunApplicationService({ baseDir: base, runner: echoRunner().runner });

  const { runId } = await service.start({ scriptPath, cwd: base });
  // 等待 checkpoint.requested 登记且 manifest 进入等待态
  await waitFor(async () => {
    const detail = await service.get(runId);
    return detail?.checkpoints.length === 1 && detail.snapshot.status === "waiting_checkpoint";
  });
  let detail = await service.get(runId);
  assert.equal(detail?.snapshot.status, "waiting_checkpoint", "等待态持久化");
  const cp = detail?.checkpoints[0];
  assert.ok(cp);
  assert.equal(cp.status, "pending");
  assert.equal(cp.version, 1);
  assert.equal(cp.decisionBy, undefined);

  // 错误版本 → CONFLICT
  await assert.rejects(
    service.decideCheckpoint(runId, cp.checkpointId, { decision: "approve", expectedVersion: 99 }),
    (e: unknown) => e instanceof ServiceError && e.code === "CONFLICT",
  );

  // 批准（正确版本）
  const decided = await service.decideCheckpoint(runId, cp.checkpointId, { decision: "approve", expectedVersion: 1 });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decisionBy, "local-user");

  await waitFor(async () => {
    detail = await service.get(runId);
    return detail?.snapshot.status === "completed";
  }, 20_000);
  assert.equal(detail?.snapshot.status, "completed");
  // 幂等重放：同决策同版本 → 返回既有结果
  const again = await service.decideCheckpoint(runId, cp.checkpointId, { decision: "approve", expectedVersion: 1 });
  assert.equal(again.status, "approved");
}));

test("checkpoint 拒绝：硬停止，不得包装为成功（E04 拒绝路径）", withBase(async (base) => {
  const scriptPath = path.join(base, "cp.js");
  fs.writeFileSync(scriptPath, CP_SCRIPT);
  const service = createRunApplicationService({ baseDir: base, runner: echoRunner().runner });
  const { runId } = await service.start({ scriptPath, cwd: base });
  await waitFor(async () => (await service.get(runId))?.checkpoints.length === 1);
  const cp = (await service.get(runId))?.checkpoints[0]!;
  await service.decideCheckpoint(runId, cp.checkpointId, { decision: "reject", expectedVersion: 1 });
  await waitFor(async () => {
    const d = await service.get(runId);
    return d?.snapshot.status === "failed";
  });
  const detail = await service.get(runId);
  assert.equal(detail?.snapshot.status, "failed", "拒绝 → failed，不是 completed");
}));

test("跨实例（模拟服务重启）：等待审批记录持久化，resume 重问 version+1", withBase(async (base) => {
  const scriptPath = path.join(base, "cp.js");
  fs.writeFileSync(scriptPath, CP_SCRIPT);

  // 实例 A：跑到等待态后"重启"（丢弃内存 engine 状态）
  const serviceA = createRunApplicationService({ baseDir: base, runner: echoRunner().runner });
  const { runId } = await serviceA.start({ scriptPath, cwd: base });
  await waitFor(async () => {
    const d = await serviceA.get(runId);
    return d?.checkpoints.length === 1 && d.snapshot.status === "waiting_checkpoint";
  });

  // 实例 B（新进程视角）：历史可读，checkpoint 记录仍在
  const serviceB = createRunApplicationService({ baseDir: base, runner: echoRunner().runner });
  const detailB = await serviceB.get(runId);
  assert.ok(detailB);
  assert.equal(detailB.snapshot.status, "waiting_checkpoint");
  assert.equal(detailB.checkpoints.length, 1);
  assert.equal(detailB.checkpoints[0]?.version, 1);

  // B resume（waiting_checkpoint 恢复不需要副作用确认）→ checkpoint 重问 → version 2
  await serviceB.resume(runId, { acknowledgeSideEffects: false });
  await waitFor(async () => {
    const d = await serviceB.get(runId);
    return d?.checkpoints[0]?.version === 2;
  });
  const cp2 = (await serviceB.get(runId))?.checkpoints[0]!;
  assert.equal(cp2.version, 2, "重问后版本自增");
  await serviceB.decideCheckpoint(runId, cp2.checkpointId, { decision: "approve", expectedVersion: 2 });
  await waitFor(async () => (await serviceB.get(runId))?.snapshot.status === "completed");
  assert.equal((await serviceB.get(runId))?.snapshot.status, "completed");
}));

test("中断恢复需副作用确认（E11：未确认不执行）", withBase(async (base) => {
  const scriptPath = path.join(base, "wf.js");
  fs.writeFileSync(scriptPath, SIMPLE);
  const service = createRunApplicationService({ baseDir: base, runner: echoRunner().runner });
  const { runId } = await service.start({ scriptPath, cwd: base });
  await waitFor(async () => (await service.get(runId))?.snapshot.status === "completed");
  // completed → CONFLICT
  await assert.rejects(
    service.resume(runId, { acknowledgeSideEffects: true }),
    (e: unknown) => e instanceof ServiceError && e.code === "CONFLICT",
  );

  // 人造 interrupted manifest + journal
  const manifestPath = path.join(base, ".pi-workflows", "runs", runId, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.status = "interrupted";
  manifest.pid = 999_999_999;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    service.resume(runId, { acknowledgeSideEffects: false }),
    (e: unknown) => e instanceof ServiceError && e.code === "SIDE_EFFECTS_UNACKNOWLEDGED",
  );
  const resumed = await service.resume(runId, { acknowledgeSideEffects: true });
  assert.equal(resumed.runId, runId);
  await waitFor(async () => (await service.get(runId))?.snapshot.status === "completed");
}));

test("并发限额：RUN_LIMIT_REACHED", withBase(async (base) => {
  const scriptPath = path.join(base, "wf.js");
  fs.writeFileSync(scriptPath, SIMPLE);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { runner } = makeRunner(async (p) => {
    if (p === "hang") {
      await gate;
    }
    return { type: "text" as const, value: "v", sessionId: "s" };
  });
  const hangScript = `export const meta = { name: "hang" }\nconst r = await agent("hang")\nreturn r`;
  const hangPath = path.join(base, "hang.js");
  fs.writeFileSync(hangPath, hangScript);

  const service = createRunApplicationService({ baseDir: base, runner, maxConcurrentRuns: 1 });
  await service.start({ scriptPath: hangPath, cwd: base });
  await assert.rejects(
    service.start({ scriptPath, cwd: base }),
    (e: unknown) => e instanceof ServiceError && e.code === "RUN_LIMIT_REACHED",
  );
  release();
  await waitFor(async () => {
    const runs = await service.list();
    return runs.every((r) => r.effectiveStatus !== "running");
  });
  await waitFor(async () => {
    const d = await service.get((await service.list())[0]?.runId ?? "");
    return d?.snapshot.status === "completed";
  });
}));

test("resume 哈希不匹配 → RESUME_MISMATCH", withBase(async (base) => {
  const scriptPath = path.join(base, "wf.js");
  fs.writeFileSync(scriptPath, SIMPLE);
  const service = createRunApplicationService({ baseDir: base, runner: echoRunner().runner });
  const { runId } = await service.start({ scriptPath, cwd: base });
  await waitFor(async () => (await service.get(runId))?.snapshot.status === "completed");
  // 改脚本 + 伪造 failed 状态触发 resume 哈希检查
  fs.writeFileSync(scriptPath, SIMPLE.replace("one", "changed"));
  const manifestPath = path.join(base, ".pi-workflows", "runs", runId, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.status = "failed";
  manifest.pid = 999_999_999;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    service.resume(runId, { acknowledgeSideEffects: true }),
    (e: unknown) => e instanceof ServiceError && e.code === "RESUME_MISMATCH",
  );
}));

async function waitFor(predicate: () => Promise<boolean | undefined>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 100));
  }
}
