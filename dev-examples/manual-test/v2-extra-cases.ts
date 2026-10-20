/**
 * V2-P0 手动测试（补充）：RunApplicationService 拒绝族与恢复族
 *
 * 覆盖 v2-service-demo.ts 之外的服务 API 面：
 *   RUN_NOT_FOUND / RUN_STILL_ACTIVE / cancel / RESUME_MISMATCH /
 *   SIDE_EFFECTS_UNACKNOWLEDGED / completed 不可恢复(CONFLICT) / CHECKPOINT_NOT_PENDING
 *
 * 运行（仓库根目录）：
 *   npx tsx dev-examples/manual-test/v2-extra-cases.ts              # 不传模型，走 settings.json 默认模型
 *   npx tsx dev-examples/manual-test/v2-extra-cases.ts provider/modelId   # 可选：临时指定模型
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunApplicationService, ServiceError } from "../../src/index.js";
import { updateManifest } from "../../src/persistence/run-store.js";

// 可选参数：不传则 service.start 不带 model，由 Pi settings 默认模型接底
const model = process.argv[2];

const CHAIN_SCRIPT = `export const meta = { name: "v2_extra_chain" }
const a = await agent("Reply with exactly: node-1-done", { label: "n1" })
const b = await agent("Reply with exactly: node-2-done", { label: "n2" })
const c = await agent("Reply with exactly: node-3-done", { label: "n3" })
return [a, b, c]`;

const SMOKE_SCRIPT = `export const meta = { name: "v2_extra_smoke" }
const a = await agent("Reply with exactly: smoke ok", { label: "smoke" })
return a`;

let pass = 0;
let fail = 0;
function expect(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    console.log(`   [PASS] ${name}`);
  } else {
    fail++;
    console.log(`   [FAIL] ${name}`);
  }
}

/** 期望 service 调用抛出指定 ServiceErrorCode；返回是否命中 */
async function expectReject(run: () => Promise<unknown>, code: string, name: string): Promise<boolean> {
  try {
    await run();
    expect(false, `${name}（未拒绝）`);
    return false;
  } catch (e) {
    const got = e instanceof ServiceError ? e.code : `unexpected:${String(e)}`;
    expect(got === code, `${name} → ${got}`);
    return got === code;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main(): Promise<number> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-v2extra-"));
  const chainPath = path.join(base, "chain.js");
  const smokePath = path.join(base, "smoke.js");
  fs.writeFileSync(chainPath, CHAIN_SCRIPT);
  fs.writeFileSync(smokePath, SMOKE_SCRIPT);
  const service = createRunApplicationService({ baseDir: base });

  try {
    console.log("── 1) RUN_NOT_FOUND：不存在 runId 的 resume");
    await expectReject(
      () => service.resume("run-not-exists", { acknowledgeSideEffects: true }),
      "RUN_NOT_FOUND",
      "resume 未知 runId",
    );

    console.log("── 2) RUN_STILL_ACTIVE：运行中 run 不可 resume");
    const { runId } = await service.start({ scriptPath: chainPath, cwd: base, model });
    await waitFor(async () => (await service.get(runId))?.snapshot.status === "running", "running");
    // 等 journal ≥1 条（n1 已提交）：后续 cancel 才能构造出有副作用的 interrupted 态
    await waitFor(
      async () => (await service.get(runId))?.snapshot.journalEntries !== undefined,
      "journal 字段可见",
    );
    await expectReject(
      () => service.resume(runId, { acknowledgeSideEffects: true }),
      "RUN_STILL_ACTIVE",
      "running 中 resume",
    );

    console.log("── 3) cancel：服务层取消 → 终态 cancelled");
    // 等 n1 完成落 journal（≥1 条）再 cancel：保证 interrupted 后有已提交节点可回放
    await waitFor(async () => (await service.get(runId))!.snapshot.journalEntries >= 1, "journal≥1");
    await service.cancel(runId);
    await waitFor(async () => (await service.get(runId))?.snapshot.status === "cancelled", "cancelled");
    expect((await service.get(runId))?.snapshot.status === "cancelled", "cancel 终态 cancelled");

    console.log("── 4) RESUME_MISMATCH：中断 run + 脚本变更 → 拒绝");
    // 模拟进程崩溃：manifest 直接置 interrupted（对应真实场景：启动进程被强杀、pid 已死）
    updateManifest(base, runId, { status: "interrupted" });
    const original = fs.readFileSync(chainPath, "utf8");
    fs.writeFileSync(chainPath, original.replace("node-3-done", "node-3-CHANGED"));
    await expectReject(
      () => service.resume(runId, { acknowledgeSideEffects: true }),
      "RESUME_MISMATCH",
      "脚本变更后 resume",
    );
    fs.writeFileSync(chainPath, original);

    console.log("── 5) SIDE_EFFECTS_UNACKNOWLEDGED：中断恢复未确认副作用 → 拒绝；确认后恢复完成");
    await expectReject(
      () => service.resume(runId, { acknowledgeSideEffects: false }),
      "SIDE_EFFECTS_UNACKNOWLEDGED",
      "未确认副作用 resume",
    );
    await service.resume(runId, { acknowledgeSideEffects: true });
    // 带轨迹等待：每 3s 打印状态与 journal 条数，卡住时可定位
    {
      const t0 = Date.now();
      let last = "";
      for (;;) {
        const d = await service.get(runId);
        const cur = `${d?.snapshot.status} journal=${d?.snapshot.journalEntries}`;
        if (cur !== last) {
          console.log(`   [trace ${Math.round((Date.now() - t0) / 1000)}s] ${cur}`);
          last = cur;
        }
        if (d?.snapshot.status === "completed") break;
        if (Date.now() - t0 > 120_000) throw new Error(`等待超时：completed（末次 ${cur}）`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    expect((await service.get(runId))?.snapshot.status === "completed", "确认后恢复至 completed");

    console.log("── 6) completed run 不可恢复 → CONFLICT");
    await expectReject(
      () => service.resume(runId, { acknowledgeSideEffects: true }),
      "CONFLICT",
      "completed run resume",
    );

    console.log("── 7) CHECKPOINT_NOT_PENDING：无 checkpoint 的 run 提交决策（含 NOT_FOUND 映射）");
    const { runId: smokeId } = await service.start({ scriptPath: smokePath, cwd: base, model });
    await waitFor(async () => (await service.get(smokeId))?.snapshot.status === "completed", "smoke completed");
    await expectReject(
      () => service.decideCheckpoint(smokeId, "no-such-checkpoint", { decision: "approve", expectedVersion: 1 }),
      "CHECKPOINT_NOT_PENDING",
      "不存在 checkpointId 决策",
    );

    console.log("\n====");
    console.log(`PASS=${pass} FAIL=${fail}`);
    if (fail === 0) console.log("OK V2-P0 补充用例全部通过");
    return fail === 0 ? 0 : 1;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`[ERROR] ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
