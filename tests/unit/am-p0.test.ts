/**
 * AM-P0 T1 契约单测：PendingAction 状态机全路径 / RunLaunch 三阶段 / InboxJournal 恢复 / TurnBudget 双层
 * 契约约束：agent-host 不 import gateway（跨入口复用禁令）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { RunLaunchStore, RunLinkStore } from "../../src/agent-host/run-launch.js";
import { InboxJournal } from "../../src/agent-host/inbox-journal.js";
import { TurnBudget, InMemoryCumulativeBudget } from "../../src/agent-host/agent-budget.js";
import { FakeAgentSession, FakeAgentToolFacade } from "../../src/agent-host/fakes.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "am-t1-"));
}

// ── PendingAction 状态机（§3） ──

test("PA：create → claim（重校验过）→ complete；重复 claim 幂等返回原始结果", async () => {
  const dir = tmpDir();
  const store = new PendingActionStore(dir);
  const a = store.create({
    userId: "u1", workflowId: "deploy", args: { x: 1 }, argsDigest: "d1",
    originMessageId: "m1", riskLevel: "write", registryDigest: "reg-1",
  });
  assert.equal(a.status, "pending");
  assert.ok(store.hasPending("u1"), "直通判定可见");

  const claimed = await store.claim(a.actionId, { userId: "u1", registryDigest: "reg-1" });
  assert.ok(claimed.ok, "重校验通过认领");
  assert.equal(claimed.ok && claimed.action.status, "executing");

  store.complete(a.actionId, { runId: "run-1", taskBindingId: "tb-1" });

  // 重复确认：幂等返回原始结果，不再认领
  const again = await store.claim(a.actionId, { userId: "u1", registryDigest: "reg-1" });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "already_executed");
  assert.deepEqual(!again.ok && again.result, { runId: "run-1", taskBindingId: "tb-1" }, "返回原始结果");
});

test("PA：并发 claim 同一 actionId 只有一个成功（原子认领）", async () => {
  const dir = tmpDir();
  const store = new PendingActionStore(dir);
  const a = store.create({
    userId: "u1", workflowId: "w", args: {}, argsDigest: "d", originMessageId: "m", riskLevel: "write", registryDigest: "r",
  });
  const [c1, c2] = await Promise.all([
    store.claim(a.actionId, { userId: "u1", registryDigest: "r" }),
    store.claim(a.actionId, { userId: "u1", registryDigest: "r" }),
  ]);
  const oks = [c1, c2].filter((c) => c.ok).length;
  assert.equal(oks, 1, "只有一个执行者获得启动资格");
});

test("PA：重校验失败路径（跨用户/registry 变/args 变/过期/reject）", async () => {
  const dir = tmpDir();
  const store = new PendingActionStore(dir);
  const mk = (id: string) =>
    store.create({ userId: "u1", workflowId: id, args: {}, argsDigest: "d", originMessageId: "m", riskLevel: "write", registryDigest: "r" });

  const other = await store.claim((await mk("a")).actionId, { userId: "u2", registryDigest: "r" });
  assert.equal(other.reason, "validation_failed", "跨用户拒绝");

  const regChanged = await store.claim((await mk("b")).actionId, { userId: "u1", registryDigest: "r-2" });
  assert.equal(regChanged.reason, "validation_failed", "registry 变化拒绝");

  const argsChanged = await store.claim((await mk("c")).actionId, { userId: "u1", registryDigest: "r", argsDigest: "d2" });
  assert.equal(argsChanged.reason, "validation_failed", "参数变化拒绝");

  const expired = store.create({ userId: "u1", workflowId: "e", args: {}, argsDigest: "d", originMessageId: "m", riskLevel: "write", registryDigest: "r", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  const expiredClaim = await store.claim(expired.actionId, { userId: "u1", registryDigest: "r" });
  assert.equal(expiredClaim.reason, "expired", "过期拒绝");
  assert.equal(store.get(expired.actionId)?.status, "expired");

  const rej = await mk("f");
  store.reject(rej.actionId);
  const rejected = await store.claim(rej.actionId, { userId: "u1", registryDigest: "r" });
  assert.equal(rejected.reason, "rejected");
});

test("PA：重启恢复（jsonl 追加末条生效）", () => {
  const dir = tmpDir();
  const s1 = new PendingActionStore(dir);
  const a = s1.create({ userId: "u1", workflowId: "w", args: {}, argsDigest: "d", originMessageId: "m", riskLevel: "write", registryDigest: "r" });
  const s2 = new PendingActionStore(dir);
  assert.equal(s2.get(a.actionId)?.status, "pending", "重启后状态可见");
  assert.ok(s2.hasPending("u1"));
});

// ── RunLaunch 三阶段（§2.3/§3.3） ──

test("RL：prewrite → link 成功回填；markUnknown 方案 B 不自动重试", () => {
  const dir = tmpDir();
  const store = new RunLaunchStore(dir);
  const a = store.prewrite({ userId: "u1", workflowId: "w", argsDigest: "d", agentTurnId: "t1" });
  assert.equal(a.status, "launched");
  assert.equal(store.staleLaunched().length, 1, "崩溃窗口遗留可查");

  store.link(a.attemptId, "run-9", "tb-9");
  assert.equal(store.get(a.attemptId)?.status, "linked");
  assert.equal(store.get(a.attemptId)?.runId, "run-9");
  assert.equal(store.staleLaunched().length, 0);

  const b = store.prewrite({ userId: "u1", workflowId: "w2", argsDigest: "d" });
  store.markUnknown(b.attemptId);
  assert.equal(store.unknownAttempts().length, 1, "unknown 人工核对队列");
});

test("RunLink：终态回写 + 后续 Turn 读取真实产物", () => {
  const dir = tmpDir();
  const links = new RunLinkStore(dir);
  links.upsert({ runId: "run-1", taskBindingId: "tb-1", agentTurnId: "t1", status: "running" });
  links.upsert({ runId: "run-1", taskBindingId: "tb-1", agentTurnId: "t1", status: "completed", resultSummary: "文章完成", resultRef: "out/a.md" });
  assert.equal(links.get("run-1")?.status, "completed", "末条生效");
  assert.equal(links.get("run-1")?.resultRef, "out/a.md");
  assert.equal(links.byUserAgentTurns(new Set(["t1"])).length, 1);
});

// ── InboxJournal（§4） ──

test("IJ：record 去重 / 状态流转 / 重启恢复未完成", () => {
  const dir = tmpDir();
  const j = new InboxJournal(dir);
  const msg = { channel: "wechat", messageId: "m1", userId: "u1", text: "帮我分析", receivedAt: new Date().toISOString() };
  assert.equal(j.record(msg).duplicate, false);
  assert.equal(j.record(msg).duplicate, true, "同 messageId 去重");

  j.markProcessing("wechat", "m1", "t1");
  j.markCompleted("wechat", "m1");
  assert.equal(j.get("wechat", "m1")?.state, "completed");

  // 崩溃场景：processing 中断 → 重启后 unfinished 恢复
  const j2 = new InboxJournal(dir);
  const msg2 = { channel: "wechat", messageId: "m2", userId: "u1", text: "第二条", receivedAt: new Date().toISOString() };
  j2.record(msg2);
  j2.markProcessing("wechat", "m2");
  const j3 = new InboxJournal(dir);
  const unfinished = j3.unfinished();
  assert.equal(unfinished.length, 1);
  assert.equal(unfinished[0]?.text, "第二条", "完整消息快照可恢复（非仅 messageId）");
});

// ── TurnBudget 双层（§6） ──

test("TB：累计预算拒绝开始；单 Turn 硬限（请求/工具/时长）；settle 入账", () => {
  const cum = new InMemoryCumulativeBudget(1000);
  const tb = new TurnBudget(cum, { maxLlmRequests: 2, maxToolCalls: 1, maxDurationMs: 10_000 });
  assert.equal(tb.begin("u1").ok, true);

  tb.activate();
  tb.onLlmRequest();
  tb.onToolCall();
  assert.equal(tb.exceeded(), null);
  tb.onToolCall();
  assert.equal(tb.exceeded(), "tool_calls", "工具调用超限");

  const tb2 = new TurnBudget(cum, { maxLlmRequests: 2, maxToolCalls: 10, maxDurationMs: 10_000 });
  tb2.begin("u1");
  tb2.activate();
  tb2.onLlmRequest();
  tb2.onLlmRequest();
  tb2.onLlmRequest();
  assert.equal(tb2.exceeded(), "llm_requests", "LLM 请求超限");

  tb2.settle("u1", { inputTokens: 300, outputTokens: 200 });
  assert.equal(cum.remaining("u1"), 500, "usage 入账");
  assert.equal(tb2.exceeded(), null, "settle 后停止计时");

  const tb3 = new TurnBudget(cum, {});
  cum.settle("u1", 600); // 累计 1100 > 1000
  assert.equal(tb3.begin("u1").ok, false, "累计预算不足拒绝新 Turn");
});

// ── Fake（供 T2+ 模块测试） ──

test("Fake：脚本化 Session 驱动工具调用链", async () => {
  const session = new FakeAgentSession();
  const facade = new FakeAgentToolFacade();
  session.queueScript({
    steps: [
      { tool: "workflow_search", args: {} },
      { tool: "workflow_execute", args: { userId: "u1", workflowId: "github-review", args: { repoUrl: "https://github.com/a/b" }, agentTurnId: "t1", originMessageId: "m1" } },
      { tool: "task_status", args: { userId: "u1", runId: "run-fake-1" } },
    ],
    finalReply: "任务已完成",
  });
  const reply = await session.prompt("分析这个仓库", facade);
  assert.equal(reply, "任务已完成");
  assert.equal(facade.searchCalls.length, 1);
  assert.equal(facade.executeCalls[0]?.workflowId, "github-review");
  assert.equal(facade.statusCalls.length, 1);
});

// ── 契约：agent-host 不依赖 gateway（§2.1-3 同款禁令） ──

test("契约：agent-host 模块不 import gateway/dispatch 微信实现", () => {
  const files = fs.readdirSync(path.resolve("src/agent-host"));
  for (const f of files) {
    const src = fs.readFileSync(path.join("src/agent-host", f), "utf8");
    assert.ok(!src.includes("../gateway/"), `${f} 不得依赖 gateway`);
    assert.ok(!src.includes("wechat-assistant"), `${f} 不得依赖微信协议实现`);
  }
});
