/**
 * WX-P2 测试矩阵：A11~A18 + WX-1/2/3（《需求》§11.2，P2 §3）
 * 全 Fake 注入（NFR-002）：不依赖真实微信与真实 LLM；微信真机链路在 PT 手动验收。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { redact } from "../../src/audit/redact.ts";
import type { BotInboundMessage, WorkflowRegistration } from "../../src/contracts/wx.ts";
import type { ExecutionService } from "../../src/dispatch/dispatcher.ts";
import type { RoutingLLM } from "../../src/dispatch/intent-router.ts";
import { WorkflowRegistry } from "../../src/dispatch/registry.ts";
import { TaskController, type TaskControlCheckpoint, type TaskControlService } from "../../src/dispatch/task-control.ts";
import { MessageInbox } from "../../src/gateway/message-inbox.ts";
import { WechatApp } from "../../src/gateway/wechat-app.ts";
import { WechatBotAdapter } from "../../src/gateway/wechat/bot-adapter.ts";
import { ModelRouter, ModelRoutingLog } from "../../src/model-routing/model-router.ts";

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

const CONTROL_ROUTE = JSON.stringify({
  intent: "task_control",
  workflowId: null,
  args: {},
  missingFields: [],
  reason: "任务控制",
  confidence: 0.9,
});

function okRoute(workflowId: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intent: "execute_workflow",
    workflowId,
    args,
    missingFields: [],
    reason: "匹配",
    confidence: 0.9,
  });
}

/** 智能假 LLM：任务控制类文本 → task_control；其余 → github-review 直达 */
function smartLLM(): RoutingLLM {
  return {
    async route(prompt) {
      const userText = prompt.split("\n")[0]?.replace(/^用户消息：/, "") ?? "";
      const control = /任务列表|查看任务|进度|状态|取消|恢复|批准|拒绝|怎么样/.test(userText);
      return {
        text: control ? CONTROL_ROUTE : okRoute("github-review", { repoUrl: "https://github.com/o/r" }),
        latencyMs: 5,
      };
    },
  };
}

interface FakeRunState {
  status: string;
  effectiveStatus: string;
  result?: unknown;
  journalEntries: number;
  alive: boolean;
  checkpoints: TaskControlCheckpoint[];
}

class FakeService implements ExecutionService, TaskControlService {
  started: Array<{ scriptPath: string; args?: unknown }> = [];
  cancelled: string[] = [];
  resumed: Array<{ runId: string; acknowledgeSideEffects: boolean }> = [];
  decisions: Array<{ runId: string; checkpointId: string; decision: string; expectedVersion: number }> = [];
  runs = new Map<string, FakeRunState>();
  nextId = 0;
  /** A12b：内部真实版本比对外 get() 高 N（模拟过期读/并发决策） */
  versionBump = 0;
  failNextStart = false;

