import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_API_PORT, REAL_API_PORT, TOKEN } from "./e2e/env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const MOCK_WEB_PORT = 5699;
const REAL_WEB_PORT = 5701;

// 每次 test run 独立 BASE（config 模块仅在主进程求值一次；run 数据不落仓库）
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-v2-"));
const src = path.join(__dirname, "e2e", "fixtures", "proj");
const proj = path.join(baseDir, "proj");
fs.mkdirSync(proj, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(proj, f));
const mk = (name: string, port: number): string => {
  // --config <dir>：resolveWebConfig 读 <dir>/pi-workflow.config.json，projectRoots 相对该 dir 解析
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pi-workflow.config.json"),
    JSON.stringify({ web: { port, token: TOKEN, projectRoots: ["../proj"] } }, null, 2),
  );
  return dir;
};
const mockDir = mk("mock", MOCK_API_PORT);
const realDir = mk("real", REAL_API_PORT);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e-results",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "mock",
      testIgnore: /real-sdk\.spec\.ts/,
      use: { baseURL: `http://localhost:${MOCK_WEB_PORT}` },
    },
    {
      name: "real",
      testMatch: /real-sdk\.spec\.ts/,
      use: { baseURL: `http://localhost:${REAL_WEB_PORT}` },
    },
  ],
  // 注意：Playwright 1.64 运行时只读 `webServer`（单数键，值为数组）；`webServers` 复数键会被静默忽略
  webServer: [
    {
      // Mock Worker 级：fake runner（确定性、无 LLM 成本）
      command: `node ${repoRoot}/dist/cli/index.js web --config ${mockDir} --port ${MOCK_API_PORT}`,
      url: `http://127.0.0.1:${MOCK_API_PORT}/api/health`,
      cwd: baseDir,
      env: {
        ...process.env,
        PI_WORKFLOW_TEST_RUNNER: "fake",
        PI_WORKFLOW_FAKE_DELAY_MS: "250",
      } as Record<string, string>,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // 真实 SDK 级：不注入 fake，Worker 内 PiAgentAdapter 走真实模型
      command: `node ${repoRoot}/dist/cli/index.js web --config ${realDir} --port ${REAL_API_PORT}`,
      url: `http://127.0.0.1:${REAL_API_PORT}/api/health`,
      cwd: baseDir,
      env: { ...process.env } as Record<string, string>,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npx vite --port ${MOCK_WEB_PORT} --strictPort`,
      url: `http://localhost:${MOCK_WEB_PORT}/`,
      cwd: path.join(repoRoot, "web"),
      env: {
        ...process.env,
        PI_WORKFLOW_WEB_PROXY_TARGET: `http://127.0.0.1:${MOCK_API_PORT}`,
      } as Record<string, string>,
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      command: `npx vite --port ${REAL_WEB_PORT} --strictPort`,
      url: `http://localhost:${REAL_WEB_PORT}/`,
      cwd: path.join(repoRoot, "web"),
      env: {
        ...process.env,
        PI_WORKFLOW_WEB_PROXY_TARGET: `http://127.0.0.1:${REAL_API_PORT}`,
      } as Record<string, string>,
      reuseExistingServer: false,
      stdout: "ignore",
    },
  ],
});
