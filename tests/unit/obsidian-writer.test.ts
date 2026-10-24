/**
 * P1a Phase W 单测：ObsidianWriter（方案 §2/§3）
 *
 * 覆盖：
 *  - vault_writer 后端契约（经 obsidian-writer.ts 包装）：
 *      create 成功 / 冲突拒绝（O_EXCL）/ 幂等重试（done 同键同内容→不重复写）/
 *      done 同键异内容→拒绝复用 / started-无-done→unknown 禁自动重试 /
 *      append 成功 / append 不存在→missing / 毒字符串 rel / 越界 rel（../、绝对、反斜杠）/
 *      父目录不存在 / content 超限（1MB）
 *  - 写脚本注入链：opts.scriptPath > env PI_VAULT_WRITER_PATH
 *  - DSL 能力门（§3）：capabilities+authorized 双条件注入 obsidianWrite；
 *      缺 authorized → ReferenceError；缺 capabilities → ReferenceError；
 *      read-only 形态（无 capabilities）obsidian Reader 照常可用
 *  - capabilities 契约三件套：registry 校验（obsidian-write×read-only 拒绝等）+ digest 纳入 + meta 校验
 *  - facade 预检：create 冲突/append 缺失在审批前发现；operationId 服务端派生覆盖外部同名；
 *      rel/content 契约拒绝；重复发起去重（同 operationId 同 actionId）
 *  - 审批卡：操作类型+digest 前 8 位+预览 ≤80 字，不回显全文
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import type { WorkflowRegistration } from "../../src/contracts/wx.js";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { renderPendingActionApproval } from "../../src/agent-host/pending-flow.js";
import { TaskControlFacade, OBSIDIAN_OP_KIND } from "../../src/agent-host/task-control-facade.js";
import { computeRegistryDigest } from "../../src/agent-host/digest.js";
import { createObsidianWriter, validWriteRel, MAX_CONTENT_BYTES } from "../../src/runtime/obsidian-writer.js";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { parseWorkflowScript } from "../../src/runtime/vm.js";
import { makeRunner } from "../helpers/fake-runner.js";
import type { PendingAction } from "../../src/agent-host/types.js";

const execFileAsync = promisify(execFile);
const dmDir = path.resolve("dev-examples/wx-article/scripts/draft_manager");
const WRITER_SCRIPT = path.join(dmDir, "vault_writer.py");
const QUERY_SCRIPT = path.join(dmDir, "vault_query.py");

/** 与 vault-resolver.test.ts 一致：干净 env（PATH/HOME），防本机真实配置串扰 */
function mkEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir(), ...extra };
}

async function pythonOk(): Promise<boolean> {
  try {
    await execFileAsync("python3", ["-c", "print('ok')"], { env: mkEnv() });
    return true;
  } catch {
    return false;
  }
}
const hasPython = await pythonOk();
/** python 不可用时跳过（与 vault-resolver.test.ts 同约定） */
function itPy(name: string, fn: () => Promise<void>): void {
  test(name, { skip: !hasPython }, fn);
}

interface WFixture {
  root: string;
  vault: string;
  ledger: string;
  writer: ReturnType<typeof createObsidianWriter>;
}

function buildFixture(): WFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-writer-"));
  const vault = path.join(root, "vault");
  const ledger = path.join(root, "ledger-root");
  fs.mkdirSync(path.join(vault, "灵感"), { recursive: true });
  fs.writeFileSync(path.join(vault, "灵感/已有.md"), "已有内容\n", "utf-8");
  return {
    root,
    vault,
    ledger,
    writer: createObsidianWriter({ scriptPath: WRITER_SCRIPT, vaultRoot: vault, ledgerRoot: ledger, env: mkEnv() }),
  };
}
function cleanup(f: WFixture): void {
  fs.rmSync(f.root, { recursive: true, force: true });
}
function ledgerFile(f: WFixture): string {
  return path.join(f.ledger, ".obsidian-ops", "ledger.jsonl");
}

// ─────────────────────────────────────────────────────────────
// A. 后端契约（经 obsidian-writer.ts 包装）
// ─────────────────────────────────────────────────────────────

