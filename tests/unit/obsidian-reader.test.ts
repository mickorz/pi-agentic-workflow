/**
 * P1a Phase R：ObsidianReader 注入链 + vault_query.py 契约 + runtime DSL `obsidian` 接线
 * 方案：dev-docs/design/2026-10-23-p1a-obsidian-service-执行方案.md §1/§4/§5
 *
 * 覆盖（§6 Phase R 出口）：命中 / 零命中 / truncated / 大小写 / scope / 大文件跳过 /
 * 预算超时 / 排序稳定 + 注入链三级 + obsidian.config.json 新配置链 + readNote 上限 + DSL 注入。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VAULT_QUERY_ENV,
  MAX_LIST_LIMIT,
  resolveVaultQueryScript,
  createObsidianReader,
  vaultQueryRead,
  vaultQuerySearch,
  vaultQueryCanonicalize,
} from "../../src/runtime/obsidian-reader.js";
import { detectPython } from "../../src/runtime/vault-resolver.js";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";

const dmDir = path.resolve("dev-examples/wx-article/scripts/draft_manager");
const queryScript = path.join(dmDir, "vault_query.py");

/** 受控子进程环境：只保留 PATH/HOME，再叠加显式覆盖（可注入 PI_VAULT_QUERY_PATH / OBSIDIAN_VAULT_ROOT） */
const mkEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return { ...env, ...overrides };
};

// python 可用性探测：无 python 的环境跳过执行类用例（不做假 PASS）
let pythonAvailable = true;
try {
  await detectPython(mkEnv());
} catch {
  pythonAvailable = false;
}
const itPy = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: pythonAvailable ? false : "无 python3/python 可执行" }, fn);

const okRunner = () => makeRunner(async () => ({ type: "text" as const, value: "ok", sessionId: "s" })).runner;

// ── 测试 fixture vault（每用例独立构建；含中文/emoji/引号毒字符串）──

interface Fixture {
  root: string; // 工作区根（含 obsidian.config.json）
  vault: string;
}

function buildFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-obs-reader-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(path.join(vault, "灵感"), { recursive: true });
  fs.mkdirSync(path.join(vault, "公众号", "AI入门"), { recursive: true });
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(vault, "imgs"), { recursive: true });
  fs.writeFileSync(path.join(vault, "灵感", "AI 自动化测试.md"), "AI 自动化测试的第一条灵感，含关键词 uniqueTokenABC。\n第二行 \"引号\" 与 emoji 😀。");
  fs.writeFileSync(path.join(vault, "灵感", "笔记 B.md"), "笔记B正文，含 keywordZZZ。");
  fs.writeFileSync(path.join(vault, "公众号", "AI入门", "唯一.md"), "唯一正文 uniqueTokenABC");
  fs.writeFileSync(path.join(vault, ".obsidian", "app.json"), "{}"); // 剪枝：不出现
  fs.writeFileSync(path.join(vault, "imgs", "x.md"), "图片目录剪枝"); // 剪枝：不出现
  fs.writeFileSync(path.join(vault, ".hidden.md"), "隐藏项剪枝"); // 剪枝：不出现
  // §4 大文件：>2MB 跳过计 skipped_large
  fs.mkdirSync(path.join(vault, "big"));
  fs.writeFileSync(path.join(vault, "big", "large.md"), "x".repeat(2 * 1024 * 1024 + 16));
  return { root, vault };
}

function cleanup(f: Fixture) {
  fs.rmSync(f.root, { recursive: true, force: true });
}

/** reader 选项：显式注入脚本 + vaultRoot flag（不依赖环境配置） */
const directOpts = (f: Fixture) => ({
  scriptPath: queryScript,
  vaultRoot: f.vault,
  env: mkEnv(),
});

// ── 注入链（三级，与 vault-resolver 同款）──

test("注入链：opts.scriptPath 优先于环境变量", () => {
  const r = resolveVaultQueryScript({
    scriptPath: queryScript,
    cwd: os.tmpdir(),
    env: mkEnv({ [VAULT_QUERY_ENV]: "/nonexistent/other.py" }),
  });
  assert.equal(r.source, "opts");
  assert.equal(r.scriptPath, queryScript);
});

test("注入链：环境变量次之（相对 cwd 解析），仓库外 cwd 可用", () => {
  const r = resolveVaultQueryScript({
    cwd: dmDir,
    env: mkEnv({ [VAULT_QUERY_ENV]: "vault_query.py" }),
  });
  assert.equal(r.source, "env");
  assert.equal(r.scriptPath, queryScript);
});

test("注入链：仓库根 cwd 走 dev 兜底", () => {
  const r = resolveVaultQueryScript({ cwd: process.cwd(), env: mkEnv() });
  assert.equal(r.source, "dev");
  assert.ok(r.scriptPath.endsWith("vault_query.py"));
});

