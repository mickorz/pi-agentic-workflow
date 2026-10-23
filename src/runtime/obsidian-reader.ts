/**
 * ObsidianReader 调用辅助（P1a Phase R）
 *
 * 方案：dev-docs/design/2026-10-23-p1a-obsidian-service-执行方案.md §1/§4/§5
 *
 * 职责：以 execFile + argv 直调 vault_query.py（零 shell 拼接、零 LLM、纯只读后端），
 * 解析其 stdout 单 JSON 结果，封装为确定性 Reader 接口：
 *  - listNotes({scope?, limit?})   → {ok, total, truncated, items:[{path,title,snippet,mtime}], ...}
 *  - readNote({path})              → {ok, path, title, content, size}（≤512KB 全文契约）
 *  - searchNotes({query, scope?, mode?, limit?}) → {ok, total, truncated, items, ...}
 *
 * 与 vault-resolver.ts 同款注入链（三级，按序）：
 *  1. opts.scriptPath      —— 测试注入专用（显式最高优先）
 *  2. 环境变量 PI_VAULT_QUERY_PATH —— 唯一正式部署通道
 *  3. dev 兜底 <cwd>/dev-examples/wx-article/scripts/draft_manager/vault_query.py
 *
 * 错误语义（与 vault-resolver 一致，语义/配置严格分离）：
 *  - 找不到脚本 / 找不到 python → throw（配置类结构性错误）
 *  - 零命中 / 越界 / 超限 / 超时 / 非法入参 → { ok: false, issues: [...] }（确定性返回，不抛）
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { detectPython } from "./vault-resolver.js";

const execFileAsync = promisify(execFile);

/** 宿主环境变量：vault_query.py 的唯一正式注入通道 */
export const VAULT_QUERY_ENV = "PI_VAULT_QUERY_PATH";

/** dev 兜底路径（相对 cwd；仅仓库内开发时可达） */
export const DEV_VAULT_QUERY_REL = path.join(
  "dev-examples", "wx-article", "scripts", "draft_manager", "vault_query.py",
);

/** 单次查询默认超时（扫描预算缺省 10s + 余量） */
export const DEFAULT_VAULT_QUERY_TIMEOUT_MS = 30_000;

/** limit 契约上限（与后端 MAX_LIST_LIMIT 一致） */
export const MAX_LIST_LIMIT = 200;

// ── 结果类型（字段与 vault_query.py stdout 契约一致；前向兼容新增字段）──

export interface ObsidianNoteItem {
  /** vault 相对路径（posix 风格，含 .md） */
  path: string;
  /** 文件名去扩展名 */
  title: string;
  /** 内容预览（≤120 字，空白压平） */
  snippet?: string;
  /** ISO 8601 UTC（秒精度） */
  mtime?: string;
  [key: string]: unknown;
}

export interface ObsidianQueryOk {
  ok: true;
  vault_root?: string;
  total: number;
  truncated: boolean;
  items: ObsidianNoteItem[];
  limit?: number;
  /** 扫描预算超时标记（§4） */
  truncated_reason?: "scan_budget";
  /** >2MB 跳过文件计数（§4） */
  skipped_large?: number;
  [key: string]: unknown;
}

export interface ObsidianQueryFail {
  ok: false;
  issues: string[];
  [key: string]: unknown;
}

export type ObsidianListResult = ObsidianQueryOk | ObsidianQueryFail;
export type ObsidianSearchResult = ObsidianQueryOk | ObsidianQueryFail;

export interface ObsidianReadOk {
  ok: true;
  vault_root?: string;
  path: string;
  title: string;
  content: string;
  size: number;
  [key: string]: unknown;
}

export type ObsidianReadResult = ObsidianReadOk | ObsidianQueryFail;

// ── 调用选项 ──

export interface VaultQueryCallOptions {
  /** 测试注入：显式查询脚本路径（注入链第一级） */
  scriptPath?: string;
  /** dev 兜底解析基准与子进程 cwd（缺省 process.cwd()） */
  cwd?: string;
  /** 子进程环境（缺省透传 process.env；测试可注入 OBSIDIAN_VAULT_ROOT / 清空干扰变量） */
  env?: NodeJS.ProcessEnv;
  /** 单次调用超时毫秒（缺省 30s；超时返回 ok:false 而非抛错） */
  timeoutMs?: number;
  /** 直传 --vault-root（配置链最高优先；测试/特殊部署用） */
  vaultRoot?: string;
}

