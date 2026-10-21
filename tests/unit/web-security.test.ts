/**
 * V2-P1-06 安全测试：E12 未授权与跨 Origin 全拒；SSE 不走 URL query 透传 token；
 * Schema 校验；限流。
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

const OK_SCRIPT = `export const meta = { name: "ok" }\nconst a = await agent("hi")\nreturn { a }`;
const fakeRunner = { async run(p: string) { return { type: "text", value: `v:${p}`, sessionId: "s" } as const; } };

function makeApp(rateLimit?: { windowMs: number; max: number }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "v2-sec-"));
  fs.mkdirSync(path.join(base, "proj"));
  fs.writeFileSync(path.join(base, "proj", "ok.js"), OK_SCRIPT);
  const registry = new ProjectRegistry([path.join(base, "proj")]);
  const service = createRunApplicationService({ baseDir: base, runner: fakeRunner });
  const config = resolveWebConfig({ configDir: base });
  const app = createWebApp({ config, service, registry, version: "test", rateLimit });
  return { app, config, base };
}

test("E12：无/错 token 全拒（401），health 免 token；正确 Bearer 放行", async () => {
  const { app, config } = makeApp();
  // 无 token
  for (const url of ["/api/projects", "/api/runs", "/api/runs/x/stream", "/api/runs/x/events"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, `${url} 应 401`);
    assert.equal(res.json().code, "UNAUTHORIZED");
    assert.ok(res.json().requestId, "错误体带 requestId");
  }
  const post = await app.inject({ method: "POST", url: "/api/runs", payload: { projectId: "proj", path: "ok.js" } });
  assert.equal(post.statusCode, 401);
  // 错 token
  const bad = await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: "Bearer wrong" } });
  assert.equal(bad.statusCode, 401);
  // health 免 token（无敏感信息，活探测用）
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  // 正确 Bearer（Authorization 头）与专用头（X-PI-Workflow-Token）均放行
  const ok1 = await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${config.token}` } });
  assert.equal(ok1.statusCode, 200);
  const ok2 = await app.inject({ method: "GET", url: "/api/projects", headers: { "x-pi-workflow-token": config.token } });
  assert.equal(ok2.statusCode, 200);
});

test("E12：SSE 不走 URL query 透传 token——query 带 token 仍 401", async () => {
  const { app, config } = makeApp();
  const res = await app.inject({ method: "GET", url: `/api/runs/x/stream?token=${config.token}` });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "UNAUTHORIZED");
});

test("E12：跨 Origin 全拒（GET/POST 皆 403）；本机同源与无 Origin 放行", async () => {
  const { app, config } = makeApp();
  const auth = { authorization: `Bearer ${config.token}` };
  const evil = { ...auth, origin: "http://evil.example" };
  // 跨 Origin：GET 读 + POST 变更全拒
  const g = await app.inject({ method: "GET", url: "/api/projects", headers: evil });
  assert.equal(g.statusCode, 403);
  assert.equal(g.json().code, "FORBIDDEN");
  const p = await app.inject({ method: "POST", url: "/api/runs", headers: evil, payload: { projectId: "proj", path: "ok.js" } });
  assert.equal(p.statusCode, 403);
  // 本机同源 Origin 放行（127.0.0.1 / localhost 两形态）
  for (const origin of [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]) {
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: { ...auth, origin } });
    assert.equal(res.statusCode, 200, `${origin} 应放行`);
  }
  // 无 Origin（curl 同形态）放行
  const noOrigin = await app.inject({ method: "GET", url: "/api/projects", headers: auth });
  assert.equal(noOrigin.statusCode, 200);
});

test("CORS 默认拒绝：响应不带任何 Access-Control-Allow-* 头；预检 OPTIONS 无 CORS 放行头", async () => {
  const { app, config } = makeApp();
  const res = await app.inject({
    method: "OPTIONS",
    url: "/api/runs",
    headers: {
      origin: "http://evil.example",
      "access-control-request-method": "POST",
      authorization: `Bearer ${config.token}`,
    },
  });
  const allowHeaders = [...Object.keys(res.headers)].filter((h) => h.startsWith("access-control-allow"));
  assert.deepEqual(allowHeaders, [], "不得出现任何 CORS 放行头");
  const get = await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${config.token}` } });
  const allowHeaders2 = [...Object.keys(get.headers)].filter((h) => h.startsWith("access-control-allow"));
  assert.deepEqual(allowHeaders2, []);
});

test("Schema 校验：缺字段/类型错/未知字段/非法枚举 → 400 INVALID_INPUT + details", async () => {
  const { app, config } = makeApp();
  const h = { authorization: `Bearer ${config.token}` };
  // 缺必填
  const missing = await app.inject({ method: "POST", url: "/api/runs", headers: h, payload: { projectId: "proj" } });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, "INVALID_INPUT");
  assert.ok(Array.isArray(missing.json().details));
  // 类型错（对象不可强制转字符串；Fastify 默认 ajv coerceTypes 会把数字转字符串，属可接受宽松）
  const badType = await app.inject({
    method: "POST",
    url: "/api/runs",
    headers: h,
    payload: { projectId: { x: 1 }, path: "ok.js" },
  });
  assert.equal(badType.statusCode, 400);
  // 未知字段（additionalProperties:false）
  const extra = await app.inject({
    method: "POST",
    url: "/api/runs",
    headers: h,
    payload: { projectId: "proj", path: "ok.js", scriptPath: "/etc/passwd" },
  });
  assert.equal(extra.statusCode, 400);
  assert.ok(JSON.stringify(extra.json().details).toLowerCase().includes("additional"), `details 应提 additional：${extra.json().details}`);
  // decision 非法枚举
  const badEnum = await app.inject({
    method: "POST",
    url: "/api/runs/x/checkpoints/c/decision",
    headers: h,
    payload: { decision: "maybe", expectedVersion: 0 },
  });
  assert.equal(badEnum.statusCode, 400);
  // resume 未知字段
  const badResume = await app.inject({
    method: "POST",
    url: "/api/runs/x/resume",
    headers: h,
    payload: { force: true },
  });
  assert.equal(badResume.statusCode, 400);
  // 合法请求不受影响（走通一个真实 run）
  const ok = await app.inject({ method: "POST", url: "/api/runs", headers: h, payload: { projectId: "proj", path: "ok.js" } });
  assert.equal(ok.statusCode, 202);
});

test("限流：超出窗口上限 → 429 RATE_LIMITED；窗口内不受影响", async () => {
  const { app, config } = makeApp({ windowMs: 60_000, max: 3 });
  const h = { authorization: `Bearer ${config.token}` };
  const codes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: h });
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes, [200, 200, 200, 429]);
  const limited = await app.inject({ method: "GET", url: "/api/runs", headers: h });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "RATE_LIMITED");
  // health 不受限流影响（onRequest 前置豁免）
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
});
