/**
 * WX-PT Part B 程序化决策（B02/B03/B04）：与微信消息同一服务层通道
 * B02 批准 tb-6d8625bb → completed（含第二阶段）
 * B03 拒绝 tb-6b5f78f9 / tb-4fda1930 → 拒绝硬停（无第二阶段）
 * B04 重复批准幂等 → 不重复推进
 * 运行：npx tsx dev-examples/wx-p2/batch-decide.ts（仓库根，wx-p2 服务的数据目录）
 */
import path from "node:path";
import { createRunApplicationService, ServiceError } from "../../src/index.js";

const base = path.resolve("dev-examples/wx-p2");
const service = createRunApplicationService({ baseDir: base });

let pass = 0;
let fail = 0;
const ok = (m: string) => { pass++; console.log(`[PASS] ${m}`); };
const bad = (m: string) => { fail++; console.log(`[FAIL] ${m}`); };

async function waitFor(runId: string, statuses: string[], timeoutMs = 120_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const d = await service.get(runId);
    const s = d?.snapshot.status ?? "unknown";
    if (statuses.includes(s)) return s;
    if (Date.now() - t0 > timeoutMs) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function decide(runId: string, decision: "approve" | "reject"): Promise<void> {
  const detail = await service.get(runId);
  // 跨固化决策场景：优先 pending，否则取首个已决（decideCheckpoint 幂等重放会走 resume 重挂路径）
  const cp = detail?.checkpoints.find((c) => c.status === "pending") ?? detail?.checkpoints[0];
  if (!cp) throw new Error(`${runId} 无 checkpoint`);
  await service.decideCheckpoint(runId, cp.checkpointId, { decision, expectedVersion: cp.version });
}

async function main(): Promise<number> {
  // B02：批准 tb-6d8625bb（run-mvhksfu4-429k）
  console.log("── B02 批准 tb-6d8625bb");
  try {
    await decide("run-mvhksfu4-429k", "approve");
    const st = await waitFor("run-mvhksfu4-429k", ["completed", "failed"], 180_000);
    const d = await service.get("run-mvhksfu4-429k");
    const result = (d?.snapshot.result as { result?: { second?: string } } | null)?.result;
    if (st === "completed" && result?.second) ok(`B02 批准后 completed 且第二阶段执行（second=${String(result.second).slice(0, 30)}）`);
    else bad(`B02 终态=${st} result=${JSON.stringify(result)?.slice(0, 80)}`);
  } catch (e) { bad(`B02 异常：${e instanceof Error ? e.message : String(e)}`); }

  // B03：拒绝 tb-6b5f78f9（run-mvhkp09y-ubru）与 tb-4fda1930（run-mvhomn8x-la6u）
  for (const [tb, runId] of [["tb-6b5f78f9", "run-mvhkp09y-ubru"], ["tb-4fda1930", "run-mvhomn8x-la6u"]] as const) {
    console.log(`── B03 拒绝 ${tb}`);
    try {
      await decide(runId, "reject");
      const st = await waitFor(runId, ["failed", "cancelled", "completed"], 60_000);
      const d = await service.get(runId);
      const result = (d?.snapshot.result as { result?: { second?: string } } | null)?.result;
      if (st === "failed" && !result?.second) ok(`B03 ${tb} 拒绝硬停（failed，无第二阶段结果）`);
      else bad(`B03 ${tb} 终态=${st}（预期 failed 且无 second）`);
    } catch (e) { bad(`B03 ${tb} 异常：${e instanceof Error ? e.message : String(e)}`); }
  }

  // B04：重复批准已批准项 → 幂等/冲突，不重复推进
  console.log("── B04 重复批准 tb-6d8625bb");
  try {
    const detail = await service.get("run-mvhksfu4-429k");
    const cp = detail?.checkpoints[0]!;
    try {
      await service.decideCheckpoint("run-mvhksfu4-429k", cp.checkpointId, { decision: "approve", expectedVersion: cp.version });
      ok("B04 重复批准幂等返回（approved 重放，不重复唤醒）");
    } catch (e) {
      if (e instanceof ServiceError && (e.code === "CONFLICT" || e.code === "CHECKPOINT_NOT_PENDING")) ok(`B04 重复批准被拒绝（${e.code}，不重复推进）`);
      else bad(`B04 异常 code=${e instanceof ServiceError ? e.code : "unknown"}`);
    }
    const st = (await service.get("run-mvhksfu4-429k"))?.snapshot.status;
    if (st === "completed") ok("B04 重放后终态仍 completed（journal 决策固化）");
    else bad(`B04 重放后终态=${st}`);
  } catch (e) { bad(`B04 异常：${e instanceof Error ? e.message : String(e)}`); }

  console.log("\n====");
  console.log(`PASS=${pass} FAIL=${fail}`);
  return fail === 0 ? 0 : 1;
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 1; });