  async start(input: { scriptPath: string; args?: unknown }): Promise<{ runId: string }> {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw Object.assign(new Error("并发 Run 上限 2"), { code: "RUN_LIMIT_REACHED" });
    }
    this.started.push({ scriptPath: input.scriptPath, args: input.args });
    this.nextId += 1;
    const runId = `run-fake-${this.nextId}`;
    this.runs.set(runId, {
      status: "running",
      effectiveStatus: "running",
      journalEntries: 0,
      alive: true,
      checkpoints: [],
    });
    return { runId };
  }

  async get(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      snapshot: {
        status: run.status,
        effectiveStatus: run.effectiveStatus,
        ...(run.result !== undefined ? { result: run.result } : {}),
      },
      checkpoints: run.checkpoints.map((c) => ({ ...c })),
    };
  }

  async cancel(runId: string): Promise<{ status: string }> {
    const run = this.runs.get(runId);
    if (!run) throw Object.assign(new Error("run 不存在"), { code: "RUN_NOT_FOUND" });
    if (run.effectiveStatus === "running" || run.effectiveStatus === "waiting_checkpoint") {
      run.effectiveStatus = "cancelled";
      run.status = "cancelled";
      this.cancelled.push(runId);
    }
    return { status: run.status };
  }

  async resume(runId: string, options: { acknowledgeSideEffects: boolean }): Promise<{ runId: string }> {
    const run = this.runs.get(runId);
    if (!run) throw Object.assign(new Error("run 不存在"), { code: "RUN_NOT_FOUND" });
    if (run.effectiveStatus === "running" && run.alive) {
      throw Object.assign(new Error("run 仍在运行"), { code: "RUN_STILL_ACTIVE" });
    }
    if (run.effectiveStatus === "completed") throw Object.assign(new Error("已完成"), { code: "CONFLICT" });
    if (
      (run.effectiveStatus === "interrupted" || (run.effectiveStatus === "running" && !run.alive)) &&
      run.journalEntries > 0 &&
      !options.acknowledgeSideEffects
    ) {
      throw Object.assign(new Error("需显式确认副作用"), { code: "SIDE_EFFECTS_UNACKNOWLEDGED" });
    }
    run.effectiveStatus = "running";
    run.status = "running";
    run.alive = true;
    this.resumed.push({ runId, acknowledgeSideEffects: options.acknowledgeSideEffects });
    return { runId };
  }

  async decideCheckpoint(
    runId: string,
    checkpointId: string,
    input: { decision: "approve" | "reject"; expectedVersion: number },
  ): Promise<unknown> {
    const run = this.runs.get(runId);
    const cp = run?.checkpoints.find((c) => c.checkpointId === checkpointId);
    if (!run || !cp) throw Object.assign(new Error("不存在"), { code: "CHECKPOINT_NOT_PENDING" });
    if (cp.status !== "pending") throw Object.assign(new Error("已处理"), { code: "CHECKPOINT_NOT_PENDING" });
    if (cp.version + this.versionBump !== input.expectedVersion) {
      throw Object.assign(new Error("版本不匹配"), { code: "CONFLICT" });
    }
    cp.status = input.decision === "approve" ? "approved" : "rejected";
    this.decisions.push({ runId, checkpointId, decision: input.decision, expectedVersion: input.expectedVersion });
    return { status: cp.status };
  }

  setCheckpoint(runId: string, cp: TaskControlCheckpoint): void {
    const run = this.runs.get(runId);
    if (run) run.checkpoints = [cp];
  }
}

class FakeBot {
  sent: Array<{ userId: string; text: string }> = [];
  fail = false;
  started = false;
  handler?: (message: BotInboundMessage) => Promise<void>;
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }
  async send(userId: string, text: string): Promise<void> {
    if (this.fail) throw new Error("微信发送失败（模拟）");
    this.sent.push({ userId, text });
  }
}

function makeApp(
  options: {
    service?: FakeService;
    llm?: RoutingLLM;
    bot?: FakeBot;
    limits?: { rateMax?: number; rateWindowMs?: number; maxTokensPerUser?: number };
    outbox?: { maxAttempts?: number; retryBaseMs?: number };
  } = {},
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wx-p2-"));
  const service = options.service ?? new FakeService();
  const bot = options.bot ?? new FakeBot();
  const llm = options.llm ?? smartLLM();
  const registry = new WorkflowRegistry([GITHUB_REVIEW]);
  const app = new WechatApp({
    bot: bot as never,
    registry,
    llm,
    service: service as never,
    scriptsRoot: base,
    dataDir: path.join(base, ".pi-wechat"),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.outbox ? { outbox: options.outbox } : {}),
  });
  return { app, service, bot, base, dataDir: path.join(base, ".pi-wechat") };
}

/** 断言式取值（替代非空断言，保持 biome 干净） */
function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  assert.ok(value !== undefined, `索引 ${index} 不存在`);
  return value;
}
function last<T>(arr: T[]): T {
  const value = arr.at(-1);
  assert.ok(value !== undefined, "数组为空");
  return value;
}
function first<T>(arr: T[]): T {
  return at(arr, 0);
}
function runOf(service: FakeService, runId: string): FakeRunState {
  const run = service.runs.get(runId);
  assert.ok(run, `run 不存在：${runId}`);
  return run;
}

