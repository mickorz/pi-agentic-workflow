/**
 * AM-9 kill -9 注入入口（配合 kill-window-suite.sh）
 *
 * 模式：
 *  prime-linked   —— 预写 attempt + 落 TaskBinding（等价 service.start 已成功），随后睡眠在
 *                     「启动后、回填前」窗口（父脚本 kill -9 制造真实崩溃）
 *  prime-unknown  —— 仅预写 attempt（等价 start 前被杀）
 *  recover        —— “重启”：重开 store 跑 recoverStale，输出 JSON 结果（零启动由结构保证）
 *  service-starts —— 输出计数文件内容（断言恢复期未发生新启动）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { TaskStore } from "../../src/dispatch/task-store.js";
import { RunLaunchStore, RunLinkStore } from "../../src/agent-host/run-launch.js";
import { LaunchCoordinator } from "../../src/agent-host/launch-flow.js";

const mode = process.argv[2];
const dataDir = process.argv[3];
if (!mode || !dataDir) {
  process.stderr.write("usage: crash-window.ts <prime-linked|prime-unknown|recover|service-starts> <dataDir>\n");
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });

const REG = {
  workflowId: "github-review", scriptPath: "github-review.js", name: "GitHub 仓库分析",
  description: "分析", argsSchema: { type: "object", properties: {}, required: [] },
  riskLevel: "read-only", enabled: true, keywords: [],
};
const registry = new WorkflowRegistry([REG]);
const startsFile = path.join(dataDir, "starts.count");

function makeDispatcher(): { dispatcher: Dispatcher; countStarts: () => number } {
  let n = Number(fs.existsSync(startsFile) ? fs.readFileSync(startsFile, "utf8").trim() : 0);
  const dispatcher = new Dispatcher({
    registry,
    router: { route: async () => { throw new Error("不应触发路由"); } } as never,
    tasks: new TaskStore(dataDir),
    service: {
      start: async () => {
        n += 1;
        fs.writeFileSync(startsFile, String(n));
        return { runId: `run-${n}` };
      },
    },
    scriptsRoot: dataDir,
  });
  return { dispatcher, countStarts: () => n };
}

if (mode === "prime-linked") {
  const attempts = new RunLaunchStore(dataDir);
  attempts.prewrite({ userId: "u1", workflowId: "github-review", argsDigest: "d", agentTurnId: "t1", originMessageId: "m1" });
  // 等价：dispatcher.execute 内 service.start 成功并写 TaskBinding（link 前的真实窗口）
  const { dispatcher } = makeDispatcher();
  await dispatcher.execute(
    { intent: "execute_workflow", action: "start_execution", workflowId: "github-review", args: {}, reason: "am9", confidence: 1 },
    { actor: "u1", authorized: true, entrypoint: "wechat" },
    { channel: "wechat", userId: "u1", messageId: "m1" },
  );
  process.stdout.write("READY\n"); // 父脚本见此行即 kill -9（link 永不执行）
  await new Promise((r) => setTimeout(r, 30_000));
  process.exit(0);
}

if (mode === "prime-unknown") {
  const attempts = new RunLaunchStore(dataDir);
  attempts.prewrite({ userId: "u1", workflowId: "github-review", argsDigest: "d", originMessageId: "m1" });
  process.stdout.write("READY\n");
  await new Promise((r) => setTimeout(r, 30_000));
  process.exit(0);
}

if (mode === "recover") {
  const { dispatcher, countStarts } = makeDispatcher();
  const coordinator = new LaunchCoordinator({
    attempts: new RunLaunchStore(dataDir),
    runLinks: new RunLinkStore(dataDir),
    dispatcher,
    tasks: new TaskStore(dataDir),
  });
  const before = countStarts();
  const out = coordinator.recoverStale();
  process.stdout.write(
    `${JSON.stringify({ linked: out.linked.length, unknown: out.unknown.length, startsBeforeRecover: before, startsAfter: countStarts() })}\n`,
  );
  process.exit(0);
}

if (mode === "service-starts") {
  process.stdout.write(`${fs.existsSync(startsFile) ? fs.readFileSync(startsFile, "utf8").trim() : 0}\n`);
  process.exit(0);
}

process.stderr.write(`unknown mode: ${mode}\n`);
process.exit(2);
void os;
