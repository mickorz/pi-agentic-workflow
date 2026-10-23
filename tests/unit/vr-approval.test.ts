/**
 * VR 阶段C单测：anyOfArgs Registry 契约（S4.4）+ 审批前参数预检（S4.2）
 * + 服务端锚点/审批卡（S4.3/#12/#13）
 *
 * 覆盖：
 *  - registry.register：anyOfArgs 合法性（非数组/空串/条目不在 argsSchema.properties → 拒绝）
 *  - computeRegistryDigest：anyOfArgs 参与摘要（规则变更旧审批失效），顺序无关
 *  - facade.executeWorkflow 预检：
 *      无通道参数 → error 且不建 pending（不产生「批准→执行→才发现缺参」空转授权）
 *      vault_ref 歧义/失败 → error 且不建 pending
 *      vault_ref 解析成功 → pending 建立且 args.vault_ref_pinned_rel 为服务端值
 *      （覆盖外部同名参数）；argsDigest 与锚点后参数一致；onPendingCreated 触发
 *      article_dir 通道 → 不做 vault 解析也建 pending（兼容通道）
 *      去重：同 vault_ref 重复发起 → 同一 actionId
 *  - renderPendingActionApproval：三要素（workflowId/resolvedTarget/actionId）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import type { WorkflowRegistration } from "../../src/contracts/wx.js";
import { PendingActionStore } from "../../src/agent-host/pending-action.js";
import { renderPendingActionApproval } from "../../src/agent-host/pending-flow.js";
import { TaskControlFacade } from "../../src/agent-host/task-control-facade.js";
import { computeArgsDigest, computeRegistryDigest } from "../../src/agent-host/digest.js";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/runtime/errors.js";
import type { PendingAction } from "../../src/agent-host/types.js";

// 测试从仓库根运行（npm test / tsx --test），与 vault-resolver.test.ts 一致用 cwd 相对定位
const dmDir = path.resolve("dev-examples/wx-article/scripts/draft_manager");
const FIXTURE_VAULT = path.join(dmDir, "test-fixture/vault");
const RESOLVER_SCRIPT = path.join(dmDir, "vault_resolver.py");

/** wx 侧文章流程注册（VR 后形态：三通道 anyOfArgs，required 清空——S4.1） */
const INSPECT: WorkflowRegistration = {
  workflowId: "article-inspect",
  scriptPath: "article_inspect.js",
  name: "文章只读巡检",
  description: "检查公众号文章状态（正文/yaml/配图/封面/草稿）",
  argsSchema: {
    type: "object",
    properties: {
      article_dir: { type: "string" },
      vault_ref: { type: "string" },
      vault_scope: { type: "string" },
      vault_ref_pinned_rel: { type: "string" },
      article_name: { type: "string" },
    },
    required: [],
  },
  riskLevel: "write", // 预检仅在高风险分支生效（S4.2）
  enabled: true,
  keywords: ["巡检"],
  anyOfArgs: ["article_dir", "vault_ref", "article_name"],
};

function mkReg(over: Partial<WorkflowRegistration>): WorkflowRegistration {
  return { ...INSPECT, ...over };
}

interface Fixture {
  root: string;
  pending: PendingActionStore;
  created: PendingAction[];
  facade: TaskControlFacade;
}

/** 高风险（write）版本 INSPECT + 真 resolver（fixture vault 作 vault_root） */
function makeFixture(vaultRoot: string = FIXTURE_VAULT): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vr-approval-"));
  const registry = new WorkflowRegistry([mkReg({ riskLevel: "write" })]);
  const pending = new PendingActionStore(path.join(root, "data"));
  const created: PendingAction[] = [];
  const facade = new TaskControlFacade({
    registry,
    launcher: { execute: async () => { throw new Error("launcher 不应被触达"); } } as never,
    tasks: { byUser: () => [], update: () => { } } as never,
    service: {} as never,
    pending,
    runLinks: {} as never,
    vaultResolver: { scriptPath: RESOLVER_SCRIPT, vaultRoot: FIXTURE_VAULT },
    onPendingCreated: (a) => created.push(a),
  });
  return { root, pending, created, facade };
}

const EXEC = { userId: "u1", workflowId: "article-inspect", agentTurnId: "turn-1", originMessageId: "msg-1" };

