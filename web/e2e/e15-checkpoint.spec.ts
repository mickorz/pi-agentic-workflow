/** E15：checkpoint approve/reject 两路径浏览器级正确性 */
import { test, expect } from "@playwright/test";
import { startRun } from "./helpers";
import { TOKEN, apiBase } from "./env";

test.describe("E15 checkpoint 审批（Mock Worker）", () => {
  test("批准路径：审批面板 → 双击确认 → 完成 + 历史已批准", async ({ page }) => {
    await startRun(page, "cpv.js");
    await expect(page.getByText("Checkpoint 审批")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("允许继续吗", { exact: false })).toBeVisible();

    await page.click("button:has-text('批准…')");
    await page.click("button:has-text('确认批准')");

    await expect(page.locator(".status-chip").first()).toHaveText("已完成", { timeout: 60_000 });
    await expect(page.getByText("已批准", { exact: false })).toBeVisible({ timeout: 15_000 });
  });

  test("拒绝路径：人工拒绝强停止 → 失败 + 历史已拒绝", async ({ page }) => {
    await startRun(page, "cpv.js");
    await expect(page.getByText("允许继续吗", { exact: false })).toBeVisible({ timeout: 30_000 });

    await page.click("button:has-text('拒绝…')");
    await page.click("button:has-text('确认拒绝')");

    await expect(page.locator(".status-chip").first()).toHaveText("失败", { timeout: 60_000 });
    await expect(page.getByText("已拒绝", { exact: false })).toBeVisible({ timeout: 15_000 });
  });

  test("重复点击去重：UI 决策与并发同版本 API POST 竞争 → 恒完成一次，历史恰一条已批准", async ({ page }) => {
    const runId = await startRun(page, "cpv.js");
    await expect(page.getByText("允许继续吗", { exact: false })).toBeVisible({ timeout: 30_000 });

    // 先取 pending checkpoint 的 id/version（决策前必然存在）
    const cps = (await (
      await fetch(`${apiBase(false)}/api/runs/${runId}/checkpoints`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { checkpoints: { checkpointId: string; version: number }[] };
    const cp = cps.checkpoints[0];
    expect(cp, "pending checkpoint 存在").toBeTruthy();

    // UI 点批准；几乎同时直连 API 再发同版本 approve（模拟双击/双端竞争；两路均容错，谁先谁都收敛）
    await page.click("button:has-text('批准…')");
    const uiClick = page
      .locator("button:has-text('确认批准')")
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    const apiPost = fetch(`${apiBase(false)}/api/runs/${runId}/checkpoints/${cp.checkpointId}/decision`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", expectedVersion: cp.version }),
    })
      .then((r) => r.status)
      .catch(() => -1);
    const [, apiCode] = await Promise.all([uiClick, apiPost]);
    // 双路竞争后状态必收敛：run 完成一次（无论 200 幂等/409 冲突谁赢）
    expect([200, 409, -1]).toContain(apiCode);

    await expect(page.locator(".status-chip", { hasText: "已完成" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("已同步完成")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(".checkpoint-history li", { hasText: "已批准" }),
    ).toHaveCount(1, { timeout: 15_000 });
  });
});
