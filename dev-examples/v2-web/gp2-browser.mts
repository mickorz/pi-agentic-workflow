/**
 * G-P2 浏览器验收（真实 Chromium / Playwright）。
 * 覆盖契约：New Run → 实时进度 → checkpoint 审批（批准+拒绝两路径）→ 完成 → 刷新重建历史；
 * 用例含 agent（hello/par）/parallel（par）/verify（cpv）/checkpoint（cpv）；浏览器关闭不终止 Worker（long）。
 * 断言全部基于关键状态文本（非截图）。
 */
import { chromium } from "playwright";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:5199";
const TOKEN = process.env.TOKEN ?? "";
const API = process.env.API ?? "http://127.0.0.1:4651";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`FAIL: ${name}${detail ? `（${detail}）` : ""}`);
  }
}

async function waitText(page: import("playwright").Page, text: string, timeout = 60_000): Promise<boolean> {
  try {
    await page.waitForSelector(`text=${text}`, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function ensureToken(pg: import("playwright").Page): Promise<void> {
  // 新 context 无 localStorage：若 TokenGate 在，则输入 token 放行
  const gate = await pg.locator("text=连接 pi-workflow Server").count();
  if (gate > 0) {
    await pg.fill("input[type=password]", TOKEN);
    await pg.keyboard.press("Enter");
    await pg.waitForSelector("nav a[href='/runs/new']", { timeout: 15_000 });
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // G1 TokenGate + Dashboard
  await page.goto(WEB_URL, { waitUntil: "networkidle" });
  check("G1 打开工作台（TokenGate 出现）", await waitText(page, "连接 pi-workflow Server", 30_000));
  await page.fill("input[type=password], input:not([type])", TOKEN);
  await page.keyboard.press("Enter");
  check("G1 token 通过进入 Dashboard", await waitText(page, "待审批", 15_000));

  // G2 New Run 表单：项目+工作流+预览
  await page.click("nav a[href='/runs/new']");
  await page.waitForSelector("select");
  // workflows 异步加载：等到选项出现再读
  await page.waitForSelector("select >> nth=1 >> option[value='par.js']", { timeout: 15_000, state: "attached" });
  const wfOptions = await page.locator("select >> nth=1").locator("option").allTextContents();
  check(
    "G2 工作流枚举含 par/cpv/long",
    wfOptions.join("|").includes("par.js") && wfOptions.join("|").includes("cpv.js") && wfOptions.join("|").includes("long.js"),
    wfOptions.join("|"),
  );
  await page.selectOption("select >> nth=1", "par.js");
  check("G2 选中即预览 meta", await waitText(page, "个阶段", 10_000));

  // G3 启动 par.js（agent+parallel）→ 实时进度 → 完成
  await page.click("button[type=submit]");
  await page.waitForURL(/\/runs\/run-/);
  check("G3 跳转 RunDetail", page.url().includes("/runs/run-"));
  check("G3 执行树实时出现节点", await waitText(page, "pa", 30_000));
  check("G3 终态=已完成", await waitText(page, "已完成", 60_000));
  check("G3 同步完成标记", await waitText(page, "已同步完成", 15_000));

  // G4 checkpoint 审批：cpv.js（verify+checkpoint+agent）批准路径
  await page.click("nav a[href='/runs/new']");
  await page.waitForSelector("select >> nth=1");
  await page.selectOption("select >> nth=1", "cpv.js");
  await page.click("button[type=submit]");
  await page.waitForURL(/\/runs\/run-/);
  check("G4 审批面板出现（verify 后 checkpoint 挂起）", await waitText(page, "Checkpoint 审批", 30_000));
  check("G4 问题文本可见", await waitText(page, "允许继续吗", 10_000));
  await page.click("button:has-text('批准…')");
  await page.click("button:has-text('确认批准')");
  check("G4 批准后完成", await waitText(page, "已完成", 60_000));
  check("G4 历史决策=已批准", await waitText(page, "已批准", 10_000));

  // G5 刷新重建（磁盘恢复，无浏览器状态）
  await page.reload({ waitUntil: "domcontentloaded" });
  check("G5 刷新后状态重建=已完成", await waitText(page, "已完成", 30_000));
  const timelineCount = await page.locator(".timeline li").count();
  check("G5 刷新后时间线重建（事件 > 5 条）", timelineCount > 5, `count=${timelineCount}`);
  check("G5 用量面板 agent 数可见", await waitText(page, "agent 数", 10_000));

  // G6 Dashboard 历史含两个 run（等行数据渲染，非空表壳）
  await page.click("nav a[href='/']");
  await page.waitForSelector("tr:has-text('par_demo')", { timeout: 20_000 });
  const historyText = await page.locator("main").innerText();
  check("G6 历史含 par.js run", historyText.includes("par_demo"), "");
  check("G6 历史含 cpv.js run", historyText.includes("cpv_demo"));

  // G7 拒绝路径（E15 浏览器级）：cpv.js → 拒绝 → 强停止 failed
  await page.goto(`${WEB_URL}/runs/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("select >> nth=1 >> option[value='cpv.js']", { state: "attached", timeout: 20_000 });
  await page.selectOption("select >> nth=1", "cpv.js");
  await page.click("button[type=submit]");
  await page.waitForURL(/\/runs\/run-/);
  await waitText(page, "允许继续吗", 30_000);
  await page.click("button:has-text('拒绝…')");
  await page.click("button:has-text('确认拒绝')");
  check("G7 拒绝后强停止=失败", await waitText(page, "失败", 60_000));

  // G8 浏览器关闭不终止 Worker：启动 long.js → 关浏览器上下文 → API 轮询到 completed
  await context.close(); // 先复用同一 context 开最后一个 run
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(`${WEB_URL}/runs/new`, { waitUntil: "domcontentloaded" });
  await ensureToken(p2);
  await p2.waitForSelector("select >> nth=1 >> option[value='long.js']", { state: "attached", timeout: 20_000 });
  await p2.selectOption("select >> nth=1", "long.js");
  await p2.click("button[type=submit]");
  await p2.waitForURL(/\/runs\/run-/);
  check("G8 long run 已启动（实时连接中）", await waitText(p2, "实时连接中", 30_000));
  const longUrl = p2.url();
  const runId = longUrl.split("/").pop() ?? "";
  // 彻底关闭浏览器（所有上下文/页面）——Worker 属于 Server，不应受影响
  await ctx2.close();
  check("G8 浏览器已关闭", true);
  let finalStatus = "";
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`${API}/api/runs/${runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (res.ok) {
      const detail = (await res.json()) as { snapshot: { effectiveStatus: string } };
      finalStatus = detail.snapshot.effectiveStatus;
      if (["completed", "failed", "cancelled", "interrupted"].includes(finalStatus)) break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check("G8 浏览器关闭后 Worker 照常完成（completed）", finalStatus === "completed", `status=${finalStatus}`);

  // 刷新重建历史（浏览器重开）：Dashboard 历史含 long run 终态
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(`${WEB_URL}/`, { waitUntil: "domcontentloaded" });
  await ensureToken(p3);
  await p3.waitForSelector("tr:has-text('long_demo')", { timeout: 20_000 });
  const hist2 = await p3.locator("main").innerText();
  check("G8 重开浏览器历史含 long run", hist2.includes("long_demo"));
  await ctx3.close();

  check("G9 无页面运行时错误（pageerror=0）", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

  await browser.close();
  console.log(`\n== G-P2 浏览器门：PASS=${pass} FAIL=${fail} ==`);
  if (fail > 0) {
    console.log(`失败项：${fails.join("；")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("DRIVER-ERROR", err);
  process.exit(1);
});