/** 注入链解析结果 */
export interface VaultQueryScript {
  scriptPath: string;
  source: "opts" | "env" | "dev";
}

/** 解析查询脚本路径（注入链三级）；三级落空 throw 并指引 PI_VAULT_QUERY_PATH */
export function resolveVaultQueryScript(
  opts: Pick<VaultQueryCallOptions, "scriptPath" | "cwd" | "env"> = {},
): VaultQueryScript {
  const cwd = opts.cwd ?? process.cwd();
  const missing = (p: string): never => {
    throw new Error(
      `vault_query 脚本不存在：${p}（检查注入路径 / ${VAULT_QUERY_ENV}）。` +
        `npm 包部署不包含 dev-examples；在仓库外运行请设置 ${VAULT_QUERY_ENV} 指向 vault_query.py。`,
    );
  };
  if (opts.scriptPath && opts.scriptPath.trim()) {
    const scriptPath = path.resolve(cwd, opts.scriptPath);
    if (!fs.existsSync(scriptPath)) missing(scriptPath);
    return { scriptPath, source: "opts" };
  }
  const env = opts.env ?? process.env;
  const fromEnv = env[VAULT_QUERY_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    const scriptPath = path.resolve(cwd, fromEnv);
    if (!fs.existsSync(scriptPath)) missing(scriptPath);
    return { scriptPath, source: "env" };
  }
  const dev = path.resolve(cwd, DEV_VAULT_QUERY_REL);
  if (fs.existsSync(dev)) {
    return { scriptPath: dev, source: "dev" };
  }
  throw new Error(
    `未找到 vault_query 脚本（cwd=${cwd}）。` +
      `请设置环境变量 ${VAULT_QUERY_ENV} 指向 vault_query.py，` +
      `或通过运行选项显式注入 scriptPath；npm 包部署不包含 dev-examples，不能假定运行目录是仓库根。`,
  );
}

// ── 入参校验（确定性失败返回，绝不抛）──

function validLimit(limit: unknown): limit is number | undefined {
  return (
    limit === undefined ||
    (typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIST_LIMIT)
  );
}

function validScope(scope: unknown): boolean {
  if (scope === undefined || scope === null || scope === "") return true;
  if (typeof scope !== "string") return false;
  const s = scope.trim();
  if (!s || s.startsWith("/")) return false;
  return !s.replace(/\\/g, "/").split("/").some((p) => p === "" || p === "." || p === "..");
}

