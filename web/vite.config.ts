import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const serverSrc = fileURLToPath(new URL("../src/server", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 共享契约：直接引用仓库 src/server/contract.ts 源文件（Vite 按需编译）
      "@server": serverSrc,
    },
  },
  server: {
    // dev 代理：浏览器同源访问 /api，规避跨 Origin（Server 仅信任本机同源 Origin）
    proxy: {
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
});