test("注入链：三级落空 → 明确报错并指引 PI_VAULT_QUERY_PATH", () => {
  assert.throws(
    () => resolveVaultQueryScript({ cwd: os.tmpdir(), env: mkEnv() }),
    (e: unknown) => e instanceof Error && e.message.includes(VAULT_QUERY_ENV),
  );
});

// ── listNotes 契约 ──

itPy("listNotes 命中：中文路径/标题/snippet/mtime；剪枝 .obsidian/imgs/隐藏项", async () => {
  const f = buildFixture();
  try {
    const r = await createObsidianReader(directOpts(f)).listNotes({});
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.total, 3);
    assert.equal(r.truncated, false);
    const paths = r.items.map((i) => i.path);
    assert.ok(paths.includes("灵感/AI 自动化测试.md"));
    const item = r.items.find((i) => i.path === "灵感/AI 自动化测试.md")!;
    assert.equal(item.title, "AI 自动化测试");
    assert.ok((item.snippet ?? "").includes("uniqueTokenABC"));
    assert.match(item.mtime ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // 剪枝项绝不出现
    for (const p of paths) {
      assert.ok(!p.startsWith(".obsidian") && !p.startsWith("imgs") && !p.startsWith("."), p);
    }
  } finally {
    cleanup(f);
  }
});

itPy("listNotes 排序稳定：路径字典序 + 两次调用输出全等", async () => {
  const f = buildFixture();
  try {
    const reader = createObsidianReader(directOpts(f));
    const a = await reader.listNotes({});
    const b = await reader.listNotes({});
    assert.equal(a.ok, true);
    if (!a.ok) return;
    const paths = a.items.map((i) => i.path);
    const sorted = [...paths].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    assert.deepEqual(paths, sorted);
    assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  } finally {
    cleanup(f);
  }
});

itPy("listNotes truncated：limit 截断且 total 反映全集", async () => {
  const f = buildFixture();
  try {
    const r = await createObsidianReader(directOpts(f)).listNotes({ limit: 1 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.items.length, 1);
    assert.equal(r.total, 3);
    assert.equal(r.truncated, true);
  } finally {
    cleanup(f);
  }
});

itPy("listNotes 大文件跳过：>2MB 不进 items，计入 skipped_large，total 不含", async () => {
  const f = buildFixture();
  try {
    const r = await createObsidianReader(directOpts(f)).listNotes({});
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.skipped_large, 1);
    assert.ok(!r.items.some((i) => i.path === "big/large.md"));
    assert.equal(r.total, 3); // large.md 不计入
  } finally {
    cleanup(f);
  }
});

itPy("listNotes 预算超时：budget 0 → truncated + truncated_reason=scan_budget", async () => {
  const f = buildFixture();
  try {
    // budgetMs 为测试通道（后端 --budget-ms 旗标；缺省 10000）
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const python = await detectPython(mkEnv());
    const { stdout } = await promisify(execFile)(
      python,
      [queryScript, "--action", "list", "--vault-root", f.vault, "--budget-ms", "0"],
      { env: mkEnv(), timeout: 30_000 },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.truncated_reason, "scan_budget");
  } finally {
    cleanup(f);
  }
});

