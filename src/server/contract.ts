/**
 * V2 Web 共享契约（P1-07）—— Server（src/server/）与前端（web/）共用的 DTO/错误码。
 *
 * 真源职责：这里是 HTTP API 的类型契约；app.ts 负责行为，若两侧漂移由
 * tests/unit/web-contract.test.ts 的 OpenAPI 路径一致性测试兜底。
 * 前端（V2-P2）从本文件 import，禁止自行重抄字段。
 */

/** PRD §4 错误码全集（+P1-06 安全层扩展） */
export type ApiErrorCode =
  | "INVALID_INPUT"
  | "RUN_NOT_FOUND"
  | "CONFLICT"
  | "RESUME_MISMATCH"
  | "CHECKPOINT_NOT_PENDING"
  | "FORBIDDEN_PATH"
  | "RUN_LIMIT_REACHED"
  | "SIDE_EFFECTS_UNACKNOWLEDGED"
  | "RUN_STILL_ACTIVE"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE";

/** 统一错误体：所有非 2xx 响应 */
export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: string[];
  requestId: string;
}

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "waiting_checkpoint";

export type CheckpointStatus = "pending" | "approved" | "rejected";

// ---------- 响应 DTO ----------

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  uptimeSec: number;
}

export interface ProjectDto {
  id: string;
  name: string;
  root: string;
}

export interface WorkflowDto {
  projectId: string;
  /** 项目内相对路径（POSIX 分隔符） */
  path: string;
  meta?: { name: string; description?: string; phases?: Array<{ title: string }> };
  error?: string;
}

export interface ValidateResponse {
  valid: boolean;
  meta: { name: string; description?: string; phases?: Array<{ title: string }> };
  phaseCount: number;
}

