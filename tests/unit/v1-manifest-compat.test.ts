/** P3-03 兼容性回归：V1 时代 manifest/journal 在 V2 引擎下行为不变（E06/E18 支撑）
 *
 * V1 的 RunManifest 不含 ownerInstanceId/startedAt（V2 新增可选字段）；
 * journal 条目结构 V1/V2 相同（{key,hash,result,...}）。
 * 本文件锁定：旧数据可读、effectiveStatus 判定正确、resume 回放不重复执行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkflowEngine } from "../../src/engine.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { hashArgs, hashContent, runDir } from "../../src/persistence/run-store.js";

const SCRIPT = `export const meta = { name: "v1_compat_demo" }
const a = await agent("one", { label: "n1" })
const b = await agent("two", { label: "n2" })
return a && b
`;

function withBase(fn: (base: string, scriptPath: string) => Promise<void>) {
  return async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-v1compat-"));
    const scriptPath = path.join(base, "wf.js");
    fs.writeFileSync(scriptPath, SCRIPT);
    try {
      await fn(base, scriptPath);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

/** 手写 V1 时代 manifest（不含 V2 新增字段 ownerInstanceId/startedAt） */
function v1Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-v1legacy-0001",
    scriptPath: path.join("/tmp", "wf.js"),
    scriptHash: hashContent(SCRIPT),
    argsHash: hashArgs(undefined),
    cwd: "/tmp",
    status: "completed",
    pid: 12345,
    meta: { name: "v1_compat_demo" },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:01.000Z",
    endedAt: "2025-01-01T00:00:01.000Z",
    options: { model: null, concurrency: null, timeoutMs: null, retries: null, maxAgents: null, continueOnFailure: false },
    ...overrides,
  };
}

function writeV1Run(base: string, manifest: Record<string, unknown>, journalLines: string[] = []): void {
  const dir = runDir(base, manifest.runId as string);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (journalLines.length > 0) {
    fs.writeFileSync(path.join(dir, "journal.jsonl"), journalLines.map((l) => `${l}\n`).join(""));
  }
}

test("V1 manifest（无 ownerInstanceId/startedAt）：getRun/listRuns 可读、终态判定正确", withBase(async (base) => {
  const { runner } = makeRunner(async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }));
  const engine = createWorkflowEngine({ baseDir: base, runner });
  writeV1Run(base, v1Manifest({ status: "completed", runId: "run-v1done" }));

  const snap = await engine.getRun("run-v1done");
  assert.ok(snap, "V1 completed manifest 应可读");
  assert.equal(snap.status, "completed");
  assert.equal(snap.effectiveStatus, "completed");
  assert.equal(snap.manifest.ownerInstanceId, undefined, "V1 无 owner 字段应保持 undefined");

  const list = await engine.listRuns();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.runId, "run-v1done");
  assert.equal(list[0]?.effectiveStatus, "completed");
}));

test("V1 running manifest + 死 pid：effectiveStatus=interrupted（不假成功）", withBase(async (base) => {
  const { runner } = makeRunner(async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }));
  const engine = createWorkflowEngine({ baseDir: base, runner });
  writeV1Run(base, v1Manifest({ status: "running", runId: "run-v1dead", pid: 999999999 }));

  const snap = await engine.getRun("run-v1dead");
  assert.ok(snap);
  assert.equal(snap.status, "running");
  assert.equal(snap.effectiveStatus, "interrupted", "死 pid 的 V1 遗留 running 应判 interrupted");
}));

test("V1 journal（既有条目结构）：resume 回放不重复执行、收敛 completed", withBase(async (base, scriptPath) => {
  let calls = 0;
  const { runner } = makeRunner(async (p) => {
    calls++;
    return { type: "text" as const, value: `v:${p}`, sessionId: "s" };
  });
  const engine = createWorkflowEngine({ baseDir: base, runner });

  // 1) 正常跑完一次，journal 落两条（真实哈希，保证回放命中）
  const first = await engine.start({ scriptPath });
  await first.result;
  assert.equal(calls, 2);

  // 2) 篡改为 V1 遗留 interrupted（保留 journal + events，模拟 V1 崩溃现场）
  const dir = runDir(base, first.runId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8")) as Record<string, unknown>;
  const v1 = v1Manifest({
    ...manifest,
    runId: first.runId,
    scriptPath,
    cwd: base,
    status: "interrupted",
    pid: 999999999,
  });
  delete (v1 as Record<string, unknown>).ownerInstanceId;
  delete (v1 as Record<string, unknown>).startedAt;
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(v1, null, 2));
  fs.rmSync(path.join(dir, "result.json"), { force: true });

  // 3) resume：journal 全量回放 → 0 次新调用 → completed
  const preEvents = await engine.readEventsSince(first.runId, 0);
  const preMaxSeq = preEvents.reduce((m, e) => Math.max(m, e.sequence), 0);
  const resumed = await engine.resume(first.runId);
  void resumed.result.catch(() => {});
  await resumed.result;
  assert.equal(calls, 2, "resume 后不应重复执行 agent（journal 回放）");
  const snap = await engine.getRun(first.runId);
  assert.equal(snap?.status, "completed");
  const events = await engine.readEventsSince(first.runId, 0);
  const replayed = events.filter((e) => e.type === "node.replayed");
  assert.equal(replayed.length, 2, "两节点均走回放");
  const newCompleted = events.filter((e) => e.type === "run.completed" && e.sequence > preMaxSeq);
  assert.equal(newCompleted.length, 1, "resume 后新堈 run.completed 恰一次（旧完成事件保留在流中）");
}));
