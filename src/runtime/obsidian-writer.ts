/**
 * ObsidianWriter 调用辅助（P1a Phase W）
 *
 * 方案：dev-docs/design/2026-10-23-p1a-obsidian-service-执行方案.md §1/§2/§2.2/§2.3
 *
 * 职责：spawn + argv 直调 vault_writer.py，内容经 stdin UTF-8 传入（零 shell 拼接、stdout 零回显）：
 *  - createNote({rel, content, operationId})  → 成功 created / 冲突 conflict（O_EXCL）
 *  - appendNote({rel, content, operationId})  → 成功 appended / 拒绝 missing / unknown
 *
 * 幂等（§2，后端台账状态机）：同 operationId 重试 → done 幂等成功（idempotent，不重复写）；
 * started-无-done → unknown（禁自动重试，人工核对）；failed → 允许重试。
 *
 * 注入链（与 obsidian-reader / vault-resolver 同款三级）：
 *  1. opts.scriptPath          —— 测试注入专用
 *  2. 环境变量 PI_VAULT_WRITER_PATH —— 唯一正式部署通道
 *  3. dev 兜底 <cwd>/dev-examples/wx-article/scripts/draft_manager/vault_writer.py
 *
 * 访问面（§3）：本模块只被 workflow-runtime 能力门（meta.capabilities 含
 * "obsidian-write" 且运行 authorized → globals.obsidianWrite）与审批链预检引用；
 * read-only workflow 拿不到 obsidianWrite 全局（不注入 → ReferenceError）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectPython } from "./vault-resolver.js";

/** 宿主环境变量：vault_writer.py 的唯一正式注入通道 */
export const VAULT_WRITER_ENV = "PI_VAULT_WRITER_PATH";

/** dev 兜底路径（相对 cwd） */
export const DEV_VAULT_WRITER_REL = path.join(
  "dev-examples", "wx-article", "scripts", "draft_manager", "vault_writer.py",
);

/** 单次写默认超时（含 fsync；正常毫秒级） */
export const DEFAULT_VAULT_WRITER_TIMEOUT_MS = 30_000;

/** §2.2：内容上限 1MB（与后端一致，前置拒绝） */
export const MAX_CONTENT_BYTES = 1024 * 1024;

// ── 结果类型（与 vault_writer.py stdout 契约一致）──

export type ObsidianWriteStatus = "created" | "appended" | "idempotent";

export interface ObsidianWriteOk {
  ok: true;
  action: "create" | "append";
  status: ObsidianWriteStatus;
  /** vault 相对路径 */
  rel: string;
  operationId: string;
  bytes: number;
  /** 内容 sha256（hex；审批卡只展示前 8 位，§2.3） */
  contentDigest: string;
  [key: string]: unknown;
}

export type ObsidianWriteErrorCode =
  | "conflict"      // create 目标已存在（O_EXCL）
  | "missing"       // append 目标不存在
  | "unknown"       // started-无-done：写入结果不确定，禁自动重试
  | "invalid"       // rel/operationId/配置非法
  | "too_large"     // 内容 >1MB 或非 UTF-8
  | "io_error";     // 底层 IO 失败（已落 failed，可重试）

export interface ObsidianWriteFail {
  ok: false;
  code: ObsidianWriteErrorCode;
  issues: string[];
  [key: string]: unknown;
}

export type ObsidianWriteResult = ObsidianWriteOk | ObsidianWriteFail;

// ── 调用选项 ──

export interface VaultWriterCallOptions {
  /** 测试注入：显式写脚本路径（注入链第一级） */
  scriptPath?: string;
  /** dev 兜底解析基准与子进程 cwd（缺省 process.cwd()） */
  cwd?: string;
  /** 子进程环境（缺省透传 process.env；测试注入 OBSIDIAN_VAULT_ROOT） */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 直传 --vault-root（配置链最高优先） */
  vaultRoot?: string;
  /** 直传 --ledger-root（测试旗标：重定向台账） */
  ledgerRoot?: string;
}

