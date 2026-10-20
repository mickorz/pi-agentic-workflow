/**
 * V2 checkpoints.jsonl 状态机观察探针（手动测试指南 §3）
 *
 * 场景：V2 服务跑到 checkpoint 等待态 → 打印 requested 行 → 批准 → 打印追加的 decision 行。
 * checkpoints.jsonl 仅由 V2 CheckpointService 写入（V1 CLI 审批 run 不产生该文件）。
 *
 * 运行（仓库根目录）：npx tsx dev-examples/manual-test/v2-checkpoint-view.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunApplicationService } from "../../src/index.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
fs.writeFileSync(
  path.join(base, "cp.js"),
  'export const meta={name:"cp_view"}\nconst a = await agent("Reply with exactly: ok")\nconst ok = await checkpoint("演示批准?")\nreturn { a, ok }',
);
const service = createRunApplicationService({ baseDir: base });

const wait = async (p: () => Promise<boolean>) => {
  while (!(await p())) await new Promise((r) => setTimeout(r, 300));
};

const { runId } = await service.start({ scriptPath: path.join(base, "cp.js"), cwd: base });
await wait(async () => (await service.get(runId))?.snapshot.status === "waiting_checkpoint");
const cpFile = path.join(base, ".pi-workflows/runs", runId, "checkpoints.jsonl");

console.log("== requested:");
console.log(fs.readFileSync(cpFile, "utf8"));

const cp = (await service.get(runId))!.checkpoints[0]!;
await service.decideCheckpoint(runId, cp.checkpointId, { decision: "approve", expectedVersion: cp.version });
await wait(async () => (await service.get(runId))?.snapshot.status === "completed");

console.log("== resolved（追加 decision 行）:");
console.log(fs.readFileSync(cpFile, "utf8"));

fs.rmSync(base, { recursive: true, force: true });
process.exit(0);
