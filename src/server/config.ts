/**
 * Web Server 配置（V2-P1 P1-01；PRD §10）
 *
 * 来源优先级：CLI flags > 环境变量 > pi-workflow.config.json 的 web 段 > 缺省值。
 * 安全缺省：仅监听 127.0.0.1；token 高熵随机（每服务一次，控制台输出；P1-06 强制校验）；
 * projectRoots 显式白名单（P1-03 使用），缺省仅 examples/。
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface WebServerConfig {
  host: string;
  port: number;
  /** 本地访问 token（P1-06 起强制校验；SSE 不经 URL query 透传） */
  token: string;
  /** 项目根白名单（相对 cwd 解析为绝对路径） */
  projectRoots: string[];
  maxConcurrentRuns: number;
  eventRetentionDays: number;
}

export const DEFAULT_WEB_CONFIG: Omit<WebServerConfig, "token"> = {
  host: "127.0.0.1",
  port: 4317,
  projectRoots: ["./examples"],
  maxConcurrentRuns: 2,
  eventRetentionDays: 30,
};

export function generateWebToken(): string {
  return randomBytes(24).toString("hex");
}

interface ConfigFileShape {
  web?: {
    host?: string;
    port?: number;
    projectRoots?: string[];
    maxConcurrentRuns?: number;
    eventRetentionDays?: number;
  };
}

/** 读 pi-workflow.config.json 的 web 段（文件不存在/畸形段→忽略并返回空） */
export function loadConfigFile(file: string): ConfigFileShape {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFileShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // 配置文件畸形不阻断启动，走缺省
  }
}

export interface WebConfigOverrides {
  host?: string;
  port?: number;
  projectRoots?: string[];
  token?: string;
  configDir?: string; // 查找 pi-workflow.config.json 的目录（缺省 cwd）
}

export function resolveWebConfig(overrides: WebConfigOverrides = {}): WebServerConfig {
  const file = loadConfigFile(path.join(overrides.configDir ?? process.cwd(), "pi-workflow.config.json"));
  const w = file.web ?? {};
  const port = overrides.port ?? numEnv("PI_WORKFLOW_WEB_PORT") ?? w.port ?? DEFAULT_WEB_CONFIG.port;
  return {
    host: overrides.host ?? w.host ?? DEFAULT_WEB_CONFIG.host,
    port,
    token: overrides.token ?? generateWebToken(),
    projectRoots: (overrides.projectRoots ?? w.projectRoots ?? DEFAULT_WEB_CONFIG.projectRoots).map((p) =>
      path.resolve(overrides.configDir ?? process.cwd(), p),
    ),
    maxConcurrentRuns: w.maxConcurrentRuns ?? DEFAULT_WEB_CONFIG.maxConcurrentRuns,
    eventRetentionDays: w.eventRetentionDays ?? DEFAULT_WEB_CONFIG.eventRetentionDays,
  };
}

function numEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}
