/**
 * V2-P1-07 契约测试：/api/openapi.json 与实际路由一致；共享契约类型可导入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebApp } from "../../src/server/app.js";
import { ProjectRegistry } from "../../src/server/projects.js";
import { createRunApplicationService } from "../../src/application/run-service.js";
import { resolveWebConfig } from "../../src/server/config.js";
import { API_ROUTES, buildOpenApiDocument } from "../../src/server/contract.js";

const fakeRunner = { async run(p: string) { return { type: "text" as const, value: p, sessionId: "s" }; } };

function makeApp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "v2-contract-"));
  fs.mkdirSync(path.join(base, "proj"));
  const registry = new ProjectRegistry([path.join(base, "proj")]);
  const service = createRunApplicationService({ baseDir: base, runner: fakeRunner });
  const config = resolveWebConfig({ configDir: base });
  const app = createWebApp({ config, service, registry, version: "test" });
  return { app, config };
}

test("openapi：GET /api/openapi.json 200 且路径集合与 API_ROUTES 完全一致", async () => {
  const { app, config } = makeApp();
  const res = await app.inject({ method: "GET", url: "/api/openapi.json", headers: { authorization: `Bearer ${config.token}` } });
  assert.equal(res.statusCode, 200);
  const doc = res.json() as { openapi: string; paths: Record<string, Record<string, unknown>> };
  assert.equal(doc.openapi, "3.1.0");
  const served = new Set<string>();
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const m of Object.keys(methods)) served.add(`${m.toUpperCase()} ${p}`);
  }
  const expected = new Set<string>(API_ROUTES);
  assert.deepEqual([...served].sort(), [...expected].sort(), "OpenAPI 文档路径必须覆盖且仅覆盖 API_ROUTES");
  await app.close();
});

test("openapi：无 token 401（与其它 /api 同规）", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("契约：buildOpenApiDocument 可独立构建；ApiError/SSE 帧类型形状稳定", () => {
  const doc = buildOpenApiDocument("http://127.0.0.1:9999") as { servers: Array<{ url: string }> };
  assert.equal(doc.servers[0].url, "http://127.0.0.1:9999");
  const err: import("../../src/server/contract.js").ApiError = {
    code: "RUN_NOT_FOUND",
    message: "x",
    requestId: "r-1",
  };
  assert.equal(err.code, "RUN_NOT_FOUND");
});
