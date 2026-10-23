/**
 * VR 阶段 B：vault-resolver 注入链（#14）+ vaultResolve 语义 + runtime DSL 接线（#11 await check 模式）
 * 方案：dev-docs/design/2026-10-23-vault-resolver-执行方案.md §S3.1/S3.2/S5
 *
 * 语义失败的下游断言遵循补丁 #11：check 失败后下游 agent（发布/写入类）必须零执行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VAULT_RESOLVER_ENV,
  resolveVaultResolverScript,
  detectPython,
  vaultResolve,
} from "../../src/runtime/vault-resolver.js";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/runtime/errors.js";

const dmDir = path.resolve("dev-examples/wx-article/scripts/draft_manager");
const resolverScript = path.join(dmDir, "vault_resolver.py");
const fixtureVault = path.join(dmDir, "test-fixture/vault");

/** 构造受控子进程环境：只保留 PATH/HOME，再叠加显式覆盖（可注入 PI_VAULT_RESOLVER_PATH / OBSIDIAN_VAULT_ROOT） */
const mkEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return { ...env, ...overrides };
};

const okRunner = () => makeRunner(async () => ({ type: "text" as const, value: "ok", sessionId: "s" }));

// python 可用性探测：无 python 的环境跳过执行类用例（不做假 PASS）
let pythonAvailable = true;
try {
  await detectPython(mkEnv());
} catch {
  pythonAvailable = false;
}
const itPy = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: pythonAvailable ? false : "无 python3/python 可执行" }, fn);

// ── 注入链（#14）：opts.scriptPath > PI_VAULT_RESOLVER_PATH > dev 兜底 ──

test("注入链：opts.scriptPath 优先于环境变量", () => {
  const r = resolveVaultResolverScript({
    scriptPath: resolverScript,
    cwd: os.tmpdir(),
    env: mkEnv({ [VAULT_RESOLVER_ENV]: "/nonexistent/other.py" }),
  });
  assert.equal(r.source, "opts");
  assert.equal(r.scriptPath, resolverScript);
});

test("注入链：环境变量次之（相对 cwd 解析），仓库外 cwd 可用", () => {
  const r = resolveVaultResolverScript({
    cwd: dmDir,
    env: mkEnv({ [VAULT_RESOLVER_ENV]: "vault_resolver.py" }),
  });
  assert.equal(r.source, "env");
  assert.equal(r.scriptPath, resolverScript);
});

test("注入链：仓库根 cwd 走 dev 兜底", () => {
  const r = resolveVaultResolverScript({ cwd: process.cwd(), env: mkEnv() });
  assert.equal(r.source, "dev");
  assert.ok(r.scriptPath.endsWith("vault_resolver.py"));
});

test("注入链：三级落空 → 明确报错并指引 PI_VAULT_RESOLVER_PATH", () => {
  assert.throws(
    () => resolveVaultResolverScript({ cwd: os.tmpdir(), env: mkEnv() }),
    (e: unknown) => e instanceof Error && e.message.includes(VAULT_RESOLVER_ENV),
  );
});

test("注入链：opts / env 指向不存在的脚本 → 配置类报错（不静默）", () => {
  assert.throws(() => resolveVaultResolverScript({ scriptPath: "/nonexistent/vr.py", env: mkEnv() }), /不存在/);
  assert.throws(
    () => resolveVaultResolverScript({ cwd: os.tmpdir(), env: mkEnv({ [VAULT_RESOLVER_ENV]: "/nonexistent/vr.py" }) }),
    /不存在/,
  );
});

// ── vaultResolve 语义（真实脚本 + fixture；仓库外 cwd 通道验证） ──

