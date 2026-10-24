/**
 * P2/T2.4 微信链路本地仿真（A12 的无微信预演；真机项见 P2 报告手动清单）
 *
 * 覆盖：
 *  1. 真实 registry.json（am-p0 + wx-article）经 facade.searchWorkflows 可见新条目
 *  2. executeWorkflow(external-side-effect) → needsApproval，未启动（LLM 无自授权通路）
 *  3. pendingFlow.confirm（用户批准通道）→ dispatcher 以 authorized 启动真实脚本
 *     （article_image_generate.js + fake provider，真实 engine 执行）
 *  4. 结果回读 task binding completed + ok=true + 9 图
 *
 * 运行：PI_WORKFLOW_INTEGRATION=1 npm run test:integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { TaskStore } from "../../src/dispatch/task-store.js";
import { TaskControlFacade } from "../../src/agent-host/task-control-facade.js";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { RunLaunchStore, RunLinkStore } from "../../src/agent-host/run-launch.js";
import { LaunchCoordinator } from "../../src/agent-host/launch-flow.js";
import { PendingActionService } from "../../src/agent-host/pending-flow.js";
import type { WorkflowRegistration } from "../../src/contracts/wx.js";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";

const explicit = process.env.PI_WORKFLOW_INTEGRATION === "1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadRegistryJson(rel: string): WorkflowRegistration[] {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")) as WorkflowRegistration[];
}

/** 真实执行 service：start() 内联跑 engine（同步等待完成，记录结果供 get()） */
function makeRealService(runs: Map<string, { status: string; result: unknown }>) {
  return {
    async start(input: { scriptPath: string; args?: unknown }) {
      const runId = `run-${runs.size + 1}`;
      const script = fs.readFileSync(input.scriptPath, "utf8");
      void (async () => {
        try {
          const outcome = await runWorkflow(script, {
            args: (input.args ?? {}) as Record<string, unknown>,
            runId,
            cwd: REPO_ROOT,
          });
          // runWorkflow 失败（含 check 失败/WorkflowError）会 throw；resolve 即 completed
          runs.set(runId, { status: "completed", result: outcome.result });
        } catch (e) {
          runs.set(runId, { status: "failed", result: { error: String(e) } });
        }
      })();
      return { runId };
    },
    async get(runId: string) {
      const r = runs.get(runId);
      const status = r?.status ?? "running";
      return {
        snapshot: { status, effectiveStatus: status, result: r?.result },
        checkpoints: [],
      };
    },
    async cancel() {},
    async resume() {
      return {};
    },
  } as never;
}

async function waitFor(cond: () => boolean, ms = 60_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test(
  "微信链路本地仿真：search 可见 → 需授权 → 批准后真实执行 → 结果回读",
  { skip: !explicit ? "set PI_WORKFLOW_INTEGRATION=1 to run" : false },
  async () => {
    // ── 前置：真实 registry 文件 + 临时文章目录 ──
    // 两份 registry 的 scriptPath 惯例不同（am-p0 相对 dev-examples/，wx-article 相对自身根 scripts/），
    // 测试里统一重写为仓库根相对路径（生产由网关配置各自的 scriptsRoot）。
    const execEntries: WorkflowRegistration[] = [
      ...loadRegistryJson("dev-examples/am-p0/registry.json").map((e) => ({ ...e, scriptPath: `dev-examples/${e.scriptPath}` })),
      ...loadRegistryJson("dev-examples/wx-article/registry.json").map((e) => ({ ...e, scriptPath: `dev-examples/wx-article/${e.scriptPath}` })),
    ];
    const registry = new WorkflowRegistry(execEntries);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ig-wx-e2e-"));
    const articleDir = path.join(base, "article");
    fs.mkdirSync(articleDir);
    fs.copyFileSync(path.join(REPO_ROOT, "dev-examples/image-gen-p0/fixtures/image-prompts.sample.json"), path.join(articleDir, "image-prompts.json"));
    process.env.IMAGE_GEN_INTER_DELAY_MS = "0";
    const runs = new Map<string, { status: string; result: unknown }>();
    try {
      // ── 1. workflow_search 可见（关键词命中） ──
      const dataDir = path.join(base, "data");
      const tasks = new TaskStore(dataDir);
      const pending = new PendingActionStore(path.join(dataDir, "pending"));
      const runLinks = new RunLinkStore(path.join(dataDir, "run-links"));
      const service = makeRealService(runs);
      const dispatcher = new Dispatcher({
        registry,
        router: { route: async () => ({ intent: "execute_workflow", action: "start_execution", workflowId: "article-image-generate", args: {}, reason: "test", confidence: 1 }) } as never,
        service,
        tasks,
        scriptsRoot: REPO_ROOT,
      });
      const launcher = new LaunchCoordinator({ dispatcher, attempts: new RunLaunchStore(path.join(dataDir, "attempts")), tasks, runLinks });
      const facade = new TaskControlFacade({ registry, dispatcher, launcher, tasks, service, pending, runLinks, channel: "wechat" });
      const foundGen = await facade.searchWorkflows("生成插图");
      assert.ok(foundGen.some((w) => w.id === "article-image-generate"), "search「生成插图」应命中 article-image-generate");
      const foundCvt = await facade.searchWorkflows("提示词转换");
      assert.ok(foundCvt.some((w) => w.id === "article-image-prompts-convert"), "search「提示词转换」应命中 converter");

      // ── 2. executeWorkflow：external-side-effect → needsApproval，绝不直接启动 ──
      const pre = await facade.executeWorkflow({
        userId: "wx-user-1",
        workflowId: "article-image-generate",
        args: { article_dir: articleDir, provider: "fake", skip_confirm: true },
        agentTurnId: "turn-1",
        originMessageId: "msg-1",
      });
      assert.equal((pre as { needsApproval?: boolean }).needsApproval, true, "高风险流程必须先授权");
      const actionId = (pre as { actionId?: string }).actionId ?? "";
      assert.ok(actionId, "返回 actionId");
      assert.equal(runs.size, 0, "授权前零启动（LLM 无自授权通路）");

      // ── 3. 用户批准（确定性通道）→ authorized=true 启动真实脚本 ──
      const pendingFlow = new PendingActionService({ pending, registry, launcher, channel: "wechat" });
      const confirmed = await pendingFlow.confirm(actionId, "wx-user-1");
      assert.equal(confirmed.ok, true, `批准并启动: ${JSON.stringify(confirmed)}`);
      const runId = (confirmed as { runId?: string }).runId ?? "";
      assert.ok(runId, "返回 runId");

      // ── 4. 真实执行完成 + 结果回读 ──
      await waitFor(() => runs.get(runId)?.status !== undefined && runs.get(runId)!.status !== "running", 120_000, "workflow 完成");
      const run = runs.get(runId)!;
      assert.equal(run.status, "completed", `执行结果: ${JSON.stringify(run.result).slice(0, 400)}`);
      const result = run.result as { ok?: boolean; succeeded?: number; total?: number; generated_paths?: string[] };
      assert.equal(result.ok, true);
      assert.equal(result.succeeded, 9);
      assert.equal(result.total, 9);
      const imgs = fs.readdirSync(path.join(articleDir, "imgs"));
      assert.equal(imgs.length, 8, "8 张正文图");
      assert.ok(fs.existsSync(path.join(articleDir, "cover.png")), "封面存在");
    } finally {
      delete process.env.IMAGE_GEN_INTER_DELAY_MS;
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);
