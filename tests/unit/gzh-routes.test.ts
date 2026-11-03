/**
 * GZH 排版工作台路由测试(T0.2,方案 V2 4.2/4.3)
 * 覆盖:鉴权 401 / 列表 / 加载(图片重写为签名 URL) / 签名图片(过期、篡改、越界、非法名) /
 *       保存往返(签名 URL 还原、baseHash 409、只改 style 时 md 字节级不变、锁冲突 409、死锁接管) /
 *       多候选 md 不猜 / 路径逃逸 403
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createWebApp } from "../../src/server/app.js";
import { resolveWebConfig } from "../../src/server/config.js";
import { deriveImgSecret } from "../../src/server/gzh-routes.js";

const SECRET = "test-secret";

function setupVault(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gzh-vault-"));
  const article = path.join(base, "文章A");
  fs.mkdirSync(path.join(article, "imgs"), { recursive: true });
  fs.writeFileSync(path.join(article, "文章A.md"), [
    "# 文章A",
    "",
    "![中心图](imgs/01-中心图.png)",
    "",
    "![流程](./imgs/02-流程.gif)",
    "",
    "外部图不动:![外链](https://example.com/x.png)",
    "",
    "白名单外不动:![未引用文件](imgs/09-不存在.png)",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> 引用块",
    "",
    "```js",
    "console.log(1)",
    "```",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(article, "article.yaml"), 'title: 文章A\ndigest: 一句话导语\nauthor: 测试\n', "utf8");
  fs.writeFileSync(path.join(article, "imgs", "01-中心图.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  fs.writeFileSync(path.join(article, "imgs", "02-流程.gif"), Buffer.from("GIF89a-fake"));
  return base;
}

function makeApp(vault: string) {
  const config = resolveWebConfig({ configDir: vault });
  const app = createWebApp({
    config,
    version: "test",
    gzhVaultRoot: vault,
    rateLimit: { windowMs: 60_000, max: 10_000 },
  });
  // 测试注入固定密钥:重新注册会冲突,改为直接用同一派生函数计算预期签名
  const auth = { authorization: `Bearer ${config.token}` };
  const inject = (opts: Parameters<typeof app.inject>[0]) =>
    app.inject({ ...opts, headers: { ...auth, ...(opts.headers ?? {}) } });
  return { app, inject, token: config.token };
}

function articleDir(vault: string): string {
  return path.join(vault, "文章A");
}

test("未带 token 访问 gzh API 返回 401;/gzh-img 免 Bearer", async () => {
  const vault = setupVault();
  const { app } = makeApp(vault);
  const r1 = await app.inject({ method: "GET", url: "/api/gzh/articles" });
  assert.equal(r1.statusCode, 401);
  const r2 = await app.inject({ method: "GET", url: "/gzh-img?s=bad" });
  assert.equal(r2.statusCode, 403); // 403(签名错)而非 401 —— 证明免 Bearer 且有自校验
});

test("文章列表返回文章并带 style 与 drafted 标记", async () => {
  const vault = setupVault();
  const { inject } = makeApp(vault);
  const r = await inject({ method: "GET", url: "/api/gzh/articles" });
  assert.equal(r.statusCode, 200);
  const body = r.json() as { articles: Array<{ title: string; drafted: boolean }> };
  assert.equal(body.articles.length, 1);
  assert.equal(body.articles[0].title, "文章A");
  assert.equal(body.articles[0].drafted, false);
});

test("加载:图片引用重写为签名 URL,外链与白名单外引用不动", async () => {
  const vault = setupVault();
  const { inject } = makeApp(vault);
  const r = await inject({ method: "GET", url: `/api/gzh/article?dir=${encodeURIComponent(articleDir(vault))}` });
  assert.equal(r.statusCode, 200);
  const body = r.json() as { markdown: string; mdHash: string; styleHash: string; images: Array<{ name: string }> };
  assert.ok(body.markdown.includes("](/gzh-img?"));
  assert.ok(!body.markdown.includes("](imgs/01-中心图.png)"));
  assert.ok(body.markdown.includes("https://example.com/x.png"), "外链不应被重写");
  assert.ok(body.markdown.includes("imgs/09-不存在.png"), "白名单外引用不应被重写");
  assert.equal(body.images.length, 2);
  assert.ok(body.mdHash.length === 64);
  globalThis.__gzhBody = body;
});

test("签名图片:正常 200 带正确 MIME;过期 403;篡改 403;文件名越界 403;目录越界 403", async () => {
  const vault = setupVault();
  const made = makeApp(vault);
  const { inject, token } = made;
  const secret = deriveImgSecret(token);
  const dir = articleDir(vault);
  const mk = (d: string, f: string, exp?: number) => {
    const e = exp ?? Date.now() + 3600_000;
    const s = crypto.createHmac("sha256", secret).update(`${d}\n${f}\n${e}`).digest("hex");
    const q = new URLSearchParams({ d, f, e: String(e), s });
    return `/gzh-img?${q.toString()}`;
  };
  const r1 = await inject({ method: "GET", url: mk(dir, "01-中心图.png") });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.headers["content-type"], "image/png");
  // GIF MIME
  // 正常(中文文件名走 encodeURIComponent)
  const r1b = await inject({ method: "GET", url: mk(dir, "02-流程.gif") });
  assert.equal(r1b.statusCode, 200);
  assert.equal(r1b.headers["content-type"], "image/gif");
  // 过期
  const r2 = await inject({ method: "GET", url: mk(dir, "01-中心图.png", Date.now() - 1000) });
  assert.equal(r2.statusCode, 403);
  // 篡改签名
  const bad = mk(dir, "01-中心图.png").replace(/s=[0-9a-f]{10}/, "s=0000000000");
  const r3 = await inject({ method: "GET", url: bad });
  assert.equal(r3.statusCode, 403);
  // 文件名含路径
  const r4 = await inject({ method: "GET", url: mk(dir, "../article.yaml") });
  assert.equal(r4.statusCode, 403);
  // 目录越界(vault 外)
  const r5 = await inject({ method: "GET", url: mk(path.join(os.tmpdir(), "other"), "x.png") });
  assert.equal(r5.statusCode, 403);
});

test("保存:签名 URL 还原为 imgs/ 相对路径,返回新哈希", async () => {
  const vault = setupVault();
  const { inject } = makeApp(vault);
  const dir = articleDir(vault);
  const loaded = (await inject({ method: "GET", url: `/api/gzh/article?dir=${encodeURIComponent(dir)}` })).json() as {
    markdown: string;
    mdHash: string;
  };
  const edited = loaded.markdown.replace("# 文章A", "# 文章A(改)");
  const r = await inject({
    method: "POST",
    url: "/api/gzh/article/save",
    payload: { dir, markdown: edited, baseMdHash: loaded.mdHash },
  });
  assert.equal(r.statusCode, 200);
  const body = r.json() as { saved: string[]; mdHash: string };
  assert.deepEqual(body.saved, ["markdown"]);
  const after = fs.readFileSync(path.join(dir, "文章A.md"), "utf8");
  assert.ok(after.includes("# 文章A(改)"));
  assert.ok(after.includes("![中心图](imgs/01-中心图.png)"), "保存后应还原为相对路径");
  assert.ok(after.includes("![流程](imgs/02-流程.gif)"));
  assert.ok(!after.includes("/gzh-img?"), "不应残留签名 URL");
  assert.equal(sha256File(path.join(dir, "文章A.md")), body.mdHash);
});

test("baseHash 不匹配返回 409(并发修改防覆盖)", async () => {
  const vault = setupVault();
  const { inject } = makeApp(vault);
  const dir = articleDir(vault);
  const r = await inject({
    method: "POST",
    url: "/api/gzh/article/save",
    payload: { dir, markdown: "# 覆盖", baseMdHash: "0".repeat(64) },
  });
  assert.equal(r.statusCode, 409);
  const after = fs.readFileSync(path.join(dir, "文章A.md"), "utf8");
  assert.ok(after.startsWith("# 文章A"), "冲突时原文件不得被改");
});

test("只保存 style:md 字节级不变,yaml 增 style 行", async () => {
  const vault = setupVault();
  const { inject } = makeApp(vault);
  const dir = articleDir(vault);
  const mdBefore = fs.readFileSync(path.join(dir, "文章A.md"));
  const r = await inject({
    method: "POST",
    url: "/api/gzh/article/save",
    payload: { dir, style: "wechat-ft" },
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual((r.json() as { saved: string[] }).saved, ["style"]);
  const mdAfter = fs.readFileSync(path.join(dir, "文章A.md"));
  assert.ok(mdBefore.equals(mdAfter), "切主题绝不能改正文");
  const yaml = fs.readFileSync(path.join(dir, "article.yaml"), "utf8");
  assert.ok(yaml.includes("style: wechat-ft"));
  assert.ok(yaml.includes("title: 文章A"), "其余 yaml 字段保留");
  // 二次保存:替换而非追加
  const r2 = await inject({ method: "POST", url: "/api/gzh/article/save", payload: { dir, style: "wechat-anthropic" } });
  assert.equal(r2.statusCode, 200);
  const yaml2 = fs.readFileSync(path.join(dir, "article.yaml"), "utf8");
  assert.equal(yaml2.match(/^style:.*$/gm)?.length, 1);
  assert.ok(yaml2.includes("wechat-anthropic"));
});

test("锁冲突:存活持有者 409;死进程锁自动接管", async () => {
  const vault = setupVault();
  const { inject } = makeApp(vault);
  const dir = articleDir(vault);
  const lockPath = path.join(dir, ".publish.article.lock");
  // 存活持有者:本进程 pid
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, runId: "other", granularity: "article" }));
  const r1 = await inject({
    method: "POST",
    url: "/api/gzh/article/save",
    payload: { dir, style: "wechat-ft" },
  });
  assert.equal(r1.statusCode, 409);
  assert.ok((r1.json() as { message: string }).message.includes("持有"));
  // 死进程:接管后成功
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, runId: "dead", granularity: "article" }));
  const r2 = await inject({
    method: "POST",
    url: "/api/gzh/article/save",
    payload: { dir, style: "wechat-ft" },
  });
  assert.equal(r2.statusCode, 200);
  assert.ok(!fs.existsSync(lockPath), "保存完成后锁应释放");
});

test("目录逃逸与多候选 md 拒绝", async () => {
  const vault = setupVault();
  const { inject } = makeApp(vault);
  const outside = path.join(vault, "..", "escaped");
  const r1 = await inject({ method: "GET", url: `/api/gzh/article?dir=${encodeURIComponent(outside)}` });
  assert.equal(r1.statusCode, 403);
  const dir = articleDir(vault);
  fs.writeFileSync(path.join(dir, "第二篇.md"), "# 第二篇", "utf8");
  const r2 = await inject({ method: "GET", url: `/api/gzh/article?dir=${encodeURIComponent(dir)}` });
  assert.equal(r2.statusCode, 400);
  const body = r2.json() as { details: { candidates: string[] } };
  assert.equal(body.details.candidates.length, 2);
});

test("导出渲染 HTML:签名 URL 还原为相对路径后写入 layout.html", async () => {
  const vault = setupVault();
  const { inject } = makeApp(vault);
  const dir = articleDir(vault);
  const loaded = (await inject({ method: "GET", url: `/api/gzh/article?dir=${encodeURIComponent(dir)}` })).json() as {
    markdown: string;
  };
  const imgUrl = loaded.markdown.match(/\/gzh-img\?[^)\s]+/)?.[0] ?? "";
  assert.ok(imgUrl.length > 0, "加载后应含签名 URL");
  const html = `<section style="font-size:16px;"><h1>标题</h1><img src="${imgUrl.replace(/&/g, "&amp;")}" style="max-width:100%;"/></section>` + "x".repeat(80);
  const r = await inject({ method: "POST", url: "/api/gzh/article/export", payload: { dir, html } });
  assert.equal(r.statusCode, 200);
  const layout = fs.readFileSync(path.join(dir, "layout.html"), "utf8");
  assert.ok(layout.includes('src="imgs/01-中心图.png"') && !layout.includes("/gzh-img?"), "export 应还原 imgs 相对引用");
  const mdAfter = fs.readFileSync(path.join(dir, "文章A.md"), "utf8");
  assert.ok(mdAfter.includes("# 文章A"), "export 不得动正文");
});

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

declare global {
  // eslint-disable-next-line no-var
  var __gzhBody: unknown;
}
