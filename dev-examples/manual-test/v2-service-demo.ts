/**
 * V2-P0 手动测试：RunApplicationService 应用服务全链（无终端）
 *
 * 场景：start（跑到 checkpoint 进入等待态）→ 快照检查 → decideCheckpoint 批准 → 完成 →
 *       历史列表 → 事件读取（V2 契约映射）。
 *
 * 运行（仓库根目录）：
 *   npm run build
 *   npx tsx dev-examples/manual-test/v2-service-demo.ts cc-switch-zhipu-glm/glm-5.3-flash
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunApplicationService, ServiceError } from "../../src/index.js";
import { toV2Event } from "../../src/contracts/web.js";
import { readEvents } from "../../src/events/jsonl-sink.js";
import { runDir } from "../../src/persistence/run-store.js";

const model = process.argv[2];
if (!model) {
  console.error("用法：npx tsx dev-examples/manual-test/v2-service-demo.ts <provider/modelId>");
  process.exit(2);
}

const CP_SCRIPT = `export const meta = { name: "v2_demo" }
const a = await agent("Reply with exactly: v2-prepare-ok", { label: "prep" })
const ok = await checkpoint("V2 演示：批准继续？")
const b = await agent("Reply with exactly: v2-after-ok", { label: "after" })
return { a, ok, b }`;

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main(): Promise<number> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-v2demo-"));
  const scriptPath = path.join(base, "demo.js");
  fs.writeFileSync(scriptPath, CP_SCRIPT);
  const service = createRunApplicationService({ baseDir: base });

  try {
    console.log("── 1) start（无终端启动）");
    const { runId } = await service.start({ scriptPath, cwd: base, model });
    console.log(`   runId = ${runId}`);

    console.log("── 2) 等待 checkpoint（manifest → waiting_checkpoint，记录持久化）");
    await waitFor(
      async () => {
        const d = await service.get(runId);
        return d?.snapshot.status === "waiting_checkpoint" && d.checkpoints.length === 1;
      },
      "waiting_checkpoint",
    );
    const detail = await service.get(runId);
    const cp = detail?.checkpoints[0];
    console.log(`   状态=${detail?.snapshot.status}，checkpoint: id=${cp?.checkpointId} v${cp?.version} status=${cp?.status}`);

    console.log("── 3) 错误版本 → CONFLICT");
    try {
      await service.decideCheckpoint(runId, cp!.checkpointId, { decision: "approve", expectedVersion: 99 });
      console.error("   ✗ 未按预期拒绝");
      return 1;
    } catch (e) {
      console.log(`   ✓ ${e instanceof ServiceError ? e.code : "rejected"}`);
    }

    console.log("── 4) decideCheckpoint 批准（正确版本）→ 等待完成");
    await service.decideCheckpoint(runId, cp!.checkpointId, { decision: "approve", expectedVersion: cp!.version });
    await waitFor(async () => (await service.get(runId))?.snapshot.status === "completed", "completed");
    const done = await service.get(runId);
    console.log(`   状态=${done?.snapshot.status}，journal=${done?.snapshot.journalEntries}，events=${done?.snapshot.events.count}`);
    console.log(`   result = ${JSON.stringify((done?.snapshot.result as { result: unknown } | null)?.result)}`);

    console.log("── 5) 幂等重放：同决策同版本再提交");
    const again = await service.decideCheckpoint(runId, cp!.checkpointId, { decision: "approve", expectedVersion: cp!.version });
    console.log(`   ✓ status=${again.status}（不重复唤醒）`);

    console.log("── 6) 历史列表 + V2 事件映射（前 6 条）");
    console.log(`   runs = ${(await service.list()).map((r) => `${r.runId}:${r.effectiveStatus}`).join(", ")}`);
    const events = readEvents(runDir(base, runId)).events.map((e) => toV2Event(e));
    for (const e of events.slice(0, 6)) console.log(`   seq=${e.seq} ${e.type}${e.nodeId ? ` node=${e.nodeId}` : ""}`);

    console.log("── 7) 并发限额：RUN_LIMIT_REACHED（活跃 running 才占用额度；等待态不占）");
    const slowScript = `export const meta = { name: "v2_slow" }
const r = await agent("Write a detailed 1500-word essay about the history of databases.", { label: "slow", timeoutMs: 90_000 })
return r`;
    const slowPath = path.join(base, "slow.js");
    fs.writeFileSync(slowPath, slowScript);
    const svc2 = createRunApplicationService({ baseDir: base, maxConcurrentRuns: 1 });
    const { runId: slowId } = await svc2.start({ scriptPath: slowPath, cwd: base, model });
    await waitFor(async () => (await svc2.get(slowId))?.snapshot.status === "running", "slow running", 60_000);
    try {
      await svc2.start({ scriptPath, cwd: base, model });
      console.error("   ✗ 未按预期限额");
      return 1;
    } catch (e) {
      console.log(`   ✓ ${e instanceof ServiceError ? e.code : "rejected"}`);
    }
    await waitFor(
      async () => ["completed", "failed", "cancelled"].includes((await svc2.get(slowId))?.snapshot.status ?? ""),
      "slow terminal",
      180_000,
    );

    console.log("\n✅ V2-P0 应用服务手动测试全部通过");
    return 0;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`❌ ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