export interface RunSummaryDto {
  runId: string;
  status: RunStatus;
  /** 死进程补偿态：manifest=running 但 pid 已死 → interrupted */
  effectiveStatus: RunStatus;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunListResponse {
  runs: RunSummaryDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CheckpointDto {
  checkpointId: string;
  nodeId?: string;
  question: string;
  status: CheckpointStatus;
  version: number;
  requestedAt?: string;
  decidedAt?: string;
  decision?: "approve" | "reject";
}

/** GET /api/runs/:id 快照（含审批清单） */
export interface RunDetailResponse {
  snapshot: {
    runId: string;
    status: RunStatus;
    meta: { name: string; description?: string };
    createdAt: string;
    updatedAt: string;
    error?: string;
    [k: string]: unknown;
  };
  checkpoints: CheckpointDto[];
}

export interface EventsResponse {
  events: Array<{ sequence: number; type: string; at?: string; [k: string]: unknown }>;
  lastSequence: number;
}

// ---------- 请求 DTO ----------

export interface StartRunRequest {
  projectId: string;
  path: string;
  args?: unknown;
  model?: string;
  cwd?: string;
  concurrency?: number;
  timeoutMs?: number | null;
  retries?: number;
  maxAgents?: number;
  continueOnFailure?: boolean;
  /** 幂等键（也可走 Idempotency-Key 头） */
  idempotencyKey?: string;
}

export interface StartRunResponse {
  runId: string;
  /** 同幂等键重复请求的回放 */
  replayed?: boolean;
}

export interface ResumeRequest {
  /** 中断恢复副作用确认（waiting_checkpoint 恢复不要求） */
  acknowledgeSideEffects: boolean;
}

export interface CheckpointDecisionRequest {
  decision: "approve" | "reject";
  /** 乐观并发：与 checkpoint 当前 version 匹配 */
  expectedVersion: number;
}

export interface CheckpointDecisionResponse {
  checkpoint: CheckpointDto;
}

/** SSE 流帧（GET /api/runs/:id/stream） */
export interface SseFrame {
  id: string;
  /** 事件类型：WorkflowEvent.type（run.completed 等）或 "done"；心跳为 SSE 注释帧（无 event 字段） */
  event: string;
  /** WorkflowEvent JSON（非 done 帧时） */
  data: unknown;
}

// ---------- OpenAPI 3.1（简版真源，GET /api/openapi.json 提供） ----------

export const API_ROUTES = [
  "GET /api/health",
  "GET /api/openapi.json",
  "GET /api/projects",
  "GET /api/projects/{id}/workflows",
  "POST /api/workflows/validate",
  "POST /api/runs",
  "GET /api/runs",
  "GET /api/runs/{id}",
  "GET /api/runs/{id}/events",
  "GET /api/runs/{id}/stream",
  "POST /api/runs/{id}/cancel",
  "POST /api/runs/{id}/resume",
  "GET /api/runs/{id}/checkpoints",
  "POST /api/runs/{id}/checkpoints/{checkpointId}/decision",
] as const;

export function buildOpenApiDocument(origin = "http://127.0.0.1:4317"): Record<string, unknown> {
  const errorRef = { $ref: "#/components/schemas/ApiError" };
  return {
    openapi: "3.1.0",
    info: { title: "pi-workflow web", version: "2", description: "本地单用户 Web API（token 保护）" },
    servers: [{ url: origin }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        ApiError: {
          type: "object",
          required: ["code", "message", "requestId"],
          properties: {
            code: { type: "string", description: "见 ApiErrorCode（INVALID_INPUT/RUN_NOT_FOUND/CONFLICT/RESUME_MISMATCH/CHECKPOINT_NOT_PENDING/FORBIDDEN_PATH/RUN_LIMIT_REACHED/SIDE_EFFECTS_UNACKNOWLEDGED/RUN_STILL_ACTIVE/NOT_FOUND/UNAUTHORIZED/FORBIDDEN/RATE_LIMITED/SERVICE_UNAVAILABLE）" },
            message: { type: "string" },
            details: { type: "array", items: { type: "string" } },
            requestId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    security: [{ bearer: [] }],
    paths: {
      "/api/health": { get: { summary: "健康检查（免 token）", responses: { "200": { description: "ok" } } } },
      "/api/openapi.json": { get: { summary: "本文档", responses: { "200": { description: "OpenAPI 3.1" } } } },
      "/api/projects": {
        get: {
          summary: "项目白名单列表",
          responses: { "200": { description: "ProjectDto[]" }, "401": { description: "未授权", content: { "application/json": { schema: errorRef } } } },
        },
      },
      "/api/projects/{id}/workflows": {
        get: {
          summary: "项目内 workflow 枚举（meta 解析，不执行）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "WorkflowDto[]" }, "404": { description: "未知项目" } },
        },
      },
      "/api/workflows/validate": {
        post: {
          summary: "解析 meta + args 校验（不执行 JS）",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "ValidateResponse" }, "400": { description: "解析失败" } },
        },
      },
      "/api/runs": {
        post: {
          summary: "启动 Run（202；Idempotency-Key 幂等）",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["projectId", "path"] } } } },
          responses: { "202": { description: "StartRunResponse" }, "403": { description: "路径越权" }, "429": { description: "并发/限流上限" } },
        },
        get: {
          summary: "Run 历史（分页+状态过滤）",
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
            { name: "pageSize", in: "query", schema: { type: "integer", maximum: 200 } },
            { name: "status", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "RunListResponse" } },
        },
      },
      "/api/runs/{id}": {
        get: {
          summary: "Run 快照（缺失 404）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "RunDetailResponse" }, "404": { description: "RUN_NOT_FOUND" } },
        },
      },
      "/api/runs/{id}/events": {
        get: {
          summary: "事件历史（after/limit）",
          parameters: [
            { name: "after", in: "query", schema: { type: "integer", minimum: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 1000 } },
          ],
          responses: { "200": { description: "EventsResponse" }, "404": { description: "RUN_NOT_FOUND" } },
        },
      },
      "/api/runs/{id}/stream": {
        get: {
          summary: "SSE 增量事件流（Last-Event-ID 重连补传；token 走头不走 query）",
          parameters: [{ name: "lastEventId", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "text/event-stream" }, "404": { description: "RUN_NOT_FOUND" } },
        },
      },
      "/api/runs/{id}/cancel": {
        post: { summary: "取消（幂等）", responses: { "200": { description: "快照" }, "404": { description: "RUN_NOT_FOUND" } } },
      },
      "/api/runs/{id}/resume": {
        post: {
          summary: "恢复（要求副作用确认）",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["acknowledgeSideEffects"] } } } },
          responses: { "202": { description: "runId" }, "409": { description: "CONFLICT/SIDE_EFFECTS_UNACKNOWLEDGED" } },
        },
      },
      "/api/runs/{id}/checkpoints": {
        get: { summary: "审批清单（只读）", responses: { "200": { description: "CheckpointDto[]" }, "404": { description: "RUN_NOT_FOUND" } } },
      },
      "/api/runs/{id}/checkpoints/{checkpointId}/decision": {
        post: {
          summary: "批准/拒绝（expectedVersion 乐观并发；拒绝后硬停）",
          parameters: [{ name: "checkpointId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["decision", "expectedVersion"] } } } },
          responses: { "200": { description: "CheckpointDecisionResponse" }, "409": { description: "版本冲突/CHECKPOINT_NOT_PENDING" } },
        },
      },
    },
  };
}
