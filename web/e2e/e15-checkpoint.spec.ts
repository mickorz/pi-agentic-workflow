/** E15：checkpoint approve/reject 两路径浏览器级正确性 */
import { test, expect } from "@playwright/test";
import { startRun } from "./helpers";

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
});