itPy("唯一文章定位（want=article）：目录正文唯一 → dir + md 字段", async () => {
  const r = await vaultResolve("单篇", {
    want: "article",
    vaultRoot: fixtureVault,
    scriptPath: resolverScript,
    cwd: os.tmpdir(),
    env: mkEnv(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.path_type, "dir");
  assert.equal(r.resolved_rel, "公众号/AI入门/单篇");
  assert.equal(r.md, "唯一.md");
});

itPy("歧义绝不猜：双候选列清单、resolved_rel 缺席", async () => {
  const r = await vaultResolve("笔记", {
    want: "any",
    vaultRoot: fixtureVault,
    scriptPath: resolverScript,
    cwd: os.tmpdir(),
    env: mkEnv(),
  });
  assert.equal(r.ok, false);
  assert.ok(!r.resolved_rel);
  assert.equal((r.candidates ?? []).length, 2);
});

itPy("scope 硬约束：精确路径命中也必须落在 scope 内", async () => {
  const r = await vaultResolve("公众号/AI入门/单篇", {
    scope: "newsky",
    vaultRoot: fixtureVault,
    scriptPath: resolverScript,
    cwd: os.tmpdir(),
    env: mkEnv(),
  });
  assert.equal(r.ok, false);
  assert.ok((r.issues ?? []).some((i) => i.includes("scope") || i.includes("范围")));
});

itPy("大小写逐段校验：prompt.md 不命中 Prompt.md，issues 提示实际名", async () => {
  const r = await vaultResolve("公众号/AI入门/prompt.md", {
    vaultRoot: fixtureVault,
    scriptPath: resolverScript,
    cwd: os.tmpdir(),
    env: mkEnv(),
  });
  assert.equal(r.ok, false);
  assert.ok(JSON.stringify(r.issues ?? []).includes("Prompt.md"));
});

itPy("注入字符全字面量：ref 含 shell 元字符仅作单参数，不执行", async () => {
  const r = await vaultResolve('a";rm -rf /', {
    vaultRoot: fixtureVault,
    scriptPath: resolverScript,
    cwd: os.tmpdir(),
    env: mkEnv(),
  });
  assert.equal(r.ok, false);
  assert.ok((r.issues ?? []).some((i) => i.includes("路径不存在")));
});

itPy("超时返回 ok:false 而非抛错（语义失败走 check）", async () => {
  const r = await vaultResolve("单篇", {
    vaultRoot: fixtureVault,
    scriptPath: resolverScript,
    cwd: os.tmpdir(),
    env: mkEnv(),
    timeoutMs: 1,
  });
  assert.equal(r.ok, false);
  assert.ok((r.issues ?? []).some((i) => i.includes("超时")));
});

itPy("仓库外 cwd + 环境变量通道：解析成功（不依赖仓库根）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vr-outside-"));
  try {
    const r = await vaultResolve("单篇", {
      want: "article",
      vaultRoot: fixtureVault,
      cwd: tmp,
      env: mkEnv({ [VAULT_RESOLVER_ENV]: resolverScript }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.resolved_rel, "公众号/AI入门/单篇");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

itPy("仓库外 cwd 且无任何通道 → vaultResolve 抛配置错误", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vr-missing-"));
  try {
    await assert.rejects(
      vaultResolve("单篇", { vaultRoot: fixtureVault, cwd: tmp, env: mkEnv() }),
      (e: unknown) => e instanceof Error && e.message.includes(VAULT_RESOLVER_ENV),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("非法入参确定性返回 ok:false（不抛错）：空 ref / 非法 want / 非对象 options", async () => {
  assert.equal((await vaultResolve("", { scriptPath: resolverScript })).ok, false);
  const badWant = await vaultResolve("x", {
    scriptPath: resolverScript,
    want: "bogus" as "dir",
  });
  assert.equal(badWant.ok, false);
  assert.ok(JSON.stringify(badWant.issues ?? []).includes("want"));
});

// ── runtime DSL 接线（#11：await check 模式 + 失败态下游零执行 + S4.3 锚点） ──

const vrOptions = {
  vaultResolver: {
    scriptPath: resolverScript,
    env: mkEnv({ OBSIDIAN_VAULT_ROOT: fixtureVault }),
  },
};

itPy("DSL：vaultResolve + await check 通过 → 下游 agent 执行", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "vr_dsl_ok" }
const r = await vaultResolve("单篇", { want: "article" })
await check(() => r.ok === true, "文章定位失败")
await agent("inspect", { label: "inspect" })
return r.resolved_rel`;
  const result = await runWorkflow(script, { agent: runner, ...vrOptions });
  assert.equal(result.result, "公众号/AI入门/单篇");
  assert.equal(result.agents.length, 1);
});

itPy("DSL：定位失败 → await check 抛 CHECK_FAILED，sequence 停止，下游发布 agent 零执行（#11）", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "vr_dsl_fail" }
let r = null
const out = await sequence([
  () => agent("inspect", { label: "inspect" }),
  async () => { r = await vaultResolve("笔记", { want: "article" }); return r },
  () => check(() => r.ok === true, "文章定位失败: " + JSON.stringify({ issues: r.issues, candidates: r.candidates })),
  () => agent("publish", { label: "publish" }),
])
return out`;
  const result = await runWorkflow(script, { agent: runner, ...vrOptions });
  assert.equal(result.result, null);
  assert.equal(result.agents.length, 1, "publish 不应执行（下游零写入）");
  assert.ok(result.logs.some((l) => l.includes("文章定位失败")));
});

itPy("DSL：锚点一致（vault_ref_pinned_rel）→ 通过", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "vr_pin_ok" }
const r = await vaultResolve(args.vault_ref, { want: "article" })
await check(() => r.ok === true, "文章定位失败")
if (args.vault_ref_pinned_rel) {
  await check(() => r.resolved_rel === args.vault_ref_pinned_rel, "定位结果与批准目标不一致，请重新授权")
}
await agent("publish", { label: "publish" })
return r.resolved_rel`;
  const result = await runWorkflow(script, {
    agent: runner,
    ...vrOptions,
    args: { vault_ref: "单篇", vault_ref_pinned_rel: "公众号/AI入门/单篇" },
  });
  assert.equal(result.result, "公众号/AI入门/单篇");
  assert.equal(result.agents.length, 1);
});

itPy("DSL：锚点漂移（批准 A 实际解析 B）→ CHECK_FAILED 中止，下游零执行（S4.3/#11）", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "vr_pin_drift" }
const r = await vaultResolve(args.vault_ref, { want: "article" })
await check(() => r.ok === true, "文章定位失败")
if (args.vault_ref_pinned_rel) {
  await check(() => r.resolved_rel === args.vault_ref_pinned_rel, "定位结果与批准目标不一致，请重新授权")
}
await agent("publish", { label: "publish" })
return r.resolved_rel`;
  await assert.rejects(
    runWorkflow(script, {
      agent: runner,
      ...vrOptions,
      args: { vault_ref: "单篇", vault_ref_pinned_rel: "公众号/AI入门/其他目录" },
    }),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === WorkflowErrorCode.CHECK_FAILED &&
      e.message.includes("批准目标不一致"),
  );
});

itPy("DSL：resolver 配置缺失 → 结构性报错指引 PI_VAULT_RESOLVER_PATH（不静默成功）", async () => {
  const { runner } = okRunner();
  const script = `export const meta = { name: "vr_no_cfg" }
const r = await vaultResolve("单篇", { want: "article" })
await check(() => r.ok === true, "文章定位失败")
await agent("publish", { label: "publish" })
return r`;
  // cwd 指向仓库外 tmp 且 env 无通道（mkEnv 不含 PI_VAULT_RESOLVER_PATH）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vr-dsl-nocfg-"));
  try {
    await assert.rejects(
      runWorkflow(script, {
        agent: runner,
        cwd: tmp,
        vaultResolver: { env: mkEnv({ OBSIDIAN_VAULT_ROOT: fixtureVault }) },
      }),
      (e: unknown) => e instanceof Error && e.message.includes(VAULT_RESOLVER_ENV),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
