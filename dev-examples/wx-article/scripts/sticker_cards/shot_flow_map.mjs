// 图形页截图：emulate 1200x1200 @2x 打开图形 HTML，截视口（1600x1600 裁剪由调用方做）
// 用法: node shot_flow_map.mjs <html路径> <输出png>
// ponytail: 仅图形页资产生产用；若多页共用再抽成参数化工具
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// 以 render.mjs 为解析基准，借用 guizang skill 的 playwright 依赖（同一 chromium，渲染链路一致）
const requireFromRender = createRequire(path.join(root, 'thirdparties/guizang-social-card-skill/scripts/render.mjs'));
const { chromium } = requireFromRender('playwright');

const html = process.argv[2];
const out = process.argv[3];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({
  viewport: { width: 1200, height: 1200 },
  deviceScaleFactor: 2,
});
await page.goto('file://' + path.resolve(html).replace(/\\/g, '/'));
await page.waitForTimeout(600); // 字体/渲染稳定
await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log('[OK] shot saved: ' + out);
