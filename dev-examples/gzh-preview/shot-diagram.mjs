/** 示意图 HTML → PNG 截图(2x retina + 390px 手机可读性副本)。用法:node shot-diagram.mjs <html路径> <输出png路径>*/
import { chromium } from 'playwright-core';
import path from 'node:path';

const html = path.resolve(process.argv[2]);
const out2x = path.resolve(process.argv[3]);
const out390 = path.resolve(process.argv[4] ?? '');

const browser = await chromium.launch();
try {
  // 2x 主图
  {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 1200 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto('file:///' + html.replace(/\\/g, '/'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.locator('.frame').screenshot({ path: out2x });
    await ctx.close();
    console.log('[OK] 2x:', out2x);
  }
  // 390px 手机可读性副本(模拟正文宽)
  if (out390) {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 1200 }, deviceScaleFactor: 0.55 });
    const page = await ctx.newPage();
    await page.goto('file:///' + html.replace(/\\/g, '/'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.locator('.frame').screenshot({ path: out390 });
    await ctx.close();
    console.log('[OK] 390px 副本:', out390);
  }
} finally {
  await browser.close();
}
