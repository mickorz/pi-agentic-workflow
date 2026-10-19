/** P0-01：validate 拒绝错误 meta、非法脚本 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowScript } from "../../src/runtime/vm.js";

const valid = `export const meta = { name: "demo", description: "d", phases: [{ title: "a" }] }
return 1`;

test("合法脚本：meta 解析与剥离", () => {
  const { meta, body } = parseWorkflowScript(valid);
  assert.equal(meta.name, "demo");
  assert.equal(meta.phases?.[0]?.title, "a");
  assert.ok(!body.includes("export const meta"));
});

test("拒绝：首条语句不是 export const meta", () => {
  assert.throws(() => parseWorkflowScript("const x = 1\nexport const meta = { name: 'a' }"), /首条语句/);
});

test("拒绝：meta 含代码（非纯字面量）", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: `${Date.now()}` }"),
    /不允许|确定性/,
  );
});

test("拒绝：meta.name 非 snake_case", () => {
  assert.throws(() => parseWorkflowScript('export const meta = { name: "not-valid name!" }'), /snake_case/);
});

test("拒绝：meta 含稀疏数组 / spread / 计算属性", () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'a', phases: [, { title: 'x' }] }"), /稀疏/);
  assert.throws(() => parseWorkflowScript("export const meta = { ...x }"), /spread/);
});

test("拒绝：脚本使用 Date.now / Math.random / new Date()", () => {
  assert.throws(() => parseWorkflowScript(`${valid}\nconst t = Date.now()`), /确定性/);
  assert.throws(() => parseWorkflowScript(`${valid}\nconst r = Math.random()`), /确定性/);
  assert.throws(() => parseWorkflowScript(`${valid}\nconst d = new Date()`), /确定性/);
});

test("拒绝：保留键名（原型污染防护）", () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'a', __proto__: {} }"), /保留键名/);
});
