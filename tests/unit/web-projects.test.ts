/**
 * V2-P1-03 项目白名单 + 安全文件枚举 + workflow 解析校验测试（含 E13）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectRegistry, ProjectError } from "../../src/server/projects.js";

function tmpRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `v2-proj-${name}-`));
}

const GOOD_SCRIPT = `export const meta = { name: "demo", description: "d", phases: [{ title: "a" }, { title: "b" }] }
const x = await agent("hi")
return { x }`;

function assertCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`应抛 ${code}`);
  } catch (error) {
    assert.ok(error instanceof ProjectError, `ProjectError：${error}`);
    assert.equal((error as ProjectError).code, code);
  }
}

test("listProjects：白名单可见 + id 稳定 + 不可用根跳过并告警", () => {
  const base = tmpRoot("list");
  const a = path.join(base, "alpha");
  const b = path.join(base, "beta");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const reg = new ProjectRegistry([a, b, path.join(base, "missing")]);
  const projects = reg.listProjects();
  assert.equal(projects.length, 2);
  assert.deepEqual(
    projects.map((p) => p.id).sort(),
    ["alpha", "beta"],
  );
  assert.equal(reg.warnings.length, 1, "缺失根记入 warnings");
  // id 稳定性
  const reg2 = new ProjectRegistry([a, b]);
  assert.deepEqual(reg2.listProjects().map((p) => p.id).sort(), ["alpha", "beta"]);
});

test("同名目录冲突：id 带根哈希后缀去歧义", () => {
  const base = tmpRoot("dup");
  const d1 = path.join(base, "one", "dup");
  const d2 = path.join(base, "two", "dup");
  fs.mkdirSync(d1, { recursive: true });
  fs.mkdirSync(d2, { recursive: true });
  const reg = new ProjectRegistry([d1, d2]);
  const ids = reg.listProjects().map((p) => p.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.some((id) => id.startsWith("dup")));
});

test("E13：`..` 穿越与绝对路径被拒（FORBIDDEN_PATH）；未知项目不可见（NOT_FOUND）", () => {
  const base = tmpRoot("e13");
  const proj = path.join(base, "proj");
  const outside = path.join(base, "outside");
  fs.mkdirSync(proj);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.js"), GOOD_SCRIPT);
  const reg = new ProjectRegistry([proj]);

  assertCode(() => reg.resolveWorkflowPath("proj", "../outside/secret.js"), "FORBIDDEN_PATH");
  assertCode(() => reg.resolveWorkflowPath("proj", "a/../../outside/secret.js"), "FORBIDDEN_PATH");
  assertCode(() => reg.resolveWorkflowPath("proj", path.join(outside, "secret.js")), "FORBIDDEN_PATH");
  // 白名单外项目：不暴露存在性
  assertCode(() => reg.resolveWorkflowPath("outside", "secret.js"), "NOT_FOUND");
  // 正常解析
  fs.writeFileSync(path.join(proj, "ok.js"), GOOD_SCRIPT);
  const resolved = reg.resolveWorkflowPath("proj", "ok.js");
  assert.equal(resolved, path.join(fs.realpathSync(proj), "ok.js"));
});

test("symlink 越权：项目内符号链接指向白名单外 → realpath 校验拒绝", () => {
  const base = tmpRoot("symlink");
  const proj = path.join(base, "proj");
  const outside = path.join(base, "outside");
  fs.mkdirSync(proj);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.js"), GOOD_SCRIPT);
  fs.symlinkSync(path.join(outside, "secret.js"), path.join(proj, "link.js"));
  const reg = new ProjectRegistry([proj]);

  assertCode(() => reg.resolveWorkflowPath("proj", "link.js"), "FORBIDDEN_PATH");
  // 根本身是符号链接：构造期已 realpath，根内直链合法（macOS /var→/private/var 同理）
  const rootLink = path.join(base, "rootlink");
  fs.symlinkSync(proj, rootLink);
  const reg2 = new ProjectRegistry([rootLink]);
  fs.writeFileSync(path.join(proj, "ok.js"), GOOD_SCRIPT);
  const resolved = reg2.resolveWorkflowPath("proj", "ok.js");
  assert.ok(resolved.startsWith(fs.realpathSync(proj)));
});

test("listWorkflows：解析 meta 不执行；坏脚本带 error；跳过 node_modules/隐藏目录", () => {
  const base = tmpRoot("walk");
  const proj = path.join(base, "proj");
  fs.mkdirSync(path.join(proj, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".hidden"));
  fs.writeFileSync(path.join(proj, "good.js"), GOOD_SCRIPT);
  fs.writeFileSync(path.join(proj, "notmd.js"), `export const other = 1`);
  fs.writeFileSync(path.join(proj, ".hidden", "x.js"), GOOD_SCRIPT);
  fs.writeFileSync(path.join(proj, "node_modules", "y.js"), GOOD_SCRIPT);
  fs.writeFileSync(path.join(proj, "readme.txt"), "not js");

  const reg = new ProjectRegistry([proj]);
  const list = reg.listWorkflows("proj");
  assert.equal(list.length, 2);
  const good = list.find((w) => w.path === "good.js");
  assert.ok(good?.meta);
  assert.equal(good.meta!.name, "demo");
  assert.equal(good.meta!.phases?.length, 2);
  const bad = list.find((w) => w.path === "notmd.js");
  assert.ok(bad?.error, "无 meta 信封的脚本应带 error 列出");
  // 未知项目
  assertCode(() => reg.listWorkflows("nope"), "NOT_FOUND");
});

test("validateWorkflow：source 内联解析（不执行脚本体）+ args 大小限制", () => {
  const base = tmpRoot("validate");
  const proj = path.join(base, "proj");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "wf.js"), GOOD_SCRIPT);
  const reg = new ProjectRegistry([proj]);

  // 内联 source：body 含 agent() 调用但不执行
  const v1 = reg.validateWorkflow({ source: GOOD_SCRIPT });
  assert.equal(v1.meta.name, "demo");
  assert.equal(v1.phaseCount, 2);

  // 白名单文件路径
  const v2 = reg.validateWorkflow({ projectId: "proj", path: "wf.js", args: { k: 1 } });
  assert.equal(v2.meta.name, "demo");

  // 非法脚本 → INVALID_INPUT（不裸抛语法错）
  assertCode(() => reg.validateWorkflow({ source: "const x = 1" }), "INVALID_INPUT");
  // 确定性阻断同样映射为 INVALID_INPUT
  assertCode(
    () => reg.validateWorkflow({ source: `export const meta = { name: "d" }\nconst t = Date.now()` }),
    "INVALID_INPUT",
  );
  // args 超限
  const bigArgs = { blob: "x".repeat(70_000) };
  assertCode(() => reg.validateWorkflow({ source: GOOD_SCRIPT, args: bigArgs }), "INVALID_INPUT");
  // 缺参
  assertCode(() => reg.validateWorkflow({}), "INVALID_INPUT");
  // 白名单外文件读取被拒
  assertCode(() => reg.validateWorkflow({ projectId: "nope", path: "wf.js" }), "NOT_FOUND");
});
