import { test } from "node:test";
import assert from "node:assert/strict";
import { RunMonitor, type RunMonitorDeps } from "../../src/dispatch/run-monitor.js";

/**
 * 失败通知契约：必须携带 manifest.error 的真实失败原因（真机教训 2026-10-26：
 * tb-9750d090 失败通知无原因，用户只能再发一条「进度如何」查询；且 run 1 真因
 * 「模型回复不是合法 JSON」被下游 TypeError 遮蔽——通知带原因可立刻定位）。
 */
function makeMonitor(detail: unknown, enqueued: unknown[]) {
  const deps = {
    tasks: {
      list: () => [
        {
          runId: "run-1",
          userId: "u1",
          workflowId: "videodigest-extract",
          taskBindingId: "tb-x1",
          status: "running",
        },
      ],
      update: () => undefined,
    },
    service: { get: async () => detail },
    outbox: { enqueue: (m: unknown) => enqueued.push(m) },
  } as unknown as RunMonitorDeps;
  return new RunMonitor(deps);
}

test("失败通知携带 manifest.error 真实原因（多行压单行）", async () => {
  const enqueued: Array<{ text: string }> = [];
  const monitor = makeMonitor(
    {
      snapshot: {
        status: "failed",
        effectiveStatus: "failed",
        manifest: {
          error:
            "阶段失败闸门：1 个 agent 重试耗尽，workflow 终止\n  [链接解析] 链接解析: agent 结构化输出解析失败：模型回复不是合法 JSON（回复前 200 字符：）",
        },
      },
      checkpoints: [],
    },
    enqueued,
  );
  await monitor.pollOnce();
  assert.equal(enqueued.length, 1);
  const text = enqueued[0]!.text;
  assert.ok(text.includes("❌「videodigest-extract」失败（tb-x1）"), text);
  assert.ok(text.includes("模型回复不是合法 JSON"), "通知包含真实失败原因");
  assert.ok(!text.includes("\n  ["), "多行闸门清单压成单行");
});

test("超长失败原因截断到 300 字符", async () => {
  const enqueued: Array<{ text: string }> = [];
  const longError = "E" + "x".repeat(500);
  const monitor = makeMonitor(
    { snapshot: { status: "failed", effectiveStatus: "failed", manifest: { error: longError } }, checkpoints: [] },
    enqueued,
  );
  await monitor.pollOnce();
  const text = enqueued[0]!.text;
  const reason = text.split("）：\n")[1]?.split("。可发")[0] ?? "";
  assert.ok(reason.length <= 302 && reason.endsWith("…"), `截断后长度 ${reason.length}`);
});

test("无 error 的失败通知保持原格式（兼容缺 manifest/error 的老 run）", async () => {
  const enqueued: Array<{ text: string }> = [];
  const monitor = makeMonitor(
    { snapshot: { status: "failed", effectiveStatus: "failed", manifest: null }, checkpoints: [] },
    enqueued,
  );
  await monitor.pollOnce();
  assert.equal(enqueued.length, 1);
  const text = enqueued[0]!.text;
  assert.ok(text.includes("失败（tb-x1）。可发"), "无原因时不追加冒号换行");
});
