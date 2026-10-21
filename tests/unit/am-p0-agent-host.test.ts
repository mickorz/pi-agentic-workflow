/**
 * AM-P0 T2 单测：AgentHost —— per-user 持久会话 + 同用户消息排队（单活动 Turn）+ 重启恢复
 * 验收锚点（执行计划 §7 T2）：
 *  1) 同用户两条消息排队串行且顺序正确
 *  2) 重启后 Session 恢复（conversationId 跨进程稳定；journal 未完成消息按 §4 恢复）
 * 契约：不使用 followUp()；不同用户可并行；received≠processed（§4）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../../src/agent-host/agent-host.js";
import type { AgentHostDeps, TurnResult } from "../../src/agent-host/types.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionOpener, sessionFileName } from "../../src/agent-host/pi-session.js";
import {
  FakeAgentToolFacade,
  FileBackedSessionRegistry,
  GatedHostedSession,
  ScriptedHostedSession,
} from "../../src/agent-host/fakes.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "am-t2-"));
}

interface Env {
  root: string;
  sessionDir: string;
  dataDir: string;
  registry: FileBackedSessionRegistry;
  completed: TurnResult[];
  deps(): AgentHostDeps;
}

function makeEnv(make?: (conversationId: string) => ScriptedHostedSession | GatedHostedSession): Env {
  const root = tmpDir();
  const sessionDir = path.join(root, "sessions");
  const dataDir = path.join(root, "data");
  const completed: TurnResult[] = [];
  const registry = new FileBackedSessionRegistry(sessionDir, make ?? ((id) => new ScriptedHostedSession(id)));
  return {
    root,
    sessionDir,
    dataDir,
    registry,
    completed,
    deps: () => ({
      cwd: root,
      sessionDir,
      dataDir,
      customTools: [],
      facade: new FakeAgentToolFacade(),
      openSession: registry.opener,
      onTurnCompleted: (r) => completed.push(r),
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

test("T2：同用户两条消息排队串行且顺序正确（验收锚点 1）", async () => {
  const env = makeEnv(() => new GatedHostedSession("conv-u1"));
  const host = new AgentHost(env.deps());

  const p1 = host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "第一条" });
  await waitFor(() => env.registry.sessions.has("u1"));
  const session = env.registry.sessions.get("u1") as GatedHostedSession;
  await waitFor(() => session.prompts.length === 1); // m1 进入 prompt（processing）

  const q2 = await host.handleMessage({ channel: "wechat", messageId: "m2", userId: "u1", text: "第二条" });
  assert.equal(q2.status, "queued", "前一 Turn 进行中 → 持久化排队");

  session.release(); // m1 完成 → 回执返回 + 后台 drain 处理 m2
  const r1 = await p1;
  assert.equal(r1.status, "processed");
  assert.equal(r1.result && r1.result.replyText, "ok");

  await waitFor(() => session.prompts.length === 2); // m2 在 m1 之后才开始（串行）
  assert.equal(session.prompts[0], "第一条");
  assert.equal(session.prompts[1], "第二条");
  session.release();
  await waitFor(() => host.inbox.get("wechat", "m2")?.state === "completed");

  assert.deepEqual(
    [host.inbox.get("wechat", "m1")?.state, host.inbox.get("wechat", "m2")?.state],
    ["completed", "completed"],
  );
  assert.equal(env.completed.length, 2, "两条消息各产生一次 onTurnCompleted（排队消息异步回执）");
  assert.equal(env.registry.openCalls.filter((u) => u === "u1").length, 1, "同一用户复用同一会话");
});

test("T2：不同用户可并行（互不阻塞）", async () => {
  const env = makeEnv();
  const host = new AgentHost(env.deps());
  const r1 = await host.handleMessage({ channel: "wechat", messageId: "a1", userId: "u1", text: "u1 的问题" });
  const r2 = await host.handleMessage({ channel: "wechat", messageId: "b1", userId: "u2", text: "u2 的问题" });
  assert.equal(r1.status, "processed");
  assert.equal(r2.status, "processed", "u1 完成不构成 u2 的前置条件（并行）");
  assert.notEqual(
    r1.result!.conversationId,
    r2.result!.conversationId,
    "不同用户各自独立会话",
  );
});

test("T2：同 messageId 重复消息去重（单次执行）", async () => {
  const env = makeEnv();
  const host = new AgentHost(env.deps());
  const first = await host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "帮我分析" });
  const dup = await host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "帮我分析" });
  assert.equal(first.status, "processed");
  assert.equal(dup.status, "duplicate");
  assert.equal(dup.state, "completed", "返回已有处理状态");
  const session = env.registry.sessions.get("u1") as ScriptedHostedSession;
  assert.equal(session.prompts.length, 1, "只执行一次");
});

test("T2：prompt 失败标记 failed；排队消息不断队列", async () => {
  const env = makeEnv(() => new GatedHostedSession("conv-u1", ["ok"], [new Error("模型故障")]));
  const host = new AgentHost(env.deps());
  const session = (await env.registry.opener("u1")) as GatedHostedSession;

  const p1 = host.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "会失败" });
  await waitFor(() => session.prompts.length === 1);
  await host.handleMessage({ channel: "wechat", messageId: "m2", userId: "u1", text: "接棒" }); // queued

  session.release(); // m1 抛错
  await assert.rejects(() => p1, /模型故障/, "本轮失败向调用方抛错");
  assert.equal(host.inbox.get("wechat", "m1")?.state, "failed");

  await waitFor(() => session.prompts.length === 2); // drain 继续：m2 正常处理
  session.release();
  await waitFor(() => host.inbox.get("wechat", "m2")?.state === "completed");
});

test("T2：重启恢复——received 重新入队处理；processing 禁止重调 Agent（验收锚点 2 / §4）", async () => {
  const env = makeEnv(() => new GatedHostedSession("conv-u1"));
  const host1 = new AgentHost(env.deps());
  const session1 = (await env.registry.opener("u1")) as GatedHostedSession;

  // m1 进行中（processing）时 m2 到达（received）；随后“进程崩溃”（不 release、直接弃置）
  const p1 = host1.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "崩溃窗口" });
  await waitFor(() => session1.prompts.length === 1);
  await host1.handleMessage({ channel: "wechat", messageId: "m2", userId: "u1", text: "恢复后处理" });
  void p1.catch(() => {}); // 挂起的 promise 不产生 unhandledRejection

  const uncertain: string[] = [];
  env.registry.reset(); // 模拟进程重启：新会话对象重开同一会话文件
  const host2 = new AgentHost({
    ...env.deps(),
    onUncertainRecovery: (e) => uncertain.push(e.messageId),
  });
  const report = await host2.recover();
  assert.equal(report.requeued, 1, "m2（received）重新入队");
  assert.deepEqual(report.uncertain.map((e) => e.messageId), ["m1"], "m1（processing）进不确定队列");
  assert.deepEqual(uncertain, ["m1"], "不确定恢复逐条告警回调");

  await waitFor(
    () =>
      env.registry.sessions.has("u1") &&
      (env.registry.sessions.get("u1") as GatedHostedSession).prompts.length >= 1,
  );
  const session2 = env.registry.sessions.get("u1") as GatedHostedSession;
  assert.deepEqual(session2.prompts, ["恢复后处理"], "只重放 received，不重调 processing");
  session2.release();
  await waitFor(() => host2.inbox.get("wechat", "m2")?.state === "completed");
  assert.equal(host2.inbox.get("wechat", "m1")?.state, "processing", "不确定消息保持 processing 待人工核对");
});

test("T2：重启后 Session 恢复——conversationId 跨进程稳定（验收锚点 2）", async () => {
  const env = makeEnv();
  const host1 = new AgentHost(env.deps());
  const r1 = await host1.handleMessage({ channel: "wechat", messageId: "m1", userId: "u1", text: "第一轮" });

  // “重启”：新 AgentHost 实例 + 新会话对象，重开同目录（conversationId 从会话文件恢复）
  env.registry.reset();
  const host2 = new AgentHost(env.deps());
  const r2 = await host2.handleMessage({ channel: "wechat", messageId: "m2", userId: "u1", text: "第二轮" });
  assert.equal(r1.result!.conversationId, r2.result!.conversationId, "同用户会话跨重启复用");
  assert.equal(env.registry.openCalls.filter((u) => u === "u1").length, 2, "两个 Host 各惰性打开一次");
});

test("T2：真实 SDK 会话文件持久化（PiSessionOpener 文件命名 + 重开回放）", () => {
  const root = tmpDir();
  const sessionDir = path.join(root, "sessions");
  const opener = new PiSessionOpener({ cwd: root, sessionDir, customTools: [] });

  // 路径注入安全：userId 含路径分隔符也不逃出 sessionDir
  const evil = "../../etc/passwd";
  const file = opener.sessionFile(evil);
  assert.ok(path.dirname(file).startsWith(sessionDir), "文件名不逃出会话目录");
  assert.ok(!sessionFileName(evil).includes("/"), "文件名不含路径分隔符");

  // 持久化：append 后落盘 → 重开同文件回放历史（真实 SessionManager，无 LLM）
  fs.mkdirSync(sessionDir, { recursive: true });
  const m1 = SessionManager.open(file, sessionDir, root);
  m1.appendMessage({ role: "user", content: [{ type: "text", text: "跨重启的上下文" }] });
  assert.ok(fs.existsSync(file), "首条消息后文件落盘");

  const m2 = SessionManager.open(opener.sessionFile(evil), sessionDir, root);
  assert.equal(m2.getSessionId(), m1.getSessionId(), "重开 sessionId 稳定");
  assert.equal(m2.getEntryCount(), 1, "历史条目可回放");
  assert.ok(JSON.stringify(m2.buildSessionContext()).includes("跨重启的上下文"));
});