let messageSeq = 0;
function msg(userId: string, text: string): BotInboundMessage {
  messageSeq += 1;
  return { channel: "wechat", userId, messageId: `m-${messageSeq}`, text, receivedAt: new Date().toISOString() };
}

/** 便捷：启动一个任务并返回 runId/binding */
async function startOne(
  app: WechatApp,
  service: FakeService,
  userId = "u1",
): Promise<{ runId: string; taskBindingId: string }> {
  const out = await app.handleInbound(msg(userId, "分析 https://github.com/o/r"));
  assert.ok(out.reply?.includes("已启动"), `启动失败：${out.reply}`);
  const binding = last(app.tasks.byUser(userId));
  return { runId: binding.runId, taskBindingId: binding.taskBindingId };
}

function pendingCheckpoint(version = 1): TaskControlCheckpoint {
  return { checkpointId: "cp-1", nodeId: "approval", question: "是否继续执行部署？", status: "pending", version };
}

// ── A11：Checkpoint → 审批卡；未批准绝不继续 ──

test("A11：waiting_checkpoint → 审批卡入 Outbox；未批准不推进", async () => {
  const { app, service } = makeApp();
  const { runId, taskBindingId } = await startOne(app, service);
  runOf(service, runId).effectiveStatus = "waiting_checkpoint";
  runOf(service, runId).status = "waiting_checkpoint";
  service.setCheckpoint(runId, pendingCheckpoint(1));

  await app.pollOnce();

  const approvals = app.outbox.list().filter((i) => i.kind === "approval");
  assert.equal(approvals.length, 1, "审批卡已入队");
  assert.ok(at(approvals, 0).text.includes(taskBindingId), "卡片含任务标识");
  assert.ok(at(approvals, 0).text.includes("是否继续执行部署"), "卡片含审批内容摘要");
  assert.equal(last(app.tasks.byUser("u1")).status, "waiting_checkpoint");
  assert.equal(last(app.tasks.byUser("u1")).approvalNotifiedVersion, 1);
  assert.equal(service.decisions.length, 0, "未批准前绝不调用决策接口");
  assert.equal(runOf(service, runId).effectiveStatus, "waiting_checkpoint", "Run 仍在等待");

  // 版本去重：再扫一轮不重发
  await app.pollOnce();
  assert.equal(app.outbox.list().filter((i) => i.kind === "approval").length, 1);
});

// ── A12：重复 / 版本冲突 / 跨用户 ──

test("A12a：重复批准 → 幂等提示，不重复推进", async () => {
  const { app, service } = makeApp();
  const { runId } = await startOne(app, service);
  const run = runOf(service, runId);
  run.effectiveStatus = "waiting_checkpoint";
  service.setCheckpoint(runId, pendingCheckpoint(1));
  await app.pollOnce();

  const first = await app.handleInbound(msg("u1", "批准"));
  assert.ok(first.reply?.includes("已批准"), first.reply);
  assert.equal(service.decisions.length, 1);
  assert.equal(at(service.decisions, 0).expectedVersion, 1, "携带 expectedVersion");

  // 已决状态下的重复批准：不再调用执行侧
  const again = await app.handleInbound(msg("u1", "批准"));
  assert.ok(again.reply?.includes("已批准过"), again.reply);
  assert.equal(service.decisions.length, 1, "幂等：不重复决策");
});

test("A12b：过期版本审批 → CONFLICT 拒绝，不推进", async () => {
  const { app, service } = makeApp();
  const { runId } = await startOne(app, service);
  const run = runOf(service, runId);
  run.effectiveStatus = "waiting_checkpoint";
  service.setCheckpoint(runId, pendingCheckpoint(1));
  await app.pollOnce();

  service.versionBump = 1; // 内部真实版本已自增（模拟并发/重问后的过期读）
  const out = await app.handleInbound(msg("u1", "批准"));
  assert.ok(out.reply?.includes("版本已变化"), out.reply);
  assert.equal(service.decisions.length, 0, "版本不匹配不得推进");
  const auditEntry = app.audit.byRun(runId).find((a) => a.action === "checkpoint.approve");
  assert.equal(auditEntry?.outcome, "rejected", "审计记录拒绝");
});

