/**
 * AM-P0 T5 单测：启动关联三阶段（§2.3）+ 方案 B 恢复 + run-links 终态回写（§5）
 * 验收锚点（执行计划 §7 T5）：崩溃注入——启动后回填前 kill → 恢复标记 unknown+人工核对，
 * 不重复启动；能对上 TaskBinding 的自动补链。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { TaskStore } from "../../src/dispatch/task-store.js";
import { RunMonitor } from "../../src/dispatch/run-monitor.js";
import { Outbox } from "../../src/notify/outbox.js";
import type { WorkflowRegistration, TaskBinding } from "../../src/contracts/wx.js";
import { RunLaunchStore, RunLinkStore } from "../../src/agent-host/run-launch.js";
import { LaunchCoordinator } from "../../src/agent-host/launch-flow.js";

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

interface Fixture {
  root: string;
  dataDir: string;
  registry: WorkflowRegistry;
  tasks: TaskStore;
  attempts: RunLaunchStore;
  runLinks: RunLinkStore;
  launcher: LaunchCoordinator;
  started: Array<unknown>;
  setFailStart(v: boolean): void;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-t5-"));
  const dataDir = path.join(root, "data");
  const registry = new WorkflowRegistry([GITHUB_REVIEW]);
  const tasks = new TaskStore(dataDir);
  const started: Array<unknown> = [];
  let failStart = false;
  const dispatcher = new Dispatcher({
    registry,
    router: { route: async () => { throw new Error("不应触发 IntentRouter"); } } as never,
    tasks,
    service: {
      start: async (input: unknown) => {
        started.push(input);
        if (failStart) throw Object.assign(new Error("已达并发上限"), { code: "RUN_LIMIT_REACHED" });
        return { runId: "run-1" };
      },
    },
    scriptsRoot: root,
  });
  const attempts = new RunLaunchStore(dataDir);
  const runLinks = new RunLinkStore(dataDir);
  const launcher = new LaunchCoordinator({ attempts, runLinks, dispatcher, tasks });
  return {
    root, dataDir, registry, tasks, attempts, runLinks, launcher, started,
    setFailStart: (v: boolean) => { failStart = v; },
  };
}

const PLAN = {
  intent: "execute_workflow" as const,
  action: "start_execution" as const,
  workflowId: "github-review",
  args: { repoUrl: "https://github.com/a/b" },
  reason: "t5",
  confidence: 1,
};

const ORIGIN = { channel: "wechat", userId: "u1", messageId: "m-1" };

test("T5 happy：预写 attempt → 启动 → linked 回填 + run-links 关联行", async () => {
  const f = makeFixture();
  const r = await f.launcher.execute(
    PLAN,
    { actor: "u1", authorized: true, entrypoint: "wechat" },
    ORIGIN,
    { agentTurnId: "turn-1" },
  );
  assert.equal(r.runId, "run-1");
  assert.equal(f.attempts.staleLaunched().length, 0, "无遗留 launched（已 linked）");
  const linked = f.runLinks.get("run-1")!;
  assert.equal(linked.status, "running");
  assert.equal(linked.attemptId?.startsWith("la-"), true);
  assert.equal(linked.agentTurnId, "turn-1", "run 与发起 Turn 关联（后续 task_status 不靠记忆）");
  const attempt = f.attempts.get(linked.attemptId!)!;
  assert.equal(attempt.status, "linked");
  assert.equal(attempt.runId, "run-1", "attempt 回填真实 runId");
  assert.equal(attempt.originMessageId, "m-1");
  assert.equal(f.attempts.unknownAttempts().length, 0);
});

test("T5 同步失败：attempt discarded（不进 unknown），无 run-links", async () => {
  const f = makeFixture();
  f.setFailStart(true);
  await assert.rejects(() =>
    f.launcher.execute(PLAN, { actor: "u1", authorized: true, entrypoint: "wechat" }, ORIGIN),
    /并发上限/,
  );
  assert.equal(f.attempts.staleLaunched().length, 0, "无 launched 遗留");
  const all = [...f.attempts.unknownAttempts()];
  assert.equal(all.length, 0, "确定性失败不进 unknown");
  // discarded 记录保留（审计）——用文件内容断言
  const lines = fs.readFileSync(path.join(f.dataDir, "run-attempts.jsonl"), "utf8").trim().split("\n");
  assert.ok(lines.some((l) => (JSON.parse(l) as { status: string }).status === "discarded"));
  assert.equal(f.runLinks.get("run-1"), undefined);
});

test("T5 崩溃注入（启动后回填前 kill，但 TaskBinding 已落盘）→ 恢复自动补链不重启动", async () => {
  const f = makeFixture();
  // 构造崩溃窗口：prewrite 完成、dispatcher.execute 内 service.start 成功并写了 TaskBinding，
  // 但 coordinator.link 前进程中断——直接手工模拟该状态（不经过 coordinator.execute 的后半段）
  const attempt = f.attempts.prewrite({
    userId: "u1", workflowId: "github-review", argsDigest: "d", agentTurnId: "turn-9",
    originMessageId: "m-1",
  });
  const now = new Date().toISOString();
  f.tasks.append({
    taskBindingId: "tb-crash", runId: "run-crash", channel: "wechat", userId: "u1",
    workflowId: "github-review", status: "running", createdAt: now, updatedAt: now, messageId: "m-1",
  });
  assert.equal(f.started.length, 0, "构造：绑定已存在（真实进程里 start 已发生）");

  // “重启”：新实例同目录
  const unknown: string[] = [];
  const c2 = new LaunchCoordinator({
    attempts: new RunLaunchStore(f.dataDir),
    runLinks: new RunLinkStore(f.dataDir),
    dispatcher: {
      execute: async () => {
        throw new Error("恢复流程禁止启动");
      },
    } as never,
    tasks: new TaskStore(f.dataDir),
    onUnknown: (a) => unknown.push(a.attemptId),
  });
  const out = c2.recoverStale();
  assert.equal(out.linked.length, 1, "对上绑定 → 自动补链");
  assert.equal(out.unknown.length, 0);
  assert.deepEqual(unknown, []);
  assert.equal(out.linked[0]!.runId, "run-crash");
  assert.equal(out.linked[0]!.status, "linked");
  const link = new RunLinkStore(f.dataDir).get("run-crash")!;
  assert.equal(link.agentTurnId, "turn-9", "run-links 补挂保留 Turn 关联");
  assert.equal(link.attemptId, attempt.attemptId);
});

test("T5 崩溃注入（启动前 kill，无 TaskBinding）→ unknown + 告警，不盲目重启动", async () => {
  const f = makeFixture();
  f.attempts.prewrite({
    userId: "u1", workflowId: "github-review", argsDigest: "d", originMessageId: "m-x",
  });
  const unknown: string[] = [];
  const c2 = new LaunchCoordinator({
    attempts: new RunLaunchStore(f.dataDir),
    runLinks: new RunLinkStore(f.dataDir),
    dispatcher: {
      execute: async () => {
        throw new Error("恢复流程禁止启动");
      },
    } as never,
    tasks: new TaskStore(f.dataDir),
    onUnknown: (a) => unknown.push(a.attemptId),
  });
  const out = c2.recoverStale();
  assert.equal(out.linked.length, 0);
  assert.equal(out.unknown.length, 1, "对不上绑定 → unknown");
  assert.equal(out.unknown[0]!.status, "unknown");
  assert.equal(unknown.length, 1, "人工核对告警回调");
  assert.equal(f.started.length, 0, "零启动：不盲目重试");
  // 幂等：再次恢复不再重复处理
  const again = c2.recoverStale();
  assert.equal(again.unknown.length + again.linked.length, 0);
});

test("T5 §5：RunMonitor 终态回写 run-links（合并保留 attemptId/agentTurnId）", async () => {
  const f = makeFixture();
  await f.launcher.execute(
    PLAN,
    { actor: "u1", authorized: true, entrypoint: "wechat" },
    ORIGIN,
    { agentTurnId: "turn-1" },
  );
  assert.equal(f.runLinks.get("run-1")?.status, "running");

  // RunMonitor 观察到 completed → 回写终态 + 摘要
  const outbox = new Outbox(path.join(f.dataDir, "outbox"));
  const monitor = new RunMonitor({
    tasks: f.tasks,
    service: {
      get: async () => ({
        snapshot: { status: "completed", effectiveStatus: "completed", result: { report: "done" } },
        checkpoints: [],
      }),
    } as never,
    outbox,
    runLinks: f.runLinks,
  });
  await monitor.pollOnce();
  const link = f.runLinks.get("run-1")!;
  assert.equal(link.status, "completed");
  assert.ok(link.resultSummary?.includes("done"));
  assert.equal(link.agentTurnId, "turn-1", "终态回写不抹掉 Turn 关联");
  assert.ok(link.attemptId, "终态回写不抹掉 attempt 关联");
  assert.equal(f.tasks.list()[0]!.status, "completed");
});

test("T5 契约：TaskBinding 不变（runId 必填真实，不接收假 runId）", async () => {
  const f = makeFixture();
  await f.launcher.execute(PLAN, { actor: "u1", authorized: true, entrypoint: "wechat" }, ORIGIN);
  const binding = f.tasks.list()[0] as TaskBinding;
  assert.equal(binding.runId, "run-1", "绑定使用真实 runId");
  assert.ok(binding.taskBindingId.startsWith("tb-"));
});
