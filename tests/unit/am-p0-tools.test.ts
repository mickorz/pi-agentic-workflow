/**
 * AM-P0 T3 单测：五工具 + TaskControlFacade
 * 验收锚点（执行计划 §7 T3）：每工具正/负例；结果可被 LLM 继续决策（结构化）。
 * 契约：execute 走 RoutePlan 直调不触发 IntentRouter；高风险只能 needsApproval（无自授权通路）；
 * 归属校验拒绝且不泄露；结果/产物引用来自 run-links 与真实服务（不靠模型记忆）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { TaskStore } from "../../src/dispatch/task-store.js";
import type { TaskControlService } from "../../src/dispatch/task-control.js";
import type { WorkflowRegistration, TaskBinding } from "../../src/contracts/wx.js";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { RunLinkStore } from "../../src/agent-host/run-launch.js";
import { TaskControlFacade } from "../../src/agent-host/task-control-facade.js";
import { computeArgsDigest, computeRegistryDigest, stableStringify } from "../../src/agent-host/digest.js";
import { createAgentTools } from "../../src/agent-host/agent-tools.js";
import { AgentHost } from "../../src/agent-host/agent-host.js";
import { FakeAgentToolFacade, FileBackedSessionRegistry, ScriptedHostedSession } from "../../src/agent-host/fakes.js";

const GITHUB_REVIEW: WorkflowRegistration = {
  workflowId: "github-review",
  scriptPath: "github-review.js",
  name: "GitHub 仓库分析",
  description: "分析 GitHub 仓库并输出评审报告",
  argsSchema: { type: "object", properties: { repoUrl: { type: "string" } }, required: ["repoUrl"] },
  riskLevel: "read-only",
  enabled: true,
  keywords: ["分析", "review", "github", "仓库"],
};

const DEPLOY: WorkflowRegistration = {
  ...GITHUB_REVIEW,
  workflowId: "deploy-service",
  name: "部署服务",
  description: "部署服务到生产环境",
  riskLevel: "write",
  keywords: ["部署", "deploy"],
};

interface Fixture {
  root: string;
  registry: WorkflowRegistry;
  dispatcher: Dispatcher;
  tasks: TaskStore;
  pending: PendingActionStore;
  runLinks: RunLinkStore;
  service: TaskControlService & {
    started: Array<{ scriptPath: string; args?: unknown }>;
    cancelled: string[];
    resumed: Array<{ runId: string; acknowledgeSideEffects: boolean }>;
    snapshot: { status: string; effectiveStatus: string; result?: unknown };
  };
  facade: TaskControlFacade;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-t3-"));
  const registry = new WorkflowRegistry([GITHUB_REVIEW, DEPLOY]);
  const tasks = new TaskStore(path.join(root, "data"));
  const service = {
    started: [] as Array<{ scriptPath: string; args?: unknown }>,
    cancelled: [] as string[],
    resumed: [] as Array<{ runId: string; acknowledgeSideEffects: boolean }>,
    snapshot: { status: "completed", effectiveStatus: "completed", result: { summary: "分析完成" } },
    async start(input: { scriptPath: string; args?: unknown }) {
      service.started.push({ scriptPath: input.scriptPath, args: input.args });
      return { runId: `run-${service.started.length}` };
    },
    async get(_runId: string) {
      return { snapshot: service.snapshot, checkpoints: [] };
    },
    async cancel(runId: string) {
      service.cancelled.push(runId);
    },
    async resume(runId: string, options: { acknowledgeSideEffects: boolean }) {
      service.resumed.push({ runId, acknowledgeSideEffects: options.acknowledgeSideEffects });
      if (!options.acknowledgeSideEffects) {
        throw Object.assign(new Error("中断恢复可能重复未记 journal 节点的副作用"), {
          code: "SIDE_EFFECTS_UNACKNOWLEDGED",
        });
      }
      return { runId };
    },
  } as unknown as Fixture["service"];
  const dispatcher = new Dispatcher({
    registry,
    // RoutePlan 直调不得触发 IntentRouter——一旦触发即测试失败
    router: {
      route: async () => {
        throw new Error("IntentRouter 被触发（违反 §2.2 直调契约）");
      },
    } as never,
    tasks,
    service,
    scriptsRoot: root,
  });
  const pending = new PendingActionStore(path.join(root, "data"));
  const runLinks = new RunLinkStore(path.join(root, "data"));
  const facade = new TaskControlFacade({ registry, dispatcher, tasks, service, pending, runLinks });
  return { root, registry, dispatcher, tasks, pending, runLinks, service, facade };
}

function seedBinding(tasks: TaskStore, over: Partial<TaskBinding> = {}): TaskBinding {
  const now = new Date().toISOString();
  const b: TaskBinding = {
    taskBindingId: "tb-1",
    runId: "run-1",
    channel: "wechat",
    userId: "u1",
    workflowId: "github-review",
    status: "running",
    createdAt: now,
    updatedAt: now,
    messageId: "m-origin",
    ...over,
  };
  tasks.append(b);
  return b;
}

// ── workflow_search ──

test("T3 search：空 query 返回完整能力清单（结构化）", async () => {
  const f = makeFixture();
  const items = await f.facade.searchWorkflows();
  assert.equal(items.length, 2);
  const gh = items.find((i) => i.id === "github-review")!;
  assert.deepEqual(
    { name: gh.name, requiredArgs: gh.requiredArgs, riskLevel: gh.riskLevel },
    { name: "GitHub 仓库分析", requiredArgs: ["repoUrl"], riskLevel: "read-only" },
  );
});

test("T3 search：带 query 返回关键词候选", async () => {
  const f = makeFixture();
  const items = await f.facade.searchWorkflows("部署");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "deploy-service");
});

// ── workflow_execute ──

test("T3 execute（read-only）：RoutePlan 直调受理 + TaskBinding 落盘（不触发 IntentRouter）", async () => {
  const f = makeFixture();
  const r = await f.facade.executeWorkflow({
    userId: "u1",
    workflowId: "github-review",
    args: { repoUrl: "https://github.com/a/b" },
    agentTurnId: "turn-1",
    originMessageId: "m1",
  });
  assert.ok("accepted" in r && r.accepted, "read-only 直接受理");
  assert.equal(r.accepted && r.status, "running");
  assert.equal(r.accepted && r.runId, "run-1");
  assert.equal(f.service.started.length, 1);
  assert.deepEqual(f.service.started[0]!.args, { repoUrl: "https://github.com/a/b" });
  const binding = f.tasks.list()[0]!;
  assert.equal(binding.userId, "u1");
  assert.equal(binding.messageId, "m1", "审计链：TaskBinding 关联原始消息");
});

test("T3 execute 负例：不存在/已下线 → 结构化 error（引导先 search）", async () => {
  const f = makeFixture();
  const r = await f.facade.executeWorkflow({
    userId: "u1", workflowId: "no-such", args: {}, agentTurnId: "t", originMessageId: "m",
  });
  assert.ok("error" in r && /不存在.*workflow_search/.test(r.error!), "结构化错误且引导检索");
});

test("T3 execute 负例：参数 Schema 不过 → 结构化 error 不抛出", async () => {
  const f = makeFixture();
  const r = await f.facade.executeWorkflow({
    userId: "u1", workflowId: "github-review", args: { repoUrl: 123 }, agentTurnId: "t", originMessageId: "m",
  });
  assert.ok("error" in r && /参数校验/.test(r.error!));
});

test("T3 execute（write）：只返 needsApproval + PendingAction 快照落盘（无自授权通路）", async () => {
  const f = makeFixture();
  const r = await f.facade.executeWorkflow({
    userId: "u1",
    workflowId: "deploy-service",
    args: { repoUrl: "https://github.com/a/b" },
    agentTurnId: "turn-1",
    originMessageId: "m1",
  });
  assert.ok("needsApproval" in r && r.needsApproval, "高风险不直接启动");
  assert.equal(f.service.started.length, 0, "未启动任何 Run");
  assert.ok(f.pending.hasPending("u1"));
  const action = f.pending.pendingFor("u1")[0]!;
  assert.equal(action.workflowId, "deploy-service");
  assert.deepEqual(action.args, { repoUrl: "https://github.com/a/b" }, "完整参数快照（确认后从这里取）");
  assert.equal(action.argsDigest, computeArgsDigest({ repoUrl: "https://github.com/a/b" }));
  assert.equal(action.registryDigest, computeRegistryDigest(f.registry));
  assert.equal(action.originMessageId, "m1");
});

// ── task_status ──

test("T3 status：真实服务状态 + run-links 产物引用（结构化，不靠记忆）", async () => {
  const f = makeFixture();
  seedBinding(f.tasks, { status: "completed" });
  f.runLinks.upsert({
    runId: "run-1", taskBindingId: "tb-1", agentTurnId: "turn-1",
    status: "completed", resultSummary: "分析完成：3 个问题", resultRef: "out/report.md",
  });
  const r = await f.facade.taskStatus("u1", { runId: "run-1" });
  assert.deepEqual(r, {
    runId: "run-1", status: "completed", resultSummary: "分析完成：3 个问题", resultRef: "out/report.md",
  });
});

test("T3 status：taskBindingId 也可查；他人 runId 拒绝不泄露", async () => {
  const f = makeFixture();
  seedBinding(f.tasks);
  const byTb = await f.facade.taskStatus("u1", { taskBindingId: "tb-1" });
  assert.equal(byTb.status, "completed");
  const other = await f.facade.taskStatus("u2", { runId: "run-1" });
  assert.equal(other.status, "forbidden");
  assert.equal(other.resultSummary, undefined, "不泄露结果");
});

test("T3 status 负例：缺引用/不存在", async () => {
  const f = makeFixture();
  assert.equal((await f.facade.taskStatus("u1", {})).status, "invalid");
  assert.equal((await f.facade.taskStatus("u1", { runId: "run-x" })).status, "not_found");
});

// ── task_cancel / task_resume ──

test("T3 cancel：本人进行中 → 真实取消 + 绑定更新；他人/终态拒绝", async () => {
  const f = makeFixture();
  seedBinding(f.tasks);
  const ok = await f.facade.taskCancel("u1", "run-1");
  assert.equal(ok.ok, true);
  assert.deepEqual(f.service.cancelled, ["run-1"]);
  assert.equal(f.tasks.list()[0]!.status, "cancelled");

  seedBinding(f.tasks, { taskBindingId: "tb-2", runId: "run-2" });
  assert.equal((await f.facade.taskCancel("u2", "run-2")).ok, false, "他人拒绝");
  seedBinding(f.tasks, { taskBindingId: "tb-3", runId: "run-3", status: "completed" });
  assert.match((await f.facade.taskCancel("u1", "run-3")).message, /终态/);
});

test("T3 resume：副作用未确认 → needsConfirm；确认后透传 ack 并更新绑定", async () => {
  const f = makeFixture();
  seedBinding(f.tasks, { status: "interrupted" });
  const need = await f.facade.taskResume("u1", "run-1");
  assert.equal(need.ok, false);
  assert.equal(need.needsConfirm, true, "确认词走确定性通道，工具不代确认");
  assert.match(need.message, /确认恢复/);
  assert.deepEqual(f.service.resumed.map((x) => x.acknowledgeSideEffects), [false], "首次未带确认");

  const done = await f.facade.taskResume("u1", "run-1", { confirmSideEffects: true });
  assert.equal(done.ok, true);
  assert.deepEqual(f.service.resumed[1], { runId: "run-1", acknowledgeSideEffects: true });
  assert.equal(f.tasks.list()[0]!.status, "running");
});

// ── 工具层（createAgentTools）──

test("T3 工具层：五工具齐备；execute 从 TurnContext 注入身份（不经 LLM 转述）", async () => {
  const facade = new FakeAgentToolFacade();
  const ctxRef = { current: undefined as never | { userId: string; agentTurnId: string; originMessageId: string } };
  const tools = createAgentTools({ facade, ctxRef });
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["task_cancel", "task_resume", "task_status", "workflow_execute", "workflow_search"],
  );

  ctxRef.current = { userId: "u1", agentTurnId: "turn-9", originMessageId: "m-9" };
  const exec = tools.find((t) => t.name === "workflow_execute")!;
  const out = await exec.execute("call-1", { workflowId: "github-review", args: { repoUrl: "x" } }, undefined, undefined, {} as never);
  assert.deepEqual(JSON.parse((out.content[0] as { text: string }).text), facade.executeResult, "结构化 JSON 返回");
  assert.deepEqual(
    { ...facade.executeCalls[0] },
    { userId: "u1", workflowId: "github-review", args: { repoUrl: "x" } },
    "身份/审计链来自服务端注入",
  );

  const status = tools.find((t) => t.name === "task_status")!;
  await status.execute("call-2", { runId: "run-fake-1" }, undefined, undefined, {} as never);
  assert.deepEqual(facade.statusCalls[0], { userId: "u1", runId: "run-fake-1" });
});

test("T3 工具层：Turn 之外调用（ctx 缺失）直接抛错", async () => {
  const facade = new FakeAgentToolFacade();
  const tools = createAgentTools({ facade, ctxRef: { current: undefined } });
  const exec = tools.find((t) => t.name === "workflow_execute")!;
  await assert.rejects(() => exec.execute("c", { workflowId: "x" }, undefined, undefined, {} as never), /上下文缺失/);
});

test("T3 接线：AgentHost 每 Turn 写入 setTurnContext（userId/originMessageId/agentTurnId 对应 journal）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-t3h-"));
  const registry = new FileBackedSessionRegistry(path.join(root, "sessions"));
  const host = new AgentHost({
    cwd: root,
    sessionDir: path.join(root, "sessions"),
    dataDir: path.join(root, "data"),
    customTools: [],
    facade: new FakeAgentToolFacade(),
    openSession: registry.opener,
  });
  await host.handleMessage({ channel: "wechat", messageId: "m-42", userId: "u1", text: "分析仓库" });
  const session = registry.sessions.get("u1") as ScriptedHostedSession;
  const ctx = session.turnContexts[0]!;
  assert.equal(ctx.userId, "u1");
  assert.equal(ctx.originMessageId, "m-42");
  assert.equal(ctx.agentTurnId, host.inbox.get("wechat", "m-42")?.agentTurnId, "与 journal 关联一致");
});

// ── 稳定摘要 ──

test("T3 digest：stableStringify 键序无关；registry 变化可检出", async () => {
  assert.equal(stableStringify({ b: 1, a: [2, { z: 1, y: 2 }] }), stableStringify({ a: [2, { y: 2, z: 1 }], b: 1 }));
  const f = makeFixture();
  const d1 = computeRegistryDigest(f.registry);
  f.registry.setEnabled("github-review", false);
  assert.notEqual(computeRegistryDigest(f.registry), d1, "下线项变化 → 摘要变化（确认时重校验可检出）");
});