test("A12c：跨用户审批 → 拒绝且不触碰决策", async () => {
  const { app, service } = makeApp();
  const { runId, taskBindingId } = await startOne(app, service); // u1 的任务
  runOf(service, runId).effectiveStatus = "waiting_checkpoint";
  service.setCheckpoint(runId, pendingCheckpoint(1));
  await app.pollOnce();

  const out = await app.handleInbound(msg("u2", `批准 ${taskBindingId}`));
  assert.ok(out.reply?.includes("无权"), out.reply);
  assert.equal(service.decisions.length, 0);
  const auditEntry = app.audit.byRun(runId).find((a) => a.action === "checkpoint.approve");
  assert.equal(auditEntry?.outcome, "rejected");
  assert.equal(auditEntry?.actor, "u2", "审计记录实际操作者");
});

// ── A13：查询 / 取消（归属正确） ──

test("A13：进度查询真实状态；取消仅作用于本人任务", async () => {
  const { app, service } = makeApp();
  const { runId } = await startOne(app, service);

  const status = await app.handleInbound(msg("u1", "进度如何"));
  assert.ok(status.reply?.includes("运行中"), status.reply);

  // u2 试图取消 u1 的任务
  const binding = first(app.tasks.byUser("u1"));
  const denied = await app.handleInbound(msg("u2", `取消任务 ${binding.taskBindingId}`));
  assert.ok(denied.reply?.includes("无权"), denied.reply);
  assert.equal(service.cancelled.length, 0);

  const cancel = await app.handleInbound(msg("u1", "取消刚才的任务"));
  assert.ok(cancel.reply?.includes("已取消"), cancel.reply);
  assert.deepEqual(service.cancelled, [runId]);
  assert.equal(first(app.tasks.byUser("u1")).status, "cancelled");
  const auditEntry = app.audit.byRun(runId).find((a) => a.action === "run.cancel");
  assert.equal(auditEntry?.outcome, "ok");
});

// ── A14：多个候选必须澄清 ──

test("A14：多个进行中任务 → 先澄清，绝不默认操作", async () => {
  const { app, service } = makeApp();
  await startOne(app, service);
  await startOne(app, service);

  const out = await app.handleInbound(msg("u1", "取消任务"));
  assert.ok(out.reply?.includes("多个"), out.reply);
  assert.ok(out.reply?.includes("tb-"), "澄清列表含任务号");
  assert.equal(service.cancelled.length, 0, "未误取消");

  // 指明后可操作
  const binding = first(app.tasks.byUser("u1"));
  const done = await app.handleInbound(msg("u1", `取消任务 ${binding.taskBindingId}`));
  assert.ok(done.reply?.includes("已取消"), done.reply);
  assert.equal(service.cancelled.length, 1);
});

// ── A15：完成 ≠ 送达；主动查询补偿 ──

test("A15：通知发送失败不丢结果；任务列表可取回", async () => {
  const { app: app1, service } = makeApp({
    bot: Object.assign(new FakeBot(), { fail: true }),
    outbox: { maxAttempts: 1, retryBaseMs: 1000 },
  });
  const { runId, taskBindingId } = await startOne(app1, service);
  const run = runOf(service, runId);
  run.effectiveStatus = "completed";
  run.status = "completed";
  run.result = { report: "评审报告：3 个建议" };
  await app1.pollOnce();

  await app1.flushOutbox(); // 发送失败 → completed 通知 failed

  const completedItem = first(app1.outbox.list().filter((i) => i.kind === "completed"));
  assert.equal(completedItem.status, "failed", "通知 failed");
  assert.equal(first(app1.tasks.byUser("u1")).status, "completed", "Run 终态不受影响");
  assert.ok(first(app1.tasks.byUser("u1")).summary?.includes("评审报告"), "摘要已存绑定");

  // NT-006：主动查询补偿（新会话 = 用户重连后查询）
  const list = await app1.handleInbound(msg("u1", "任务列表"));
  assert.ok(list.reply?.includes("已完成"), list.reply);
  assert.ok(list.reply?.includes("评审报告"), "列表可取回结果摘要");
  assert.ok(list.reply?.includes(taskBindingId));

  // outbox.giveup 审计可按 runId 串（NT-005）
  assert.ok(app1.audit.byRun(runId).some((a) => a.action === "outbox.giveup"));
});

