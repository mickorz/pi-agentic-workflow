/**
 * AM-P0 T4 单测：PendingAction 确认执行链（§3 全量）
 * 验收锚点（执行计划 §7 T4）：并发确认只一个 Run；重复确认返原始结果；
 * kill -9 重启（executing 悬置）进入告警人工核对，不盲目重启动。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { TaskStore } from "../../src/dispatch/task-store.js";
import type { WorkflowRegistration } from "../../src/contracts/wx.js";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { PendingActionService } from "../../src/agent-host/pending-flow.js";
import { RunLaunchStore, RunLinkStore } from "../../src/agent-host/run-launch.js";
import { LaunchCoordinator } from "../../src/agent-host/launch-flow.js";
import { computeArgsDigest, computeRegistryDigest } from "../../src/agent-host/digest.js";

const DEPLOY: WorkflowRegistration = {
  workflowId: "deploy-service",
  scriptPath: "deploy.js",
  name: "部署服务",
  description: "部署服务到生产环境",
  argsSchema: { type: "object", properties: { env: { type: "string" } }, required: [] },
  riskLevel: "write",
  enabled: true,
  keywords: ["部署"],
};

interface Fixture {
  root: string;
  registry: WorkflowRegistry;
  tasks: TaskStore;
  pending: PendingActionStore;
  flow: PendingActionService;
  started: Array<{ scriptPath: string; args?: unknown }>;
  setFailStart(v: boolean): void;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-t4-"));
  const registry = new WorkflowRegistry([DEPLOY]);
  const tasks = new TaskStore(path.join(root, "data"));
  const started: Array<{ scriptPath: string; args?: unknown }> = [];
  let failStart = false;
  const dispatcher = new Dispatcher({
    registry,
    router: { route: async () => { throw new Error("IntentRouter 不应被触发"); } } as never,
    tasks,
    service: {
      start: async (input: { scriptPath: string; args?: unknown }) => {
        started.push({ scriptPath: input.scriptPath, args: input.args });
        if (failStart) throw Object.assign(new Error("已达并发上限"), { code: "RUN_LIMIT_REACHED" });
        return { runId: `run-${started.length}` };
      },
    },
    scriptsRoot: root,
  });
  const pending = new PendingActionStore(path.join(root, "data"));
  const launcher = new LaunchCoordinator({
    attempts: new RunLaunchStore(path.join(root, "data")),
    runLinks: new RunLinkStore(path.join(root, "data")),
    dispatcher,
    tasks,
  });
  const flow = new PendingActionService({ pending, registry, launcher });
  return {
    root, registry, tasks, pending, flow, started,
    setFailStart: (v: boolean) => { failStart = v; },
  };
}

/** 创建一个高风险待审批项（走真实 create 快照路径） */
function seedPending(f: Fixture, args: unknown = { env: "prod" }): string {
  return f.pending.create({
    userId: "u1",
    workflowId: "deploy-service",
    args,
    argsDigest: computeArgsDigest(args),
    originMessageId: "m1",
    riskLevel: "write",
    registryDigest: computeRegistryDigest(f.registry),
  }).actionId;
}

test("T4：确认 happy path——认领→快照直调→回填（authorized 仅此通道为 true）", async () => {
  const f = makeFixture();
  const id = seedPending(f);
  const out = await f.flow.confirm(id, "u1");
  assert.equal(out.ok, true);
  assert.equal(f.started.length, 1, "从快照启动一次");
  assert.deepEqual(f.started[0]!.args, { env: "prod" });
  assert.equal(f.pending.get(id)?.status, "executed");
  assert.equal(f.pending.get(id)?.result?.runId, "run-1");
  const binding = f.tasks.list()[0]!;
  assert.equal(binding.workflowId, "deploy-service");
  assert.equal(binding.messageId, "m1", "审计链回到原始消息");
});

test("T4：并发确认只一个 Run；重复确认幂等返回原始结果", async () => {
  const f = makeFixture();
  const id = seedPending(f);
  const [a, b] = await Promise.all([f.flow.confirm(id, "u1"), f.flow.confirm(id, "u1")]);
  assert.equal(f.started.length, 1, "只启动一个 Run");
  // 后到者要么 busy（飞行中）要么 alreadyExecuted（已完成，同 runId）；不得出现第二个启动
  for (const r of [a, b]) {
    if (r.ok && r.alreadyExecuted) assert.equal(r.runId, "run-1", "幂等返回原始结果");
    if (!r.ok) assert.ok(r.reason === "busy" || r.reason === "already_executed", `意外失败原因：${r.reason}`);
  }
  // 顺序重复确认：started 仍为 1
  const again = await f.flow.confirm(id, "u1");
  assert.equal(again.ok, true);
  assert.ok(again.ok && again.alreadyExecuted);
  assert.equal(f.started.length, 1);
});