test("registry：anyOfArgs 非法（非数组/空串/条目不在 schema）拒绝注册", () => {
  const base = mkReg({ workflowId: "wf-a", riskLevel: "write" });
  const mk = (over: Record<string, unknown>) =>
    new WorkflowRegistry([{ ...base, ...over } as unknown as WorkflowRegistration]);
  assert.equal(mk({ anyOfArgs: "article_dir" }).all(false).length, 0, "非数组拒绝");
  assert.equal(mk({ anyOfArgs: [] }).all(false).length, 0, "空数组拒绝");
  assert.equal(mk({ anyOfArgs: ["article_dir", ""] }).all(false).length, 0, "空串条目拒绝");
  assert.equal(mk({ anyOfArgs: ["article_dir", "no_such_arg"] }).all(false).length, 0, "条目不在 properties 拒绝");
  const ok = mk({ anyOfArgs: ["vault_ref", "article_name"] });
  assert.equal(ok.all(false).length, 1, "合法 anyOfArgs 通过");
});

test("digest：anyOfArgs 参与摘要且顺序无关（规则变更旧审批失效）", () => {
  const withArgs = new WorkflowRegistry([mkReg({ anyOfArgs: ["vault_ref", "article_dir"] })]);
  const sameOrder = new WorkflowRegistry([mkReg({ anyOfArgs: ["article_dir", "vault_ref"] })]);
  const changed = new WorkflowRegistry([mkReg({ anyOfArgs: ["vault_ref", "article_name"] })]);
  const none = new WorkflowRegistry([mkReg({ anyOfArgs: undefined })]);
  assert.equal(computeRegistryDigest(withArgs), computeRegistryDigest(sameOrder), "顺序无关");
  assert.notEqual(computeRegistryDigest(withArgs), computeRegistryDigest(changed), "规则变更摘要变化");
  assert.notEqual(computeRegistryDigest(withArgs), computeRegistryDigest(none), "有无 anyOfArgs 摘要不同");
});

test("facade 预检：三通道全空 → error 且不建 pending", async () => {
  const f = makeFixture();
  const out = await f.facade.executeWorkflow({ ...EXEC, args: { account_slot: 2 } });
  assert.match(out.error ?? "", /缺少定位参数/);
  assert.equal(f.pending.pendingFor("u1").length, 0, "不建 pending");
  assert.equal(f.created.length, 0, "不触发 onPendingCreated");
});

test("facade 预检：vault_ref 歧义 → error 带候选且不建 pending", async () => {
  const f = makeFixture();
  const out = await f.facade.executeWorkflow({ ...EXEC, args: { vault_ref: "笔记" } });
  assert.match(out.error ?? "", /文章定位失败（未创建审批/);
  assert.match(out.error ?? "", /dup\/A\/笔记\.md/, "候选返回给 Agent");
  assert.equal(f.pending.pendingFor("u1").length, 0);
});

test("facade 预检：vault_ref 解析成功 → 服务端锚点覆盖外部 + resolvedTarget", async () => {
  const f = makeFixture();
  // 外部（LLM）伪造锚点：必须被服务端值覆盖
  const out = await f.facade.executeWorkflow({
    ...EXEC,
    args: { vault_ref: "单篇", vault_ref_pinned_rel: "恶意/伪造/锚点" },
  });
  if (!("needsApproval" in out)) assert.fail("应进入审批分支");
  assert.equal(out.resolvedTarget, "公众号/AI入门/单篇");
  const [action] = f.pending.pendingFor("u1");
  assert.ok(action, "pending 已建立");
  assert.equal((action.args as Record<string, unknown>).vault_ref_pinned_rel, "公众号/AI入门/单篇", "服务端锚点覆盖外部");
  assert.equal(action.argsDigest, computeArgsDigest(action.args), "argsDigest 与锚点后参数一致");
  assert.equal(action.resolvedTarget, "公众号/AI入门/单篇");
  assert.equal(f.created.length, 1, "onPendingCreated 触发一次");
});

