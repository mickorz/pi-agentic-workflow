/**
 * 集成测试：真实 Pi SDK Adapter
 *
 * 运行条件：本机配置了至少一个可用模型凭证（ModelRuntime.getAvailable() 非空）。
 * 无凭证时全部 skip（明确标记，不误报为通过）。
 * 运行：PI_WORKFLOW_INTEGRATION=1 npm run test:integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAgentAdapter } from "../../src/adapters/pi/pi-agent-adapter.js";
import { ModelResolver } from "../../src/adapters/pi/model-resolver.js";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";

const explicit = process.env.PI_WORKFLOW_INTEGRATION === "1";

async function findModelSpec(): Promise<string | undefined> {
  try {
    const runtime = await ModelRuntime.create();
    const available = await runtime.getAvailable();
    return available[0] ? `${available[0].provider}/${available[0].id}` : undefined;
  } catch {
    return undefined;
  }
}

test("前置：检查可用模型凭证", { skip: !explicit ? "set PI_WORKFLOW_INTEGRATION=1 to run" : false }, async (t) => {
  const spec = await findModelSpec();
  const resolver = new ModelResolver();
  const has = await resolver.hasCredentials();
  if (!spec || !has) return t.skip("无可用模型凭证（getAvailable 为空），跳过真实 SDK 测试");

  await t.test("P0-02：真实 smoke —— 单 agent 完成且结果非空", async () => {
    const adapter = new PiAgentAdapter({ defaultModel: spec });
    const result = await runWorkflow(
      'export const meta = { name: "smoke" }\nconst r = await agent("Reply with exactly: integration ok")\nreturn r',
      { agent: adapter, agentTimeoutMs: 120_000 },
    );
    assert.ok(typeof result.result === "string" && result.result.trim().length > 0, "结果非空");
    assert.equal(result.agents[0]?.status, "ok");
    assert.ok(result.agents[0]?.sessionId, "sessionId 已回填");
  });

  await t.test("P0-05：explore 工具在隔离目录中不能写文件", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-explore-"));
    try {
      const adapter = new PiAgentAdapter({ defaultModel: spec, cwd: tmp });
      const script = `export const meta = { name: "explore_write" }
const r = await agent("Use your write tool to create a file named pwned.txt in the current directory containing 'x'. If you cannot, report which tools you actually have.", { label: "try-write" })
return r`;
      const result = await runWorkflow(script, { agent: adapter, agentTimeoutMs: 120_000, cwd: tmp });
      assert.equal(result.agents[0]?.status, "ok");
      assert.equal(existsSync(path.join(tmp, "pwned.txt")), false, "explore 不得写出 pwned.txt");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  await t.test("P0-05b：general 在允许目录能够写入", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-general-"));
    try {
      const adapter = new PiAgentAdapter({ defaultModel: spec, cwd: tmp });
      const script = `export const meta = { name: "general_write" }
const r = await agent("Create a file named made.txt in the current directory containing 'hello'. Reply done when finished.", { label: "do-write", agentType: "general" })
return r`;
      const result = await runWorkflow(script, { agent: adapter, agentTimeoutMs: 180_000, cwd: tmp });
      assert.equal(result.agents[0]?.status, "ok");
      assert.equal(existsSync(path.join(tmp, "made.txt")), true, "general 应能写出 made.txt");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  await t.test("模型找不到 → 失败态而非成功（P0-06）", async () => {
    const adapter = new PiAgentAdapter({ defaultModel: "no-such-provider/no-such-model" });
    await assert.rejects(
      runWorkflow('export const meta = { name: "bad_model" }\nconst r = await agent("hi")\nreturn r', {
        agent: adapter,
        agentRetries: 0,
        continueOnAgentFailure: false,
      }),
      /model not found|阶段失败闸门/,
    );
  });
});
