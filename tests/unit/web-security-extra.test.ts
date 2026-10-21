/** P3-04 安全补充：body 大小上限、HTTP 级 Run 并发限额、响应脱敏（无凭证/env 直推）、
 * XSS 面收敛（API 全 JSON、无 text/html 输出点）。E12/E13 的补齐面。 */

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
const LONG_SCRIPT = `export const meta = { name: "long_run" }\nconst out = []\nfor (let i = 0; i < 40; i++) out.push(await agent("s" + i))\nreturn out.length`;

/** 慢 fake runner：挂起直到 resolve，便于占住并发额度 */
function makePendingRunner() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const runner = {
    async run(p: string) {
      await gate;
      return { type: "text", value: `v:${p}`, sessionId: "s" } as const;
    },
  };
  return { runner, release: () => release() };
}

function makeApp(opts?: { maxConcurrentRuns?: number }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "v2-sec2-"));
  fs.mkdirSync(path.join(base, "proj"));
  fs.writeFileSync(path.join(base, "proj", "ok.js"), OK_SCRIPT);
  fs.writeFileSync(path.join(base, "proj", "long.js"), LONG_SCRIPT);
  const registry = new ProjectRegistry([path.join(base, "proj")]);
  const pending = makePendingRunner();
  const service = createRunApplicationService({
    baseDir: base,
    runner: pending.runner,
    maxConcurrentRuns: opts?.maxConcurrentRuns ?? 1,
  });
  const config = resolveWebConfig({ configDir: base });
  const app = createWebApp({ config, service, registry, version: "test" });
  const auth = { authorization: `Bearer ${config.token}` };
  return { app, config, base, auth, release: pending.release };
}

test("body 上限：>1MB 请求体 413 拒绝", async () => {
  const { app, auth } = makeApp();
  const huge = "x".repeat(1024 * 1024 + 1024);
  const res = await app.inject({
    method: "POST",
    url: "/api/workflows/validate",
    headers: { ...auth, "content-type": "application/json" },
    payload: { source: huge },
  });
  assert.equal(res.statusCode, 413, "超限 body 应 413");
});

test("Run 并发限额：HTTP 级 429 RUN_LIMIT_REACHED（maxConcurrentRuns=1）", async () => {
  const { app, auth, release } = makeApp();
  const first = await app.inject({
    method: "POST",
    url: "/api/runs",
    headers: { ...auth, "content-type": "application/json" },
    payload: { projectId: "proj", path: "long.js" },
  });
  assert.equal(first.statusCode, 202);
  const second = await app.inject({
    method: "POST",
    url: "/api/runs",
    headers: { ...auth, "content-type": "application/json" },
    payload: { projectId: "proj", path: "ok.js" },
  });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().code, "RUN_LIMIT_REACHED");
  release();
});

test("脱敏：全 API 响应不含 token/哨兵 env 值/堆栈帧；错误体结构化", async () => {
  const { app, auth, base, config, release } = makeApp();
  // 哨兵：模拟进程内敏感 env（任何 API 响应都不得出现其值）
  const sentinel = "P3-04-SECRET-VALUE-c7f91d";
  process.env.P3_04_SENTINEL = sentinel;
  try {
    const started = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { ...auth, "content-type": "application/json" },
      payload: { projectId: "proj", path: "ok.js", args: { note: "plain" } },
    });
    assert.equal(started.statusCode, 202);
    const runId = started.json().runId;
    release();
    const deadline = Date.now() + 15_000;
    let detail: { statusCode: number; body: string } | null = null;
    while (Date.now() < deadline) {
      detail = await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: auth });
      if (detail.json().snapshot?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(detail, "应读到 run 详情");
    const events = await app.inject({ method: "GET", url: `/api/runs/${runId}/events?limit=1000`, headers: auth });
    const list = await app.inject({ method: "GET", url: "/api/runs", headers: auth });
    const cps = await app.inject({ method: "GET", url: `/api/runs/${runId}/checkpoints`, headers: auth });
    const unknown = await app.inject({ method: "GET", url: "/api/runs/run-nonexistent", headers: auth });

    for (const [name, res] of [
      ["detail", detail],
      ["events", events],
      ["list", list],
      ["checkpoints", cps],
      ["404-error", unknown],
    ] as const) {
      const body = res.body;
      assert.ok(!body.includes(config.token), `${name} 不得回显 token`);
      assert.ok(!body.includes(sentinel), `${name} 不得携带进程 env 值`);
      assert.ok(!body.includes("    at "), `${name} 不得包含堆栈帧`);
      assert.ok(!/"stack"\s*:/.test(body), `${name} 不得有 stack 字段`);
    }
    // 错误体：结构化 code/message/requestId
    const errJson = unknown.json();
    assert.equal(errJson.code, "RUN_NOT_FOUND");
    assert.ok(errJson.requestId);
    void base;
  } finally {
    delete process.env.P3_04_SENTINEL;
  }
});

test("XSS 面：API 输出全部 application/json（无 text/html 输出点）；HTML 载荷作为数据转义", async () => {
  const { app, auth, base } = makeApp();
  // 带 HTML 注入载荷的脚本名/描述/日志（进 meta.name/description 与 log.appended 事件）
  const xssScript = `export const meta = { name: "xss_probe", description: "<img src=x onerror=window.__xss=1>" }\nlog("<script>window.__xss=2</script>")\nconst a = await agent("<b>bold</b>")\nreturn a`;
  fs.writeFileSync(path.join(base, "proj", "xss.js"), xssScript);
  const detail = await app.inject({
    method: "POST",
    url: "/api/workflows/validate",
    headers: { ...auth, "content-type": "application/json" },
    payload: { projectId: "proj", path: "xss.js" },
  });
  assert.equal(detail.statusCode, 200);
  assert.ok(detail.headers["content-type"].startsWith("application/json"), "validate 返回 JSON");
  // JSON 体里载荷是字符串数据（会被前端 React 文本渲染转义），后端不解释 HTML
  assert.ok(detail.body.includes("&lt;") === false, "JSON 体不嵌 HTML 实体（保持数据原样）");
  assert.ok(detail.body.includes("onerror"), "载荷作为数据原样传输（前端负责转义）");

  for (const [method, url] of [
    ["GET", "/api/projects"],
    ["GET", "/api/runs"],
    ["GET", "/api/openapi.json"],
  ] as const) {
    const res = await app.inject({ method, url, headers: auth });
    assert.ok(
      (res.headers["content-type"] ?? "").startsWith("application/json"),
      `${url} 应 application/json`,
    );
    assert.ok(!(res.headers["content-type"] ?? "").includes("text/html"), `${url} 不得 text/html`);
  }
});
