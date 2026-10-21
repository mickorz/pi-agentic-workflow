/** Worker 独立性：浏览器关闭不终止后台 Worker；重开浏览器历史可见 */
import { test, expect } from "@playwright/test";
import { enterWorkspace, startRun, apiRun } from "./helpers";
import { MOCK_API_PORT } from "./env";

test("浏览器关闭后 Worker 照常完成（long.js 40 agents）", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const runId = await startRun(page, "long.js");
  // 实时连接确认（SSE 活着，run 在跑）
  await expect(page.getByText("实时连接中")).toBeVisible({ timeout: 30_000 });

  // 彻底关闭浏览器上下文
  await ctx.close();

  // 无浏览器存活时轮询 API 至终态
  let status = "";
  for (let i = 0; i < 120; i++) {
    const detail = await apiRun(runId, false, MOCK_API_PORT);
    status = String(detail.snapshot.effectiveStatus ?? "");
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(status).toBe("completed");

  // 重开浏览器：Dashboard 历史可见该 run
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto("/", { waitUntil: "domcontentloaded" });
  await enterWorkspace(p2);
  await expect(p2.locator("tr:has-text('long_demo')")).toBeVisible({ timeout: 20_000 });
  await ctx2.close();
});
