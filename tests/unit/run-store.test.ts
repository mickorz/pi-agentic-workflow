/** P2：run-store（manifest 原子写 / list 死进程补偿 / journal 追加与加载） */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createManifest,
  hashArgs,
  hashContent,
  listRuns,
  readManifest,
  runsRoot,
  updateManifest,
  writeResult,
} from "../../src/persistence/run-store.js";
import { appendJournalEntry, loadJournal } from "../../src/persistence/journal.js";

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-store-"));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const base = (dir: string) => ({
  runId: "run-test1",
  scriptPath: "/tmp/x.js",
  scriptHash: hashContent("script"),
  argsHash: hashArgs({ a: 1 }),
  args: { a: 1 },
  cwd: dir,
  status: "running" as const,
  pid: process.pid,
  meta: { name: "demo" },
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
});

test("manifest 创建/更新/读取（原子写，无残留 tmp）", withDir(async (dir) => {
  createManifest(dir, base(dir));
  const read1 = readManifest(dir, "run-test1");
  assert.ok(read1);
  assert.equal(read1.status, "running");
  const updated = updateManifest(dir, "run-test1", { status: "completed" });
  assert.equal(updated.status, "completed");
  const read2 = readManifest(dir, "run-test1");
  assert.equal(read2?.status, "completed");
  // 无 tmp 残留
  const files = fs.readdirSync(path.join(runsRoot(dir), "run-test1"));
  assert.deepEqual(files.filter((f) => f.includes(".tmp-")), []);
}));

test("listRuns：活进程 running / 死进程 → interrupted 补偿态", withDir(async (dir) => {
  createManifest(dir, { ...base(dir), runId: "run-alive", pid: process.pid });
  createManifest(dir, { ...base(dir), runId: "run-dead", pid: 999_999_999 });
  const runs = listRuns(dir);
  const alive = runs.find((r) => r.runId === "run-alive");
  const dead = runs.find((r) => r.runId === "run-dead");
  assert.equal(alive?.effectiveStatus, "running");
  assert.equal(dead?.effectiveStatus, "interrupted");
}));

test("journal 追加与加载（损坏行跳过计数）", withDir(async (dir) => {
  const runDir = path.join(runsRoot(dir), "run-j");
  fs.mkdirSync(runDir, { recursive: true });
  appendJournalEntry(runDir, { key: "run-j:0", hash: "h1", result: "v1" });
  appendJournalEntry(runDir, { key: "run-j:1", hash: "h2", result: { x: 2 } });
  fs.appendFileSync(path.join(runDir, "journal.jsonl"), "{corrupted!!!\n", "utf-8");
  const { journal, entries, skipped } = loadJournal(runDir);
  assert.equal(entries, 2);
  assert.equal(skipped, 1);
  assert.equal(journal.get("run-j:0")?.result, "v1");
}));

test("hashArgs：undefined 与 null 语义区分；内容变化即变", () => {
  assert.equal(hashArgs(undefined), null);
  assert.notEqual(hashArgs({ a: 1 }), hashArgs({ a: 2 }));
  assert.equal(hashContent("x"), hashContent("x"));
  assert.notEqual(hashContent("x"), hashContent("y"));
});

test("writeResult 原子写 result.json", withDir(async (dir) => {
  createManifest(dir, base(dir));
  writeResult(dir, "run-test1", { ok: true, result: 42 });
  const file = path.join(runsRoot(dir), "run-test1", "result.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { ok: boolean };
  assert.equal(parsed.ok, true);
}));
