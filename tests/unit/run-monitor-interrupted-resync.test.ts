import { test } from "node:test";
import assert from "node:assert/strict";
import { RunMonitor, type RunMonitorDeps, type RunLinkRow } from "../../src/dispatch/run-monitor.js";

/**
 * interrupted 补扫契约（真机 2026-10-28 run-mvqdnrv1-5405：binding 停在 interrupted
 * 而 manifest 已 completed，用户收到「已中断」但任务实际完成）：
 *  - interrupted + Run 已终态（completed/failed/cancelled）→ 同步回写 + 通知 + run-links
 *  - interrupted + Run 仍 interrupted/running/waiting → 跳过（等用户 resume，不自动拉回）
 */

interface Recorded {
  updates: Array<{ runId: string; patch: Record<string, unknown> }>;
  enqueued: Array<{ kind: string; text: string }>;
  links: RunLinkRow[];
}

function makeMonitor(status: string, bindingStatus: string, rec: Recorded): RunMonitor {
  const deps = {
    tasks: {
      list: () => [
        {
          runId: "run-1",
          userId: "u1",
          workflowId: "wf-x",
          taskBindingId: "tb-x1",
          status: bindingStatus,
        },
      ],
      update: (runId: string, patch: Record<string, unknown>) => {
        rec.updates.push({ runId, patch });
      },
    },
    service: {
      get: async () => ({
        snapshot: {
          status,
          effectiveStatus: status,
          manifest: status === "failed" ? { error: "注入失败原因 x" } : null,
          result: status === "completed" ? { summary: "完成摘要" } : null,
        },
        checkpoints: [],
      }),
    },
    outbox: { enqueue: (m: { kind: string; text: string }) => rec.enqueued.push(m) },
    runLinks: {
      get: () => undefined,
      upsert: (row: RunLinkRow) => {
        rec.links.push(row);
      },
    },
  } as unknown as RunMonitorDeps;
  return new RunMonitor(deps);
}

test("interrupted + Run 已 completed：同步回写并发完成通知", async () => {
  const rec: Recorded = { updates: [], enqueued: [], links: [] };
  await makeMonitor("completed", "interrupted", rec).pollOnce();
  assert.equal(rec.updates.length, 1, "回写一次");
  assert.equal(rec.updates[0]!.patch.status, "completed");
  assert.equal(rec.enqueued.length, 1, "完成通知入队一次");
  assert.equal(rec.enqueued[0]!.kind, "completed");
  assert.ok(rec.enqueued[0]!.text.includes("已完成"), rec.enqueued[0]!.text);
  assert.equal(rec.links[0]?.status, "completed", "run-links 回写 completed");
});

test("interrupted + Run 已 failed：同步失败并携带真实原因", async () => {
  const rec: Recorded = { updates: [], enqueued: [], links: [] };
  await makeMonitor("failed", "interrupted", rec).pollOnce();
  assert.equal(rec.updates[0]!.patch.status, "failed");
  assert.equal(rec.enqueued[0]!.kind, "failed");
  assert.ok(rec.enqueued[0]!.text.includes("注入失败原因 x"), "通知含 manifest.error");
});

test("interrupted + Run 仍 interrupted：跳过（等用户 resume，不重复发中断通知）", async () => {
  const rec: Recorded = { updates: [], enqueued: [], links: [] };
  await makeMonitor("interrupted", "interrupted", rec).pollOnce();
  assert.equal(rec.updates.length, 0, "不改状态");
  assert.equal(rec.enqueued.length, 0, "不重复发中断通知");
});

test("interrupted + Run 已 resumed 到 running：跳过（不自动拉回，等 resume 流程或下轮终态）", async () => {
  const rec: Recorded = { updates: [], enqueued: [], links: [] };
  await makeMonitor("running", "interrupted", rec).pollOnce();
  assert.equal(rec.updates.length, 0);
  assert.equal(rec.enqueued.length, 0);
});

test("cancelled 终态同步（无通知，与 running 路径一致）", async () => {
  const rec: Recorded = { updates: [], enqueued: [], links: [] };
  await makeMonitor("cancelled", "interrupted", rec).pollOnce();
  assert.equal(rec.updates[0]!.patch.status, "cancelled");
  assert.equal(rec.enqueued.length, 0, "cancelled 不入队");
  assert.equal(rec.links[0]?.status, "cancelled");
});