// ── A16：中断恢复（显式副作用确认 + 路由决策回放） ──

test("A16：interrupted 恢复需显式确认；确认后恢复；决策回放一致", async () => {
  const { app, service, dataDir } = makeApp();
  const { runId, taskBindingId } = await startOne(app, service);
  const run = runOf(service, runId);
  run.effectiveStatus = "interrupted";
  run.status = "interrupted";
  run.journalEntries = 3;
  await app.pollOnce(); // monitor 同步 interrupted 并通知可恢复

  const attempt = await app.handleInbound(msg("u1", "恢复任务"));
  assert.ok(attempt.reply?.includes("确认恢复"), attempt.reply);
  assert.ok(attempt.reply?.includes(taskBindingId), "确认话术含任务号");
  assert.equal(service.resumed.length, 0, "未确认不得恢复（EX-009）");

  const confirmed = await app.handleInbound(msg("u1", `确认恢复 ${taskBindingId}`));
  assert.ok(confirmed.reply?.includes("已恢复"), confirmed.reply);
  assert.equal(service.resumed.length, 1);
  assert.equal(at(service.resumed, 0).acknowledgeSideEffects, true, "显式确认后才 ack");
  assert.equal(first(app.tasks.byUser("u1")).status, "running");

  // MR-010：路由决策持久化 → 新实例读回一致（Resume 可追溯）
  const log = new ModelRoutingLog(dataDir);
  const decision = {
    nodeId: "analyze",
    runId,
    requestedTier: "quick" as const,
    actualModel: "p/quick",
    routeSource: "node-tier" as const,
    decidedAt: new Date().toISOString(),
  };
  log.append(decision);
  const reloaded = new ModelRoutingLog(dataDir);
  assert.deepEqual(reloaded.list(runId), [decision], "重启后决策记录一致");
});

test("A16b：等待审批的任务 → 恢复引导走审批而非 resume", async () => {
  const { app, service } = makeApp();
  const { runId } = await startOne(app, service);
  runOf(service, runId).effectiveStatus = "waiting_checkpoint";
  service.setCheckpoint(runId, pendingCheckpoint(1));
  await app.pollOnce();

  const out = await app.handleInbound(msg("u1", "恢复任务"));
  assert.ok(out.reply?.includes("批准"), out.reply);
  assert.equal(service.resumed.length, 0);
});

// ── A17：断线自愈（持久化去重 / 停 Bot ≠ 取消 Run / 重连） ──

test("A17a：messageId 幂等跨重启持久（WG-006）", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wx-p2-inbox-"));
  const inbox1 = new MessageInbox(base);
  const message = msg("u1", "任务列表");
  assert.equal(inbox1.accept(message).status, "received");
  assert.equal(inbox1.accept(message).status, "duplicate");
  // 重启（新实例同目录）
  const inbox2 = new MessageInbox(base);
  assert.equal(inbox2.accept(message).status, "duplicate", "重启后仍去重");
});

test("A17b：重复消息经全链路只处理一次", async () => {
  const { app, service } = makeApp();
  const message = msg("u1", "分析 https://github.com/o/r");
  const first = await app.handleInbound(message);
  const second = await app.handleInbound(message);
  assert.equal(second.duplicate, true);
  assert.equal(service.started.length, 1, "幂等单 Run");
  assert.ok(first.reply);
});

test("A17c：停止 Bot ≠ 取消 Run（WG-007）", async () => {
  const { app, service, bot } = makeApp();
  await startOne(app, service);
  await app.stop();
  assert.equal(bot.started, false, "Bot 已停");
  assert.equal(service.cancelled.length, 0, "Run 一律不取消");
  assert.equal(first(app.tasks.byUser("u1")).status, "running", "任务状态不变");
});

