/**
 * 静态资源路由(P0 部署补齐):Fastify 直接服务 web/dist(React SPA)与
 * thirdparties/huasheng_editor(排版编辑器 iframe),使 `pi-workflow web` 单进程
 * 即可打开 /gzh-preview 工作台,无需另起 vite dev。
 *
 * 设计约束(方案 4.2 预留项,2026-11-03 落地):
 *   - 零新依赖:fs 读取 + 手写 content-type 映射(静态文件不含数据,Bearer 保护只在 /api)
 *   - SPA 回退:未命中文件回退 index.html(React Router 前端路由接管)
 *   - 路径逃逸防御:normalize 后必须在目标根目录内(与 gzh-routes 同规则)
 *   - 注册顺序:在 API 路由之后注册,find-my-way 静态/具体路由优先于通配
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".md": "text/markdown; charset=utf-8",
};

function serveFrom(root: string, rel: string, fallback?: string): { data: Buffer; type: string } | null {
  let rel2 = rel;
  if (rel2 === "" || rel2 === "/") rel2 = "/index.html";
  let filePath = path.normalize(path.join(root, decodeURIComponent(rel2)));
  if (!filePath.startsWith(root)) return null; // 路径逃逸
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (!fallback) return null;
    filePath = fallback; // SPA 回退
  }
  return {
    data: fs.readFileSync(filePath),
    type: MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
  };
}

export function registerStaticRoutes(
  app: FastifyInstance,
  deps: { webDist?: string; huashengDir?: string },
): void {
  // /huasheng/*:编辑器静态站(iframe 同源加载)
  if (deps.huashengDir && fs.existsSync(deps.huashengDir)) {
    const root = path.resolve(deps.huashengDir);
    app.get("/huasheng/*", async (req, reply) => {
      const rel = (req.params as { "*": string })["*"] ?? "";
      const hit = serveFrom(root, `/${rel}`);
      if (!hit) return reply.code(404).send({ code: "NOT_FOUND", message: "not found" });
      reply.header("content-type", hit.type);
      return reply.send(hit.data);
    });
  }

  // web/dist:SPA(具体路由 /api、/gzh-img、/huasheng 已注册,通配兜底)
  if (deps.webDist && fs.existsSync(deps.webDist)) {
    const root = path.resolve(deps.webDist);
    const indexHtml = path.join(root, "index.html");
    app.get("/*", async (req, reply) => {
      const hit = serveFrom(root, req.url.split("?")[0] ?? "/", indexHtml);
      if (!hit) return reply.code(404).send({ code: "NOT_FOUND", message: "not found" });
      reply.header("content-type", hit.type);
      return reply.send(hit.data);
    });
  }
}
