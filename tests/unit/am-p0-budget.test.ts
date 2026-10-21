/**
 * AM-P0 T6 单测：双层预算（§6）
 * 验收锚点（执行计划 §7 T6）：超 Turn 硬限安全停，已启 Run 不受影响。
 * - 累计预算：Turn 开始前检查（不足拒绝）；结束后按实际 usage 入账；余量容差（1.2x）实时中止
 * - 单 Turn 硬限：LLM 请求/工具调用/时长，执行中实时检查 → 安全中止（只停 Agent Loop）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../../src/agent-host/agent-host.js";
import { InMemoryCumulativeBudget } from "../../src/agent-host/agent-budget.js";
import { FileBackedSessionRegistry, GatedHostedSession, ScriptedHostedSession } from "../../src/agent-host/fakes.js";
import { FakeAgentToolFacade } from "../../src/agent-host/fakes.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "am-t6-"));
}

interface Env {
  root: string;
  registry: FileBackedSessionRegistry;
  cumulative: InMemoryCumulativeBudget;
  deps(over?: Record<string, unknown>): Record<string, unknown>;
}

function makeEnv(make: () => GatedHostedSession | ScriptedHostedSession): Env {
  const root = tmpDir();
  const registry = new FileBackedSessionRegistry(path.join(root, "sessions"), make);
  const cumulative = new InMemoryCumulativeBudget(1_000_000);
  return {
    root,
    registry,
    cumulative,
    deps: (over: Record<string, unknown> = {}) => ({
      cwd: root,
      sessionDir: path.join(root, "sessions"),
      dataDir: path.join(root, "data"),
      customTools: [],
      facade: new FakeAgentToolFacade(),
      openSession: registry.opener,
      cumulative,
      budgetPollMs: 20,
      ...over,
    }),
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("T6：工具调用超单 Turn 硬限 → 安全中止（不触碰已启动 Run，journal 完成）", async () => {
  const env = makeEnv(() => new GatedHostedSession("conv-u1"));
  const host = new AgentHost(
    env.deps({ limits: { maxLlmRequests: 100, maxToolCalls: 2, maxDurationMs: 60_000 } }) as never,
  );
  const p1 = host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "开始" });
  await waitFor(() => env.registry.sessions.has("u1"));
  const session = env.registry.sessions.get("u1") as GatedHostedSession;
  await waitFor(() => session.prompts.length === 1);

  session.emit({ type: "tool_call" }); // 1 次：未超
  assert.equal(session.abortCalls, 0);
  session.emit({ type: "tool_call" }); // 第 3 次？onToolCall 计数=2 未超
  session.emit({ type: "tool_call" }); // 计数=3 > 2 → 超限
  await waitFor(() => session.abortCalls === 1, "超限触发一次安全中止");

  const r1 = await p1; // abort 放行 gate → prompt 以中止态返回
  assert.equal(r1.status, "processed");
  assert.match(r1.result!.replyText, /预算上限.*tool_calls/, "回执说明安全停止");
  assert.match(r1.result!.replyText, /已启动的任务不受影响/);
  assert.equal(host.inbox.get("wechat", "m1")?.state, "completed", "消息处理完成（非失败）");
  // 已启动 Run 不受影响：AgentHost 从不调用 facade 取消（结构性保证），此处验证 abort 只作用于会话
  assert.equal(session.abortCalls, 1);
});

test("T6：时长硬限 → 定时器触发安全中止", async () => {
  const env = makeEnv(() => new GatedHostedSession("conv-u1"));
  const host = new AgentHost(
    env.deps({ limits: { maxLlmRequests: 100, maxToolCalls: 100, maxDurationMs: 60 } }) as never,
  );
  const p1 = host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "开始" });
  await waitFor(() => (env.registry.sessions.get("u1") as GatedHostedSession | undefined)?.prompts.length === 1);
  const session = env.registry.sessions.get("u1") as GatedHostedSession;
  await waitFor(() => session.abortCalls === 1, "超时触发中止");
  const r1 = await p1;
  assert.match(r1.result!.replyText, /预算上限.*duration/);
});

test("T6：累计预算不足 → 拒绝开始本轮（无 prompt，消息标记 failed）", async () => {
  const env = makeEnv(() => new ScriptedHostedSession("conv-u1"));
  env.cumulative.settle("u1", 1_000_000); // 用尽
  const host = new AgentHost(env.deps() as never);
  await assert.rejects(
    () => host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "hi" }),
    /累计 Token 预算已用尽/,
  );
  assert.equal(host.inbox.get("wechat", "m1")?.state, "failed");
  assert.equal(env.registry.openCalls.length, 0, "未打开会话（开始前检查）");
});

test("T6：累计余量容差（1.2x）实时中止；usage 实际入账", async () => {
  const env = makeEnv(() => new GatedHostedSession("conv-u1"));
  // 第一轮：正常完成并入账 90（usage 10+5=15 ×6 轮? 直接 Scripted 不合适——用 Gated 手动放行）
  const host = new AgentHost(env.deps() as never);
  const p1 = host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "第一轮" });
  await waitFor(() => (env.registry.sessions.get("u1") as GatedHostedSession | undefined)?.prompts.length === 1);
  const session = env.registry.sessions.get("u1") as GatedHostedSession;
  session.release(); // 正常完成：usage 10+5=15 入账
  await p1;
  assert.equal(env.cumulative.remaining("u1"), 1_000_000 - 15, "结束后按实际 usage 入账");

  // 第二轮：余量远小（构造），实时用量超容差 → 中止
  const scarce = new InMemoryCumulativeBudget(20); // 余量 20，容差 24
  const host2 = new AgentHost(env.deps({ cumulative: scarce }) as never);
  const p2 = host2.handleMessage({ channel: "wechat", messageId: "m2", userId: "u2", text: "第二轮" });
  await waitFor(() => (env.registry.sessions.get("u2") as GatedHostedSession | undefined)?.prompts.length === 1);
  const session2 = env.registry.sessions.get("u2") as GatedHostedSession;
  session2.usageNow = { inputTokens: 20, outputTokens: 10 }; // 已用 30 > 24
  session2.emit({ type: "llm_request" });
  await waitFor(() => session2.abortCalls === 1, "容差超限触发中止");
  const r2 = await p2;
  assert.match(r2.result!.replyText, /cumulative/, "说明累计预算触发");
});

test("T6：不限累计（缺省）时容差检查永不触发", async () => {
  const env = makeEnv(() => new GatedHostedSession("conv-u1"));
  const host = new AgentHost({ ...env.deps(), cumulative: undefined } as never);
  const p1 = host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "x" });
  await waitFor(() => (env.registry.sessions.get("u1") as GatedHostedSession | undefined)?.prompts.length === 1);
  const session = env.registry.sessions.get("u1") as GatedHostedSession;
  session.usageNow = { inputTokens: 10_000_000, outputTokens: 10_000_000 };
  session.emit({ type: "llm_request" });
  assert.equal(session.abortCalls, 0, "不限累计不中止");
  session.release();
  const r1 = await p1;
  assert.equal(r1.result!.replyText, "ok");
});
