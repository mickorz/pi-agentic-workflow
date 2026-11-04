/** 图片 390px 手机宽副本生成(v2:临时 HTML 承载,规避 about:blank 拦 file 子资源)。node img-390.mjs <img...> → 同目录 <名>-390.png */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const files = process.argv.slice(2);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gzh390-'));
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 1400 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  files.forEach((f, n) => {
    const abs = path.resolve(f);
    const html = path.join(tmpDir, `i${n}.html`);
    fs.writeFileSync(html, `<body style="margin:0"><img id="i" src="file:///${abs.replace(/\\/g, '/')}" style="width:390px;display:block"></body>`);
    files[n] = { abs, html, out: abs.replace(/\.(png|jpe?g)$/i, '-390.png') };
  });
  for (const it of files) {
    await page.goto('file:///' + it.html.replace(/\\/g, '/'));
    await page.waitForSelector('#i');
    await page.waitForFunction(() => { const i = document.getElementById('i'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
    await page.locator('#i').screenshot({ path: it.out });
    console.log('[OK] 390:', path.basename(it.out));
  }
} finally {
  await browser.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
