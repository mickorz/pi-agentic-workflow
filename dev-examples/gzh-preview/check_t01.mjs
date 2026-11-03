/**
 * T0.1 最小桥接实验验收脚本(GZH 排版工作台,方案 V2)
 *
 * 用法(仓库根目录):
 *   cd dev-examples/gzh-preview && npm install && node check_t01.mjs
 *
 * 前提:本机 ms-playwright 已有 chromium(本仓库 web/e2e 环境);脚本自起静态 HTTP 服务。
 * 输出契约:逐项 [OK]/[FAIL] + 结尾 === T01 ALL DONE PASS=n FAIL=m ===
 *
 * 覆盖:
 *   A 独立模式零回归:window.editorVm 暴露成功、编辑内容 1s 防抖持久化到 localStorage
 *   B hosted 模式协议:editor:ready / article:load / article:get:request+response /
 *     style:change / article:dirty(content+style)
 *   C 独立草稿零污染(hosted 会话写穿后):localStorage 原键不变、sessionStorage hosted: 前缀生效
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const PORT = 8931;
const BASE = `http://${HOST}:${PORT}`;
const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:');

let pass = 0;
let fail = 0;
function report(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`[OK] ${name}${detail ? ' - ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? ' - ' + detail : ''}`);
  }
}

function startServer() {
  // Windows 本机 python 命令;仓库根做静态根,宿主页与编辑器同源
  const proc = spawn('python', ['-m', 'http.server', String(PORT), '--bind', HOST], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  return proc;
}

async function waitServerReady(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/dev-examples/gzh-preview/test-host.html`);
      if (res.ok) return true;
    } catch {
      /* 服务未起,继续等 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const server = startServer();
  let browser;
  try {
    if (!(await waitServerReady())) {
      console.log('[FAIL] HTTP 服务未就绪');
      process.exitCode = 1;
      return;
    }
    browser = await chromium.launch();
    const ctx = await browser.newContext();

    // ---------- A 独立模式零回归 ----------
    const pageA = await ctx.newPage();
    await pageA.goto(`${BASE}/thirdparties/huasheng_editor/index.html`);
    const vmExposed = await pageA.waitForFunction(
      () => window.editorVm && window.editorVm.md,
      null,
      { timeout: 15000 },
    ).then(() => true).catch(() => false);
    report('A1 独立模式 window.editorVm 且 md 就绪(补丁生效)', vmExposed);

    await pageA.evaluate(() => {
      window.editorVm.markdownInput = 'T01-STANDALONE-EDIT';
    });
    await pageA.waitForTimeout(1600); // 1s 防抖 + 余量
    const lsStandalone = await pageA.evaluate(() => localStorage.getItem('markdownInput'));
    report('A2 独立模式编辑内容持久化 localStorage(bridge 未拦截)', lsStandalone === 'T01-STANDALONE-EDIT');

    const ssLeak = await pageA.evaluate(() => sessionStorage.getItem('hosted:markdownInput'));
    report('A3 独立模式无 hosted: 前缀键(bridge 静默)', ssLeak === null);
    await pageA.close();

    // ---------- B/C hosted 模式 ----------
    const pageB = await ctx.newPage();
    // 先模拟同 Origin 下用户独立草稿(hosted 会话最坏场景)
    await pageB.goto(`${BASE}/dev-examples/gzh-preview/test-host.html`);
    await pageB.evaluate(() => {
      localStorage.setItem('markdownInput', 'USER-STANDALONE-DRAFT');
      localStorage.setItem('currentStyle', 'wechat-default');
    });
    await pageB.reload(); // 重新进页面,iframe 重新加载

    const readyOk = await pageB.waitForFunction(
      () => window.__t01State && window.__t01State.ready === true,
      null,
      { timeout: 15000 },
    ).then(() => true).catch(() => false);
    report('B1 editor:ready(editorVm.md 就绪后发送)', readyOk);
    if (!readyOk) {
      console.log(`=== T01 ALL DONE PASS=${pass} FAIL=${fail + 1} === (ready 未达,终止后续)`);
      return;
    }

    // load:注入正文 + 主题
    await pageB.evaluate(() => window.t01.sendLoad());
    await pageB.waitForTimeout(600);
    const rid1 = await pageB.evaluate(() => window.t01.sendGet());
    await pageB.waitForTimeout(400);
    const resp1 = await pageB.evaluate((rid) => window.__t01State.responses[rid], rid1);
    report(
      'B2 article:load 后 get 一致',
      Boolean(resp1) && resp1.markdown.includes('宿主通过 article:load 注入') && resp1.style === 'wechat-ft',
    );

    // dirty(content):改 iframe 内编辑器内容
    await pageB.evaluate(() => {
      const w = document.getElementById('editor').contentWindow;
      w.editorVm.markdownInput += '\n\n人工补充一段。';
    });
    await pageB.waitForTimeout(900); // 轮询 400ms + 余量
    const dirtyContent = await pageB.evaluate(() => window.__t01State.dirty.includes('content'));
    report('B3 article:dirty dirtyType=content', dirtyContent);

    // dirty(style)+ style:change
    await pageB.evaluate(() => window.t01.sendStyle('wechat-anthropic'));
    await pageB.waitForTimeout(900);
    const rid2 = await pageB.evaluate(() => window.t01.sendGet());
    await pageB.waitForTimeout(400);
    const resp2 = await pageB.evaluate((rid) => window.__t01State.responses[rid], rid2);
    report('B4 style:change 生效(currentStyle=wechat-anthropic)', Boolean(resp2) && resp2.style === 'wechat-anthropic');
    // B5 dirty(style):编辑器内部改主题(模拟用户在下拉框选择),宿主应收到 dirty:style
    await pageB.evaluate(() => {
      const w = document.getElementById('editor').contentWindow;
      w.editorVm.currentStyle = 'wechat-apple';
    });
    await pageB.waitForTimeout(900);
    const dirtyStyle = await pageB.evaluate(() => window.__t01State.dirty.includes('style'));
    report('B5 article:dirty dirtyType=style(编辑器内部改主题)', dirtyStyle);

    // C 独立草稿零污染:等 1s 防抖持久化写穿
    await pageB.waitForTimeout(1800);
    const lsAfter = await pageB.evaluate(() => ({
      md: localStorage.getItem('markdownInput'),
      style: localStorage.getItem('currentStyle'),
      hostedMd: sessionStorage.getItem('hosted:markdownInput'),
      hostedStyle: sessionStorage.getItem('hosted:currentStyle'),
    }));
    report('C1 localStorage 独立草稿未被污染', lsAfter.md === 'USER-STANDALONE-DRAFT' && lsAfter.style === 'wechat-default');
    report(
      'C2 hosted: 前缀键收到改道写入',
      Boolean(lsAfter.hostedMd) && lsAfter.hostedMd.includes('人工补充一段') && lsAfter.hostedStyle === 'wechat-apple',
    );
    await pageB.close();
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`=== T01 ALL DONE PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.log('[FAIL] 脚本异常:', e && e.message ? e.message : String(e));
  process.exitCode = 1;
});
