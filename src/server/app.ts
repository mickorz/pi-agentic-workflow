/**
 * Web app 工厂（V2-P1 P1-01 + P1-04 REST）
 *
 * createWebApp(deps) —— 全部依赖可注入（测试注入 fake；生产注入真实服务）：
 *   - config：WebServerConfig（host/port/token/白名单）
 *   - service：RunApplicationService（runs/checkpoints 数据面）
 *   - registry：ProjectRegistry（项目白名单/workflow 枚举与校验）
 *   - version：版本号（health 展示）
 *
 * REST 面（PRD §4，13 端点；/api/runs/:id/stream 属 P1-05 SSE）：
 *   GET  /api/health                                无敏感信息
 *   GET  /api/projects                              白名单项目列表
 *   GET  /api/projects/:id/workflows                安全枚举（E13 在 registry 层拦截）
 *   POST /api/workflows/validate                    meta 解析+args 校验（不执行 JS）
 *   POST /api/runs                                  启动（Idempotency-Key 幂等）→ 202 {runId}
 *   GET  /api/runs?page&pageSize&status             历史（页码分页+状态过滤）
 *   GET  /api/runs/:id                              Run Snapshot（含 checkpoints）
 *   GET  /api/runs/:id/events?after&limit           增量事件
 *   POST /api/runs/:id/cancel                       幂等取消
 *   POST /api/runs/:id/resume                       恢复（副作用确认）
 *   GET  /api/runs/:id/checkpoints                  待审批清单
 *   POST /api/runs/:id/checkpoints/:cid/decision    approve/reject（expectedVersion）
 *
 * 错误统一：{ code, message, details?, requestId }（requestId 每请求随机）。
 * 安全层（P1-06，PRD §6.1）：除 /api/health 外全部要求 Bearer token（绝不从 URL query 读
 * token，SSE 同规）；带 Origin 头时仅允许本机同源（跨站全拒，防 CSRF）；CORS 默认拒绝
 * （不加任何 Access-Control-Allow-* 头，浏览器只能同源读）；POST body JSON Schema 校验；
 * 每 IP 滑动窗口限流 + 全局 1MB body 上限。
 */

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { buildOpenApiDocument } from "./contract.js";
import type { WebServerConfig } from "./config.js";
import type { RunApplicationService } from "../application/run-service.js";
import { ServiceError, type StartRunOptions } from "../application/run-service.js";
import { ProjectError, type ProjectRegistry } from "./projects.js";
import type { WorkflowEvent } from "../events/types.js";

export interface WebAppDeps {
  config: WebServerConfig;
  /** REST 数据面服务（缺省时 REST 路由回 503，health 仍可用） */
  service?: RunApplicationService;
  registry?: ProjectRegistry;
  version?: string;
  startedAt?: number;
  /** 每 IP 滑动窗口限流（缺省 60s / 600 次） */
  rateLimit?: { windowMs: number; max: number };
}

/** 恒时比较 token（防时序侧信道） */
function tokenEquals(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 每 IP 滑动窗口限流器（进程内；本地服务足够，无需外置存储） */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

/** 错误码 → HTTP 状态映射（PRD §4 错误枚举） */
function statusForCode(code: string): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "NOT_FOUND":
    case "RUN_NOT_FOUND":
      return 404;
    case "FORBIDDEN_PATH":
      return 403;
    case "CONFLICT":
    case "RESUME_MISMATCH":
    case "CHECKPOINT_NOT_PENDING":
    case "RUN_STILL_ACTIVE":
    case "SIDE_EFFECTS_UNACKNOWLEDGED":
      return 409;
    case "RUN_LIMIT_REACHED":
      return 429;
    case "RATE_LIMITED":
      return 429;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
    case "FORBIDDEN_PATH":
      return 403;
    case "SERVICE_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function fail(reply: FastifyReply, code: string, message: string, details?: unknown): FastifyReply {
  return reply.code(statusForCode(code)).send({
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    requestId: reply.request.id,
  });
}

