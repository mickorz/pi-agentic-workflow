/** E12/XSS：HTML 注入载荷（meta.description / log / checkpoint 问题）在浏览器一律字面文本渲染，
 * 不执行（React 转义）；pageerror 必须为 0。 */
import { test, expect } from "@playwright/test";
import { startRun } from "./helpers";

test("XSS 注入载荷全字面渲染，无脚本执行、无 pageerror", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await startRun(page, "xss.js");

  // checkpoint 问题以字面文本出现（React 转义，不作为 HTML 解释）
  await expect(page.getByText("<b>bold</b> 批准？", { exact: false })).toBeVisible({ timeout: 30_000 });
  // 未注入任何脚本
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss, "window.__xss 不得被注入执行").toBeUndefined();

  // 批准 → 完成；时间线 log 字面含 <script>
  await page.click("button:has-text('批准…')");
  await page.click("button:has-text('确认批准')");
  await expect(page.locator(".status-chip", { hasText: "已完成" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("<script>", { exact: false })).toBeVisible();

  const xss2 = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss2, "完成前后均无注入执行").toBeUndefined();
  expect(pageErrors, "无页面级异常").toEqual([]);
});