test("A17d：会话过期 → 退避重连；超限停止不伪装在线", async () => {
  const statuses: string[] = [];
  let connects = 0;
  const factory = async () => {
    connects += 1;
    return { sendText: async () => undefined, getUpdates: async () => [] };
  };
  const adapter = new WechatBotAdapter({
    clientFactory: factory,
    reconnect: { maxRetries: 2, backoffMs: 10 },
    onStatus: (s) => statuses.push(s),
  });
  await adapter.start();
  assert.equal(connects, 1);

  adapter.handleSessionExpired(); // 第 1 次重连（10ms 后）
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(connects, 2, "已自动重连");
  assert.ok(statuses.includes("reconnecting"));

  // 重连成功重置计数；此后连续失败超限应停（maxRetries=2）
  statuses.length = 0;
  let firstConnect = true;
  const failing = new WechatBotAdapter({
    clientFactory: async () => {
      if (firstConnect) {
        firstConnect = false;
        return { sendText: async () => undefined, getUpdates: async () => [] };
      }
      throw new Error("断线");
    },
    reconnect: { maxRetries: 2, backoffMs: 5 },
    onStatus: (s) => statuses.push(s),
  });
  await failing.start(); // 首连成功
  failing.handleSessionExpired();
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(statuses.includes("stopped"), "超限后停用，不无依据假定在线");
  await failing.stop();
  await adapter.stop();
});

// ── A18：三层限额 ──

test("A18a：并发超限 → 明确反馈话术", async () => {
  const { app, service } = makeApp();
  service.failNextStart = true;
  const out = await app.handleInbound(msg("u1", "分析 https://github.com/o/r"));
  assert.ok(out.reply?.includes("并发上限"), out.reply);
  assert.ok(app.audit.list().some((a) => a.action === "limit.reject"));
});

test("A18b：消息频率超限 → 拒绝并提示等待", async () => {
  const { app } = makeApp({ limits: { rateMax: 1, rateWindowMs: 60_000 } });
  await app.handleInbound(msg("u1", "任务列表"));
  const out = await app.handleInbound(msg("u1", "任务列表"));
  assert.ok(out.reply?.includes("太频繁"), out.reply);
  assert.ok(app.audit.list().some((a) => a.action === "limit.reject"));
});

test("A18c：Token 预算超限 → 拒绝新启动", async () => {
  const { app, service } = makeApp({ limits: { maxTokensPerUser: 100 } });
  app.budget.record("u1", 100);
  const out = await app.handleInbound(msg("u1", "分析 https://github.com/o/r"));
  assert.ok(out.reply?.includes("预算"), out.reply);
  assert.equal(service.started.length, 0, "超预算不启动");
  assert.ok(app.audit.list().some((a) => a.action === "limit.reject"));
});

// ── WX-1：重启恢复 ──

test("WX-1：重启后任务列表完整、待审批可继续、Outbox 补投", async () => {
  const failingBot = Object.assign(new FakeBot(), { fail: true });
  const service = new FakeService();
  const llm = smartLLM();
  const registry = new WorkflowRegistry([GITHUB_REVIEW]);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wx-p2-restart-"));
  const dataDir = path.join(base, ".pi-wechat");
  const mk = (bot: FakeBot) =>
    new WechatApp({
      bot: bot as never,
      registry,
      llm,
      service: service as never,
      scriptsRoot: base,
      dataDir,
      outbox: { maxAttempts: 3, retryBaseMs: 60_000 },
    });

  // 第一次进程：启动任务 → 等待审批 → 审批卡与回执均因发送失败滞留 Outbox
  const app1 = mk(failingBot);
  const { runId, taskBindingId } = await startOne(app1, service);
  runOf(service, runId).effectiveStatus = "waiting_checkpoint";
  service.setCheckpoint(runId, pendingCheckpoint(1));
  await app1.pollOnce();
  await app1.flushOutbox();
  assert.ok(app1.outbox.list().some((i) => i.kind === "approval" && i.status === "pending"));

  // 重启：新进程（新 Bot 成功、同一 dataDir）
  const bot2 = new FakeBot();
  const app2 = mk(bot2);
  await app2.pollOnce(); // 重启补扫：不重发旧版本审批卡
  assert.equal(app2.outbox.list().filter((i) => i.kind === "approval").length, 1, "审批卡不重复");
  await app2.flushOutbox(); // 补投滞留通知
  assert.ok(
    bot2.sent.some((s) => s.text.includes("等待你的审批")),
    "审批卡补投成功",
  );
  assert.ok(
    bot2.sent.some((s) => s.text.includes("已启动")),
    "回执补投成功",
  );

  // 任务列表完整 + 待审批可继续
  const list = await app2.handleInbound(msg("u1", "任务列表"));
  assert.ok(list.reply?.includes(taskBindingId), "重启后映射完整");
  const approve = await app2.handleInbound(msg("u1", "批准"));
  assert.ok(approve.reply?.includes("已批准"), approve.reply);
  assert.equal(service.decisions.length, 1);
});

