/**
 * AM-P0 T7 单测：WechatApp routingMode 分支 + inbox-journal 接线 + legacy 隔离
 * 验收锚点（执行计划 §7 T7）：legacy 零变化回归；agent 分支处理状态可恢复。
 * agent 分支链路：幂等 → 限频 → 确定性通道（审批决策/副作用确认词）→ AgentHost。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WechatApp } from "../../src/gateway/wechat-app.js";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import type { WorkflowRegistration, BotInboundMessage } from "../../src/contracts/wx.js";
import { FileBackedSessionRegistry, GatedHostedSession, ScriptedHostedSession } from "../../src/agent-host/fakes.js";
import { computeArgsDigest, computeRegistryDigest } from "../../src/agent-host/digest.js";

const GITHUB_REVIEW: WorkflowRegistration = {
  workflowId: "github-review",
  scriptPath: "github-review.js",
  name: "GitHub 仓库分析",
  description: "分析 GitHub 仓库并输出评审报告",
  argsSchema: { type: "object", properties: { repoUrl: { type: "string" } }, required: [] },
  riskLevel: "read-only",
  enabled: true,
  keywords: ["分析"],
};

const DEPLOY: WorkflowRegistration = {
  ...GITHUB_REVIEW,
  workflowId: "deploy-service",
  name: "部署服务",
  description: "部署服务到生产环境",
  riskLevel: "write",
  keywords: ["部署"],
};

class FakeBot {
  sent: Array<{ userId: string; text: string }> = [];
  handler?: (message: BotInboundMessage) => Promise<void>;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }
  async send(userId: string, text: string): Promise<void> {
    this.sent.push({ userId, text });
  }
}

class FakeService {
  started: Array<{ scriptPath: string; args?: unknown }> = [];
  resumed: Array<{ runId: string; acknowledgeSideEffects: boolean }> = [];
  async start(input: { scriptPath: string; args?: unknown }) {
    this.started.push({ scriptPath: input.scriptPath, args: input.args });
    return { runId: `run-${this.started.length}` };
  }
  async get() {
    return { snapshot: { status: "completed", effectiveStatus: "completed", result: { ok: true } }, checkpoints: [] };
  }
  async cancel(): Promise<void> {}
  async resume(runId: string, options: { acknowledgeSideEffects: boolean }) {
    this.resumed.push({ runId, acknowledgeSideEffects: options.acknowledgeSideEffects });
    return { runId };
  }
}

interface Env {
  base: string;
  dataDir: string;
  app: WechatApp;
  bot: FakeBot;
  service: FakeService;
  registryRef: WorkflowRegistry;
  sessions: FileBackedSessionRegistry;
  make(over?: Record<string, unknown>): { app: WechatApp; bot: FakeBot; service: FakeService };
}

function makeEnv(
  registrations: WorkflowRegistration[] = [GITHUB_REVIEW, DEPLOY],
  make: (id: string) => ScriptedHostedSession | GatedHostedSession = (id) => new ScriptedHostedSession(id),
): Env {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "am-t7-"));
  const dataDir = path.join(base, ".pi-wechat");
  const bot = new FakeBot();
  const service = new FakeService();
  const registryRef = new WorkflowRegistry(registrations);
  const sessions = new FileBackedSessionRegistry(path.join(base, ".pi-agent-host", "sessions"), make);
  const build = (over: Record<string, unknown> = {}) => {
    const b = over.bot ? (over.bot as FakeBot) : bot;
    const s = over.service ? (over.service as FakeService) : service;
    const app = new WechatApp({
      bot: b as never,
      registry: registryRef,
      llm: { route: async () => { throw new Error("legacy IntentRouter 不应被触发（agent 模式）"); } } as never,
      service: s as never,
      scriptsRoot: base,
      dataDir,
      routingMode: "agent",
      agentOpenSession: sessions.opener,
      agentSessionDir: path.join(base, ".pi-agent-host", "sessions"),
      ...over,
    });
    return { app, bot: b, service: s };
  };
  const first = build();
  return { base, dataDir, app: first.app, bot: first.bot, service: first.service, registryRef, sessions, make: build };
}

function msg(id: string, text: string, userId = "u1"): BotInboundMessage {
  return { channel: "wechat", userId, messageId: id, text, receivedAt: new Date().toISOString() };
}

test("T7 legacy 隔离：缺省 routingMode → 旧链路，agent 装配为空", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "am-t7l-"));
  const bot = new FakeBot();
  const service = new FakeService();
  const app = new WechatApp({
    bot: bot as never,
    registry: new WorkflowRegistry([GITHUB_REVIEW]),
    llm: {
      route: async () => ({
        text: JSON.stringify({ intent: "chat_reply", action: "chat_reply", confidence: 1, reason: "旧链路应答" }),
        latencyMs: 1,
      }),
    } as never,
    service: service as never,
    scriptsRoot: base,
    dataDir: path.join(base, ".pi-wechat"),
  });
  assert.equal(app.agentHost, undefined, "legacy 不装配 agent 栈");
  const out = await app.handleInbound(msg("m1", "你好"));
  assert.equal(out.duplicate, false);
  assert.match(out.reply!, /旧链路/, "走旧 IntentRouter 链路");
});

test("T7 agent 分支：processed → 回执仅投递一次（防双发）+ 审计 + 预算入账", async () => {
  const env = makeEnv();
  const out = await env.app.handleInbound(msg("m1", "帮我分析这个仓库"));
  assert.equal(out.duplicate, false);
  assert.equal(out.reply, "好的", "首条消息同步回执");
  await env.app.flushOutbox();
  const sends = env.bot.sent.filter((s) => s.text === "好的");
  assert.equal(sends.length, 1, "回执只投递一次（onTurnCompleted 唯一出口，processed 分支不得重复入队）");
  assert.equal(env.app.agentHost!.inbox.get("wechat", "m1")?.state, "completed", "journal 状态接线");
});

test("T7 agent 分支：排队 ack + 排队完成后异步回执", async () => {
  const env = makeEnv([GITHUB_REVIEW], () => new GatedHostedSession("conv"));
  const p1 = env.app.handleInbound(msg("m1", "第一条"));
  await new Promise((r) => setTimeout(r, 30)); // m1 进入 prompt（阻塞中）
  const q2 = await env.app.handleInbound(msg("m2", "第二条"));
  assert.match(q2.reply!, /排队|正在处理/, "排队消息即时 ack");

  const session = env.sessions.sessions.get("u1") as GatedHostedSession;
  session.release();
  const r1 = await p1;
  assert.equal(r1.reply, "ok");
  // m2 由 drain 后台处理 → onTurnCompleted → enqueueReply
  await new Promise((r) => setTimeout(r, 50));
  session.release();
  await new Promise((r) => setTimeout(r, 100));
  await env.app.flushOutbox();
  assert.equal(env.bot.sent.filter((s) => /排队|正在处理/.test(s.text)).length, 1, "排队 ack 恰一次");
  assert.equal(env.bot.sent.filter((s) => s.text === "ok").length, 2, "两条消息各一次回执（排队不双发不漏发）");
});

test("T7 agent 分支：duplicate 直接吞掉", async () => {
  const env = makeEnv();
  await env.app.handleInbound(msg("m1", "你好"));
  const dup = await env.app.handleInbound(msg("m1", "你好"));
  assert.equal(dup.duplicate, true);
});

test("T7 确定性通道：执行前审批直通（单项/AM-13 序号/拒绝），不经 LLM", async () => {
  const env = makeEnv();
  // 构造两个待审批项（deploy = write）
  const a1 = env.app.pendingStore!.create({
    userId: "u1", workflowId: "deploy-service", args: { env: "prod" },
    argsDigest: computeArgsDigest({ env: "prod" }), originMessageId: "m-a",
    riskLevel: "write", registryDigest: computeRegistryDigest(env.registryRef),
  });
  const a2 = env.app.pendingStore!.create({
    userId: "u1", workflowId: "deploy-service", args: { env: "staging" },
    argsDigest: computeArgsDigest({ env: "staging" }), originMessageId: "m-b",
    riskLevel: "write", registryDigest: computeRegistryDigest(env.registryRef),
  });

  // AM-13：两项并存，序号选择第 2 项
  const out = await env.app.handleInbound(msg("d1", "批准 2"));
  assert.match(out.reply!, /已批准并启动.*deploy-service/, "确定性批准启动");
  assert.equal(env.service.started.length, 1);
  assert.deepEqual(env.service.started[0]!.args, { env: "staging" }, "选中第 2 项");
  assert.equal(env.app.pendingStore!.get(a2.actionId)?.status, "executed");
  assert.equal(env.app.pendingStore!.get(a1.actionId)?.status, "pending", "另一项不受影响");

  const rej = await env.app.handleInbound(msg("d2", "拒绝"));
  assert.match(rej.reply!, /已拒绝/);
  assert.equal(env.app.pendingStore!.get(a1.actionId)?.status, "rejected");
  assert.equal(env.service.started.length, 1, "拒绝不启动");
});

test("T7 确定性通道：确认恢复直通（EX-009 确认词不经 LLM）", async () => {
  const env = makeEnv();
  const now = new Date().toISOString();
  env.app.tasks.append({
    taskBindingId: "tb-i", runId: "run-9", channel: "wechat", userId: "u1",
    workflowId: "github-review", status: "interrupted", createdAt: now, updatedAt: now, messageId: "m-old",
  });
  const out = await env.app.handleInbound(msg("r1", "确认恢复"));
  assert.match(out.reply!, /已恢复任务 tb-i/);
  assert.deepEqual(env.service.resumed, [{ runId: "run-9", acknowledgeSideEffects: true }], "带副作用确认恢复");
  assert.equal(env.app.tasks.list()[0]!.status, "running");

  // 无中断任务时确认词落入 Agent（LLM 解答，不误触发）
  const fallthrough = await env.app.handleInbound(msg("r2", "确认恢复"));
  assert.equal(fallthrough.reply, "好的");
});

test("T7 agent 失败：报错不重路由（legacy IntentRouter 不触发）", async () => {
  const env = makeEnv([GITHUB_REVIEW], () => new ScriptedHostedSession("conv", [], [new Error("模型超时")]));
  const out = await env.app.handleInbound(msg("e1", "分析"));
  assert.match(out.reply!, /处理失败.*模型超时/);
  assert.equal(env.app.agentHost!.inbox.get("wechat", "e1")?.state, "failed");
});

test("T7 启动恢复：journal 遗留 received 消息 → start() 恢复处理后回执", async () => {
  const env = makeEnv();
  // 模拟崩溃遗留：消息已入 journal（received）但未处理
  env.app.agentHost!.inbox.record({
    channel: "wechat", messageId: "m-left", userId: "u1", text: "崩溃前遗留", receivedAt: new Date().toISOString(),
  });
  // “重启”：新 WechatApp 同 dataDir
  const bot2 = new FakeBot();
  const second = env.make({ bot: bot2 });
  await second.app.start();
  await new Promise((r) => setTimeout(r, 100));
  await second.app.flushOutbox();
  assert.ok(bot2.sent.some((s) => s.text === "好的"), "遗留消息恢复处理后回执");
  assert.equal(second.app.agentHost!.inbox.get("wechat", "m-left")?.state, "completed");
  await second.app.stop();
});
