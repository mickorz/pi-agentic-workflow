/** 按百分比裁剪截图(2x 渲染保清晰)。node crop-img.mjs <img> <l> <t> <r> <b> → 覆盖原文件 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const [f, l, t, r, b] = process.argv.slice(2);
const abs = path.resolve(f);
const tmp = path.join(path.dirname(abs), `.crop-${Date.now()}.html`);
const fileUrl = 'file:///' + abs.replace(/\\/g, '/');
fs.writeFileSync(tmp, `<body style="margin:0"><img id="i" src="${fileUrl}"></body>`);
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 2200, height: 1600 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('file:///' + tmp.replace(/\\/g, '/'));
  await page.waitForSelector('#i');
  await page.waitForFunction(() => { const i = document.getElementById('i'); return i && i.complete && i.naturalWidth > 0; });
  const W = await page.evaluate(() => document.getElementById('i').naturalWidth);
  const H = await page.evaluate(() => document.getElementById('i').naturalHeight);
  await page.setViewportSize({ width: W, height: H });
  await page.waitForTimeout(200);
  const clip = {
    x: Math.round(W * (parseFloat(l) / 100)),
    y: Math.round(H * (parseFloat(t) / 100)),
    width: Math.round(W * ((parseFloat(r) - parseFloat(l)) / 100)),
    height: Math.round(H * ((parseFloat(b) - parseFloat(t)) / 100)),
  };
  console.log("[dbg] W,H:", W, H, "clip:", JSON.stringify(clip), "vp:", JSON.stringify(page.viewportSize()));
  await page.screenshot({ path: abs, clip });
  console.log(`[OK] crop ${path.basename(abs)}: ${clip.width}x${clip.height} (原 ${W}x${H})`);
} finally {
  await browser.close();
  fs.rmSync(tmp, { force: true });
}
