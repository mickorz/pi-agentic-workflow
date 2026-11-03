import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { configDefaults } from "vitest/config";
import fs from "node:fs";

const serverSrc = fileURLToPath(new URL("../src/server", import.meta.url));
const huashengDir = fileURLToPath(new URL("../thirdparties/huasheng_editor", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/** GZH 预览工作台:/huasheng/* 同源静态映射到 thirdparties/huasheng_editor(T0.3,零新依赖) */
function huashengStaticPlugin(): Plugin {
  return {
    name: "gzh-huasheng-static",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/huasheng")) return next();
        let rel = req.url.slice("/huasheng".length).split("?")[0];
        if (rel === "" || rel === "/") rel = "/index.html";
        const filePath = path.normalize(path.join(huashengDir, rel));
        if (!filePath.startsWith(huashengDir)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          res.setHeader("content-type", MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
          res.end(data);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), huashengStaticPlugin()],
  resolve: {
    alias: {
      // 共享契约：直接引用仓库 src/server/contract.ts 源文件（Vite 按需编译）
      "@server": serverSrc,
    },
  },
  server: {
    // dev 代理：浏览器同源访问 /api，规避跨 Origin（Server 仅信任本机同源 Origin）
    proxy: {
      // GZH 预览:签名图片走 Server(iframe img 无法带 Bearer,HMAC 自校验)
      "/gzh-img": {
        target: process.env.PI_WORKFLOW_WEB_PROXY_TARGET ?? "http://127.0.0.1:4317",
        changeOrigin: false,
      },
      "/api": {
        // 目标可配（验收门/本地联调指向不同端口的 Server 实例）
        target: process.env.PI_WORKFLOW_WEB_PROXY_TARGET ?? "http://127.0.0.1:4317",
        changeOrigin: false,
        // dev 代理场景：浏览器 Origin 是 vite 端口（如 localhost:5199），与 Server 端口不同。
        // Server 安全部跨 Origin 全拒，代理层剥掉 Origin 头等价同源请求（仅 dev 代理；生产同源部署无此问题）。
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
  },
  // vitest 只跑 src 单测；e2e/ 是 Playwright spec（import @playwright/test，vitest 加载必炸）
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
