/**
 * pi-workflow web —— 本地 Web Server 启动命令（V2-P1 P1-01）
 *
 * 用法：pi-workflow web [--host 127.0.0.1] [--port 4317] [--config <dir>]
 * 配置：CLI flags > 环境变量(PI_WORKFLOW_WEB_PORT) > pi-workflow.config.json web 段 > 缺省。
 * 安全：仅 127.0.0.1；token 每次启动随机生成并打印（P1-06 起强制校验）。
 * Ctrl-C：优雅关停（停接新请求并等待在途完成；不触碰任何 Run——WG-007 同语义）。
 */

import { resolveWebConfig } from "../../server/config.js";
import { createWebApp } from "../../server/app.js";
import { ProjectRegistry } from "../../server/projects.js";
import { RunSupervisor } from "../../server/worker-supervisor.js";
import { RunApplicationService } from "../../application/run-service.js";

export async function web(argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const host = flag("--host");
  const portRaw = flag("--port");
  const port = portRaw !== undefined ? Number(portRaw) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port >= 65536)) {
    process.stderr.write(`--port 非法：${portRaw}\n`);
    return 2;
  }
  const configDir = flag("--config");

  const config = resolveWebConfig({
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(configDir ? { configDir } : {}),
  });

  // V2-P1-04：装配真实执行栈（Worker 进程隔离 + 白名单）
  const baseDir = process.cwd();
  const supervisor = new RunSupervisor({
    baseDir,
    maxConcurrentRuns: config.maxConcurrentRuns,
  });
  const service = new RunApplicationService({
    baseDir,
    maxConcurrentRuns: config.maxConcurrentRuns,
    supervisor,
  });
  const registry = new ProjectRegistry(config.projectRoots);

  const app = createWebApp({
    config,
    service,
    registry,
    version: process.env.npm_package_version ?? "0.1.0",
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Web Server 启动失败：${msg}\n`);
    return 1;
  }

  process.stdout.write(
    [
      `pi-workflow web 已启动：http://${config.host}:${config.port}`,
      `本地访问 token（本次会话）：${config.token}`,
      `健康检查：curl http://${config.host}:${config.port}/api/health`,
      `项目白名单（${config.projectRoots.length}）：${config.projectRoots.join(", ")}`,
      ...(registry.warnings.length > 0 ? registry.warnings : []),
      `Ctrl-C 优雅停止（运行中 Run 不受影响）`,
    ].join("\n") + "\n",
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      void app.close().finally(resolve);
    });
    process.once("SIGTERM", () => {
      void app.close().finally(resolve);
    });
  });
  return 0;
}
