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
        target: "http://127.0.0.1:4317",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
