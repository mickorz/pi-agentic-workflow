/**
 * WX-P1 测试矩阵：A01~A10 + 安全负向 + 共享契约一致性（§2.1）
 * 全 Fake 注入（NFR-002）：不依赖真实微信与真实 LLM。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.ts";
import { IntentRouter, type RoutingLLM } from "../../src/dispatch/intent-router.ts";
import { ConversationStore } from "../../src/dispatch/conversation.ts";
import { TaskStore } from "../../src/dispatch/task-store.ts";
import { Dispatcher, type ExecutionService } from "../../src/dispatch/dispatcher.ts";
import { ModelRouter } from "../../src/model-routing/model-router.ts";
import { MessageInbox } from "../../src/gateway/message-inbox.ts";
import { CHAT_FALLBACK_REPLY } from "../../src/gateway/wechat/bot-adapter.ts";
import { DispatchError, type RoutePlan, type WorkflowRegistration } from "../../src/contracts/wx.ts";

// ── 测试装置 ──

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

function makeFakes(llmOutputs: Record<string, () => string> | (() => string)) {
  const started: Array<{ scriptPath: string; args?: unknown }> = [];
  const service: ExecutionService & { started: typeof started } = {
    started,
    async start(input) {
      started.push({ scriptPath: input.scriptPath, args: input.args });
      return { runId: `run-fake-${started.length}` };
    },
  };
  const pick = typeof llmOutputs === "function" ? llmOutputs : () => {
    throw new Error("no llm output configured");
  };
  const llm: RoutingLLM = {
    async route(prompt) {
      const out =
        typeof llmOutputs === "function"
          ? llmOutputs()
          : (Object.entries(llmOutputs).find(([k]) => prompt.includes(k))?.[1] ?? pick())();
      return { text: out, latencyMs: 5 };
    },
  };
  return { service, llm, started };
}

function makeDispatcher(llm: RoutingLLM, service: ExecutionService) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wx-p1-"));
  const registry = new WorkflowRegistry([GITHUB_REVIEW, DEPLOY]);
  const router = new IntentRouter({ llm, registry });
  const tasks = new TaskStore(path.join(base, ".pi-wechat"));
  const conversation = new ConversationStore();
  const dispatcher = new Dispatcher({ registry, router, tasks, service, scriptsRoot: base, defaultModel: "p/quick" });
  return { dispatcher, registry, router, tasks, conversation, base };
}

const OK_ROUTE = (workflowId: string, args: Record<string, unknown> = {}, confidence = 0.9) =>
  JSON.stringify({ intent: "execute_workflow", workflowId, args, reason: "匹配", confidence });

// ── A01~A10 ──

test("A01：「分析 <repo>」→ 启动（IR+WR+EX 链路）", async () => {
  const { llm, service } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", { repoUrl: "https://github.com/o/r" }) });
  const { dispatcher } = makeDispatcher(llm, service);
  const out = await dispatcher.handleMessage(
    { channel: "wechat", userId: "u1", messageId: "m1", text: "分析 https://github.com/o/r", receivedAt: new Date().toISOString() },
    new ConversationStore(),
  );
  assert.equal(out.plan.action, "start_execution");
  assert.ok(out.executeResult);
  assert.equal(service.started.length, 1);
  assert.deepEqual((service.started[0]?.args as { repoUrl: string }).repoUrl, "https://github.com/o/r");
});

test("A02：缺 repoUrl 只追问不启动（IR-005）", async () => {
  const { llm, service } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", {}) });
  const { dispatcher, conversation } = makeDispatcher(llm, service);
  const out = await dispatcher.handleMessage(
    { channel: "wechat", userId: "u1", messageId: "m1", text: "帮我分析个仓库", receivedAt: new Date().toISOString() },
    conversation,
  );
  assert.equal(out.plan.action, "ask_clarification");
  assert.deepEqual(out.plan.missingFields, ["repoUrl"]);
  assert.equal(service.started.length, 0, "缺参不得启动");
  assert.ok(conversation.get("u1")?.pendingPlan, "挂起计划已保存");
});

test("A03：补 URL 合并启动（CV-002）", async () => {
  const { llm, service } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", {}) });
  const { dispatcher, conversation } = makeDispatcher(llm, service);
  await dispatcher.handleMessage(
    { channel: "wechat", userId: "u1", messageId: "m1", text: "帮我分析个仓库", receivedAt: new Date().toISOString() },
    conversation,
  );
  const out = await dispatcher.handleMessage(
    { channel: "wechat", userId: "u1", messageId: "m2", text: "repoUrl=https://github.com/o/r", receivedAt: new Date().toISOString() },
    conversation,
  );
  assert.ok(out.executeResult, "补参后启动");
  assert.deepEqual((service.started[0]?.args as { repoUrl: string }).repoUrl, "https://github.com/o/r");
});

test("A04：「你好」→ chat 固定回复（LK-05）", async () => {
  const { llm, service } = makeFakes({ "用户消息：你好": () => JSON.stringify({ intent: "chat", confidence: 0.95, reason: CHAT_FALLBACK_REPLY }) });
  const { dispatcher } = makeDispatcher(llm, service);
  const out = await dispatcher.handleMessage(
    { channel: "wechat", userId: "u1", messageId: "m1", text: "你好", receivedAt: new Date().toISOString() },
    new ConversationStore(),
  );
  assert.equal(out.plan.intent, "chat");
  assert.equal(out.plan.action, "chat_reply");
  assert.equal(service.started.length, 0);
});

test("A05：LLM 给出未注册流程 → refuse（IR-004）", async () => {
  const { llm, service } = makeFakes(() => OK_ROUTE("no-such-flow"));
  const { dispatcher } = makeDispatcher(llm, service);
  const out = await dispatcher.handleMessage(
    { channel: "wechat", userId: "u1", messageId: "m1", text: "随便跑个东西", receivedAt: new Date().toISOString() },
    new ConversationStore(),
  );
  assert.equal(out.plan.action, "refuse");
  assert.match(out.reply, /未注册或不支持/);
});

test("A06：重复 messageId → 单 Run（WG-003）", async () => {
  const { llm, service } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", { repoUrl: "https://github.com/o/r" }) });
  const { dispatcher } = makeDispatcher(llm, service);
  const inbox = new MessageInbox();
  const conversation = new ConversationStore();
  const message = { channel: "wechat" as const, userId: "u1", messageId: "dup-1", text: "分析 https://github.com/o/r", receivedAt: new Date().toISOString() };
  await dispatcher.handleMessage(message, conversation);
  const receipt2 = inbox.accept(message);
  assert.equal(receipt2.status, "received"); // inbox 首见
  const receipt3 = inbox.accept(message);
  assert.equal(receipt3.status, "duplicate"); // 幂等拦截
  if (receipt3.status === "duplicate") return; // Gateway 语义：duplicate 不再投递
  await dispatcher.handleMessage(message, conversation);
  assert.equal(service.started.length, 1);
});

test("A07：篡改 workflowId → 白名单拒绝（IR-007）", async () => {
  const { llm, service } = makeFakes(() => OK_ROUTE("../../etc/passwd"));
  const { dispatcher } = makeDispatcher(llm, service);
  const out = await dispatcher.handleMessage(
    { channel: "wechat", userId: "u1", messageId: "m1", text: "分析点什么", receivedAt: new Date().toISOString() },
    new ConversationStore(),
  );
  assert.equal(out.plan.action, "refuse");
  assert.equal(service.started.length, 0);
});

test("A08：三 tier 节点各用真实模型且有记录（MR-005/006）", async () => {
  const router = new ModelRouter(
    { pools: { quick: ["p/flash"], general: ["p/plus"], frontier: ["p/max"] }, defaultTier: "general" },
    { listAvailable: async () => ["p/flash", "p/plus", "p/max"] },
  );
  const runId = "run-x";
  for (const [nodeId, tier, expected] of [["n1", "quick", "p/flash"], ["n2", "general", "p/plus"], ["n3", "frontier", "p/max"]] as const) {
    const d = await router.decide({ runId, nodeId, tier });
    assert.equal(d?.actualModel, expected);
    assert.equal(d?.routeSource, "node-tier");
  }
  assert.equal(router.records(runId).length, 3, "决策可追溯");
});

test("A09：显式 agent({model}) 不被覆盖（MR-003）", async () => {
  const router = new ModelRouter(
    { pools: { general: ["p/plus"] }, defaultTier: "general" },
    { listAvailable: async () => ["p/explicit", "p/plus"] },
  );
  const d = await router.decide({ runId: "r", nodeId: "n", model: "p/explicit", tier: "quick" });
  assert.equal(d?.actualModel, "p/explicit");
  assert.equal(d?.routeSource, "explicit-model");
});

test("A10：模型不可用 → 池内降级（MR-004）", async () => {
  const router = new ModelRouter(
    { pools: { general: ["p/down", "p/up"] }, defaultTier: "general" },
    { listAvailable: async () => ["p/up"] },
  );
  const d = await router.decide({ runId: "r", nodeId: "n", tier: "general" });
  assert.equal(d?.actualModel, "p/up", "池内首个可用");
  const none = new ModelRouter({ pools: { general: ["p/down"] }, defaultTier: "general" }, { listAvailable: async () => ["p/up"] });
  assert.equal(await none.decide({ runId: "r", nodeId: "n" }), null, "全不可用且无 fallback → 明确失败");
});

// ── 安全负向 ──

test("安全：write 风险未授权 → NOT_AUTHORIZED（不允许先启动后确认）", async () => {
  const { llm, service } = makeFakes({ 部署: () => OK_ROUTE("deploy-service", {}, 0.95) });
  const { dispatcher } = makeDispatcher(llm, service);
  const plan: RoutePlan = { intent: "execute_workflow", action: "start_execution", workflowId: "deploy-service", args: { repoUrl: "x" }, confidence: 0.9 };
  await assert.rejects(
    dispatcher.execute(plan, { actor: "u1", authorized: false, entrypoint: "wechat" }, { channel: "wechat", userId: "u1", messageId: "m" }),
    (e: unknown) => e instanceof DispatchError && e.code === "NOT_AUTHORIZED",
  );
  assert.equal(service.started.length, 0, "高风险未授权绝不启动");
});

test("安全：read-only 自动执行授权成立", async () => {
  const { llm, service } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", { repoUrl: "x" }) });
  const { dispatcher } = makeDispatcher(llm, service);
  const plan: RoutePlan = { intent: "execute_workflow", action: "start_execution", workflowId: "github-review", args: { repoUrl: "x" }, confidence: 0.9 };
  const result = await dispatcher.execute(plan, { actor: "u1", authorized: false, entrypoint: "wechat" }, { channel: "wechat", userId: "u1", messageId: "m" });
  assert.ok(result.runId);
});

test("安全：registry 恶意路径/非法元数据不入表（WR-003）", () => {
  const registry = new WorkflowRegistry([]);
  assert.equal(registry.register({ ...GITHUB_REVIEW, workflowId: "Bad Id" }).ok, false);
  assert.equal(registry.register({ ...GITHUB_REVIEW, scriptPath: "../escape.js" }).ok, false);
  assert.equal(registry.register({ ...GITHUB_REVIEW, scriptPath: "/abs/path.js" }).ok, false);
  assert.equal(registry.register({ ...GITHUB_REVIEW, riskLevel: "rm-rf" as never }).ok, false);
  assert.equal(registry.all(false).length, 0);
});

test("安全：置信度低于门限 → refuse（confidence 不是授权）", async () => {
  const { llm, service } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", { repoUrl: "x" }, 0.4) });
  const { dispatcher } = makeDispatcher(llm, service);
  const out = await dispatcher.handleMessage(
    { channel: "wechat", userId: "u1", messageId: "m1", text: "分析仓库", receivedAt: new Date().toISOString() },
    new ConversationStore(),
  );
  assert.equal(out.plan.action, "refuse");
  assert.match(out.reply, /置信度不足/);
});

// ── 共享契约一致性（§2.1） ──

test("契约：plan() 无副作用（不产生 Run/TaskBinding/通知）", async () => {
  const { llm, service } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", { repoUrl: "x" }) });
  const { dispatcher, tasks } = makeDispatcher(llm, service);
  const plan = await dispatcher.plan({ text: "分析 https://github.com/o/r" });
  assert.equal(plan.action, "start_execution");
  assert.equal(service.started.length, 0, "plan 不启动 Run");
  assert.equal(tasks.list().length, 0, "plan 不写 TaskBinding");
});

test("契约：execute() 重校验——计划后流程下线 → WORKFLOW_NOT_FOUND", async () => {
  const { llm, service } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", { repoUrl: "x" }) });
  const { dispatcher, registry } = makeDispatcher(llm, service);
  const plan = await dispatcher.plan({ text: "分析 https://github.com/o/r" });
  // 模拟两调用间隔内 Registry 变更：下线
  registry.setEnabled("github-review", false);
  await assert.rejects(
    dispatcher.execute(plan, { actor: "u1", authorized: true, entrypoint: "cli" }, { channel: "cli", userId: "u1", messageId: "m" }),
    (e: unknown) => e instanceof DispatchError && e.code === "WORKFLOW_NOT_FOUND",
  );
});

test("契约：dispatch 层无 gateway 依赖（§2.1-3 跨入口复用）", () => {
  const files = ["registry.ts", "intent-router.ts", "conversation.ts", "dispatcher.ts", "task-store.ts"];
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(`src/dispatch/${file}`), "utf-8");
    assert.ok(!/from\s+"[^"]*gateway/.test(source), `${file} 不得 import gateway`);
  }
});

test("契约：Intent 与 Action 独立枚举（示例：缺参=execute_workflow+ask_clarification）", async () => {
  const { llm } = makeFakes({ "GitHub 仓库分析": () => OK_ROUTE("github-review", {}) });
  const { dispatcher } = makeDispatcher(llm, makeFakes({}).service);
  const plan = await dispatcher.plan({ text: "帮我分析个仓库" });
  assert.equal(plan.intent, "execute_workflow");
  assert.equal(plan.action, "ask_clarification");
});
