/**
 * P1.5 两阶段生图微信链路本地仿真（无微信预演；真机项见 P2 报告手动清单）
 *
 * 覆盖：
 *  1. 真实 registry.json（am-p0 + wx-article）经 facade.searchWorkflows 可见新条目
 *  2. preview 链路：executeWorkflow → needsApproval（LLM 无自授权通路）→ 批准后真实执行，
 *     含两个 checkpoint（付费执行授权 + 风格确认，均经 confirm 人工通道）→ 风格锁定
 *  3. batch 链路：风格审批已通过 → 剩余 8 张批量生成（补齐 9 图）
 *  4. 未审批 batch：风格审批门拒绝（验收 3），run 失败且零生成
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

/** 真实执行 service：start() 内联跑 engine（同步等待完成，记录结果供 get()）
 *  confirm：checkpoint 人工确认通道（模拟微信用户批准；计数供断言） */
let confirmCalls = 0;
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
            confirm: async () => {
              confirmCalls++;
              return true;
            },
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
  "微信链路本地仿真：preview 双审批 → 风格锁定 → batch 补齐 → 未审批拦截",
  { skip: !explicit ? "set PI_WORKFLOW_INTEGRATION=1 to run" : false },
  async () => {
    // ── 前置：真实 registry 文件 + 临时文章目录 ──
    // 两份 registry 的 scriptPath 惯例不同（am-p0 相对 dev-examples/，wx-article 相对自身根 scripts/），
    // 测试里统一重写为仓库根相对路径（生产由网关配置各自的 scriptsRoot）。
    // enabled=true 覆盖：article-image-generate 在 wx-article registry 中 enabled=false
    // （921f930 工具面收敛所致）；本 e2e 验证两阶段链路，启用策略面由 registry 契约测试覆盖。
    const execEntries: WorkflowRegistration[] = [
      ...loadRegistryJson("dev-examples/am-p0/registry.json").map((e) => ({ ...e, enabled: true, scriptPath: `dev-examples/${e.scriptPath}` })),
      ...loadRegistryJson("dev-examples/wx-article/registry.json").map((e) => ({ ...e, enabled: true, scriptPath: `dev-examples/wx-article/${e.scriptPath}` })),
    ];
    const registry = new WorkflowRegistry(execEntries);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ig-wx-e2e-"));
    const articleDir = path.join(base, "article");
    fs.mkdirSync(articleDir);
    const freshDir = path.join(base, "fresh-unapproved"); // 未审批 batch 拦截用（无 preview 历史）
    fs.mkdirSync(freshDir);
    fs.copyFileSync(path.join(REPO_ROOT, "dev-examples/image-gen-p0/fixtures/image-prompts.sample.json"), path.join(articleDir, "image-prompts.json"));
    fs.copyFileSync(path.join(REPO_ROOT, "dev-examples/image-gen-p0/fixtures/image-prompts.sample.json"), path.join(freshDir, "image-prompts.json"));
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

      // ── 2. preview：高风险流程先授权，绝不直接启动 ──
      confirmCalls = 0;
      const pre = await facade.executeWorkflow({
        userId: "wx-user-1",
        workflowId: "article-image-generate",
        args: { article_dir: articleDir, provider: "fake", mode: "preview" },
        agentTurnId: "turn-1",
        originMessageId: "msg-1",
      });
      assert.equal((pre as { needsApproval?: boolean }).needsApproval, true, "高风险流程必须先授权");
      const previewActionId = (pre as { actionId?: string }).actionId ?? "";
      assert.ok(previewActionId, "返回 actionId");
      assert.equal(runs.size, 0, "授权前零启动（LLM 无自授权通路）");

      // ── 3. 用户批准 preview（确定性通道）→ 真实执行：1 张预览图 + 两个人工确认点 + 风格锁定 ──
      const pendingFlow = new PendingActionService({ pending, registry, launcher, channel: "wechat" });
      const confirmedPreview = await pendingFlow.confirm(previewActionId, "wx-user-1");
      assert.equal(confirmedPreview.ok, true, `批准并启动: ${JSON.stringify(confirmedPreview)}`);
      const previewRunId = (confirmedPreview as { runId?: string }).runId ?? "";
      assert.ok(previewRunId, "返回 runId");
      await waitFor(() => runs.get(previewRunId)?.status !== undefined && runs.get(previewRunId)!.status !== "running", 120_000, "preview workflow 完成");
      const previewRun = runs.get(previewRunId)!;
      assert.equal(previewRun.status, "completed", `preview 执行结果: ${JSON.stringify(previewRun.result).slice(0, 400)}`);
      const previewResult = previewRun.result as { ok?: boolean; style_approved?: boolean; succeeded?: number; mode?: string };
      assert.equal(previewResult.ok, true);
      assert.equal(previewResult.mode, "preview");
      assert.equal(previewResult.succeeded, 1, "只生成 1 张预览图");
      assert.equal(previewResult.style_approved, true, "风格已锁定");
      // 网关链路「一次授权」契约：执行授权由 pendingAction 批准卡承担（facade 注入 skip_confirm），
      // 风格确认是内容审批、不可被外层授权豁免 → 必须仍经 checkpoint 人工通道
      assert.equal(confirmCalls, 1, "风格确认 checkpoint 必须经人工通道");
      const previewImgs = fs.readdirSync(path.join(articleDir, "imgs"));
      assert.equal(previewImgs.length, 1, "仅 1 张正文预览图");

      // ── 4. batch：风格审批已通过（skip_confirm 透传网关授权）→ 补齐剩余 8 张 ──
      confirmCalls = 0;
      const batch = await facade.executeWorkflow({
        userId: "wx-user-1",
        workflowId: "article-image-generate",
        args: { article_dir: articleDir, provider: "fake", mode: "batch", skip_confirm: true },
        agentTurnId: "turn-2",
        originMessageId: "msg-2",
      });
      const batchActionId = (batch as { actionId?: string }).actionId ?? "";
      assert.ok(batchActionId, "batch 也需网关授权（风格审批不豁免安全审批）");
      const confirmedBatch = await pendingFlow.confirm(batchActionId, "wx-user-1");
      assert.equal(confirmedBatch.ok, true);
      const batchRunId = (confirmedBatch as { runId?: string }).runId ?? "";
      await waitFor(() => runs.get(batchRunId)?.status !== undefined && runs.get(batchRunId)!.status !== "running", 120_000, "batch workflow 完成");
      const batchRun = runs.get(batchRunId)!;
      assert.equal(batchRun.status, "completed", `batch 执行结果: ${JSON.stringify(batchRun.result).slice(0, 400)}`);
      const batchResult = batchRun.result as { ok?: boolean; succeeded?: number; total?: number };
      assert.equal(batchResult.ok, true);
      assert.equal(batchResult.succeeded, 9);
      assert.equal(batchResult.total, 9);
      assert.equal(confirmCalls, 0, "skip_confirm 透传后无额外确认点");
      const imgs = fs.readdirSync(path.join(articleDir, "imgs"));
      assert.equal(imgs.length, 8, "8 张正文图");
      assert.ok(fs.existsSync(path.join(articleDir, "cover.png")), "封面存在");

      // ── 5. 未审批 batch（无 preview 历史）：风格审批门拒绝（验收 3）──
      const unapproved = await facade.executeWorkflow({
        userId: "wx-user-1",
        workflowId: "article-image-generate",
        args: { article_dir: freshDir, provider: "fake", mode: "batch", skip_confirm: true },
        agentTurnId: "turn-3",
        originMessageId: "msg-3",
      });
      const unapprovedActionId = (unapproved as { actionId?: string }).actionId ?? "";
      const confirmedUnapproved = await pendingFlow.confirm(unapprovedActionId, "wx-user-1");
      const unapprovedRunId = (confirmedUnapproved as { runId?: string }).runId ?? "";
      await waitFor(() => runs.get(unapprovedRunId)?.status !== undefined && runs.get(unapprovedRunId)!.status !== "running", 120_000, "未审批 batch 完成");
      const unapprovedRun = runs.get(unapprovedRunId)!;
      assert.equal(unapprovedRun.status, "failed", "未过风格审批的 batch 必须失败");
      const errText = String((unapprovedRun.result as { error?: string })?.error ?? "");
      assert.match(errText, /风格审批/, `错误应提示风格审批: ${errText.slice(0, 200)}`);
      assert.equal(fs.existsSync(path.join(freshDir, "imgs")), false, "零生成");
    } finally {
      delete process.env.IMAGE_GEN_INTER_DELAY_MS;
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);
