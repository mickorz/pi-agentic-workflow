/** P0-05（工具 profile 部分）：explore 无写工具，general 可写 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveToolProfile, EXPLORE_TOOLS, GENERAL_TOOLS } from "../../src/adapters/pi/tool-profiles.js";

test("explore profile：只读工具，无 bash/edit/write", () => {
  const tools = resolveToolProfile("explore");
  assert.deepEqual(tools, [...EXPLORE_TOOLS]);
  for (const dangerous of ["bash", "edit", "write"]) {
    assert.ok(!tools.includes(dangerous), `explore 不应包含 ${dangerous}`);
  }
});

test("缺省 agentType = explore（安全缺省）", () => {
  assert.deepEqual(resolveToolProfile(undefined), [...EXPLORE_TOOLS]);
});

test("general profile：含写能力", () => {
  const tools = resolveToolProfile("general");
  assert.deepEqual(tools, [...GENERAL_TOOLS]);
  for (const needed of ["read", "bash", "edit", "write"]) {
    assert.ok(tools.includes(needed), `general 应包含 ${needed}`);
  }
});

test("未知 agentType 抛结构性错误（不静默降级）", () => {
  assert.throws(() => resolveToolProfile("admin"), /unknown agentType/);
});
