/**
 * VaultResolver 调用辅助（VR 阶段 B）
 *
 * 方案：dev-docs/design/2026-10-23-vault-resolver-执行方案.md §S3.1（含三轮评审补丁 #14 简化版注入链）
 *
 * 职责：以 execFile + argv 数组直调 vault_resolver.py（零 shell 拼接，ref 任意字符只作单参数传递），
 * 解析其 stdout 单 JSON 结果。runtime 的 DSL helper 与 agent-host 的审批前预检（阶段 C）共用本模块。
 *
 * Resolver 脚本路径注入链（三级，按序，#14）：
 *  1. opts.scriptPath      —— 测试注入专用（显式最高优先）
 *  2. 环境变量 PI_VAULT_RESOLVER_PATH —— 唯一正式部署通道（CLI / 微信服务 / 恢复执行统一走宿主环境）
 *  3. dev 兜底 <cwd>/dev-examples/wx-article/scripts/draft_manager/vault_resolver.py —— 仓库内开发
 * 三级落空 → 明确报错并指引设置 PI_VAULT_RESOLVER_PATH（不假定 cwd 是 Git 仓库根）。
 *
 * 错误语义：
 *  - 找不到脚本（三级落空）/ 找不到 python —— 配置类结构性错误，直接 throw（调用方不可恢复）
 *  - resolver 语义失败（零命中/歧义/越界/超时/脚本异常退出）—— 返回 { ok: false, issues: [...] }，
 *    由 workflow 侧经 await check() 转为可恢复失败（补丁 #11），绝不抛错绕过 FAILURE 态
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** 宿主环境变量：vault_resolver.py 的唯一正式注入通道（补丁 #14） */
export const VAULT_RESOLVER_ENV = "PI_VAULT_RESOLVER_PATH";

/** dev 兜底路径（相对 cwd；仅仓库内开发时可达） */
export const DEV_VAULT_RESOLVER_REL = path.join(
  "dev-examples", "wx-article", "scripts", "draft_manager", "vault_resolver.py",
);

/** 单次解析默认超时（resolver 为纯 stdlib 快速脚本） */
export const DEFAULT_VAULT_RESOLVE_TIMEOUT_MS = 15_000;

/** vault_resolver.py 的 stdout JSON 结果（字段与脚本输出契约一致；前向兼容新增字段） */
export interface VaultResolveResult {
  ok: boolean;
  /** 实际生效的 vault 根（绝对路径） */
  vault_root?: string;
  /** 回显的规范化 ref */
  ref?: string;
  /** 命中方式（exact_name / exact_path / unique_partial） */
  match?: string | null;
  want?: string;
  /** 文件系统类型（只有 dir|file；article 是 want 模式，结果仍为 dir + md 字段） */
  path_type?: "dir" | "file";
  resolved_path?: string;
  /** vault 相对路径（posix 风格） */
  resolved_rel?: string;
  /** want=article 时定位到的正文 md（相对文章目录的文件名） */
  md?: string;
  /** 歧义候选（vault 相对路径）；绝不自动选择 */
  candidates?: string[];
  /** 失败原因清单 */
  issues?: string[];
  [key: string]: unknown;
}

export interface VaultResolverCallOptions {
  /** 测试注入：显式 resolver 脚本路径（注入链第一级） */
  scriptPath?: string;
  /** dev 兜底解析基准与子进程 cwd（缺省 process.cwd()） */
  cwd?: string;
  /** 子进程环境（缺省透传 process.env；测试可注入 OBSIDIAN_VAULT_ROOT / 清空干扰变量） */
  env?: NodeJS.ProcessEnv;
  /** 单次解析超时毫秒（缺省 15s；超时返回 ok:false 而非抛错） */
  timeoutMs?: number;
  /** 直传 --vault-root（优先级最高，与脚本契约一致；测试/特殊部署用） */
  vaultRoot?: string;
  /** 限定搜索范围（vault 相对目录或 scope 别名；硬约束） */
  scope?: string;
  /** 解析意图：dir/file/article/any */
  want?: "dir" | "file" | "article" | "any";
}

/** 注入链解析结果 */
export interface VaultResolverScript {
  scriptPath: string;
  source: "opts" | "env" | "dev";
}

