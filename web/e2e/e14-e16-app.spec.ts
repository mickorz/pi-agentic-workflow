/** E14：Dashboard → New Run → Detail 全流程关键状态断言（非截图）；E16：reload 状态重建 */
import { test, expect } from "@playwright/test";
import { enterWorkspace, startRun } from "./helpers";

test.describe("E14 浏览器全流程（Mock Worker）", () => {
  test("TokenGate → New Run → RunDetail：执行树实时出现 → 终态与用量", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await enterWorkspace(page);
    await expect(page.getByText("待审批", { exact: false }).first()).toBeVisible();

    await page.goto("/runs/new", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("select >> nth=1 >> option[value='par.js']", { state: "attached" });
    const options = await page.locator("select >> nth=1").locator("option").allTextContents();
    expect(options.join("|")).toContain("par.js");
    expect(options.join("|")).toContain("cpv.js");

    await page.selectOption("select >> nth=1", "par.js");
    await expect(page.getByText("个阶段")).toBeVisible(); // validate 预览

    await page.click("button[type=submit]");
    await page.waitForURL(/\/runs\/run-/);
    // 实时执行树（SSE 驱动）
    await expect(page.getByText("pa", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("pb", { exact: true })).toBeVisible({ timeout: 30_000 });
    // 终态与同步完成
    await expect(page.locator(".status-chip").first()).toHaveText("已完成", { timeout: 60_000 });
    await expect(page.getByText("已同步完成")).toBeVisible({ timeout: 15_000 });
    // 用量面板（关键状态断言）
    await expect(page.getByText("agent 数")).toBeVisible();
    const usage = await page.locator("main").innerText();
    expect(usage).toMatch(/agent 数[\s\S]{0,10}2/);
  });

  test("Dashboard 历史列表含已完成 run", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await enterWorkspace(page);
    await startRun(page, "par.js");
    await expect(page.locator(".status-chip").first()).toHaveText("已完成", { timeout: 60_000 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("tr:has-text('par_demo')").first()).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("E16 reload/断开重建", () => {
  test("刷新后状态/时间线/用量重建不丢", async ({ page }) => {
    const runId = await startRun(page, "par.js");
    expect(runId).toMatch(/^run-/);
    await expect(page.locator(".status-chip").first()).toHaveText("已完成", { timeout: 60_000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".status-chip").first()).toHaveText("已完成", { timeout: 30_000 });
    const timeline = await page.locator(".timeline li").count();
    expect(timeline).toBeGreaterThan(5); // 磁盘全量重建
    await expect(page.getByText("agent 数")).toBeVisible();
  });
});
