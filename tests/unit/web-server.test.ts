/**
 * V2-P1 P1-01 单测：Web app 工厂 + 配置解析 + health 端点
 * 契约（PRD §4/§6）：GET /api/health 无敏感信息（不含 token/路径/环境）；
 * 配置优先级 CLI flags > 环境变量 > config 文件 > 缺省。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebApp } from "../../src/server/app.js";
import { resolveWebConfig, generateWebToken, DEFAULT_WEB_CONFIG } from "../../src/server/config.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "v2p1-"));
}

test("P1-01 config：缺省值（127.0.0.1:4317，仅 examples 白名单）", () => {
  const dir = tmpDir(); // 无 config 文件
  const c = resolveWebConfig({ configDir: dir });
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 4317);
  assert.equal(c.maxConcurrentRuns, 2);
  assert.equal(c.eventRetentionDays, 30);
  assert.ok(c.token.length >= 32, "token 高熵随机");
  assert.deepEqual(c.projectRoots, [path.resolve(dir, "./examples")]);
});

test("P1-01 config：优先级 CLI flags > config 文件；projectRoots 解析为绝对路径", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "pi-workflow.config.json"),
    JSON.stringify({ web: { port: 9999, host: "0.0.0.0", projectRoots: ["./projects"] } }),
  );
  const c = resolveWebConfig({ configDir: dir });
  assert.equal(c.port, 9999);
  assert.equal(c.host, "0.0.0.0", "config 文件可改 host（仅本机自定；缺省仍是 127.0.0.1）");
  assert.deepEqual(c.projectRoots, [path.resolve(dir, "./projects")]);

  const overridden = resolveWebConfig({ configDir: dir, port: 7777 });
  assert.equal(overridden.port, 7777, "CLI flag 优先于 config 文件");
});

test("P1-01 config：畸形 config 文件不阻断（回落缺省）", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "pi-workflow.config.json"), "{not json");
  const c = resolveWebConfig({ configDir: dir });
  assert.equal(c.port, DEFAULT_WEB_CONFIG.port);
});

test("P1-01 config：token 可注入（生产沿用固定值场景）", () => {
  const t = generateWebToken();
  const c = resolveWebConfig({ token: t });
  assert.equal(c.token, t);
});

test("P2-05 config：config 文件 web.token 生效（修复：此前被忽略），CLI token 优先", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "pi-workflow.config.json"),
    JSON.stringify({ web: { token: "fixed-token-from-config-0123456789" } }),
  );
  const c = resolveWebConfig({ configDir: dir });
  assert.equal(c.token, "fixed-token-from-config-0123456789", "config 文件 token 不再被随机值覆盖");

  const overridden = resolveWebConfig({ configDir: dir, token: "cli-token-0123456789abcdef0123456789" });
  assert.equal(overridden.token, "cli-token-0123456789abcdef0123456789", "CLI token 优先于 config 文件");
});

test("P1-01 health：app.inject 200，形状正确且无敏感信息", async () => {
  const config = resolveWebConfig({});
  const app = createWebApp({ config, version: "0.1.0-test" });
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; service: string; version: string; uptimeSec: number };
  assert.equal(body.ok, true);
  assert.equal(body.service, "pi-workflow-web");
  assert.equal(body.version, "0.1.0-test");
  assert.equal(typeof body.uptimeSec, "number");
  const raw = res.body;
  assert.ok(!raw.includes(config.token), "health 不泄露 token");
  assert.ok(!raw.includes("/Users/"), "health 不泄露本机路径");
});

test("P1-06 后：未知 /api 路由无 token → 401（不暴露路由存在性）；带 token → 404 JSON", async () => {
  const config = resolveWebConfig({});
  const app = createWebApp({ config, service: undefined });
  const noToken = await app.inject({ method: "GET", url: "/api/no-such" });
  assert.equal(noToken.statusCode, 401);
  const withToken = await app.inject({ method: "GET", url: "/api/no-such", headers: { authorization: `Bearer ${config.token}` } });
  assert.equal(withToken.statusCode, 404);
  await app.close();
});
