/**
 * P1a Phase F 单测：三个 obsidian workflow 脚本 + 双 registry 注册 + 审批卡渲染
 *
 * 出口判据（方案 §6 Phase F）：
 *  - parseWorkflowScript：三脚本可解析；create/append meta.capabilities=['obsidian-write']；
 *    search 无 capabilities（读面，无写能力声明）
 *  - 双 registry（wx-article + am-p0）loadFromFile 全量注册（坏条目静默跳过 → 必须显式断言在册）
 *  - 注册契约：写流程 riskLevel=write + capabilities；search read-only；required 参数齐备
 *  - facade + 审批卡端到端：registry 实条目 → executeWorkflow → needsApproval → 卡片含操作类型/digest8/预览
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { renderPendingActionApproval } from "../../src/agent-host/pending-flow.js";
import { TaskControlFacade } from "../../src/agent-host/task-control-facade.js";
import { parseWorkflowScript } from "../../src/runtime/vm.js";
import type { PendingAction } from "../../src/agent-host/types.js";

const execFileAsync = promisify(execFile);

const SCRIPTS = path.resolve("dev-examples/wx-article/scripts");
const REGISTRIES = [
  { path: path.resolve("dev-examples/wx-article/registry.json"), prefix: "scripts/" },
  { path: path.resolve("dev-examples/am-p0/registry.json"), prefix: "wx-article/scripts/" },
];

function readScript(file: string): string {
  return fs.readFileSync(path.join(SCRIPTS, file), "utf-8");
}

test("parseWorkflowScript：三脚本可解析，能力声明正确", () => {
  const create = parseWorkflowScript(readScript("obsidian_note_create.js"));
  assert.equal(create.meta.name, "obsidian_note_create");
  assert.deepEqual(create.meta.capabilities, ["obsidian-write"], "create 声明写能力");

  const append = parseWorkflowScript(readScript("obsidian_note_append.js"));
  assert.equal(append.meta.name, "obsidian_note_append");
  assert.deepEqual(append.meta.capabilities, ["obsidian-write"], "append 声明写能力");

  const search = parseWorkflowScript(readScript("obsidian_note_search.js"));
  assert.equal(search.meta.name, "obsidian_note_search");
  assert.equal(search.meta.capabilities, undefined, "search 读面不声明写能力");
});

test("双 registry：三个 obsidian 流程全部在册且契约正确（loadFromFile 坏条目跳过 → 显式断言）", () => {
  for (const reg of REGISTRIES) {
    const { registry, issues } = WorkflowRegistry.loadFromFile(reg.path);
    assert.deepEqual(issues, [], `${reg.path}: 无坏条目`);
    const create = registry.get("obsidian-note-create");
    const append = registry.get("obsidian-note-append");
    const search = registry.get("obsidian-note-search");
    assert.ok(create, `${reg.path}: obsidian-note-create 在册`);
    assert.ok(append, `${reg.path}: obsidian-note-append 在册`);
    assert.ok(search, `${reg.path}: obsidian-note-search 在册`);
    if (!create || !append || !search) continue;
    assert.equal(create.riskLevel, "write");
    assert.deepEqual(create.capabilities, ["obsidian-write"]);
    assert.equal(append.riskLevel, "write");
    assert.deepEqual(append.capabilities, ["obsidian-write"]);
    assert.equal(search.riskLevel, "read-only");
    assert.equal(search.capabilities, undefined);
    // required 参数：写流程 rel+content；检索 query
    assert.deepEqual((create.argsSchema as { required?: string[] }).required, ["rel", "content"]);
    assert.deepEqual((append.argsSchema as { required?: string[] }).required, ["rel", "content"]);
    assert.deepEqual((search.argsSchema as { required?: string[] }).required, ["query"]);
    // scriptPath 指向真实脚本（registry 前缀差异由 scriptsRoot 约定保证）
    assert.ok(create.scriptPath.startsWith(reg.prefix), `${reg.path}: scriptPath 前缀 ${create.scriptPath}`);
    assert.ok(
      fs.existsSync(path.join(path.dirname(reg.path), create.scriptPath)) ||
        fs.existsSync(path.join(path.resolve("dev-examples"), create.scriptPath)),
      `${create.scriptPath} 落盘存在`,
    );
    // 路由提示：description 含使用场景关键词
    assert.match(create.description, /保存灵感/);
    assert.match(search.description, /检索/);
  }
});

test("registry 存量不回归：wx-article 16 条 / am-p0 22 条（+idea-article start/turn/write/status/handoff）", () => {
  for (const [reg, expect] of [
    [REGISTRIES[0], 16],
    [REGISTRIES[1], 22],
  ] as const) {
    const { registry, issues } = WorkflowRegistry.loadFromFile(reg.path);
    assert.deepEqual(issues, [], `${reg.path}: 无坏条目`);
    assert.equal(registry.all(false).length, expect, `${reg.path}`);
  }
});

test("端到端：registry 实条目 → facade 预检 → 审批卡渲染（操作/digest8/预览）", async () => {
  // python 可用性守卫（与 obsidian-reader.test.ts 同约定）
  let hasPython = false;
  try {
    await execFileAsync("python3", ["-c", "print('ok')"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    hasPython = true;
  } catch {
    hasPython = false;
  }
  if (!hasPython) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-phasef-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  try {
    const { registry } = WorkflowRegistry.loadFromFile(REGISTRIES[0].path);
    const pending = new PendingActionStore(path.join(root, "data"));
    const facade = new TaskControlFacade({
      registry,
      launcher: { execute: async () => { throw new Error("launcher 不应被触达"); } } as never,
      tasks: { byUser: () => [], update: () => { } } as never,
      service: {} as never,
      pending,
      runLinks: {} as never,
      vaultQuery: {
        scriptPath: path.resolve("dev-examples/wx-article/scripts/draft_manager/vault_query.py"),
        vaultRoot: vault,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir() },
      },
    });
    const out = await facade.executeWorkflow({
      userId: "u1",
      workflowId: "obsidian-note-create",
      args: { rel: "灵感/AI 自动化测试.md", content: "微信保存的灵感内容" },
      agentTurnId: "turn-1",
      originMessageId: "msg-1",
    });
    if (!("needsApproval" in out)) assert.fail(`应进入审批分支：${JSON.stringify(out)}`);
    const [action] = pending.pendingFor("u1");
    assert.ok(/^[0-9a-f]{16}$/.test(String(action.args.operationId)));
    const card = renderPendingActionApproval(action as PendingAction);
    assert.match(card, /流程：obsidian-note-create/);
    assert.match(card, /目标：灵感\/AI 自动化测试\.md/);
    assert.match(card, /操作：创建笔记（内容摘要 [0-9a-f]{8}）/);
    assert.match(card, /预览：微信保存的灵感内容/);
    assert.ok(!card.includes("回复「批准」") === false, "保留批准指引");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