test("facade：article_dir 通道 → 不做 vault 解析直接建 pending（兼容）", async () => {
  const f = makeFixture();
  const out = await f.facade.executeWorkflow({
    ...EXEC,
    args: { article_dir: "/abs/some/article" },
  });
  if (!("needsApproval" in out)) assert.fail("应进入审批分支");
  assert.equal(out.resolvedTarget, undefined, "无 vault 解析即无 resolvedTarget");
  const [action] = f.pending.pendingFor("u1");
  assert.equal((action.args as Record<string, unknown>).vault_ref_pinned_rel, undefined, "不注入锚点");
});

test("facade 去重：同 vault_ref 重复发起 → 同 actionId（不叠加 pending）", async () => {
  const f = makeFixture();
  const a1 = await f.facade.executeWorkflow({ ...EXEC, args: { vault_ref: "单篇" } });
  // 完全相同的参数重试（LLM 重试场景）才去重；参数不同属于新请求
  const a2 = await f.facade.executeWorkflow({ ...EXEC, args: { vault_ref: "单篇" } });
  if (!("needsApproval" in a1) || !("needsApproval" in a2)) assert.fail("两次都应进审批分支");
  assert.equal(a1.actionId, a2.actionId, "同 actionId");
  assert.equal(f.pending.pendingFor("u1").length, 1);
});

test("审批卡：三要素（workflowId/resolvedTarget/actionId）确定性生成", () => {
  const card = renderPendingActionApproval({
    actionId: "pa-abc12345",
    userId: "u1",
    workflowId: "article-inspect",
    args: {},
    argsDigest: "x",
    riskLevel: "write",
    registryDigest: "y",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    status: "pending",
    resolvedTarget: "公众号/AI入门/单篇",
  });
  for (const token of ["article-inspect", "公众号/AI入门/单篇", "pa-abc12345", "批准", "拒绝"]) {
    assert.ok(card.includes(token), `审批卡含 ${token}`);
  }
});

test("审批卡：无 resolvedTarget 时不渲染目标行", () => {
  const bare = renderPendingActionApproval({
    actionId: "pa-x",
    userId: "u1",
    workflowId: "deploy",
    args: {},
    argsDigest: "x",
    riskLevel: "write",
    registryDigest: "y",
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    status: "pending",
  });
  assert.ok(!bare.includes("目标："));
});

// ── article_inspect.js 真实文件接线（无 LLM：structured runner 回 canned 结果） ──
const INSPECT_SCRIPT = fs.readFileSync(
  path.resolve("dev-examples/wx-article/scripts/article_inspect.js"),
  "utf8",
);
const INSPECT_VR = { scriptPath: RESOLVER_SCRIPT, vaultRoot: FIXTURE_VAULT };
const inspectRunner = {
  async run() {
    return {
      type: "structured" as const,
      sessionId: "fake",
      value: {
        raw: JSON.stringify({ article_dir: "(来自检查脚本)" }),
        ok: true,
        article_dir: "(来自检查脚本)",
        needs_insert: false,
        prepare_ready: true,
        yaml_missing: [],
        cover_state: "root",
        issues: [],
        state_accounts: {},
        md_name: "唯一.md",
      },
    };
  },
};

test("article_inspect：vault_ref 三 vault 通道全链路（定位→锚点一致→检查 agent 执行）", async () => {
  const result = await runWorkflow(INSPECT_SCRIPT, {
    agent: inspectRunner,
    args: { vault_ref: "单篇", vault_ref_pinned_rel: "公众号/AI入门/单篇" },
    vaultResolver: INSPECT_VR,
  });
  assert.equal(result.result.ok, true);
  // article_dir 取检查脚本返回值（workflow 契约）；vault 定位路径体现在定位日志与 --article-dir 传参
  assert.equal(result.result.article_dir, "(来自检查脚本)");
  assert.equal(result.agents.length, 1, "检查 agent 执行一次");
  assert.ok(result.logs.some((l: string) => l.includes("vault 定位: 单篇 -> 公众号/AI入门/单篇")));
});

test("article_inspect：锚点漂移 → CHECK_FAILED 中止，检查 agent 零执行", async () => {
  await assert.rejects(
    runWorkflow(INSPECT_SCRIPT, {
      agent: inspectRunner,
      args: { vault_ref: "单篇", vault_ref_pinned_rel: "公众号/AI入门/其他目录" },
      vaultResolver: INSPECT_VR,
    }),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === WorkflowErrorCode.CHECK_FAILED &&
      e.message.includes("批准目标不一致"),
  );
});
