/**
 * run-store 终态不可逆守卫测试（IPC 双写竞态回归）。
 * 背景：Server（wireCheckpointRecording 的 waiting↔running 回翻）与 Worker（终态写入）
 * 对 manifest.json 的写操作经 IPC 后到达顺序不定；守卫保证终态一经写入即事实，
 * 除显式恢复（force）外任何迟到写入不能把终态迁回非终态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createManifest, readManifest, TERMINAL_STATUSES, updateManifest } from "../../src/persistence/run-store.js";
import type { RunManifest } from "../../src/persistence/run-store.js";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "v2-terminal-guard-"));
}

function seed(base: string, status: RunManifest["status"]): string {
  const runId = `run-guard-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const manifest: RunManifest = {
    runId,
    scriptPath: path.join(base, "s.js"),
    scriptHash: "h".repeat(64),
    argsHash: null,
    cwd: base,
    status,
    pid: process.pid,
    meta: { name: "guard_test" },
    createdAt: now,
    updatedAt: now,
  };
  createManifest(base, manifest);
  return runId;
}

test("终态不可逆：completed 后迟到的 running 回翻被静默丢弃（其余字段照常合并）", () => {
  const base = tmpBase();
  const runId = seed(base, "completed");
  const next = updateManifest(base, runId, { status: "running", error: "late write" });
  assert.equal(next.status, "completed", "终态不可被迟到写入迁出");
  assert.equal(next.error, "late write", "非 status 字段仍合并");
  const onDisk = readManifest(base, runId);
  assert.equal(onDisk?.status, "completed");
});

test("终态之间也不可互相覆盖（interrupted 不吃掉 completed 的真相）", () => {
  const base = tmpBase();
  const runId = seed(base, "completed");
  const next = updateManifest(base, runId, { status: "interrupted", error: "worker exit without terminal" });
  assert.equal(next.status, "completed", "先落盘的终态是事实");
  void TERMINAL_STATUSES;
});

test("force:true 允许显式恢复迁移（interrupted → running 的 resume 路径）", () => {
  const base = tmpBase();
  const runId = seed(base, "interrupted");
  const next = updateManifest(base, runId, { status: "running", pid: 4242 }, { force: true });
  assert.equal(next.status, "running");
  assert.equal(next.pid, 4242);
});

test("非终态间迁移不受守卫影响（waiting_checkpoint → running）", () => {
  const base = tmpBase();
  const runId = seed(base, "waiting_checkpoint");
  const next = updateManifest(base, runId, { status: "running" });
  assert.equal(next.status, "running");
});

test("同状态重复写入不受守卫影响（幂等补写）", () => {
  const base = tmpBase();
  const runId = seed(base, "completed");
  const next = updateManifest(base, runId, { status: "completed", error: "refine" });
  assert.equal(next.status, "completed");
  assert.equal(next.error, "refine");
});