export interface VaultWriterScript {
  scriptPath: string;
  source: "opts" | "env" | "dev";
}

/** 解析写脚本路径（注入链三级）；三级落空 throw 并指引 PI_VAULT_WRITER_PATH */
export function resolveVaultWriterScript(
  opts: Pick<VaultWriterCallOptions, "scriptPath" | "cwd" | "env"> = {},
): VaultWriterScript {
  const cwd = opts.cwd ?? process.cwd();
  const missing = (p: string): never => {
    throw new Error(
      `vault_writer 脚本不存在：${p}（检查注入路径 / ${VAULT_WRITER_ENV}）。` +
        `在仓库外运行请设置 ${VAULT_WRITER_ENV} 指向 vault_writer.py。`,
    );
  };
  if (opts.scriptPath && opts.scriptPath.trim()) {
    const scriptPath = path.resolve(cwd, opts.scriptPath);
    if (!fs.existsSync(scriptPath)) missing(scriptPath);
    return { scriptPath, source: "opts" };
  }
  const env = opts.env ?? process.env;
  const fromEnv = env[VAULT_WRITER_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    const scriptPath = path.resolve(cwd, fromEnv);
    if (!fs.existsSync(scriptPath)) missing(scriptPath);
    return { scriptPath, source: "env" };
  }
  const dev = path.resolve(cwd, DEV_VAULT_WRITER_REL);
  if (fs.existsSync(dev)) {
    return { scriptPath: dev, source: "dev" };
  }
  throw new Error(
    `未找到 vault_writer 脚本（cwd=${cwd}）。请设置环境变量 ${VAULT_WRITER_ENV}，` +
      `或通过运行选项显式注入 scriptPath。`,
  );
}

// ── 入参校验（确定性失败返回，绝不抛）──

export function validWriteRel(rel: unknown): boolean {
  if (typeof rel !== "string" || !rel.trim()) return false;
  const s = rel.trim();
  if (s.startsWith("/")) return false;
  if (!s.toLowerCase().endsWith(".md")) return false;
  // P1a §2.2：与后端 validate_rel 对齐——拒绝 shell 元字符/引号（vault 文件名保持干净可移植）
  if (/["'`$;|&<>\u0000-\u001f]/.test(s)) return false;
  return !s.replace(/\\/g, "/").split("/").some(
    (seg) => seg === "" || seg === "." || seg === ".." || seg.startsWith("."),
  );
}

function validOperationId(opId: unknown): boolean {
  return (
    typeof opId === "string" && opId.trim().length > 0 && opId.length <= 128 && !/[\s\u0000-\u001f]/.test(opId)
  );
}

/** 统一出口：spawn vault_writer.py --action，内容经 stdin UTF-8（execFile 异步型无 input 选项） */
async function callVaultWriter(
  action: "create" | "append",
  input: { rel: string; content: string; operationId: string },
  options: VaultWriterCallOptions = {},
): Promise<ObsidianWriteResult> {
  const { scriptPath } = resolveVaultWriterScript(options);
  const args = [scriptPath, "--action", action, "--rel", input.rel, "--operation-id", input.operationId];
  if (options.vaultRoot) args.push("--vault-root", options.vaultRoot);
  if (options.ledgerRoot) args.push("--ledger-root", options.ledgerRoot);

  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VAULT_WRITER_TIMEOUT_MS;
  const python = await detectPython(env);

  return await new Promise<ObsidianWriteResult>((resolve) => {
    const child = spawn(python, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const finish = (result: ObsidianWriteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: "io_error", issues: [`vault_writer 超时（>${timeoutMs}ms）`] });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ ok: false, code: "io_error", issues: [`vault_writer 启动失败：${err.message}`] });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
        finish({
          ok: false,
          code: "io_error",
          issues: [
            `vault_writer 异常退出（code=${code}）${stderr ? `：${stderr.slice(0, 300)}` : ""}`,
          ],
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { ok?: unknown; code?: unknown; issues?: unknown };
        if (typeof parsed?.ok !== "boolean") {
          finish({
            ok: false,
            code: "io_error",
            issues: ["vault_writer 输出缺少 ok 布尔字段", stdout.slice(0, 300)],
          });
          return;
        }
        if (parsed.ok === false && typeof parsed.code !== "string") {
          finish({ ok: false, code: "io_error", issues: ["vault_writer 失败输出缺少 code 字段"] });
          return;
        }
        if (parsed.ok === false && !Array.isArray(parsed.issues)) {
          finish({
            ok: false,
            code: parsed.code as ObsidianWriteErrorCode,
            issues: ["（后端未提供 issues）"],
          });
          return;
        }
        finish(parsed as ObsidianWriteResult);
      } catch {
        finish({ ok: false, code: "io_error", issues: ["vault_writer 输出无法解析为 JSON", stdout.slice(0, 300)] });
      }
    });

    // §2.2：内容走 stdin；EPIPE（后端 1MB 预检提前退出）不炸进程
    child.stdin.on("error", () => {});
    child.stdin.end(input.content, "utf-8");
  });
}