itPy("listNotes scope：硬约束过滤 + scope 不存在 → ok:false", async () => {
  const f = buildFixture();
  try {
    const reader = createObsidianReader(directOpts(f));
    const r = await reader.listNotes({ scope: "灵感" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.total, 2);
    assert.ok(r.items.every((i) => i.path.startsWith("灵感/")));
    const bad = await reader.listNotes({ scope: "不存在" });
    assert.equal(bad.ok, false);
    assert.ok((bad as { issues: string[] }).issues.some((i) => i.includes("scope")));
  } finally {
    cleanup(f);
  }
});

itPy("配置链（§5）：仓库根 obsidian.config.json + scope_aliases 别名生效（无 --vault-root）", async () => {
  const f = buildFixture();
  try {
    fs.writeFileSync(path.join(f.root, "obsidian.config.json"), JSON.stringify({
      vault_root: f.vault,
      scope_aliases: { 灵感集: "灵感" },
    }));
    const reader = createObsidianReader({ scriptPath: queryScript, cwd: f.root, env: mkEnv() });
    const r = await reader.listNotes({ scope: "灵感集" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.total, 2);
    assert.ok(r.items.every((i) => i.path.startsWith("灵感/")));
  } finally {
    cleanup(f);
  }
});

// ── readNote 契约 ──

itPy("readNote 全文契约：中文/引号/emoji/换行原样返回 + size 正确", async () => {
  const f = buildFixture();
  try {
    const r = await vaultQueryRead({ path: "灵感/AI 自动化测试.md" }, directOpts(f));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const expected = 'AI 自动化测试的第一条灵感，含关键词 uniqueTokenABC。\n第二行 "引号" 与 emoji 😀。';
    assert.equal(r.content, expected);
    assert.equal(r.title, "AI 自动化测试");
    assert.equal(Buffer.byteLength(expected, "utf-8"), r.size);
  } finally {
    cleanup(f);
  }
});

itPy("readNote 超限/缺失/越界：512KB 上限报错带尺寸；不存在 ok:false；../ 与绝对路径确定性拒绝", async () => {
  const f = buildFixture();
  try {
    const opts = directOpts(f);
    const over = await vaultQueryRead({ path: "big/large.md" }, opts);
    assert.equal(over.ok, false);
    if (!over.ok) {
      assert.ok(over.issues.some((i) => i.includes("512KB")), JSON.stringify(over.issues));
      assert.equal(over.size, 2 * 1024 * 1024 + 16);
    }
    const missing = await vaultQueryRead({ path: "灵感/不存在.md" }, opts);
    assert.equal(missing.ok, false);
    const escape1 = await vaultQueryRead({ path: "../outside.md" }, opts);
    assert.equal(escape1.ok, false);
    const escape2 = await vaultQueryRead({ path: "/etc/passwd" }, opts);
    assert.equal(escape2.ok, false);
    // 毒字符串：路径含 shell 元字符 → 只作单参数传递，不执行
    const poison = await vaultQueryRead({ path: 'a";rm -rf /.md' }, opts);
    assert.equal(poison.ok, false);
  } finally {
    cleanup(f);
  }
});

// ── searchNotes 契约 ──

itPy("searchNotes 大小写不敏感：小写 query 命中中文+英文混合标题与正文", async () => {
  const f = buildFixture();
  try {
    const r = await vaultQuerySearch({ query: "ai 自动化" }, directOpts(f));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.total, 1);
    assert.equal(r.items[0]!.path, "灵感/AI 自动化测试.md");
  } finally {
    cleanup(f);
  }
});

itPy("searchNotes 零命中：确定性 ok:true + total 0（不是失败）", async () => {
  const f = buildFixture();
  try {
    const r = await vaultQuerySearch({ query: "绝对不存在的词xyzq" }, directOpts(f));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.total, 0);
    assert.deepEqual(r.items, []);
    assert.equal(r.truncated, false);
  } finally {
    cleanup(f);
  }
});

itPy("searchNotes mode 隔离：name 只搜路径；content 只搜正文；snippet ≤120 字含命中窗口", async () => {
  const f = buildFixture();
  try {
    const opts = directOpts(f);
    // keywordZZZ 只在正文：name 模式零命中，content 模式命中
    const byName = await vaultQuerySearch({ query: "keywordzzz", mode: "name" }, opts);
    assert.equal(byName.ok, true);
    if (byName.ok) assert.equal(byName.total, 0);
    const byContent = await vaultQuerySearch({ query: "keywordzzz", mode: "content" }, opts);
    assert.equal(byContent.ok, true);
    if (byContent.ok) {
      assert.equal(byContent.total, 1);
      assert.equal(byContent.items[0]!.path, "灵感/笔记 B.md");
      assert.ok((byContent.items[0]!.snippet ?? "").includes("keywordZZZ"));
    }
    // snippet 长度契约
    const both = await vaultQuerySearch({ query: "uniqueTokenABC" }, opts);
    if (both.ok) {
      for (const item of both.items) {
        assert.ok((item.snippet ?? "").length <= 120);
      }
    }
  } finally {
    cleanup(f);
  }
});

itPy("searchNotes scope + truncated + 大文件跳过", async () => {
  const f = buildFixture();
  try {
    const opts = directOpts(f);
    const scoped = await vaultQuerySearch({ query: "uniqueTokenABC", scope: "灵感" }, opts);
    assert.equal(scoped.ok, true);
    if (scoped.ok) {
      assert.equal(scoped.total, 1);
      // scope 硬约束：big/ 在 scope 外不进扫描，skipped_large 不误报
    }
    // 无 scope：big/large.md 进入扫描且被跳过计数
    const unscoped = await vaultQuerySearch({ query: "uniqueTokenABC" }, opts);
    if (unscoped.ok) assert.equal(unscoped.skipped_large, 1);
    const limited = await vaultQuerySearch({ query: "n" /* 公众号/唯一.md 等命中 */, limit: 1 }, opts);
    if (limited.ok) {
      assert.equal(limited.truncated, true);
      assert.equal(limited.items.length, 1);
    }
  } finally {
    cleanup(f);
  }
});

