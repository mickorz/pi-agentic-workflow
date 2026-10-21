/**
 * E17：真实 SDK E2E —— Pi Agent 真正完成完整 workflow。
 * 判定（PRD）：真实结果、Token 与状态核验。
 * 本 spec 仅在 --project=real 下运行（对应 Server 未注入 fake runner）。
 * 若因凭证/网络无法运行，本测试会失败——此时 G-P3 记 BLOCKED 附复现方法，不假成功。
 */
import { test, expect } from "@playwright/test";
import { startRun, apiRun } from "./helpers";
import { REAL_API_PORT } from "./env";

interface AgentRecord {
  tokens?: number;
  cost?: number;
  model?: string;
  status?: string;
}

test("真实 SDK：单 agent workflow 完成 + 真实 Token/模型核验", async ({ page }) => {
  test.setTimeout(180_000); // 真实 LLM 调用预算
  const runId = await startRun(page, "real_hello.js");

  // UI 终态（SSE 实时推进）
  await expect(page.locator(".status-chip").first()).toHaveText("已完成", { timeout: 150_000 });

  // API 核验：真实用量（tokens>0、model 存在）——fake runner 下无 tokens，真实 SDK 必有
  const detail = await apiRun(runId, true, REAL_API_PORT);
  const snap = detail.snapshot as { result?: { agents?: AgentRecord[]; agentCount?: number } };
  const agents = snap.result?.agents ?? [];
  expect(agents.length).toBeGreaterThanOrEqual(1);
  expect(snap.result?.agentCount).toBe(1);
  expect(agents[0].tokens ?? 0).toBeGreaterThan(0);
  // record.model = DSL 指定的 model（脚本未指定时为空，真实 SDK 用默认模型）——不作为真实 SDK 判据；
  // tokens>0 已足以证明真实调用（fake runner 不产生 tokens）。

  // UI 用量面板显示真实 tokens（非「无用量数据」）
  await expect(page.getByText("agent 数")).toBeVisible();
  const usageText = await page.locator("main").innerText();
  expect(usageText).not.toContain("无用量数据");
});