// ── WX-2：审计按 runId 串起全链路 ──

test("WX-2：审计链：意图→启动→审批→通知可按 runId 串起（NT-005）", async () => {
  const failingBot = Object.assign(new FakeBot(), { fail: true });
  const { app, service } = makeApp({ bot: failingBot, outbox: { maxAttempts: 1, retryBaseMs: 1000 } });
  const { runId } = await startOne(app, service);
  const run = runOf(service, runId);
  run.effectiveStatus = "waiting_checkpoint";
  service.setCheckpoint(runId, pendingCheckpoint(1));
  await app.pollOnce();
  await app.handleInbound(msg("u1", "批准"));
  run.effectiveStatus = "completed";
  at(run.checkpoints, 0).status = "approved";
  run.result = "完成";
  await app.pollOnce();
  await app.flushOutbox();

  const chain = app.audit.byRun(runId).map((a) => a.action);
  for (const expected of ["intent.route", "run.start", "checkpoint.requested", "checkpoint.approve", "outbox.giveup"]) {
    assert.ok(chain.includes(expected as never), `审计链缺 ${expected}（实际 ${chain.join(",")}）`);
  }
});

// ── WX-3：日志脱敏 ──

test("WX-3：审计落盘无凭据/密钥明文（SC-004）", async () => {
  const { app, dataDir } = makeApp();
  app.audit.record({
    actor: "u1",
    action: "intent.route",
    detail:
      '路由携带 sk-abcdef1234567890 与 Authorization: Bearer eyJhbGciOi.9x 和 {"token":"supersecret123"} 与 ~/.pi/agent/wechat-assistant/credentials.json',
  });
  const raw = fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf-8");
  assert.ok(!raw.includes("sk-abcdef1234567890"), "API key 已脱敏");
  assert.ok(!raw.includes("supersecret123"), "token 字段值已脱敏");
  assert.ok(!raw.includes("credentials.json"), "凭据路径已脱敏");
  assert.ok(raw.includes("[REDACTED:"), "留有脱敏占位");

  assert.ok(redact("Bearer abcdefghijk123456").startsWith("[REDACTED"));
  assert.equal(redact("正常文本 repo=https://github.com/o/r"), "正常文本 repo=https://github.com/o/r", "非敏感不误伤");
});

// ── ModelRouter 审计钩子（MR-011/NFR-008 接线验证） ──

test("ModelRouter 决策经钩子进审计与路由日志", async () => {
  const { app, dataDir } = makeApp();
  const router = new ModelRouter(
    { pools: { quick: ["p/quick"] }, defaultTier: "quick" },
    { listAvailable: async () => ["p/quick"] },
    {
      onDecision: (d) => {
        app.modelRoutes.append(d);
        app.audit.record({
          actor: "system",
          action: "model.route",
          target: { runId: d.runId },
          detail: `${d.nodeId} → ${d.actualModel} (${d.routeSource})`,
        });
      },
    },
  );
  const decision = await router.decide({ runId: "run-x", nodeId: "n1", tier: "quick" });
  assert.equal(decision?.actualModel, "p/quick");
  assert.ok(app.audit.byRun("run-x").some((a) => a.action === "model.route"));
  assert.equal(new ModelRoutingLog(dataDir).list("run-x").length, 1);
});