/** 解析 resolver 脚本路径（注入链三级）；三级落空 throw 并指引 PI_VAULT_RESOLVER_PATH */
export function resolveVaultResolverScript(
  opts: Pick<VaultResolverCallOptions, "scriptPath" | "cwd" | "env"> = {},
): VaultResolverScript {
  const cwd = opts.cwd ?? process.cwd();
  const missing = (p: string): never => {
    throw new Error(
      `vault_resolver 脚本不存在：${p}（检查注入路径 / ${VAULT_RESOLVER_ENV}）。` +
        `npm 包部署不包含 dev-examples；在仓库外运行请设置 ${VAULT_RESOLVER_ENV} 指向 vault_resolver.py。`,
    );
  };
  if (opts.scriptPath && opts.scriptPath.trim()) {
    const scriptPath = path.resolve(cwd, opts.scriptPath);
    if (!fs.existsSync(scriptPath)) missing(scriptPath);
    return { scriptPath, source: "opts" };
  }
  const env = opts.env ?? process.env;
  const fromEnv = env[VAULT_RESOLVER_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    const scriptPath = path.resolve(cwd, fromEnv);
    if (!fs.existsSync(scriptPath)) missing(scriptPath);
    return { scriptPath, source: "env" };
  }
  const dev = path.resolve(cwd, DEV_VAULT_RESOLVER_REL);
  if (fs.existsSync(dev)) {
    return { scriptPath: dev, source: "dev" };
  }
  throw new Error(
    `未找到 vault_resolver 脚本（cwd=${cwd}）。` +
      `请设置环境变量 ${VAULT_RESOLVER_ENV} 指向 vault_resolver.py，` +
      `或通过运行选项显式注入 scriptPath；npm 包部署不包含 dev-examples，不能假定运行目录是仓库根。`,
  );
}

let cachedPython: string | null = null;

/**
 * python 可执行探测：python3 优先，ENOENT 回退 python（Windows 常只有 python）。
 * 探测结果缓存（二进制名与 env 无关）。两者皆缺 → throw（配置类错误）。
 */
export async function detectPython(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (cachedPython) return cachedPython;
  for (const bin of ["python3", "python"] as const) {
    try {
      await execFileAsync(bin, ["--version"], { env, timeout: 10_000, windowsHide: true });
      cachedPython = bin;
      return bin;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // 存在但执行异常（如 Windows Store 桩）：换下一个候选
        continue;
      }
    }
  }
  throw new Error("vault_resolver 需要 python3 或 python 可执行（当前 PATH 均不可用）");
}

/**
 * 确定性解析一个 vault 逻辑引用。
 *
 * 语义失败（ok:false）与配置失败（throw）严格分离：
 *  - ref 非字符串/空 → ok:false（确定性返回，不抛）
 *  - 脚本缺失/python 缺失 → throw
 *  - 零命中/歧义/越界/大小写不符 → resolver 自身输出 ok:false
 *  - 超时/脚本异常退出/JSON 损坏 → 合成为 ok:false + issues
 */
export async function vaultResolve(
  ref: string,
  options: VaultResolverCallOptions = {},
): Promise<VaultResolveResult> {
  if (typeof ref !== "string" || !ref.trim()) {
    return { ok: false, issues: ["vaultResolve(ref, options?) 需要非空字符串引用（文章名或 vault 相对路径）"] };
  }
  if (options.want && !["dir", "file", "article", "any"].includes(options.want)) {
    return { ok: false, issues: [`vaultResolve 不支持的 want="${String(options.want)}"（dir|file|article|any）`] };
  }

  const { scriptPath } = resolveVaultResolverScript(options);
  const args = [scriptPath, "--ref", ref];
  if (options.scope) args.push("--scope", options.scope);
  if (options.want) args.push("--want", options.want);
  if (options.vaultRoot) args.push("--vault-root", options.vaultRoot);

  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VAULT_RESOLVE_TIMEOUT_MS;

  let stdout: string;
  try {
    const python = await detectPython(env);
    ({ stdout } = await execFileAsync(python, args, {
      cwd: options.cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string; code?: string | number };
    if (err.code === "ENOENT") {
      // python 本体缺失（detectPython 已兜底探测过，这里只剩脚本路径不存在的情形）
      throw new Error(`vault_resolver 脚本不存在：${scriptPath}（检查 ${VAULT_RESOLVER_ENV} 或 scriptPath 注入）`);
    }
    if (err.killed) {
      return { ok: false, issues: [`vault_resolver 超时（>${timeoutMs}ms）`] };
    }
    const stderr = (err.stderr ?? "").toString().trim();
    return {
      ok: false,
      issues: [`vault_resolver 异常退出（code=${String(err.code)}）${stderr ? `：${stderr.slice(0, 300)}` : ""}`],
    };
  }

  try {
    const parsed = JSON.parse(stdout.trim()) as VaultResolveResult;
    if (typeof parsed?.ok !== "boolean") {
      return { ok: false, issues: ["vault_resolver 输出缺少 ok 布尔字段", stdout.trim().slice(0, 300)] };
    }
    return parsed;
  } catch {
    return { ok: false, issues: ["vault_resolver 输出无法解析为 JSON", stdout.trim().slice(0, 300)] };
  }
}
