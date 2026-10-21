/**
 * API client —— 全部类型来自共享契约 src/server/contract.ts（@server 别名），
 * 前端禁止重抄字段。token 仅走 Authorization 头（Server 不读 query）。
 */
import type {
  ApiError,
  CheckpointDecisionRequest,
  CheckpointDecisionResponse,
  CheckpointDto,
  EventsResponse,
  HealthResponse,
  ProjectDto,
  ResumeRequest,
  RunDetailResponse,
  RunListResponse,
  RunStatus,
  StartRunRequest,
  StartRunResponse,
  ValidateResponse,
  WorkflowDto,
} from "@server/contract";
import { getToken } from "./auth";

export class ApiRequestError extends Error {
  readonly code: ApiError["code"];
  readonly status: number;
  readonly details?: string[];
  readonly requestId?: string;

  constructor(err: ApiError, status: number) {
    super(err.message);
    this.name = "ApiRequestError";
    this.code = err.code;
    this.status = status;
    this.details = err.details;
    this.requestId = err.requestId;
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function request<T>(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: authHeaders(init?.headers) });
  } catch (e) {
    throw new ApiRequestError(
      {
        code: "SERVICE_UNAVAILABLE",
        message: e instanceof Error ? `网络错误：${e.message}` : "网络错误",
        requestId: "-",
      },
      0,
    );
  }
  if (!res.ok) {
    let body: ApiError = { code: "SERVICE_UNAVAILABLE", message: `HTTP ${res.status}`, requestId: "-" };
    try {
      const parsed = (await res.json()) as ApiError;
      if (parsed && typeof parsed.code === "string") body = parsed;
    } catch {
      // 保持兜底错误体
    }
    throw new ApiRequestError(body, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>("/api/health");
  },

  projects(): Promise<{ projects: ProjectDto[] }> {
    return request("/api/projects");
  },

  workflows(projectId: string): Promise<{ workflows: WorkflowDto[] }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/workflows`);
  },

  validate(body: { projectId?: string; path?: string; source?: string; args?: unknown }): Promise<ValidateResponse> {
    return request("/api/workflows/validate", { method: "POST", body: JSON.stringify(body) });
  },

  startRun(body: StartRunRequest): Promise<StartRunResponse> {
    const headers: Record<string, string> = {};
    if (body.idempotencyKey) headers["Idempotency-Key"] = body.idempotencyKey;
    return request("/api/runs", { method: "POST", body: JSON.stringify(body), headers });
  },

  listRuns(opts?: { page?: number; pageSize?: number; status?: RunStatus | string }): Promise<RunListResponse> {
    const q = new URLSearchParams();
    if (opts?.page) q.set("page", String(opts.page));
    if (opts?.pageSize) q.set("pageSize", String(opts.pageSize));
    if (opts?.status) q.set("status", opts.status);
    const qs = q.toString();
    return request(`/api/runs${qs ? `?${qs}` : ""}`);
  },

  getRun(runId: string): Promise<RunDetailResponse> {
    return request(`/api/runs/${encodeURIComponent(runId)}`);
  },

  events(runId: string, after?: number, limit?: number): Promise<EventsResponse> {
    const q = new URLSearchParams();
    if (after !== undefined) q.set("after", String(after));
    if (limit !== undefined) q.set("limit", String(limit));
    return request(`/api/runs/${encodeURIComponent(runId)}/events?${q.toString()}`);
  },

  cancel(runId: string): Promise<{ snapshot: RunDetailResponse["snapshot"] }> {
    return request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  },

  resume(runId: string, body: ResumeRequest): Promise<{ snapshot: RunDetailResponse["snapshot"] }> {
    return request(`/api/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", body: JSON.stringify(body) });
  },

  checkpoints(runId: string): Promise<{ checkpoints: CheckpointDto[] }> {
    return request(`/api/runs/${encodeURIComponent(runId)}/checkpoints`);
  },

  decideCheckpoint(runId: string, checkpointId: string, body: CheckpointDecisionRequest): Promise<CheckpointDecisionResponse> {
    return request(
      `/api/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/decision`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
};

// ---------- SSE（fetch 流式：可带 Authorization 头；EventSource 做不到） ----------

export interface SseHandlers {
  onEvent: (frame: { id: string; data: unknown }) => void;
  onDone?: () => void;
}

export async function streamRun(runId: string, lastEventId: string | null, handlers: SseHandlers, signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stream`, { headers, signal });
  if (!res.ok || !res.body) {
    let body: ApiError = { code: "SERVICE_UNAVAILABLE", message: `HTTP ${res.status}`, requestId: "-" };
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // 兜底
    }
    throw new ApiRequestError(body, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE 帧以空行分隔；逐帧解析（id:/event:/data: 字段）
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const rawFrame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);

      let id = "";
      let event = "message";
      const dataLines: string[] = [];
      for (const line of rawFrame.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        // 冒号开头为注释（心跳帧）
      }

      if (event === "done") {
        handlers.onDone?.();
        return;
      }
      // 服务端事件帧的 event 字段是 WorkflowEvent.type（run.completed 等），无 event 字段= message（SSE 规范缺省）；
      // 仅忽略显式 heartbeat 与无 data 帧，其余均按事件数据处理。
      if (event === "heartbeat") continue;
      const dataText = dataLines.join("\n");
      if (!dataText) continue;
      let data: unknown;
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }
      handlers.onEvent({ id, data });
    }
  }
  // 流被服务端/网络关闭且未收到 done：正常返回，调用方决定重连
}
