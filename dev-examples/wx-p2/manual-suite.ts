/**
 * WX-P2 手动验收套件（ scripted，确定性 FakeBot/FakeService，不依赖真机与真实 LLM）
 *
 * 用法（仓库根执行）：
 *   npx tsx dev-examples/wx-p2/manual-suite.ts
 *
 * 输出：逐断言 PASS/FAIL + 结尾汇总。真机（微信渠道）用例见
 * dev-docs/guides/2026-10-21-wx-p2-manual-test.md，需扫码后在 pi-workflow wechat start 会话中执行。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WechatApp } from "../../src/gateway/wechat-app.ts";
import { WorkflowRegistry } from "../../src/dispatch/registry.ts";
import type { RoutingLLM } from "../../src/dispatch/intent-router.ts";
import type { TaskControlCheckpoint, TaskControlService } from "../../src/dispatch/task-control.ts";
import type { ExecutionService } from "../../src/dispatch/dispatcher.ts";
import type { BotInboundMessage, WorkflowRegistration } from "../../src/contracts/wx.ts";

// ── 计数 ──
let pass = 0;
let fail = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.log(`FAIL  ${name}\n      ${message}`);
  }
}

// ── 装置（与单测同构） ──

const WORKFLOW: WorkflowRegistration = {
  workflowId: "github-review",
  scriptPath: "github-review.js",
  name: "GitHub 仓库分析",
  description: "分析 GitHub 仓库并输出评审报告",
  argsSchema: { type: "object", properties: { repoUrl: { type: "string" } }, required: ["repoUrl"] },
  riskLevel: "read-only",
  enabled: true,
  keywords: ["分析", "review", "github", "仓库"],
};

const CONTROL = JSON.stringify({ intent: "task_control", workflowId: null, args: {}, missingFields: [], reason: "任务控制", confidence: 0.9 });
const EXEC = JSON.stringify({ intent: "execute_workflow", workflowId: "github-review", args: { repoUrl: "https://github.com/o/r" }, missingFields: [], reason: "匹配", confidence: 0.9 });

const llm: RoutingLLM = {
  async route(prompt) {
    const userText = prompt.split("\n")[0]?.replace(/^用户消息：/, "") ?? "";
    const control = /任务列表|查看任务|进度|状态|取消|恢复|批准|拒绝|怎么样/.test(userText);
    return { text: control ? CONTROL : EXEC, latencyMs: 5, tokens: 120 };
  },
};

interface RunState {
  status: string;
  effectiveStatus: string;
  result?: unknown;
  journalEntries: number;
  alive: boolean;
  checkpoints: TaskControlCheckpoint[];
}

class FakeService implements ExecutionService, TaskControlService {
  started = 0;
  cancelled: string[] = [];
  resumed: Array<{ runId: string; acknowledgeSideEffects: boolean }> = [];
  decisions: unknown[] = [];
  runs = new Map<string, RunState>();
  private next = 0;

  async start(): Promise<{ runId: string }> {
    this.next += 1;
    const runId = `run-m${this.next}`;
    this.runs.set(runId, { status: "running", effectiveStatus: "running", journalEntries: 0, alive: true, checkpoints: [] });
    this.started += 1;
    return { runId };
  }
  async get(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      snapshot: { status: run.status, effectiveStatus: run.effectiveStatus, ...(run.result !== undefined ? { result: run.result } : {}) },
      checkpoints: run.checkpoints.map((c) => ({ ...c })),
    };
  }
  async cancel(runId: string): Promise<{ status: string }> {
    const run = this.runs.get(runId);
    if (run && (run.effectiveStatus === "running" || run.effectiveStatus === "waiting_checkpoint")) {
      run.effectiveStatus = "cancelled";
      run.status = "cancelled";
      this.cancelled.push(runId);
    }
    return { status: "cancelled" };
  }
  async resume(runId: string, options: { acknowledgeSideEffects: boolean }): Promise<{ runId: string }> {
    const run = this.runs.get(runId);
    if (!run) throw Object.assign(new Error("不存在"), { code: "RUN_NOT_FOUND" });
    if (run.effectiveStatus === "interrupted" && run.journalEntries > 0 && !options.acknowledgeSideEffects) {
      throw Object.assign(new Error("需确认"), { code: "SIDE_EFFECTS_UNACKNOWLEDGED" });
    }
    run.effectiveStatus = "running";
    run.status = "running";
    this.resumed.push({ runId, acknowledgeSideEffects: options.acknowledgeSideEffects });
    return { runId };
  }
  async decideCheckpoint(runId: string, checkpointId: string, input: { decision: "approve" | "reject"; expectedVersion: number }) {
    const run = this.runs.get(runId);
    const cp = run?.checkpoints.find((c) => c.checkpointId === checkpointId);
    if (!run || !cp || cp.status !== "pending" || cp.version !== input.expectedVersion) {
      throw Object.assign(new Error("冲突"), { code: "CONFLICT" });
    }
    cp.status = input.decision === "approve" ? "approved" : "rejected";
    this.decisions.push({ runId, checkpointId, decision: input.decision });
    return { status: cp.status };
  }
}

class FakeBot {
  sent: Array<{ userId: string; text: string }> = [];
  fail = false;
  started = false;
  async start() {
    this.started = true;
  }
  async stop() {
    this.started = false;
  }
  onMessage(): void {}
  async send(userId: string, text: string): Promise<void> {
    if (this.fail) throw new Error("发送失败（模拟断线）");
    this.sent.push({ userId, text });
  }
}

function build(service: FakeService, bot: FakeBot, dataDir: string): WechatApp {
  return new WechatApp({
    bot: bot as never,
    registry: new WorkflowRegistry([WORKFLOW]),
    llm,
    service: service as never,
    scriptsRoot: dataDir,
    dataDir: path.join(dataDir, ".pi-wechat"),
    outbox: { maxAttempts: 3, retryBaseMs: 60_000 },
  });
}

let seq = 0;
function msg(userId: string, text: string): BotInboundMessage {
  seq += 1;
  return { channel: "wechat", userId, messageId: `mm-${seq}`, text, receivedAt: new Date().toISOString() };
}

async function startOne(app: WechatApp, userId = "u1"): Promise<{ runId: string; taskBindingId: string }> {
  const out = await app.handleInbound(msg(userId, "分析 https://github.com/o/r"));
  assert.ok(out.reply?.includes("已启动"), `启动失败：${out.reply}`);
  const mine = app.tasks.byUser(userId);
  const binding = mine.at(-1);
  assert.ok(binding);
  return { runId: binding.runId, taskBindingId: binding.taskBindingId };
}

function cp(v = 1): TaskControlCheckpoint {
  return { checkpointId: "cp-1", nodeId: "approval", question: "是否继续执行部署？", status: "pending", version: v };
}

// ── 套件 ──

async function main(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wx-p2-manual-"));
  console.log(`工作目录：${base}\n`);

  // 场景一：审批闭环（A11/A12/A13 通道）
  await check("S1-1 发起任务 → 受理回执", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    const app = build(service, bot, path.join(base, "s1"));
    const { runId, taskBindingId } = await startOne(app);
    await app.flushOutbox();
    assert.equal(service.started, 1);
    assert.ok(bot.sent.some((s) => s.text.includes("已启动") || s.text.includes(taskBindingId)), "回执已投递");
    const state = service.runs.get(runId);
    assert.ok(state && state.effectiveStatus === "running");
  });

  await check("S1-2 等待审批 → 审批卡（未批准不推进）", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    const app = build(service, bot, path.join(base, "s2"));
    const { runId, taskBindingId } = await startOne(app);
    const run = service.runs.get(runId);
    assert.ok(run);
    run.effectiveStatus = "waiting_checkpoint";
    run.checkpoints = [cp(1)];
    await app.pollOnce();
    await app.flushOutbox();
    assert.ok(bot.sent.some((s) => s.text.includes("等待你的审批") && s.text.includes(taskBindingId)), "审批卡含任务标识");
    assert.equal(service.decisions.length, 0, "未批准绝不推进");
  });

  await check("S1-3 批准 → 继续执行；重复批准幂等", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    const app = build(service, bot, path.join(base, "s3"));
    const { runId } = await startOne(app);
    const run = service.runs.get(runId);
    assert.ok(run);
    run.effectiveStatus = "waiting_checkpoint";
    run.checkpoints = [cp(1)];
    await app.pollOnce();
    const ok = await app.handleInbound(msg("u1", "批准"));
    assert.ok(ok.reply?.includes("已批准"), ok.reply);
    const again = await app.handleInbound(msg("u1", "批准"));
    assert.ok(again.reply?.includes("已批准过"), again.reply);
    assert.equal(service.decisions.length, 1, "幂等");
  });

  // 场景二：取消与歧义（A13/A14）
  await check("S2-1 多任务取消 → 先澄清后指名操作", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    const app = build(service, bot, path.join(base, "s4"));
    await startOne(app);
    await startOne(app);
    const ambiguous = await app.handleInbound(msg("u1", "取消任务"));
    assert.ok(ambiguous.reply?.includes("多个"), "先澄清");
    assert.equal(service.cancelled.length, 0);
    const firstBinding = app.tasks.byUser("u1")[0];
    assert.ok(firstBinding);
    const done = await app.handleInbound(msg("u1", `取消任务 ${firstBinding.taskBindingId}`));
    assert.ok(done.reply?.includes("已取消"), done.reply);
    assert.equal(service.cancelled.length, 1);
  });

  await check("S2-2 跨用户操作被拒绝", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    const app = build(service, bot, path.join(base, "s5"));
    const { taskBindingId } = await startOne(app);
    const denied = await app.handleInbound(msg("u2", `取消任务 ${taskBindingId}`));
    assert.ok(denied.reply?.includes("无权"), denied.reply);
    assert.equal(service.cancelled.length, 0);
  });

  // 场景三：完成≠送达 + 补偿查询（A15）
  await check("S3-1 通知失败不丢结果；任务列表取回", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    bot.fail = true;
    const app = build(service, bot, path.join(base, "s6"));
    const { runId, taskBindingId } = await startOne(app);
    const run = service.runs.get(runId);
    assert.ok(run);
    run.effectiveStatus = "completed";
    run.status = "completed";
    run.result = { report: "评审报告：3 个建议" };
    await app.pollOnce();
    await app.flushOutbox();
    const item = app.outbox.list().find((i) => i.kind === "completed");
    assert.ok(item && item.status !== "sent", "完成通知未送达");
    bot.fail = false; // 用户主动查询（新通道可达）
    const list = await app.handleInbound(msg("u1", "任务列表"));
    assert.ok(list.reply?.includes(taskBindingId) && list.reply?.includes("评审报告"), list.reply);
  });

  // 场景四：中断恢复（A16）
  await check("S4-1 中断恢复需显式确认副作用", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    const app = build(service, bot, path.join(base, "s7"));
    const { runId, taskBindingId } = await startOne(app);
    const run = service.runs.get(runId);
    assert.ok(run);
    run.effectiveStatus = "interrupted";
    run.status = "interrupted";
    run.journalEntries = 3;
    await app.pollOnce();
    const attempt = await app.handleInbound(msg("u1", "恢复任务"));
    assert.ok(attempt.reply?.includes("确认恢复"), "先要求确认");
    assert.equal(service.resumed.length, 0);
    const confirmed = await app.handleInbound(msg("u1", `确认恢复 ${taskBindingId}`));
    assert.ok(confirmed.reply?.includes("已恢复"), confirmed.reply);
    assert.equal(service.resumed[0]?.acknowledgeSideEffects, true);
  });

  // 场景五：断线自愈与重启恢复（A17/WX-1）
  await check("S5-1 重启恢复：Outbox 补投 + 待审批不重发 + 可继续审批", async () => {
    const service = new FakeService();
    const badBot = new FakeBot();
    badBot.fail = true;
    const dir = path.join(base, "s8");
    const app1 = build(service, badBot, dir);
    const { runId, taskBindingId } = await startOne(app1);
    const run = service.runs.get(runId);
    assert.ok(run);
    run.effectiveStatus = "waiting_checkpoint";
    run.checkpoints = [cp(1)];
    await app1.pollOnce();
    await app1.flushOutbox();
    // 重启：新 Bot 可达
    const goodBot = new FakeBot();
    const app2 = build(service, goodBot, dir);
    await app2.pollOnce();
    assert.equal(app2.outbox.list().filter((i) => i.kind === "approval").length, 1, "审批卡不重复");
    await app2.flushOutbox();
    assert.ok(goodBot.sent.some((s) => s.text.includes("等待你的审批")), "补投成功");
    const approve = await app2.handleInbound(msg("u1", "批准"));
    assert.ok(approve.reply?.includes("已批准"), approve.reply);
    const list = await app2.handleInbound(msg("u1", "任务列表"));
    assert.ok(list.reply?.includes(taskBindingId), "重启后映射完整");
  });

  await check("S5-2 重复消息（重连重发）只处理一次", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    const app = build(service, bot, path.join(base, "s9"));
    const message = msg("u1", "分析 https://github.com/o/r");
    await app.handleInbound(message);
    const second = await app.handleInbound(message);
    assert.equal(second.duplicate, true);
    assert.equal(service.started, 1);
  });

  // 场景六：限额（A18）
  await check("S6-1 频率超限明确反馈", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    const dir = path.join(base, "s10");
    const app = new WechatApp({
      bot: bot as never,
      registry: new WorkflowRegistry([WORKFLOW]),
      llm,
      service: service as never,
      scriptsRoot: dir,
      dataDir: path.join(dir, ".pi-wechat"),
      limits: { rateMax: 1, rateWindowMs: 60_000 },
    });
    await app.handleInbound(msg("u1", "任务列表"));
    const out = await app.handleInbound(msg("u1", "任务列表"));
    assert.ok(out.reply?.includes("太频繁"), out.reply);
  });

  // 场景七：审计链与脱敏（WX-2/WX-3）
  await check("S7-1 审计按 runId 串起全链路；无凭据明文", async () => {
    const service = new FakeService();
    const bot = new FakeBot();
    bot.fail = true;
    const dir = path.join(base, "s11");
    const app = new WechatApp({
      bot: bot as never,
      registry: new WorkflowRegistry([WORKFLOW]),
      llm,
      service: service as never,
      scriptsRoot: dir,
      dataDir: path.join(dir, ".pi-wechat"),
      outbox: { maxAttempts: 1, retryBaseMs: 1000 },
    });
    const { runId } = await startOne(app);
    const run = service.runs.get(runId);
    assert.ok(run);
    run.effectiveStatus = "waiting_checkpoint";
    run.checkpoints = [cp(1)];
    await app.pollOnce();
    await app.handleInbound(msg("u1", "批准"));
    run.effectiveStatus = "completed";
    run.checkpoints[0]!.status = "approved";
    run.result = "完成";
    await app.pollOnce();
    await app.flushOutbox();
    const chain = app.audit.byRun(runId).map((a) => a.action);
    for (const want of ["intent.route", "run.start", "checkpoint.requested", "checkpoint.approve", "outbox.giveup"]) {
      assert.ok(chain.includes(want), `缺 ${want}`);
    }
    const raw = fs.readFileSync(path.join(dir, ".pi-wechat", "audit.jsonl"), "utf-8");
    app.audit.record({ actor: "u1", action: "intent.route", detail: "sk-abcdef1234567890" });
    const raw2 = fs.readFileSync(path.join(dir, ".pi-wechat", "audit.jsonl"), "utf-8");
    assert.ok(!raw2.includes("sk-abcdef1234567890") && raw.length > 0, "凭据脱敏");
  });

  // 汇总
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  if (failures.length > 0) {
    console.log("\n失败明细：");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

void main();
