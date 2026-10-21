/**
 * 集成测试（AM-P0 T9 自动化部分）：真实 LLM Conversational Agent + 五工具
 *
 * 验证（真机 AM-1/AM-2 的无微信预演）：
 *  - 真实模型只看到五工具（tools 白名单），能按含糊中文请求自主 search → execute
 *  - execute 只返受理回执（runId/taskBindingId）；TaskBinding/attempt/run-links 三阶段真实落盘
 *  - 同会话后续消息用 task_status 查真实结果（不靠模型记忆编造）
 *
 * 运行条件：本机配置了至少一个可用模型凭证；无凭证时全部 skip。
 * 运行：PI_WORKFLOW_INTEGRATION=1 npm run test:integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { TaskStore } from "../../src/dispatch/task-store.js";
import type { WorkflowRegistration } from "../../src/contracts/wx.js";
import { PiSessionOpener } from "../../src/agent-host/pi-session.js";
import { createAgentTools } from "../../src/agent-host/agent-tools.js";
import { TaskControlFacade } from "../../src/agent-host/task-control-facade.js";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { RunLaunchStore, RunLinkStore } from "../../src/agent-host/run-launch.js";
import { LaunchCoordinator } from "../../src/agent-host/launch-flow.js";

const explicit = process.env.PI_WORKFLOW_INTEGRATION === "1";

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

async function findModelSpec(): Promise<string | undefined> {
  try {
    const runtime = await ModelRuntime.create();
    const available = await runtime.getAvailable();
    return available[0] ? `${available[0].provider}/${available[0].id}` : undefined;
  } catch {
    return undefined;
  }
}

test("前置：检查可用模型凭证", { skip: !explicit ? "set PI_WORKFLOW_INTEGRATION=1 to run" : false }, async (t) => {
  const spec = await findModelSpec();
  if (!spec) return t.skip("无可用模型凭证，跳过真实 LLM Agent 测试");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "am-t9-"));
  const dataDir = path.join(base, "data");
  const registry = new WorkflowRegistry([GITHUB_REVIEW]);
  const tasks = new TaskStore(dataDir);
  const started: Array<{ scriptPath: string; args?: unknown }> = [];
  const service = {
    async start(input: { scriptPath: string; args?: unknown }) {
      started.push({ scriptPath: input.scriptPath, args: input.args });
      return { runId: `run-real-1` };
    },
    async get(runId: string) {
      return {
        snapshot: { status: "completed", effectiveStatus: "completed", result: { report: "3 个问题" } },
        checkpoints: [],
      };
    },
    async cancel() {},
    async resume() {
      return {};
    },
  } as never;
  const dispatcher = new Dispatcher({
    registry,
    router: { route: async () => { throw new Error("IntentRouter 不应被触发"); } } as never,
    tasks,
    service,
    scriptsRoot: base,
  });
  const runLinks = new RunLinkStore(dataDir);
  const launcher = new LaunchCoordinator({
    attempts: new RunLaunchStore(dataDir),
    runLinks,
    dispatcher,
    tasks,
  });
  const facade = new TaskControlFacade({
    registry,
    launcher,
    tasks,
    service,
    pending: new PendingActionStore(dataDir),
    runLinks,
  });
  // 终态回写（模拟 RunMonitor 轮询发现 completed）
  runLinks.upsert({ runId: "run-real-1", status: "completed", resultSummary: "分析完成：3 个问题", resultRef: "out/report.md" });

  const opener = new PiSessionOpener({
    cwd: base,
    sessionDir: path.join(base, "sessions"),
    model: spec,
    toolsFactory: (ctxRef) => createAgentTools({ facade, ctxRef }),
  });

  await t.test("AM-1 预演：含糊中文 → search/execute → 受理回执 + 三阶段落盘", async () => {
    const session = await opener.open("u-real");
    session.setTurnContext?.({ userId: "u-real", agentTurnId: "turn-1", originMessageId: "m-1" });
    const out = await session.prompt("帮我看看这个仓库写得怎么样 https://github.com/example/repo");
    assert.ok(out.replyText.trim().length > 0, "有实质回复");
    assert.equal(started.length, 1, "真实 LLM 经 workflow_execute 启动了 run");
    assert.deepEqual(started[0]!.args, { repoUrl: "https://github.com/example/repo" }, "参数抽取正确");
    assert.equal(tasks.list().length, 1, "TaskBinding 落盘");
    assert.equal(runLinks.get("run-real-1")?.taskBindingId, tasks.list()[0]!.taskBindingId, "run-links 关联");
    session.dispose?.();
  });

  await t.test("AM-2 预演：同会话后续消息查进度 → task_status 真实结果（不编造）", async () => {
    const session = await opener.open("u-real"); // 同会话文件重开（持久会话）
    session.setTurnContext?.({ userId: "u-real", agentTurnId: "turn-2", originMessageId: "m-2" });
    const out = await session.prompt("刚才那个任务结果怎么样？");
    assert.ok(/run-real-1|3 个问题|分析完成/.test(out.replyText), `回复引用真实结果：${out.replyText.slice(0, 120)}`);
    session.dispose?.();
  });
});
