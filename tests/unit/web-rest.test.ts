/**
 * V2-P1-04 REST 路由测试（app.inject；in-process engine + fake runner）
 * 覆盖：13 端点行为、错误统一格式 {code,message,requestId}、幂等 start、E13 经 HTTP 层。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebApp } from "../../src/server/app.js";
import { ProjectRegistry } from "../../src/server/projects.js";
import { createRunApplicationService } from "../../src/application/run-service.js";
import type { AgentSessionRunner } from "../../src/agent/session-runner.js";
import { resolveWebConfig } from "../../src/server/config.js";

const fakeRunner: AgentSessionRunner = {
  async run(prompt: string) {
    return { type: "text", value: `fake:${prompt}`, sessionId: "s" };
  },
};

function makeApp(base: string) {
  const registry = new ProjectRegistry([path.join(base, "proj")]);
  const service = createRunApplicationService({ baseDir: base, runner: fakeRunner });
  const config = resolveWebConfig({ configDir: base });
  return {
    app: createWebApp({ config, service, registry, version: "test" }),
    service,
  };
}

function setup(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "v2-rest-"));
  fs.mkdirSync(path.join(base, "proj"));
  fs.writeFileSync(
    path.join(base, "proj", "ok.js"),
    `export const meta = { name: "ok", description: "d" }\nconst a = await agent("hi")\nreturn { a }`,
  );
  fs.writeFileSync(
    path.join(base, "proj", "cp.js"),
    `export const meta = { name: "cp" }\nconst ok = await checkpoint("deploy?")\nreturn { ok }`,
  );
  return base;
}

/** 等待条件（轮询 manifest 状态） */
async function waitStatus(app: ReturnType<typeof makeApp>["app"], runId: string, want: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    if (res.statusCode === 200 && (res.json() as { snapshot: { status: string } }).snapshot.status === want) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待状态 ${want} 超时：${runId}`);
}

test("GET /api/projects + /api/projects/:id/workflows：白名单可见 + meta 枚举", async () => {
  const base = setup();
  const { app } = makeApp(base);
  const p = await app.inject({ method: "GET", url: "/api/projects" });
  assert.equal(p.statusCode, 200);
  const projects = (p.json() as { projects: Array<{ id: string }> }).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.id, "proj");

  const w = await app.inject({ method: "GET", url: "/api/projects/proj/workflows" });
  assert.equal(w.statusCode, 200);
  const workflows = (w.json() as { workflows: Array<{ path: string; meta?: { name: string } }> }).workflows;
  const ok = workflows.find((x) => x.path === "ok.js");
  assert.equal(ok?.meta?.name, "ok");

  const nf = await app.inject({ method: "GET", url: "/api/projects/nope/workflows" });
  assert.equal(nf.statusCode, 404);
  assert.equal((nf.json() as { code: string }).code, "NOT_FOUND");
});

test("POST /api/workflows/validate：解析不执行 + 错误映射", async () => {
  const base = setup();
  const { app } = makeApp(base);
  const good = await app.inject({
    method: "POST",
    url: "/api/workflows/validate",
    payload: { source: `export const meta = { name: "x", phases: [{ title: "p" }] }` },
  });
  assert.equal(good.statusCode, 200);
  assert.equal((good.json() as { valid: boolean; phaseCount: number }).phaseCount, 1);

  const bad = await app.inject({
    method: "POST",
    url: "/api/workflows/validate",
    payload: { source: "const x = 1" },
  });
  assert.equal(bad.statusCode, 400);
  const body = bad.json() as { code: string; message: string; requestId: string };
  assert.equal(body.code, "INVALID_INPUT");
  assert.ok(body.requestId, "错误体带 requestId");
});

test("POST /api/runs：202+runId；真实执行到 completed；GET 详情/事件/列表", async () => {
  const base = setup();
  const { app } = makeApp(base);
  const created = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { projectId: "proj", path: "ok.js", args: { k: 1 } },
  });
  assert.equal(created.statusCode, 202);
  const { runId } = created.json() as { runId: string };

  await waitStatus(app, runId, "completed");

  const detail = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
  assert.equal(detail.statusCode, 200);
  const dj = detail.json() as { snapshot: { status: string; runId: string }; checkpoints: unknown[] };
  assert.equal(dj.snapshot.status, "completed");
  assert.equal(dj.snapshot.runId, runId);

  const events = await app.inject({ method: "GET", url: `/api/runs/${runId}/events?after=0&limit=1000` });
  assert.equal(events.statusCode, 200);
  const ej = events.json() as { events: Array<{ type: string; sequence: number }>; lastSequence: number };
  assert.ok(ej.events.length > 0, "事件非空");
  assert.ok(ej.events.some((e) => e.type === "run.completed"));
  assert.equal(ej.lastSequence, ej.events.at(-1)!.sequence);
  // after 游标
  const ev2 = await app.inject({ method: "GET", url: `/api/runs/${runId}/events?after=${ej.lastSequence}` });
  assert.deepEqual((ev2.json() as { events: unknown[] }).events, []);

  const list = await app.inject({ method: "GET", url: "/api/runs?pageSize=10&status=completed" });
  assert.equal(list.statusCode, 200);
  const lj = list.json() as { runs: Array<{ runId: string }>; page: number; pageSize: number; total: number };
  assert.equal(lj.total, 1);
  assert.equal(lj.runs[0]!.runId, runId);
  assert.equal(lj.pageSize, 10);

  const missing = await app.inject({ method: "GET", url: "/api/runs/run-nope" });
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.json() as { code: string }).code, "RUN_NOT_FOUND");
});

test("POST /api/runs 幂等键：重复请求同 runId 单创建 + replayed 标记", async () => {
  const base = setup();
  const { app } = makeApp(base);
  const payload = { method: "POST", url: "/api/runs", payload: { projectId: "proj", path: "ok.js" } } as const;
  const r1 = await app.inject({ ...payload, headers: { "idempotency-key": "abc" } });
  assert.equal(r1.statusCode, 202);
  const r2 = await app.inject({ ...payload, headers: { "idempotency-key": "abc" } });
  assert.equal(r2.statusCode, 202);
  const j1 = r1.json() as { runId: string; replayed?: boolean };
  const j2 = r2.json() as { runId: string; replayed?: boolean };
  assert.equal(j1.runId, j2.runId);
  assert.equal(j2.replayed, true);
  assert.equal(j1.replayed, undefined);
  // 单创建
  const list = await app.inject({ method: "GET", url: "/api/runs" });
  assert.equal((list.json() as { total: number }).total, 1);
});

test("E13 经 HTTP：穿越/未知项目/非法体 → 统一错误格式", async () => {
  const base = setup();
  const { app } = makeApp(base);
  const trav = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { projectId: "proj", path: "../outside/secret.js" },
  });
  assert.equal(trav.statusCode, 403);
  const tb = trav.json() as { code: string; requestId: string };
  assert.equal(tb.code, "FORBIDDEN_PATH");
  assert.ok(tb.requestId);

  const unknown = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { projectId: "zzz", path: "ok.js" },
  });
  assert.equal(unknown.statusCode, 404);

  const noFields = await app.inject({ method: "POST", url: "/api/runs", payload: {} });
  assert.equal(noFields.statusCode, 400);

  const badKey = await app.inject({
    method: "POST",
    url: "/api/runs",
    headers: { "idempotency-key": "" },
    payload: { projectId: "proj", path: "ok.js" },
  });
  assert.equal(badKey.statusCode, 400);
});

test("checkpoint 全链：pending 列表 → decision approve → completed", async () => {
  const base = setup();
  const { app } = makeApp(base);
  const created = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { projectId: "proj", path: "cp.js" },
  });
  const { runId } = created.json() as { runId: string };
  await waitStatus(app, runId, "waiting_checkpoint");

  const pending = await app.inject({ method: "GET", url: `/api/runs/${runId}/checkpoints` });
  assert.equal(pending.statusCode, 200);
  const cps = (pending.json() as { checkpoints: Array<{ checkpointId: string; version: number; status: string }> }).checkpoints;
  assert.equal(cps.length, 1);
  assert.equal(cps[0]!.status, "pending");

  const badVersion = await app.inject({
    method: "POST",
    url: `/api/runs/${runId}/checkpoints/${cps[0]!.checkpointId}/decision`,
    payload: { decision: "approve", expectedVersion: 99 },
  });
  assert.equal(badVersion.statusCode, 409);
  assert.equal((badVersion.json() as { code: string }).code, "CONFLICT");

  const ok = await app.inject({
    method: "POST",
    url: `/api/runs/${runId}/checkpoints/${cps[0]!.checkpointId}/decision`,
    payload: { decision: "approve", expectedVersion: cps[0]!.version },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { checkpoint: { status: string } }).checkpoint.status, "approved");
  await waitStatus(app, runId, "completed");

  const badDecision = await app.inject({
    method: "POST",
    url: `/api/runs/${runId}/checkpoints/${cps[0]!.checkpointId}/decision`,
    payload: { decision: "maybe", expectedVersion: 1 },
  });
  assert.equal(badDecision.statusCode, 400);
});

test("cancel/resume：幂等取消 + 完成后恢复 409", async () => {
  const base = setup();
  const { app } = makeApp(base);
  const created = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { projectId: "proj", path: "ok.js" },
  });
  const { runId } = created.json() as { runId: string };
  await waitStatus(app, runId, "completed");

  // cancel 幂等：非活跃直接返快照
  const c = await app.inject({ method: "POST", url: `/api/runs/${runId}/cancel` });
  assert.equal(c.statusCode, 200);
  assert.equal((c.json() as { snapshot: { status: string } }).snapshot.status, "completed");

  const r = await app.inject({ method: "POST", url: `/api/runs/${runId}/resume`, payload: {} });
  assert.equal(r.statusCode, 409);
  assert.equal((r.json() as { code: string }).code, "CONFLICT");

  const nf = await app.inject({ method: "POST", url: "/api/runs/run-nope/cancel" });
  assert.equal(nf.statusCode, 404);

  const badAck = await app.inject({
    method: "POST",
    url: `/api/runs/${runId}/resume`,
    payload: { acknowledgeSideEffects: "yes" },
  });
  assert.equal(badAck.statusCode, 400);
});