// ── Writer 接口（§1 契约；确定性返回不抛错）──

export interface ObsidianWriter {
  createNote(input: { rel: string; content: string; operationId: string }): Promise<ObsidianWriteResult>;
  appendNote(input: { rel: string; content: string; operationId: string }): Promise<ObsidianWriteResult>;
}

function prevalidate(input: { rel?: unknown; content?: unknown; operationId?: unknown }): ObsidianWriteFail | null {
  if (input === null || typeof input !== "object") {
    return { ok: false, code: "invalid", issues: ["入参需要对象 { rel, content, operationId }"] };
  }
  if (!validWriteRel(input.rel)) {
    return {
      ok: false,
      code: "invalid",
      issues: ["rel 必须是 vault 相对 .md 路径（不允许绝对路径或 . / .. 段）"],
    };
  }
  if (typeof input.content !== "string") {
    return { ok: false, code: "invalid", issues: ["content 必须是字符串（UTF-8，≤1MB）"] };
  }
  const bytes = Buffer.byteLength(input.content, "utf-8");
  if (bytes > MAX_CONTENT_BYTES) {
    return { ok: false, code: "too_large", issues: [`content ${bytes} 字节 > 1MB 上限（§2.2）`] };
  }
  if (!validOperationId(input.operationId)) {
    return { ok: false, code: "invalid", issues: ["operationId 必须是非空字符串（≤128 字符、无空白）"] };
  }
  return null;
}

/**
 * 构造绑定配置的 ObsidianWriter。
 * 注意（§3）：仅 workflow-runtime 能力门（globals.obsidianWrite）与审批链预检可触达；
 * 不向 read-only workflow 暴露。
 */
export function createObsidianWriter(options: VaultWriterCallOptions = {}): ObsidianWriter {
  return {
    async createNote(input) {
      const bad = prevalidate(input);
      if (bad) return bad;
      return callVaultWriter("create", input, options);
    },
    async appendNote(input) {
      const bad = prevalidate(input);
      if (bad) return bad;
      return callVaultWriter("append", input, options);
    },
  };
}

/** 便捷直调（agent-host 审批链预检/冲突检查用） */
export async function vaultWriterCreate(
  input: { rel: string; content: string; operationId: string },
  options: VaultWriterCallOptions = {},
): Promise<ObsidianWriteResult> {
  return createObsidianWriter(options).createNote(input);
}

export async function vaultWriterAppend(
  input: { rel: string; content: string; operationId: string },
  options: VaultWriterCallOptions = {},
): Promise<ObsidianWriteResult> {
  return createObsidianWriter(options).appendNote(input);
}
