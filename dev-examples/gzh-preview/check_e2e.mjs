/**
 * GZH 排版工作台 P0 浏览器全栈 E2E(T0.5)
 *
 * 用法(仓库根):cd dev-examples/gzh-preview && node check_e2e.mjs
 * 前提:根仓库已 npm run build;web 已 npm ci;ms-playwright chromium 已装。
 *
 * 链路:vite dev(React 预览页)+ Fastify Server(gzh 路由 + 签名图片)+ huasheng iframe。
 * 覆盖:TokenGate 旁路(注入 token)→ 文章加载 → 图片经代理真实渲染(GIF/中文名)→
 *       编辑 → dirty 指示 → 保存 → 磁盘 md diff 仅含人工改动 → 重开一致。
 * 输出契约:[OK]/[FAIL] + === E2E ALL DONE PASS=n FAIL=m ===
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const FIXTURE_DIR = path.join(HERE, "fixture-vault", "单篇", "20261102-DeepSeek超级智能体");
const MD_FILE = path.join(FIXTURE_DIR, "一句话解释DeepSeek刚开源的超级智能体super-agent.md");
const SERVER_PORT = 8944;
const VITE_PORT = 5199;

let pass = 0;
let fail = 0;
function report(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`[OK] ${name}${detail ? " - " + detail : ""}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? " - " + detail : ""}`);
  }
}

function spawnNode(args, opts = {}) {
  return spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
}

async function waitUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 未起 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function grabToken(serverProc) {
  // banner 在 listen 后打印;轮询 stdout 累积缓冲
  const buf = [];
  serverProc.stdout.on("data", (d) => buf.push(d.toString()));
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const text = buf.join("");
    const m = text.match(/本次会话[）)]:?\s*([0-9a-f]{16,})/) || text.match(/Bearer\s+([0-9a-f]{16,})/);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function ensureFixture() {
  if (fs.existsSync(path.join(HERE, "fixture-vault"))) return true;
  const gen = spawn("python", [path.join(HERE, "make_fixture.py")], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve) => gen.on("close", (c) => resolve(c === 0)));
}

async function main() {
  if (!(await ensureFixture())) {
    console.log("[FAIL] fixture 生成失败");
    process.exitCode = 1;
    return;
  }
  const mdBackup = fs.readFileSync(MD_FILE);
  const server = spawnNode([path.join(REPO, "dist", "cli", "index.js"), "web", "--port", String(SERVER_PORT)], {
    cwd: REPO,
    env: { ...process.env, GZH_PREVIEW_VAULT_ROOT: path.join(HERE, "fixture-vault"), PI_WORKFLOW_WEB_PORT: String(SERVER_PORT) },
  });
  const vite = spawn("npm.cmd", ["run", "dev", "--", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: path.join(REPO, "web"),
    env: { ...process.env, PI_WORKFLOW_WEB_PROXY_TARGET: `http://127.0.0.1:${SERVER_PORT}` },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    const token = await grabToken(server);
    report("Server 起动并抓到 token", Boolean(token));
    const viteOk = await waitUrl(`http://localhost:${VITE_PORT}/`, 45000);
    report("vite dev 起动", viteOk);
    if (!token || !viteOk) return;

    browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/`);
    await page.evaluate((t) => localStorage.setItem("pi-workflow-web.token", t), token);

    // 列表页选文章
    await page.goto(`http://localhost:${VITE_PORT}/gzh-preview`);
    await page.waitForSelector(".gzh-article-list button", { timeout: 15000 });
    await page.click(".gzh-article-list button");
    await page.waitForSelector(".gzh-editor-frame", { timeout: 15000 });
    // 等 iframe 内编辑器 ready + 加载(host 在 ready 后 load)
    await page.waitForFunction(
      () => {
        const f = document.querySelector(".gzh-editor-frame");
        const w = f && f.contentWindow;
        return !!(w && w.editorVm && w.editorVm.md && w.editorVm.markdownInput && w.editorVm.markdownInput.length > 200);
      },
      null,
      { timeout: 20000 },
    );
    report("文章加载进编辑器", true);

    // 图片经签名 URL + vite 代理真实渲染(含 GIF 与中文文件名)
    const imgOk = await page.evaluate(async () => {
      const f = document.querySelector(".gzh-editor-frame");
      const w = f.contentWindow;
      await w.editorVm.$nextTick();
      await new Promise((r) => setTimeout(r, 500));
      const preview = w.document.querySelector("#preview, .preview, .preview-area") || w.document;
      const imgs = Array.from(preview.querySelectorAll("img"));
      const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
      const gif = imgs.some((i) => decodeURIComponent(i.src).includes(".gif"));
      const cn = imgs.some((i) => /%E4%B8%AD|%E6%99%BA|%E8%83%BD/.test(i.src));
      return { total: imgs.length, loaded, gif, cn };
    });
    report(
      `图片渲染(${imgOk.total} 张,成功 ${imgOk.loaded},含GIF:${imgOk.gif},含中文名:${imgOk.cn})`,
      imgOk.total >= 5 && imgOk.loaded >= 5 && imgOk.gif && imgOk.cn,
    );

    // 编辑器内改正文 -> dirty 指示出现
    await page.evaluate(() => {
      const w = document.querySelector(".gzh-editor-frame").contentWindow;
      w.editorVm.markdownInput += "\n\n[E2E 人工改动标记]";
    });
    const dirtyShown = await page
      .waitForSelector(".gzh-toolbar .dirty.on", { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    report("编辑后 dirty 指示亮起", dirtyShown);

    // 点保存
    await page.click(".gzh-toolbar button:not(.ghost)");
    await page.waitForFunction(
      () => document.querySelector(".gzh-toolbar .status") && document.querySelector(".gzh-toolbar .status").textContent.includes("已保存"),
      null,
      { timeout: 10000 },
    );
    const onDisk = fs.readFileSync(MD_FILE, "utf8");
    report(
      "保存落盘:含人工改动且图片还原相对路径",
      onDisk.includes("[E2E 人工改动标记]") && onDisk.includes("](imgs/02-人机分工闭环.gif)") && !onDisk.includes("/gzh-img?"),
    );
    const dirtyCleared = await page.evaluate(
      () => !document.querySelector(".gzh-toolbar .dirty.on"),
    );
    report("保存后 dirty 清零", dirtyCleared);

    // 重开一致
    await page.reload();
    await page.waitForFunction(
      () => {
        const f = document.querySelector(".gzh-editor-frame");
        const w = f && f.contentWindow;
        return !!(w && w.editorVm && w.editorVm.md && w.editorVm.markdownInput.includes("[E2E 人工改动标记]"));
      },
      null,
      { timeout: 20000 },
    );
    report("关闭重开内容一致", true);

    // 导出渲染 HTML(P2):layout.html 落盘且图片为相对引用
    await page.click(".gzh-toolbar button.ghost:not(:first-child)");
    let exportedOk = false;
    try {
      await page.waitForFunction(
        () => document.querySelector(".gzh-toolbar .status")?.textContent?.includes("已导出"),
        null,
        { timeout: 10000 },
      );
      exportedOk = true;
    } catch {
      const st = await page.evaluate(() => document.querySelector(".gzh-toolbar .status")?.textContent ?? "(无状态)");
      console.log("[dbg] 导出状态:", st);
    }
    const layoutPath = path.join(FIXTURE_DIR, "layout.html");
    const layout = fs.existsSync(layoutPath) ? fs.readFileSync(layoutPath, "utf8") : "";
    console.log("[dbg] layout exists:", fs.existsSync(layoutPath), "len:", layout.length, "hasImgs:", layout.includes("imgs/"), "hasSigned:", layout.includes("/gzh-img?"));
    report("导出 layout.html(相对图片引用)", exportedOk && layout.includes("imgs/") && !layout.includes("/gzh-img?") && layout.length > 500);

  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(MD_FILE, mdBackup);
    try {
      fs.unlinkSync(path.join(FIXTURE_DIR, "layout.html"));
    } catch {
      /* 不存在则忽略 */
    }
    server.kill();
    try {
      vite.kill();
    } catch {
      /* ignore */
    }
    try {
      process.kill(-vite.pid);
    } catch {
      /* ignore */
    }
  }
  console.log(`=== E2E ALL DONE PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.log("[FAIL] 脚本异常:", e && e.message ? e.message : String(e));
  process.exitCode = 1;
});
