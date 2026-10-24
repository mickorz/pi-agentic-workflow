/**
 * P1a Phase V 验收（本地全链路 E2E，方案 §7.1/§7.2/§7.3 + §3 授权贯通）
 *
 * 链路：TaskControlFacade.executeWorkflow（预检+operationId 派生）→ PendingAction 审批卡
 *      → PendingActionService.confirm（authorized:true 唯一入口）
 *      → LaunchCoordinator → Dispatcher（重校验+authorized 透传）→ RunApplicationService
 *      → engine → runWorkflow（meta.capabilities 门 + obsidianWrite 注入）→ vault_writer.py（O_EXCL/台账）
 *
 * 真机微信通道与跨机云同步不在本用例（Windows/真机待办，见 Phase V 报告）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { IntentRouter } from "../../src/dispatch/intent-router.js";
import { TaskStore } from "../../src/dispatch/task-store.js";
import { createRunApplicationService } from "../../src/application/run-service.js";
import { LaunchCoordinator } from "../../src/agent-host/launch-flow.js";
import { RunLaunchStore, RunLinkStore } from "../../src/agent-host/run-launch.js";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { PendingActionService, renderPendingActionApproval } from "../../src/agent-host/pending-flow.js";
import { TaskControlFacade } from "../../src/agent-host/task-control-facade.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { createObsidianWriter } from "../../src/runtime/obsidian-writer.js";
import { createObsidianReader } from "../../src/runtime/obsidian-reader.js";

const execFileAsync = promisify(execFile);

const QUERY = path.resolve("dev-examples/wx-article/scripts/draft_manager/vault_query.py");
const WRITER = path.resolve("dev-examples/wx-article/scripts/draft_manager/vault_writer.py");
const REGISTRY_FILE = path.resolve("dev-examples/wx-article/registry.json");
const SCRIPTS_ROOT = path.resolve("dev-examples/wx-article");

interface Assembled {
  root: string;
  vault: string;
  ledgerRoot: string;
  service: ReturnType<typeof createRunApplicationService>;
  pendingStore: PendingActionStore;
  pendingFlow: PendingActionService;
  facade: TaskControlFacade;
}

async function hasPython(): Promise<boolean> {
  try {
    await execFileAsync("python3", ["-c", "print('ok')"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    return true;
  } catch {
    return false;
  }
}

async function assemble(): Promise<Assembled> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-e2e-"));
  const vault = path.join(root, "vault");
  const ledgerRoot = path.join(root, "ledger");
  fs.mkdirSync(path.join(vault, "灵感"), { recursive: true });
  const dataDir = path.join(root, "data");
  const baseDir = path.join(root, "base");
  fs.mkdirSync(baseDir, { recursive: true });

  // 播报 agent：结构化返回 { message }（§7.1 回复真实文件位置）
  const { runner } = makeRunner(async () => ({
    type: "structured" as const,
    value: { message: "P1a 验收播报：已处理" },
    sessionId: "fake-e2e",
  }));
  const service = createRunApplicationService({ baseDir, runner });

  const { registry } = WorkflowRegistry.loadFromFile(REGISTRY_FILE);
  const tasks = new TaskStore(dataDir);
  const dispatcher = new Dispatcher({
    registry,
    router: new IntentRouter({ llm: null as never, registry }),
    tasks,
    service,
    scriptsRoot: SCRIPTS_ROOT,
  });
  const runLinks = new RunLinkStore(dataDir);
  const launcher = new LaunchCoordinator({
    attempts: new RunLaunchStore(dataDir),
    runLinks,
    dispatcher,
    tasks,
  });
  const pendingStore = new PendingActionStore(dataDir);
  const pendingFlow = new PendingActionService({ pending: pendingStore, registry, launcher });
  const facade = new TaskControlFacade({
    registry,
    launcher,
    tasks,
    service,
    pending: pendingStore,
    runLinks,
    vaultQuery: {
      scriptPath: QUERY,
      vaultRoot: vault,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir() },
    },
  });
  return { root, vault, ledgerRoot, service, pendingStore, pendingFlow, facade };
}

async function waitForRun(service: Assembled["service"], runId: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await service.get(runId);
    const snap = detail?.snapshot as { effectiveStatus?: string; result?: unknown } | undefined;
    // completed 但 result 未落盘（updateManifest 先于 writeResult 的窗口）：继续轮询至齐
    if (snap && (snap.effectiveStatus === "failed" || (snap.effectiveStatus === "completed" && snap.result != null))) {
      return snap as unknown as Record<string, unknown>;
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内完成（状态 ${snap?.effectiveStatus}）`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("E2E §7.1+§7.3：微信保存灵感全链路（预检→审批卡→批准→O_EXCL 创建→幂等）", { timeout: 120_000 }, async (t) => {
  if (!(await hasPython())) return t.skip("python3 不可用");
  const saved: Record<string, string | undefined> = {};
  for (const k of ["PI_VAULT_QUERY_PATH", "PI_VAULT_WRITER_PATH", "OBSIDIAN_VAULT_ROOT", "PI_OBSIDIAN_LEDGER_ROOT"]) {
    saved[k] = process.env[k];
  }
  const app = await assemble();
  try {
    process.env.PI_VAULT_QUERY_PATH = QUERY;
    process.env.PI_VAULT_WRITER_PATH = WRITER;
    process.env.OBSIDIAN_VAULT_ROOT = app.vault;
    process.env.PI_OBSIDIAN_LEDGER_ROOT = app.ledgerRoot;
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir() };

    const userId = "wx-p1a";
    const rel = "灵感/P1a验收AI自动化/idea.md"; // 话术「保存到灵感」：标题目录自动创建
    const content = "# P1a 验收灵感\n\n微信保存的灵感内容：AI 工作流与 Obsidian 联动。\n";

    // ① facade 预检 + 审批卡（目标不存在 → 通过 O_EXCL 预检）
    const r1 = await app.facade.executeWorkflow({
      userId,
      workflowId: "obsidian-note-create",
      args: { rel, content },
      agentTurnId: "turn-1",
      originMessageId: "msg-1",
    });
    assert.ok("needsApproval" in r1, `应进入审批：${JSON.stringify(r1)}`);
    const action = app.pendingStore.pendingFor(userId)[0];
    const opId = String(action.args.operationId);
    assert.match(opId, /^[0-9a-f]{16}$/);

    const card = renderPendingActionApproval(action);
    assert.match(card, /流程：obsidian-note-create/);
    assert.match(card, /操作：创建笔记（内容摘要 [0-9a-f]{8}）/);
    assert.match(card, /预览：# P1a 验收灵感/);

    // ② 批准 → 全链路启动（authorized:true 唯一入口）
    const c1 = await app.pendingFlow.confirm(action.actionId, userId);
    assert.ok(c1.ok, `confirm 应成功：${JSON.stringify(c1)}`);
    if (!c1.ok) return;
    const snap = await waitForRun(app.service, c1.runId);
    assert.equal(snap.effectiveStatus, "completed");
    const envelope = JSON.parse(JSON.stringify(snap.result)) as { result: unknown };
    const result = envelope.result as { ok: boolean; rel: string; status: string; message: string };
    assert.equal(result.ok, true);
    assert.equal(result.rel, rel);
    assert.equal(result.status, "created");

    // ③ O_EXCL 语义：文件真实落盘，内容逐字节一致
    const file = path.join(app.vault, rel);
    assert.equal(fs.readFileSync(file, "utf-8"), content);

    // ④ 审批级幂等：重复 confirm → alreadyExecuted（不二次启动）
    const c2 = await app.pendingFlow.confirm(action.actionId, userId);
    assert.ok(c2.ok && c2.alreadyExecuted === true, `应幂等：${JSON.stringify(c2)}`);
    if (c2.ok) assert.equal(c2.runId, c1.runId);

    // ⑤ 写面幂等（§7.3）：同 operationId 同内容直写 → idempotent，文件零变化
    const before = fs.readFileSync(file, "utf-8");
    const w = createObsidianWriter({ scriptPath: WRITER, vaultRoot: app.vault, ledgerRoot: app.ledgerRoot, env });
    const retry = await w.createNote({ rel, content, operationId: opId });
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.status, "idempotent");
    assert.equal(fs.readFileSync(file, "utf-8"), before, "幂等重试不得改文件");

    // ⑥ 台账检查：started→done 事件落盘
    const ledger = fs.readFileSync(path.join(app.ledgerRoot, ".obsidian-ops", "ledger.jsonl"), "utf-8");
    const events = ledger.trim().split("\n").map((l) => JSON.parse(l) as { event: string; operationId: string });
    assert.ok(events.some((e) => e.event === "started" && e.operationId === opId));
    assert.ok(events.some((e) => e.event === "done" && e.operationId === opId));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(app.root, { recursive: true, force: true });
  }
});

test("E2E §7.2+追加：检索命中刚创建内容 + append 审批链", { timeout: 120_000 }, async (t) => {
  if (!(await hasPython())) return t.skip("python3 不可用");
  const saved: Record<string, string | undefined> = {};
  for (const k of ["PI_VAULT_QUERY_PATH", "PI_VAULT_WRITER_PATH", "OBSIDIAN_VAULT_ROOT", "PI_OBSIDIAN_LEDGER_ROOT"]) {
    saved[k] = process.env[k];
  }
  const app = await assemble();
  try {
    process.env.PI_VAULT_QUERY_PATH = QUERY;
    process.env.PI_VAULT_WRITER_PATH = WRITER;
    process.env.OBSIDIAN_VAULT_ROOT = app.vault;
    process.env.PI_OBSIDIAN_LEDGER_ROOT = app.ledgerRoot;
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir() };
    const userId = "wx-p1a";

    // 准备：直写创建一篇（幂等层已验证，此处聚焦检索与追加）
    const rel = "灵感/P1a检索目标.md";
    const token = "p1a_unique_token_搜索验证";
    const content = `# 检索目标\n\n正文包含 ${token}，用于验证微信搜笔记场景。\n`;
    const w = createObsidianWriter({ scriptPath: WRITER, vaultRoot: app.vault, ledgerRoot: app.ledgerRoot, env });
    const created = await w.createNote({ rel, content, operationId: "e2e0000000000002" });
    assert.equal(created.ok, true);

    // ① 检索 workflow 全链路（read-only 直启，无审批）
    const s1 = await app.facade.executeWorkflow({
      userId,
      workflowId: "obsidian-note-search",
      args: { query: token, scope: "灵感" },
      agentTurnId: "turn-2",
      originMessageId: "msg-2",
    });
    assert.ok("runId" in (s1 as object), `检索应直启：${JSON.stringify(s1)}`);
    const sRun = s1 as { runId: string };
    const sSnap = await waitForRun(app.service, sRun.runId);
    assert.equal(sSnap.effectiveStatus, "completed");
    const sResult = (JSON.parse(JSON.stringify(sSnap.result)) as { result: unknown }).result as { ok: boolean; total: number; items: { path: string }[] };
    assert.equal(sResult.ok, true);
    assert.equal(sResult.total, 1);
    assert.equal(sResult.items[0]?.path, rel);

    // Reader 层再断言一次（同链路后端）
    const reader = createObsidianReader({ scriptPath: QUERY, vaultRoot: app.vault, env });
    const hit = await reader.searchNotes({ query: token });
    assert.equal(hit.ok, true);
    if (hit.ok) assert.equal(hit.total, 1);

    // ② append 审批链：目标已存在 → 预检通过 → 批准 → 追加
    const extra = "追加段落：验收阶段补充。\n";
    const a1 = await app.facade.executeWorkflow({
      userId,
      workflowId: "obsidian-note-append",
      args: { rel, content: extra },
      agentTurnId: "turn-3",
      originMessageId: "msg-3",
    });
    assert.ok("needsApproval" in a1, `append 应进审批：${JSON.stringify(a1)}`);
    const aAction = app.pendingStore.pendingFor(userId)[0];
    const aCard = renderPendingActionApproval(aAction);
    assert.match(aCard, /操作：追加内容（内容摘要 [0-9a-f]{8}）/);

    const c1 = await app.pendingFlow.confirm(aAction.actionId, userId);
    assert.ok(c1.ok);
    if (!c1.ok) return;
    const aSnap = await waitForRun(app.service, c1.runId);
    assert.equal(aSnap.effectiveStatus, "completed");
    const aResult = (JSON.parse(JSON.stringify(aSnap.result)) as { result: unknown }).result as { ok: boolean; status: string };
    assert.equal(aResult.status, "appended");
    assert.equal(fs.readFileSync(path.join(app.vault, rel), "utf-8"), content + extra);

    // ③ append 不存在目标：预检拒绝，不建审批项
    const a2 = await app.facade.executeWorkflow({
      userId,
      workflowId: "obsidian-note-append",
      args: { rel: "灵感/不存在.md", content: "x" },
      agentTurnId: "turn-4",
      originMessageId: "msg-4",
    });
    assert.ok("error" in a2 && /不存在/.test((a2 as { error: string }).error), `预检应拒绝：${JSON.stringify(a2)}`);
    assert.equal(app.pendingStore.pendingFor(userId).length, 0);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(app.root, { recursive: true, force: true });
  }
});

test("E2E §7.3-unknown：started-无-done 台账 → unknown 报错禁自动重试", { timeout: 60_000 }, async (t) => {
  if (!(await hasPython())) return t.skip("python3 不可用");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-unk-"));
  const vault = path.join(root, "vault");
  const ledgerRoot = path.join(root, "ledger");
  fs.mkdirSync(path.join(vault, "灵感"), { recursive: true });
  fs.mkdirSync(path.join(ledgerRoot, ".obsidian-ops"), { recursive: true });
  try {
    const rel = "灵感/悬置.md";
    fs.writeFileSync(path.join(vault, rel), "既有内容");
    // 注入伪造 started（无 done）
    const rec = JSON.stringify({ ts: "2026-10-24T00:00:00Z", event: "started", operationId: "dead000000000001", action: "append", rel, contentDigest: "x", bytes: 1 });
    fs.appendFileSync(path.join(ledgerRoot, ".obsidian-ops", "ledger.jsonl"), rec + "\n");
    const w = createObsidianWriter({
      scriptPath: WRITER,
      vaultRoot: vault,
      ledgerRoot,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir() },
    });
    const r = await w.appendNote({ rel, content: "再写", operationId: "dead000000000001" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "unknown");
      assert.ok(r.issues.some((i) => /人工|核对/.test(i)), "须提示人工核对禁自动重试");
    }
    assert.equal(fs.readFileSync(path.join(vault, rel), "utf-8"), "既有内容", "unknown 分支不得写文件");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