export function createWebApp(deps: WebAppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 1 * 1024 * 1024, // 1MB：POST /api/runs 参数上限（P1-06 细化 Rate/Size）
    genReqId: () => randomUUID(),
    // 覆盖 Fastify 默认 ajv removeAdditional:true（静默剥离未知字段）：
    // additionalProperties:false 必须真正报 400，防止调用方误传字段被无声忽略。
    // 保留 coerceTypes（数字/字符串宽松互转，可接受的 ergonomics）。
    ajv: { customOptions: { removeAdditional: false } },
  });
  const startedAt = deps.startedAt ?? Date.now();
  const version = deps.version ?? "0.0.0";
  const service = deps.service;
  const registry = deps.registry;
  const limiter = new RateLimiter(deps.rateLimit?.windowMs ?? 60_000, deps.rateLimit?.max ?? 600);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${deps.config.port}`,
    `http://localhost:${deps.config.port}`,
    `http://${deps.config.host}:${deps.config.port}`,
  ]);

  // ---- 安全层（P1-06）：限流 → token → Origin（对全部 /api 生效；/api/health 除外）----
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/health" || request.url.startsWith("/api/health?")) return;
    if (!limiter.allow(request.ip ?? "unknown")) {
      return reply.code(429).send({ code: "RATE_LIMITED", message: "请求过于频繁", requestId: request.id });
    }
    // token：仅 Authorization: Bearer 或专用头（绝不从 URL query 读，含 SSE）
    const authHeader = request.headers.authorization;
    const altHeader = request.headers["x-pi-workflow-token"];
    const received =
      (typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined) ??
      (typeof altHeader === "string" ? altHeader : undefined);
    if (received === undefined || !tokenEquals(received, deps.config.token)) {
      return reply.code(401).send({ code: "UNAUTHORIZED", message: "缺少或错误的访问 token", requestId: request.id });
    }
    // Origin：带头的请求仅允许本机同源（跨站 GET/POST 全拒；curl 无 Origin 不受影响）
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin !== "" && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ code: "FORBIDDEN", message: `跨 Origin 请求被拒：${origin}`, requestId: request.id });
    }
  });

  // 统一错误出口：ServiceError/ProjectError 按码映射；Schema/语法错 → INVALID_INPUT；其余 500
  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    if (error instanceof ServiceError || error instanceof ProjectError) {
      void reply.code(statusForCode(error.code)).send({
        code: error.code,
        message: error.message,
        requestId: request.id,
      });
      return;
    }
    if ((error as { validation?: unknown }).validation) {
      const validation = (error as { validation: Array<{ message?: string }> }).validation;
      void reply.code(400).send({
        code: "INVALID_INPUT",
        message: "请求体不符合 Schema",
        details: validation.map((v) => v.message ?? String(v)),
        requestId: request.id,
      });
      return;
    }
    if (error instanceof SyntaxError || (error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON") {
      void reply.code(400).send({ code: "INVALID_INPUT", message: "请求体不是合法 JSON", requestId: request.id });
      return;
    }
    void reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      requestId: request.id,
    });
  });

  app.get("/api/openapi.json", async () => buildOpenApiDocument(`http://${deps.config.host}:${deps.config.port}`));

  app.get("/api/health", async () => {
    return {
      ok: true,
      service: "pi-workflow-web",
      version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    };
  });

  // ---- projects / workflows ----

  app.get("/api/projects", async (_req, reply) => {
    if (!registry) return fail(reply, "SERVICE_UNAVAILABLE", "项目白名单未配置");
    return { projects: registry.listProjects() };
  });

  app.get("/api/projects/:id/workflows", async (req, reply) => {
    if (!registry) return fail(reply, "SERVICE_UNAVAILABLE", "项目白名单未配置");
    const { id } = req.params as { id: string };
    try {
      return { projectId: id, workflows: registry.listWorkflows(id) };
    } catch (error) {
      if (error instanceof ProjectError) return fail(reply, error.code, error.message);
      throw error;
    }
  });

  app.post("/api/workflows/validate", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          projectId: { type: "string" },
          path: { type: "string" },
          args: {},
        },
      },
    },
  }, async (req, reply) => {
    if (!registry) return fail(reply, "SERVICE_UNAVAILABLE", "项目白名单未配置");
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = registry.validateWorkflow({
        ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
        ...(typeof body.path === "string" ? { path: body.path } : {}),
        ...(typeof body.source === "string" ? { source: body.source } : {}),
        ...("args" in body ? { args: body.args } : {}),
      });
      return { valid: true, ...result };
    } catch (error) {
      if (error instanceof ProjectError) return fail(reply, error.code, error.message);
      throw error;
    }
  });

  // ---- runs ----

  // 幂等键缓存（进程内；上限 1000 FIFO 驱逐）
  const idempotencyCache = new Map<string, { runId: string }>();
  const IDEMPOTENCY_CACHE_LIMIT = 1000;

  app.post("/api/runs", {
    schema: {
      body: {
        type: "object",
        required: ["projectId", "path"],
        additionalProperties: false,
        properties: {
          projectId: { type: "string" },
          path: { type: "string" },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          args: {},
          model: { type: "string" },
          cwd: { type: "string" },
          concurrency: { type: "number" },
          timeoutMs: { type: "number" },
          retries: { type: "number" },
          maxAgents: { type: "number" },
          continueOnFailure: { type: "boolean" },
        },
      },
    },
  }, async (req, reply) => {
    if (!service || !registry) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const body = (req.body ?? {}) as Record<string, unknown>;
    // 幂等键：Header 优先，body.idempotencyKey 兜底
    const header = req.headers["idempotency-key"];
    const idemKey = (typeof header === "string" ? header : undefined) ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined);
    if (idemKey !== undefined && (idemKey.length === 0 || idemKey.length > 128)) {
      return fail(reply, "INVALID_INPUT", "Idempotency-Key 长度须在 1~128");
    }
    if (typeof body.projectId !== "string" || typeof body.path !== "string") {
      return fail(reply, "INVALID_INPUT", "需提供 projectId 与 path");
    }
    const replay = idemKey !== undefined ? idempotencyCache.get(idemKey) : undefined;
    if (replay) {
      return reply.code(202).send({ runId: replay.runId, replayed: true });
    }
    let scriptPath: string;
    try {
      scriptPath = registry.resolveWorkflowPath(body.projectId, body.path);
    } catch (error) {
      if (error instanceof ProjectError) return fail(reply, error.code, error.message);
      throw error;
    }
    const numeric = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    const input: StartRunOptions = {
      scriptPath,
      ...("args" in body ? { args: body.args } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
      ...(numeric(body.concurrency) !== undefined ? { concurrency: numeric(body.concurrency) } : {}),
      ...(numeric(body.timeoutMs) !== undefined ? { timeoutMs: numeric(body.timeoutMs) } : {}),
      ...(numeric(body.retries) !== undefined ? { retries: numeric(body.retries) } : {}),
      ...(numeric(body.maxAgents) !== undefined ? { maxAgents: numeric(body.maxAgents) } : {}),
      ...(typeof body.continueOnFailure === "boolean" ? { continueOnFailure: body.continueOnFailure } : {}),
    };
    const { runId } = await service.start(input);
    if (idemKey !== undefined) {
      if (idempotencyCache.size >= IDEMPOTENCY_CACHE_LIMIT) {
        const oldest = idempotencyCache.keys().next().value;
        if (oldest !== undefined) idempotencyCache.delete(oldest);
      }
      idempotencyCache.set(idemKey, { runId });
    }
    return reply.code(202).send({ runId });
  });

  app.get("/api/runs", async (req, reply) => {
    if (!service) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const query = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const pageSizeRaw = Number.parseInt(query.pageSize ?? "50", 10) || 50;
    const pageSize = Math.min(Math.max(1, pageSizeRaw), 200);
    const status = query.status;
    const all = await service.list();
    const filtered = status ? all.filter((r) => r.effectiveStatus === status) : all;
    const start = (page - 1) * pageSize;
    return {
      runs: filtered.slice(start, start + pageSize),
      page,
      pageSize,
      total: filtered.length,
    };
  });

  app.get("/api/runs/:id", async (req, reply) => {
    if (!service) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const { id } = req.params as { id: string };
    const detail = await service.get(id);
    if (!detail) return fail(reply, "RUN_NOT_FOUND", `run 不存在：${id}`);
    return detail;
  });

  app.get("/api/runs/:id/events", async (req, reply) => {
    if (!service) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, string | undefined>;
    const after = Math.max(0, Number.parseInt(query.after ?? "0", 10) || 0);
    const limitRaw = Number.parseInt(query.limit ?? "200", 10) || 200;
    const limit = Math.min(Math.max(1, limitRaw), 1000);
    const detail = await service.get(id);
    if (!detail) return fail(reply, "RUN_NOT_FOUND", `run 不存在：${id}`);
    const events = await service.readEvents(id, after);
    return { events: events.slice(0, limit), lastSequence: events.at(-1)?.sequence ?? after };
  });

  app.post("/api/runs/:id/cancel", async (req, reply) => {
    if (!service) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const { id } = req.params as { id: string };
    return { snapshot: await service.cancel(id) };
  });

  app.post("/api/runs/:id/resume", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: { acknowledgeSideEffects: { type: "boolean" } },
      },
    },
  }, async (req, reply) => {
    if (!service) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.acknowledgeSideEffects !== undefined && typeof body.acknowledgeSideEffects !== "boolean") {
      return fail(reply, "INVALID_INPUT", "acknowledgeSideEffects 须为布尔");
    }
    return service.resume(id, { acknowledgeSideEffects: body.acknowledgeSideEffects === true });
  });

  app.get("/api/runs/:id/checkpoints", async (req, reply) => {
    if (!service) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const { id } = req.params as { id: string };
    const detail = await service.get(id);
    if (!detail) return fail(reply, "RUN_NOT_FOUND", `run 不存在：${id}`);
    return { checkpoints: detail.checkpoints };
  });

  // ---- SSE：实时事件流（P1-05；PRD §4 /api/runs/:id/stream）----
  const SSE_POLL_MS = 150;
  const SSE_HEARTBEAT_MS = 15_000;
  const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled", "run.interrupted"]);
  const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

  app.get("/api/runs/:id/stream", async (req, reply) => {
    if (!service) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const { id } = req.params as { id: string };
    const detail = await service.get(id);
    if (!detail) return fail(reply, "RUN_NOT_FOUND", `run 不存在：${id}`);

    // 重连游标：Last-Event-ID 头（EventSource 自动携带）优先，query.lastEventId 兜底（token 不走 query，游标可以）
    const query = req.query as Record<string, string | undefined>;
    const headerRaw = req.headers["last-event-id"];
    const lastRaw = (typeof headerRaw === "string" && headerRaw !== "" ? headerRaw : undefined) ?? query.lastEventId;
    let cursor = Math.max(0, Number.parseInt(lastRaw ?? "0", 10) || 0);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let closed = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      raw.end();
    };
    const writeEvent = (event: WorkflowEvent): void => {
      raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    raw.on("close", close);

    // ① 先补传：游标之后的历史事件一次性发齐（顺序 = seq 单调）
    const backlog = await service.readEvents(id, cursor);
    for (const event of backlog) writeEvent(event);
    if (backlog.length > 0) cursor = backlog.at(-1)!.sequence;

    // ② 再订阅：短轮询磁盘（单写者 events.jsonl，天然去重/顺序）；终态无新增 → done 后关流
    let sawTerminalEvent =
      backlog.length > 0 && TERMINAL_EVENT_TYPES.has(backlog.at(-1)!.type);
    const poll = async (): Promise<void> => {
      if (closed) return;
      try {
        const events = await service.readEvents(id, cursor);
        if (events.length > 0) {
          for (const event of events) writeEvent(event);
          cursor = events.at(-1)!.sequence;
          if (TERMINAL_EVENT_TYPES.has(events.at(-1)!.type)) sawTerminalEvent = true;
          return;
        }
        // 无新增：查 manifest 终态（supervisor 失联回收等无 run.* 终态事件的场景）
        const d = await service.get(id);
        const status = d?.snapshot.status;
        if (sawTerminalEvent || (status !== undefined && TERMINAL_STATUSES.has(status))) {
          raw.write("event: done\ndata: {}\n\n");
          close();
        }
      } catch {
        /* 瞬时读错（如原子写中途）：下轮重试 */
      }
    };
    pollTimer = setInterval(() => void poll(), SSE_POLL_MS);
    heartbeatTimer = setInterval(() => {
      if (!closed) raw.write(": ping\n\n");
    }, SSE_HEARTBEAT_MS);
    void poll();
  });

  app.post("/api/runs/:id/checkpoints/:checkpointId/decision", {
    schema: {
      body: {
        type: "object",
        required: ["decision", "expectedVersion"],
        additionalProperties: false,
        properties: {
          decision: { type: "string", enum: ["approve", "reject"] },
          expectedVersion: { type: "integer", minimum: 0 },
        },
      },
    },
  }, async (req, reply) => {
    if (!service) return fail(reply, "SERVICE_UNAVAILABLE", "服务未配置");
    const { id, checkpointId } = req.params as { id: string; checkpointId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.decision !== "approve" && body.decision !== "reject") {
      return fail(reply, "INVALID_INPUT", "decision 须为 approve|reject");
    }
    if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
      return fail(reply, "INVALID_INPUT", "expectedVersion 须为非负整数");
    }
    const record = await service.decideCheckpoint(id, checkpointId, {
      decision: body.decision,
      expectedVersion: body.expectedVersion,
    });
    return { checkpoint: record };
  });

  return app;
}