export function validNotePath(p: unknown): boolean {
  if (typeof p !== "string" || !p.trim()) return false;
  const s = p.trim();
  if (s.startsWith("/")) return false;
  return !s.replace(/\\/g, "/").split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/** 统一出口：调 vault_query.py --action <action>，解析单 JSON */
async function callVaultQuery(
  action: "list" | "read" | "search",
  params: Record<string, unknown>,
  options: VaultQueryCallOptions = {},
): Promise<ObsidianQueryOk | ObsidianReadOk | ObsidianQueryFail> {
  const { scriptPath } = resolveVaultQueryScript(options);
  const args = [scriptPath, "--action", action];
  for (const [flag, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    args.push(`--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value));
  }
  if (options.vaultRoot) args.push("--vault-root", options.vaultRoot);

  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VAULT_QUERY_TIMEOUT_MS;

  let stdout: string;
  try {
    const python = await detectPython(env);
    ({ stdout } = await execFileAsync(python, args, {
      cwd: options.cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      // readNote ≤512KB 全文 + JSON 转义开销：8MB 上限安全
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string; code?: string | number };
    if (err.code === "ENOENT") {
      throw new Error(`vault_query 脚本不存在：${scriptPath}（检查 ${VAULT_QUERY_ENV} 或 scriptPath 注入）`);
    }
    if (err.killed) {
      return { ok: false, issues: [`vault_query 超时（>${timeoutMs}ms）`] };
    }
    const stderr = (err.stderr ?? "").toString().trim();
    return {
      ok: false,
      issues: [`vault_query 异常退出（code=${String(err.code)}）${stderr ? `：${stderr.slice(0, 300)}` : ""}`],
    };
  }

  try {
    const parsed = JSON.parse(stdout.trim()) as { ok?: unknown };
    if (typeof parsed?.ok !== "boolean") {
      return { ok: false, issues: ["vault_query 输出缺少 ok 布尔字段", stdout.trim().slice(0, 300)] };
    }
    return parsed as ObsidianQueryOk | ObsidianReadOk | ObsidianQueryFail;
  } catch {
    return { ok: false, issues: ["vault_query 输出无法解析为 JSON", stdout.trim().slice(0, 300)] };
  }
}

// ── Reader 接口（§1 契约；全部确定性返回）──

export interface ObsidianReader {
  listNotes(input?: { scope?: string; limit?: number }): Promise<ObsidianListResult>;
  readNote(input: { path: string }): Promise<ObsidianReadResult>;
  searchNotes(input: {
    query: string;
    scope?: string;
    mode?: "name" | "content" | "both";
    limit?: number;
  }): Promise<ObsidianSearchResult>;
}

/** 构造绑定配置的 ObsidianReader（runtime globals 与 agent-host 预检共用） */
export function createObsidianReader(options: VaultQueryCallOptions = {}): ObsidianReader {
  return {
    async listNotes(input = {}) {
      if (input === null || typeof input !== "object") {
        return { ok: false, issues: ["listNotes(input?) 需要对象 { scope?, limit? }"] };
      }
      if (!validLimit(input.limit)) {
        return { ok: false, issues: [`limit 必须是 1..${MAX_LIST_LIMIT} 的整数`] };
      }
      if (!validScope(input.scope)) {
        return { ok: false, issues: ["scope 必须是 vault 相对目录（不含 . / .. 段）"] };
      }
      return callVaultQuery("list", { scope: input.scope, limit: input.limit }, options) as Promise<ObsidianListResult>;
    },
    async readNote(input: { path: string }) {
      if (input === null || typeof input !== "object") {
        return { ok: false, issues: ["readNote(input) 需要对象 { path }"] };
      }
      if (!validNotePath(input.path)) {
        return { ok: false, issues: ["path 必须是 vault 相对 .md 路径（不允许绝对路径或 . / .. 段）"] };
      }
      return callVaultQuery("read", { path: input.path }, options) as Promise<ObsidianReadResult>;
    },
    async searchNotes(input: { query: string; scope?: string; mode?: string; limit?: number }) {
      if (input === null || typeof input !== "object") {
        return { ok: false, issues: ["searchNotes(input) 需要对象 { query, scope?, mode?, limit? }"] };
      }
      if (typeof input.query !== "string" || !input.query.trim()) {
        return { ok: false, issues: ["query 必须是非空字符串"] };
      }
      if (input.mode !== undefined && !["name", "content", "both"].includes(input.mode)) {
        return { ok: false, issues: [`mode 必须是 name|content|both，收到 ${String(input.mode)}`] };
      }
      if (!validLimit(input.limit)) {
        return { ok: false, issues: [`limit 必须是 1..${MAX_LIST_LIMIT} 的整数`] };
      }
      if (!validScope(input.scope)) {
        return { ok: false, issues: ["scope 必须是 vault 相对目录（不含 . / .. 段）"] };
      }
      return callVaultQuery(
        "search",
        { query: input.query, scope: input.scope, mode: input.mode, limit: input.limit },
        options,
      ) as Promise<ObsidianSearchResult>;
    },
  };
}

/** 便捷直调（对齐 vaultResolve 的函数形态；agent-host 预检用） */
export async function vaultQueryList(
  input: { scope?: string; limit?: number },
  options: VaultQueryCallOptions = {},
): Promise<ObsidianListResult> {
  return createObsidianReader(options).listNotes(input);
}

export async function vaultQueryRead(
  input: { path: string },
  options: VaultQueryCallOptions = {},
): Promise<ObsidianReadResult> {
  return createObsidianReader(options).readNote(input);
}

export async function vaultQuerySearch(
  input: { query: string; scope?: string; mode?: "name" | "content" | "both"; limit?: number },
  options: VaultQueryCallOptions = {},
): Promise<ObsidianSearchResult> {
  return createObsidianReader(options).searchNotes(input);
}