itPy("createNote：创建成功（rel/digest/bytes 契约）", async () => {
  const f = buildFixture();
  try {
    const r = await f.writer.createNote({ rel: "灵感/新笔记.md", content: "第一条灵感", operationId: "op-create-1" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.status, "created");
    assert.equal(r.rel, "灵感/新笔记.md");
    assert.equal(r.bytes, 15);
    assert.ok(/^[0-9a-f]{64}$/.test(r.contentDigest));
    assert.equal(fs.readFileSync(path.join(f.vault, "灵感/新笔记.md"), "utf-8"), "第一条灵感");
    // 台账：started → done 成对
    const events = fs.readFileSync(ledgerFile(f), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ["started", "done"]);
  } finally {
    cleanup(f);
  }
});

itPy("createNote：目标已存在 → conflict 拒绝（O_EXCL 语义）", async () => {
  const f = buildFixture();
  try {
    const r = await f.writer.createNote({ rel: "灵感/已有.md", content: "x", operationId: "op-c-2" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "conflict");
    assert.equal(fs.readFileSync(path.join(f.vault, "灵感/已有.md"), "utf-8"), "已有内容\n", "原文件不动");
  } finally {
    cleanup(f);
  }
});

itPy("createNote：同 operationId 同内容重试 → idempotent 不重复写", async () => {
  const f = buildFixture();
  try {
    const first = await f.writer.createNote({ rel: "灵感/幂等.md", content: "内容A", operationId: "op-idem" });
    assert.equal(first.ok && first.status, "created");
    const second = await f.writer.createNote({ rel: "灵感/幂等.md", content: "内容A", operationId: "op-idem" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.status, "idempotent");
    assert.equal(fs.readFileSync(path.join(f.vault, "灵感/幂等.md"), "utf-8"), "内容A", "文件不被二次写入");
  } finally {
    cleanup(f);
  }
});

itPy("createNote：同 operationId 不同内容 → invalid 拒绝复用", async () => {
  const f = buildFixture();
  try {
    await f.writer.createNote({ rel: "灵感/幂等2.md", content: "内容A", operationId: "op-idem-2" });
    const r = await f.writer.createNote({ rel: "灵感/幂等2.md", content: "内容B", operationId: "op-idem-2" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "invalid");
    assert.match(r.issues.join(" "), /拒绝复用/);
  } finally {
    cleanup(f);
  }
});

itPy("台账 unknown：started-无-done → unknown 禁自动重试（人工核对）", async () => {
  const f = buildFixture();
  try {
    // 人为注入悬置 started（模拟进程在写前崩溃）
    fs.mkdirSync(path.dirname(ledgerFile(f)), { recursive: true });
    fs.appendFileSync(
      ledgerFile(f),
      JSON.stringify({ event: "started", operationId: "op-unk", action: "create", rel: "灵感/悬置.md", contentDigest: "d", ts: "t" }) + "\n",
      "utf-8",
    );
    const r = await f.writer.createNote({ rel: "灵感/悬置.md", content: "新内容", operationId: "op-unk" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "unknown");
    assert.match(r.issues.join(" "), /禁自动重试/);
    assert.ok(r.issues.some((i) => i.includes("ledger.jsonl")), "告知台账位置");
  } finally {
    cleanup(f);
  }
});

itPy("appendNote：追加成功（O_APPEND 不改写既有内容）", async () => {
  const f = buildFixture();
  try {
    const r = await f.writer.appendNote({ rel: "灵感/已有.md", content: "追加一行", operationId: "op-app-1" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.status, "appended");
    assert.equal(fs.readFileSync(path.join(f.vault, "灵感/已有.md"), "utf-8"), "已有内容\n追加一行");
  } finally {
    cleanup(f);
  }
});

itPy("appendNote：目标不存在 → missing 拒绝（append 不创建）", async () => {
  const f = buildFixture();
  try {
    const r = await f.writer.appendNote({ rel: "灵感/不存在.md", content: "x", operationId: "op-app-2" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "missing");
    assert.ok(!fs.existsSync(path.join(f.vault, "灵感/不存在.md")));
  } finally {
    cleanup(f);
  }
});

itPy("毒字符串与越界 rel：统一 invalid，不触达文件系统写入", async () => {
  const f = buildFixture();
  try {
    const badRels = [
      '灵感/a";rm -rf /.md',        // 毒字符串（shell 注入形态）
      "灵感/$(pwd).md",
      "灵感/`echo x`.md",
      "../escape.md",               // 越界：父目录
      "灵感/../../escape.md",
      "/etc/passwd.md",             // 绝对路径
      "灵感\\..\\escape.md",        // 反斜杠形态
      "灵感/no-ext",                // 非 .md
      ".md",                        // 空 stem
    ];
    for (const rel of badRels) {
      assert.equal(validWriteRel(rel), false, `validWriteRel 拒绝：${rel}`);
      const r = await f.writer.createNote({ rel, content: "x", operationId: `op-poison-${rel.length}` });
      assert.equal(r.ok, false, `createNote 拒绝：${rel}`);
      if (!r.ok) assert.equal(r.code, "invalid", `code=invalid：${rel}`);
    }
    // 话术「保存到灵感」结构：父目录不存在 → 逐段自动创建（拒符号链接），文件仍 O_EXCL
    const nested = await f.writer.createNote({
      rel: "灵感/为什么学了那么多AI框架还是做不出产品/idea.md",
      content: "为什么你学了那么多 AI 框架，还是做不出产品？\n",
      operationId: "op-auto-mkdir",
    });
    assert.equal(nested.ok, true, `自动建父目录应成功：${JSON.stringify(nested)}`);
    if (nested.ok) assert.equal(nested.status, "created");
    assert.ok(fs.existsSync(path.join(f.vault, "灵感/为什么学了那么多AI框架还是做不出产品/idea.md")));
    // 同 rel 再建（不同 operationId）→ conflict，目录结构不变
    const dupDir = await f.writer.createNote({
      rel: "灵感/为什么学了那么多AI框架还是做不出产品/idea.md",
      content: "x",
      operationId: "op-auto-mkdir-2",
    });
    assert.ok(!dupDir.ok && dupDir.code === "conflict");
    assert.ok(!fs.existsSync(path.join(f.root, "escape.md")));
    assert.ok(!fs.existsSync("/tmp/escape-test-p1a.md"));
  } finally {
    cleanup(f);
  }
});

itPy("内容超限：>1MB → too_large（包装层预检，不发后端）", async () => {
  const f = buildFixture();
  try {
    const big = "x".repeat(MAX_CONTENT_BYTES + 1);
    const r = await f.writer.createNote({ rel: "灵感/超限.md", content: big, operationId: "op-big" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "too_large");
    assert.ok(!fs.existsSync(path.join(f.vault, "灵感/超限.md")));
  } finally {
    cleanup(f);
  }
});

itPy("写脚本注入链：opts.scriptPath > env PI_VAULT_WRITER_PATH", async () => {
  const f = buildFixture();
  try {
    const byEnv = createObsidianWriter({
      env: mkEnv({ PI_VAULT_WRITER_PATH: WRITER_SCRIPT, OBSIDIAN_VAULT_ROOT: f.vault, PI_OBSIDIAN_LEDGER_ROOT: f.ledger }),
    });
    const r = await byEnv.createNote({ rel: "灵感/env链.md", content: "env 通道", operationId: "op-env-1" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.status, "created");
    assert.ok(fs.existsSync(path.join(f.vault, "灵感/env链.md")));
  } finally {
    cleanup(f);
  }
});

// ─────────────────────────────────────────────────────────────
// B. DSL 能力门（§3：capabilities × authorized 双条件）
// ─────────────────────────────────────────────────────────────

const okRunner = () => makeRunner(async () => ({ type: "text" as const, value: "ok", sessionId: "s" })).runner;

itPy("DSL 能力门：capabilities+authorized → obsidianWrite 注入可用", async () => {
  const f = buildFixture();
  try {
    const script = `
export const meta = { name: "obs_write_ok", description: "write gate ok", capabilities: ["obsidian-write"] };
await agent("probe", { label: "probe" });
const r = await obsidianWrite.createNote({ rel: "灵感/DSL创建.md", content: "来自 DSL", operationId: "dsl-op-1" });
return { ok: r.ok, status: r.ok ? r.status : r.code };
`;
    const result = await runWorkflow(script, {
      agent: okRunner(),
      cwd: f.root,
      authorized: true,
      obsidian: { scriptPath: WRITER_SCRIPT, env: mkEnv({ OBSIDIAN_VAULT_ROOT: f.vault, PI_OBSIDIAN_LEDGER_ROOT: f.ledger }) },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { ok: true, status: "created" });
    assert.equal(fs.readFileSync(path.join(f.vault, "灵感/DSL创建.md"), "utf-8"), "来自 DSL");
  } finally {
    cleanup(f);
  }
});

itPy("DSL 能力门：无 authorized → obsidianWrite 未注入（ReferenceError）", async () => {
  const f = buildFixture();
  try {
    const script = `
export const meta = { name: "obs_write_unauth", description: "write gate unauth", capabilities: ["obsidian-write"] };
await agent("probe", { label: "probe" });
const r = await obsidianWrite.createNote({ rel: "灵感/x.md", content: "x", operationId: "dsl-op-2" });
return { ok: r.ok };
`;
    await assert.rejects(
      runWorkflow(script, {
        agent: okRunner(),
        cwd: f.root,
        // 不传 authorized
        obsidian: { env: mkEnv({ OBSIDIAN_VAULT_ROOT: f.vault }) },
      }),
      (e: unknown) => String(e).includes("obsidianWrite"),
    );
    assert.ok(!fs.existsSync(path.join(f.vault, "灵感/x.md")), "未授权不产生写入");
  } finally {
    cleanup(f);
  }
});

itPy("DSL 能力门：未声明 capabilities → obsidianWrite 未注入（ReferenceError）", async () => {
  const f = buildFixture();
  try {
    const script = `
export const meta = { name: "obs_write_nocap", description: "write gate no capability" };
await agent("probe", { label: "probe" });
const r = await obsidianWrite.appendNote({ rel: "灵感/已有.md", content: "x", operationId: "dsl-op-3" });
return { ok: r.ok };
`;
    await assert.rejects(
      runWorkflow(script, {
        agent: okRunner(),
        cwd: f.root,
        authorized: true, // 有授权但脚本未声明能力 → 仍不注入
        obsidian: { env: mkEnv({ OBSIDIAN_VAULT_ROOT: f.vault }) },
      }),
      (e: unknown) => String(e).includes("obsidianWrite"),
    );
    assert.equal(fs.readFileSync(path.join(f.vault, "灵感/已有.md"), "utf-8"), "已有内容\n", "未声明能力不产生写入");
  } finally {
    cleanup(f);
  }
});

itPy("DSL：read-only 形态（无 capabilities）obsidian Reader 照常可用", async () => {
  const f = buildFixture();
  try {
    const script = `
export const meta = { name: "obs_read_still", description: "reader still works" };
await agent("probe", { label: "probe" });
const r = await obsidian.readNote({ path: "灵感/已有.md" });
return { ok: r.ok, size: r.ok ? r.size : -1 };
`;
    const result = await runWorkflow(script, {
      agent: okRunner(),
      cwd: f.root,
      obsidian: { scriptPath: QUERY_SCRIPT, env: mkEnv({ OBSIDIAN_VAULT_ROOT: f.vault }) },
    });
    const r = JSON.parse(JSON.stringify(result.result));
    assert.equal(r.ok, true);
    assert.equal(r.size, 13);
  } finally {
    cleanup(f);
  }
});

// ─────────────────────────────────────────────────────────────
// C. capabilities 契约三件套（contracts/registry/digest/meta）
// ─────────────────────────────────────────────────────────────

const WRITE_REG: WorkflowRegistration = {
  workflowId: "obsidian-note-create",
  scriptPath: "scripts/obsidian_note_create.js",
  name: "创建笔记",
  description: "在 Obsidian vault 创建笔记",
  argsSchema: {
    type: "object",
    properties: { rel: { type: "string" }, content: { type: "string" }, operationId: { type: "string" } },
    required: ["rel", "content"],
  },
  riskLevel: "write",
  enabled: true,
  keywords: ["obsidian"],
  capabilities: ["obsidian-write"],
};

test("registry：capabilities 校验（非数组/空/非法字符/重复 → 拒绝）", () => {
  const mk = (over: Record<string, unknown>) =>
    new WorkflowRegistry([{ ...WRITE_REG, ...over } as unknown as WorkflowRegistration]);
  assert.equal(mk({ capabilities: "obsidian-write" }).all(false).length, 0, "非数组拒绝");
  assert.equal(mk({ capabilities: [] }).all(false).length, 0, "空数组拒绝");
  assert.equal(mk({ capabilities: [42] }).all(false).length, 0, "非字符串条目拒绝");
  assert.equal(mk({ capabilities: ["Obsidian_Write"] }).all(false).length, 0, "非 kebab-case 拒绝");
  assert.equal(mk({ capabilities: ["obsidian-write", "obsidian-write"] }).all(false).length, 0, "重复拒绝");
  assert.equal(mk({ capabilities: ["obsidian-write"] }).all(false).length, 1, "合法通过");
  assert.equal(mk({ capabilities: undefined }).all(false).length, 1, "缺省通过（向后兼容）");
});

test("registry：obsidian-write × riskLevel=read-only → 拒绝（写能力必须 write/external-side-effect）", () => {
  const mk = (riskLevel: WorkflowRegistration["riskLevel"]) =>
    new WorkflowRegistry([{ ...WRITE_REG, riskLevel } as WorkflowRegistration]);
  assert.equal(mk("read-only").all(false).length, 0, "read-only + obsidian-write 拒绝");
  assert.equal(mk("write").all(false).length, 1, "write + obsidian-write 通过");
  assert.equal(mk("external-side-effect").all(false).length, 1, "external-side-effect 通过");
  // read-only 不声明写能力照常注册
  const ro = new WorkflowRegistry([{ ...WRITE_REG, riskLevel: "read-only", capabilities: undefined } as WorkflowRegistration]);
  assert.equal(ro.all(false).length, 1);
});

test("digest：capabilities 参与摘要（顺序无关；有无不同）", () => {
  const a = new WorkflowRegistry([WRITE_REG]);
  const reordered = new WorkflowRegistry([{ ...WRITE_REG, capabilities: ["another-cap", "obsidian-write"] } as WorkflowRegistration]);
  const none = new WorkflowRegistry([{ ...WRITE_REG, capabilities: undefined } as WorkflowRegistration]);
  const other = new WorkflowRegistry([{ ...WRITE_REG, capabilities: ["other-cap"] } as WorkflowRegistration]);
  assert.notEqual(computeRegistryDigest(a), computeRegistryDigest(none), "有无 capabilities 摘要不同");
  assert.notEqual(computeRegistryDigest(a), computeRegistryDigest(other), "能力集变更摘要变化");
  const b = new WorkflowRegistry([{ ...WRITE_REG, capabilities: ["obsidian-write", "another-cap"] } as WorkflowRegistration]);
  assert.equal(computeRegistryDigest(reordered), computeRegistryDigest(b), "顺序无关（排序后摘要）");
});

test("vm validateMeta：capabilities 必须是非空 kebab-case 字符串数组", () => {
  const mk = (capabilities: unknown) =>
    parseWorkflowScript(
      `export const meta = { name: "t_w", description: "d", capabilities: ${JSON.stringify(capabilities)} };
return 1;`,
    );
  assert.equal(mk(["obsidian-write"]).meta.capabilities?.[0], "obsidian-write");
  assert.throws(() => mk([]), /capabilities/);
  assert.throws(() => mk(["UPPER"]), /capabilities/);
  assert.throws(() => mk(["a", "a"]), /capabilities/);
  assert.throws(() => mk("obsidian-write"), /capabilities/);
});

// ─────────────────────────────────────────────────────────────
// D. facade 预检（obsidian 写操作）
// ─────────────────────────────────────────────────────────────

interface FFixture {
  root: string;
  vault: string;
  pending: PendingActionStore;
  created: PendingAction[];
  facade: TaskControlFacade;
}

function makeFacadeFixture(vault: string): FFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-facade-"));
  const registry = new WorkflowRegistry([
    WRITE_REG,
    { ...WRITE_REG, workflowId: "obsidian-note-append", name: "追加笔记" },
  ]);
  const pending = new PendingActionStore(path.join(root, "data"));
  const created: PendingAction[] = [];
  const facade = new TaskControlFacade({
    registry,
    launcher: { execute: async () => { throw new Error("launcher 不应被触达"); } } as never,
    tasks: { byUser: () => [], update: () => { } } as never,
    service: {} as never,
    pending,
    runLinks: {} as never,
    vaultQuery: { scriptPath: QUERY_SCRIPT, vaultRoot: vault, env: mkEnv() },
    onPendingCreated: (a) => created.push(a),
  });
  return { root, vault, pending, created, facade };
}

const FEXEC = { userId: "u1", workflowId: "obsidian-note-create", agentTurnId: "turn-1", originMessageId: "msg-1" };

itPy("facade 预检：create 目标已存在 → error 不建审批（批准前发现 O_EXCL 冲突）", async () => {
  const f = buildFixture();
  const ff = makeFacadeFixture(f.vault);
  try {
    const out = await ff.facade.executeWorkflow({ ...FEXEC, args: { rel: "灵感/已有.md", content: "x" } });
    assert.match(out.error ?? "", /目标笔记已存在/);
    assert.equal(ff.pending.pendingFor("u1").length, 0, "不建 pending");
    assert.equal(ff.created.length, 0);
  } finally {
    cleanup(f);
    fs.rmSync(ff.root, { recursive: true, force: true });
  }
});

itPy("facade 预检：append 目标不存在 → error 不建审批", async () => {
  const f = buildFixture();
  const ff = makeFacadeFixture(f.vault);
  try {
    const out = await ff.facade.executeWorkflow({
      ...FEXEC,
      workflowId: "obsidian-note-append",
      args: { rel: "灵感/不存在.md", content: "x" },
    });
    assert.match(out.error ?? "", /目标笔记不存在/);
    assert.equal(ff.pending.pendingFor("u1").length, 0);
  } finally {
    cleanup(f);
    fs.rmSync(ff.root, { recursive: true, force: true });
  }
});

itPy("facade 预检：合法 create → operationId 服务端派生覆盖外部同名 + resolvedTarget", async () => {
  const f = buildFixture();
  const ff = makeFacadeFixture(f.vault);
  try {
    const out = await ff.facade.executeWorkflow({
      ...FEXEC,
      args: { rel: "灵感/审批创建.md", content: "审批后内容", operationId: "外部伪造的id" },
    });
    if (!("needsApproval" in out)) assert.fail(`应进入审批分支：${JSON.stringify(out)}`);
    assert.equal(out.resolvedTarget, "灵感/审批创建.md");
    const [action] = ff.pending.pendingFor("u1");
    assert.ok(/^[0-9a-f]{16}$/.test(String(action.args.operationId)), "服务端 16hex operationId");
    assert.notEqual(action.args.operationId, "外部伪造的id", "外部同名参数被覆盖");
    // 未批准不产生任何写入
    assert.ok(!fs.existsSync(path.join(f.vault, "灵感/审批创建.md")));
  } finally {
    cleanup(f);
    fs.rmSync(ff.root, { recursive: true, force: true });
  }
});

itPy("facade 预检：rel/content 契约拒绝（../、无 .md、空内容、超限）", async () => {
  const f = buildFixture();
  const ff = makeFacadeFixture(f.vault);
  try {
    const bad: Array<Record<string, unknown>> = [
      { rel: "../escape.md", content: "x" },
      { rel: "灵感/no-ext", content: "x" },
      { rel: "灵感/空内容.md", content: "" },
      { rel: "灵感/空白.md", content: "   " },
      { rel: "灵感/超限.md", content: "x".repeat(MAX_CONTENT_BYTES + 1) },
      { content: "缺 rel" },
    ];
    for (const args of bad) {
      const out = await ff.facade.executeWorkflow({ ...FEXEC, args });
      assert.ok(out.error, `应拒绝：${JSON.stringify(args).slice(0, 60)}`);
      assert.match(out.error ?? "", /rel|content/, `错误信息指向契约：${out.error}`);
    }
    assert.equal(ff.pending.pendingFor("u1").length, 0, "全部不建审批");
  } finally {
    cleanup(f);
    fs.rmSync(ff.root, { recursive: true, force: true });
  }
});

itPy("facade 去重：同 userId+workflowId+同参（同 operationId）→ 复用同一 actionId", async () => {
  const f = buildFixture();
  const ff = makeFacadeFixture(f.vault);
  try {
    const args = { rel: "灵感/去重.md", content: "同参" };
    const out1 = await ff.facade.executeWorkflow({ ...FEXEC, args });
    const out2 = await ff.facade.executeWorkflow({ ...FEXEC, args });
    if (!("needsApproval" in out1) || !("needsApproval" in out2)) assert.fail("两轮都应进入审批分支");
    assert.equal(out1.actionId, out2.actionId, "同 operationId → 同 argsDigest → 复用 pending");
    assert.equal(ff.pending.pendingFor("u1").length, 1);
  } finally {
    cleanup(f);
    fs.rmSync(ff.root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// E. 审批卡（§2.3：操作类型 + digest 前 8 位 + 预览 ≤80 字，不回显全文）
// ─────────────────────────────────────────────────────────────

test("审批卡：obsidian 写操作显示 操作/digest8/预览≤80，不回显全文", () => {
  const tailToken = "TAIL_TOKEN_不应出现在卡片里";
  const content = `标题\n\n${"很长的灵感内容".repeat(40)} ${tailToken}`;
  const action = {
    actionId: "pa-x1",
    userId: "u1",
    workflowId: "obsidian-note-create",
    args: { rel: "灵感/AI 自动化测试.md", content, operationId: "op-x" },
    argsDigest: "d",
    originMessageId: "m1",
    riskLevel: "write",
    registryDigest: "r",
    resolvedTarget: "灵感/AI 自动化测试.md",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    status: "pending",
  } as unknown as PendingAction;
  const card = renderPendingActionApproval(action);
  assert.match(card, /流程：obsidian-note-create/);
  assert.match(card, /目标：灵感\/AI 自动化测试\.md/);
  assert.match(card, /操作：创建笔记（内容摘要 [0-9a-f]{8}）/);
  const previewLine = card.split("\n").find((l) => l.startsWith("预览：")) ?? "";
  assert.ok(previewLine.length <= 80 + "预览：".length + 10, `预览 ≤80 字：${previewLine.length}`);
  assert.ok(!card.includes(tailToken), "全文尾部不出现");
  assert.ok(!card.includes(content), "全文不回显");
});

test("审批卡：append 显示「追加内容」；非 obsidian 流程卡片形态不变", () => {
  const appendAction = {
    actionId: "pa-x2",
    userId: "u1",
    workflowId: "obsidian-note-append",
    args: { rel: "灵感/已有.md", content: "追加内容", operationId: "op-y" },
    argsDigest: "d",
    originMessageId: "m1",
    riskLevel: "write",
    registryDigest: "r",
    resolvedTarget: "灵感/已有.md",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    status: "pending",
  } as unknown as PendingAction;
  const card = renderPendingActionApproval(appendAction);
  assert.match(card, /操作：追加内容/);

  const plain = {
    actionId: "pa-x3",
    userId: "u1",
    workflowId: "article-prepare",
    args: { vault_ref_pinned_rel: "公众号/AI入门/单篇" },
    argsDigest: "d",
    originMessageId: "m1",
    riskLevel: "external-side-effect",
    registryDigest: "r",
    resolvedTarget: "公众号/AI入门/单篇",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    status: "pending",
  } as unknown as PendingAction;
  const plainCard = renderPendingActionApproval(plain);
  assert.ok(!plainCard.includes("操作："));
  assert.ok(!plainCard.includes("预览："));
  assert.match(plainCard, /目标：公众号\/AI入门\/单篇/);
  assert.doesNotThrow(() => {
    void OBSIDIAN_OP_KIND["obsidian-note-create"];
  });
});
