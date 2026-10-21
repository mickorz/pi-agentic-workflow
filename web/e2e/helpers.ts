/** 浏览器 E2E 共享工具 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { TOKEN } from "./env";

/** 新 context 无 localStorage token：若 TokenGate 在，则输入 token 放行 */
export async function enterWorkspace(page: Page): Promise<void> {
  const gate = await page.locator("text=连接 pi-workflow Server").count();
  if (gate > 0) {
    await page.fill("input[type=password]", TOKEN);
    await page.getByRole("button", { name: "连接" }).click();
  }
  await expect(page.locator("nav a[href='/runs/new']")).toBeVisible({ timeout: 15_000 });
}

/** New Run 页选择工作流并提交，返回 runId（从 URL 提取） */
export async function startRun(page: Page, workflow: string): Promise<string> {
  await page.goto("/runs/new", { waitUntil: "domcontentloaded" });
  await enterWorkspace(page);
  await page.waitForSelector(`select >> nth=1 >> option[value='${workflow}']`, { state: "attached", timeout: 20_000 });
  await page.selectOption("select >> nth=1", workflow);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/runs\/run-/);
  return page.url().split("/").pop() ?? "";
}

/** 直连 API（绕过浏览器）读取 run 快照 */
export async function apiRun(runId: string, real: boolean, port: number): Promise<{ snapshot: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`api ${res.status}`);
  return (await res.json()) as { snapshot: Record<string, unknown> };
}