test("A11 补充：歧义审批支持序号选择（批准 2 / 纯数字）与越界拒绝", async () => {
  // 复用 S1 已有的 TaskController 构造方式见上；此处直接构造最小依赖
  const bindings = [
    { taskBindingId: "tb-a", runId: "run-a", channel: "wechat", userId: "u1", workflowId: "w", status: "waiting_checkpoint", createdAt: "t", updatedAt: "t" },
    { taskBindingId: "tb-b", runId: "run-b", channel: "wechat", userId: "u1", workflowId: "w", status: "waiting_checkpoint", createdAt: "t", updatedAt: "t" },
  ];
  const decided: Array<{ id: string; decision: string }> = [];
  const controller = new TaskController({
    tasks: { byUser: () => bindings, list: () => bindings } as never,
    service: {
      get: async (runId: string) => ({
        snapshot: { status: "waiting_checkpoint", effectiveStatus: "waiting_checkpoint" },
        checkpoints: [{ checkpointId: `${runId}:1`, nodeId: `${runId}:1`, question: `q-${runId}`, status: "pending", version: 1 }],
      }),
      decideCheckpoint: async (runId: string, _cp: string, input: { decision: string }) => {
        decided.push({ id: runId, decision: input.decision });
        return { status: input.decision === "approve" ? "approved" : "rejected" };
      },
    } as never,
  });
  // 多待审批 → 澄清话术含序号提示
  const clarify = await controller.decide("u1", "approve", "批准");
  assert.ok(clarify.includes("[1]") && clarify.includes("[2]"), "澄清列表带序号");
  assert.ok(clarify.includes("批准 1"), "提示序号回复方式");
  // 序号选择：批准 2 → 作用于第二个
  const pick = await controller.decide("u1", "approve", "批准 2");
  assert.ok(pick.includes("run-b") || pick.includes("tb-b"), `作用于第二项：${pick}`);
  assert.equal(decided.at(-1)?.id, "run-b");
  // 纯数字选择
  const pick1 = await controller.decide("u1", "reject", "1");
  assert.ok(pick1.length > 0);
  assert.equal(decided.at(-1)?.id, "run-a");
  // 越界拒绝
  const oob = await controller.decide("u1", "approve", "批准 9");
  assert.ok(oob.includes("超出范围"), `越界话术：${oob}`);
});

test("A11 补充：批量决策「批准 2 拒绝 1」按快照序号逐项执行", async () => {
  const bindings = ["run-a", "run-b", "run-c"].map((runId, i) => ({
    taskBindingId: `tb-${runId}`, runId, channel: "wechat", userId: "u1", workflowId: "w",
    status: "waiting_checkpoint", createdAt: "t", updatedAt: "t", __i: i,
  }));
  const decided: Array<{ id: string; decision: string }> = [];
  const controller = new TaskController({
    tasks: { byUser: () => bindings, list: () => bindings } as never,
    service: {
      get: async (runId: string) => ({
        snapshot: { status: "waiting_checkpoint", effectiveStatus: "waiting_checkpoint" },
        checkpoints: [{ checkpointId: `${runId}:1`, nodeId: `${runId}:1`, question: `q-${runId}`, status: "pending", version: 1 }],
      }),
      decideCheckpoint: async (runId: string, _cp: string, input: { decision: string }) => {
        decided.push({ id: runId, decision: input.decision });
        return { status: input.decision === "approve" ? "approved" : "rejected" };
      },
    } as never,
  });
  const out = await controller.decideMulti("u1", "批准 2 拒绝 1");
  assert.ok(out && out.includes("tb-run-b") && out.includes("tb-run-a"), `汇总含两项：${out}`);
  assert.deepEqual(
    decided.map((d) => `${d.decision}:${d.id}`),
    ["approve:run-b", "reject:run-a"],
    "按快照序号各自落位",
  );
  // 混合 tb- 精确 + 序号 + 越界段
  const out2 = await controller.decideMulti("u1", "批准 tb-run-c 拒绝 9");
  assert.ok(out2?.includes("tb-run-c"), "tb- 精确段生效");
  assert.ok(out2?.includes("超出") || out2?.includes("未找到"), "越界段提示");
  // 单段（<2）返回 null 走 decide 原路径
  assert.equal(await controller.decideMulti("u1", "批准 2"), null);
});