test("T4：重校验失败路径——跨用户/registry 变化/过期/拒绝", async () => {
  const f = makeFixture();
  const other = seedPending(f);
  const cross = await f.flow.confirm(other, "u2");
  assert.equal(!cross.ok && cross.reason, "validation_failed");
  assert.equal(f.started.length, 0, "不启动");

  const id2 = seedPending(f);
  f.registry.setEnabled("deploy-service", false); // plan 与 confirm 间隔内下线
  const regChanged = await f.flow.confirm(id2, "u1");
  assert.equal(!regChanged.ok && regChanged.reason, "validation_failed");
  f.registry.setEnabled("deploy-service", true);

  const expired = f.pending.create({
    userId: "u1", workflowId: "deploy-service", args: {}, argsDigest: computeArgsDigest({}),
    originMessageId: "m", riskLevel: "write", registryDigest: computeRegistryDigest(f.registry), ttlMs: 1,
  });
  await new Promise((r) => setTimeout(r, 20));
  const exp = await f.flow.confirm(expired.actionId, "u1");
  assert.equal(!exp.ok && exp.reason, "expired");

  const id3 = seedPending(f);
  const rej = f.flow.rejectAction(id3, "u1");
  assert.equal(rej.ok, true);
  const afterReject = await f.flow.confirm(id3, "u1");
  assert.equal(!afterReject.ok && afterReject.reason, "rejected");
  assert.equal(f.started.length, 0);
});

test("T4：确定性启动失败→退回 pending 可再确认（非不确定态）", async () => {
  const f = makeFixture();
  const id = seedPending(f);
  f.setFailStart(true);
  const fail1 = await f.flow.confirm(id, "u1");
  assert.equal(!fail1.ok && fail1.reason, "launch_failed");
  assert.equal(f.pending.get(id)?.status, "pending", "同步失败退回 pending");

  f.setFailStart(false);
  const ok2 = await f.flow.confirm(id, "u1");
  assert.equal(ok2.ok, true, "可再次确认启动");
  assert.equal(f.pending.get(id)?.status, "executed");
});

test("T4：kill -9 重启（executing 悬置）→ recoverStuck 告警，禁自动重试", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-t4k-"));
  const registry = new WorkflowRegistry([DEPLOY]);
  const tasks = new TaskStore(path.join(root, "data"));
  const started: Array<unknown> = [];
  const dispatcher = new Dispatcher({
    registry,
    router: { route: async () => { throw new Error("不应触发"); } } as never,
    tasks,
    service: { start: async (input: unknown) => { started.push(input); return { runId: "run-1" }; } },
    scriptsRoot: root,
  });
  const pending1 = new PendingActionStore(path.join(root, "data"));
  const id = pending1.create({
    userId: "u1", workflowId: "deploy-service", args: { env: "prod" },
    argsDigest: computeArgsDigest({ env: "prod" }), originMessageId: "m1",
    riskLevel: "write", registryDigest: computeRegistryDigest(registry),
  }).actionId;
  // 模拟：确认已认领（claim 成功）后、启动前进程被 kill -9
  const claim = await pending1.claim(id, { userId: "u1", registryDigest: computeRegistryDigest(registry) });
  assert.equal(claim.ok, true);
  assert.equal(started.length, 0, "认领后、启动前中断（最坏窗口）");

  // “重启”：新实例从 jsonl 恢复
  const uncertain: string[] = [];
  const pending2 = new PendingActionStore(path.join(root, "data"));
  const flow2 = new PendingActionService({
    pending: pending2, registry,
    launcher: new LaunchCoordinator({
      attempts: new RunLaunchStore(path.join(root, "data")),
      runLinks: new RunLinkStore(path.join(root, "data")),
      dispatcher,
      tasks,
    }),
    onUncertain: (a) => uncertain.push(a.actionId),
  });
  const stuck = flow2.recoverStuck();
  assert.equal(stuck.length, 1);
  assert.deepEqual(uncertain, [id], "逐条告警");
  assert.equal(started.length, 0, "禁自动重试：不盲目重启");
  assert.equal(pending2.get(id)?.status, "executing", "保持 executing 待人工核对");
  // 再次确认也被挡（busy）：启动结果不确定，不允许并发补启动
  const again = await flow2.confirm(id, "u1");
  assert.equal(!again.ok && again.reason, "busy");
  assert.equal(started.length, 0);
});

test("T4：AM-13 多待审批并存——listFor 返回全部；按 actionId 精确确认互不误批", async () => {
  const f = makeFixture();
  const a = seedPending(f, { env: "prod" });
  const b = seedPending(f, { env: "staging" });
  assert.equal(f.flow.listFor("u1").length, 2);

  const out = await f.flow.confirm(b, "u1"); // 明确批准第二项
  assert.equal(out.ok, true);
  assert.deepEqual(f.started[0]!.args, { env: "staging" });
  assert.equal(f.pending.get(a)?.status, "pending", "另一项不受影响");
  assert.equal(f.pending.get(b)?.status, "executed");
});

test("T4：过期 pending 不再占据待审批列表（2026-10-27 真机「批准永远过期」陷阱）", async () => {
  const f = makeFixture();
  const args = { env: "prod" };
  const id = f.pending.create({
    userId: "u1",
    workflowId: "deploy-service",
    args,
    argsDigest: computeArgsDigest(args),
    originMessageId: "m1",
    riskLevel: "write",
    registryDigest: computeRegistryDigest(f.registry),
    ttlMs: 1, // 立即过期
  }).actionId;
  await new Promise((r) => setTimeout(r, 25)); // 时间推进到过期之后
  const expired = f.pending.get(id)!;
  assert.ok(new Date(expired.expiresAt).getTime() <= Date.now(), "已过期");
  assert.equal(f.pending.pendingFor("u1").length, 0, "过期项从列表消失（不占首位劫持「批准」）");
  assert.equal(f.pending.hasPending("u1"), false, "hasPending 同步为 false");
  // 新建的活 pending 正常可见且序号不被死项挤位
  const liveId = seedPending(f);
  assert.equal(f.pending.pendingFor("u1")[0]!.actionId, liveId, "活 pending 独占首位，序号稳定");
});