test("非法入参确定性 ok:false（不抛错）：空 query / 非法 mode / 越界 limit / 非法 scope", async () => {
  const reader = createObsidianReader({ scriptPath: queryScript, env: mkEnv() });
  const badQuery = await reader.searchNotes({ query: "  " });
  assert.equal(badQuery.ok, false);
  const badMode = await reader.searchNotes({ query: "x", mode: "bogus" as "name" });
  assert.equal(badMode.ok, false);
  const badLimit = await reader.listNotes({ limit: MAX_LIST_LIMIT + 1 });
  assert.equal(badLimit.ok, false);
  const badScope = await reader.listNotes({ scope: "../etc" });
  assert.equal(badScope.ok, false);
  const badPath = await reader.readNote({ path: "" });
  assert.equal(badPath.ok, false);
});

// ── runtime DSL `obsidian` 全局注入（§3：全 workflow 可用）──

itPy("DSL 注入：workflow 脚本内 await obsidian.listNotes / searchNotes（env 通道注入 vault）", async () => {
  const f = buildFixture();
  try {
    const script = `
export const meta = { name: "obs_reader_probe", description: "reader DSL probe" };
await agent("probe", { label: "probe" });
const list = await obsidian.listNotes({ scope: "灵感" });
const search = await obsidian.searchNotes({ query: "uniqueTokenABC" });
return { listTotal: list.total, listFirst: list.items[0].path, searchTotal: search.total };
`;
    const result = await runWorkflow(script, {
      agent: okRunner(),
      cwd: f.root,
      obsidian: {
        scriptPath: queryScript,
        env: mkEnv({ OBSIDIAN_VAULT_ROOT: f.vault }),
      },
    });
    // vm 跨 realm 对象：JSON 往返拉回主 realm 再比对
    assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
      listTotal: 2,
      listFirst: "灵感/AI 自动化测试.md",
      searchTotal: 2,
    });
  } finally {
    cleanup(f);
  }
});

itPy("DSL 注入：语义失败走 ok:false（脚本可用 check 转可恢复失败，#11 约定）", async () => {
  const f = buildFixture();
  try {
    const script = `
export const meta = { name: "obs_reader_fail_probe", description: "reader fail probe" };
await agent("probe", { label: "probe" });
const r = await obsidian.readNote({ path: "不存在.md" });
return r;
`;
    const result = await runWorkflow(script, {
      agent: okRunner(),
      cwd: f.root,
      obsidian: {
        scriptPath: queryScript,
        env: mkEnv({ OBSIDIAN_VAULT_ROOT: f.vault }),
      },
    });
    const r = result.result as { ok: boolean; issues?: string[] };
    assert.equal(r.ok, false);
    assert.ok((r.issues ?? []).some((i) => i.includes("不存在")));
  } finally {
    cleanup(f);
  }
});

itPy("canonicalize：scope_aliases 目录前缀 + file_aliases 文件名锚定（cwd 配置链）", async () => {
  const f = buildFixture();
  fs.writeFileSync(
    path.join(f.root, "obsidian.config.json"),
    JSON.stringify({
      vault_root: f.vault,
      scope_aliases: { 灵感: "60_Workspace/写作/灵感" },
      file_aliases: { "idea.md": "0-idea.md" },
    }),
  );
  const opts = { scriptPath: queryScript, cwd: f.root, env: mkEnv() };
  // ① 双别名改写：目录前缀 + 文件名
  const r1 = await vaultQueryCanonicalize({ path: "灵感/标题甲/idea.md" }, opts);
  assert.ok(r1.ok, JSON.stringify(r1));
  if (r1.ok) {
    assert.equal(r1.rel, "60_Workspace/写作/灵感/标题甲/0-idea.md");
    assert.equal(r1.rewritten, true);
  }
  // ② 无别名命中：原样返回（非默认文件名不动）
  const r2 = await vaultQueryCanonicalize({ path: "30_Content/草稿/正文.md" }, opts);
  assert.ok(r2.ok && r2.rewritten === false && r2.rel === "30_Content/草稿/正文.md", JSON.stringify(r2));
  // ③ 已是规范路径：不重复改写（幂等）
  const r3 = await vaultQueryCanonicalize({ path: "60_Workspace/写作/灵感/标题甲/0-idea.md" }, opts);
  assert.ok(r3.ok && r3.rewritten === false, JSON.stringify(r3));
  // ④ 非法 rel：拒绝（后缀 .md 约束由写侧 validWriteRel 先行把关，后端只做通用锚定）
  const r4 = await vaultQueryCanonicalize({ path: "../evil.md" }, opts);
  assert.ok(!r4.ok, JSON.stringify(r4));
  const r5 = await vaultQueryCanonicalize({ path: "/abs/evil.md" }, opts);
  assert.ok(!r5.ok, JSON.stringify(r5));
  fs.rmSync(f.root, { recursive: true, force: true });
});
