/**
 * Web app 工厂（V2-P1 P1-01）
 *
 * createWebApp(deps) —— 全部依赖可注入（测试注入 fake；生产注入真实服务）：
 *   - config：WebServerConfig（host/port/token/白名单）
 *   - service：RunApplicationService（P1-04 路由用；本任务先入 deps 定形）
 *   - version：版本号（health 展示）
 *
 * 已注册面（本任务）：GET /api/health（无敏感信息）。
 * 后续：P1-04 REST 13 端点 / P1-05 SSE / P1-06 token+Origin 强制。
 */

import Fastify, { type FastifyInstance } from "fastify";
import type { WebServerConfig } from "./config.js";
import type { RunApplicationService } from "../application/run-service.js";

export interface WebAppDeps {
  config: WebServerConfig;
  /** REST 路由的执行服务（P1-04 接线；缺省占位——health 不需要） */
  service?: RunApplicationService;
  version?: string;
  startedAt?: number;
}

export function createWebApp(deps: WebAppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 1 * 1024 * 1024, // 1MB：POST /api/runs 参数上限（P1-06 细化 Rate/Size）
  });
  const startedAt = deps.startedAt ?? Date.now();
  const version = deps.version ?? "0.0.0";

  app.get("/api/health", async () => {
    return {
      ok: true,
      service: "pi-workflow-web",
      version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    };
  });

  return app;
}
