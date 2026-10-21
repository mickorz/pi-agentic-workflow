/**
 * ProjectRegistry —— V2-P1-03 项目白名单与安全文件枚举（PRD §4 / §6.2）
 *
 * 安全边界：
 *  - 项目根来自 WebServerConfig.projectRoots 显式白名单（缺省仅 examples/），
 *    构造时 realpath 归一（消解 symlink），不可用根跳过并记入 warnings。
 *  - resolveWorkflowPath：拒绝对路径与 `..` 段，再 realpath 校验落点仍在根内
 *    （阻断符号链接越权，E13）；白名单外项目不可见（NOT_FOUND，不暴露存在性）。
 *  - listWorkflows：受限遍历（深度/数量上限，跳过 node_modules/隐藏目录），
 *    逐文件 parseWorkflowScript 提取 meta —— 纯字面量解析，不执行脚本体。
 *  - validateWorkflow：白名单内文件或内联 source 的 meta 解析 + args 大小校验。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseWorkflowScript } from "../runtime/vm.js";
import type { WorkflowMeta } from "../runtime/types.js";
import { WorkflowError } from "../runtime/errors.js";

/** 遍历上限（防白名单根被海量文件拖垮服务） */
const MAX_WORKFLOW_FILES = 500;
const MAX_TRAVERSE_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** 内联 source 大小上限（256KB）与 args 序列化上限（64KB） */
const MAX_SOURCE_CHARS = 256 * 1024;
const MAX_ARGS_JSON_CHARS = 64 * 1024;

export interface ProjectInfo {
  /** 稳定项目 ID（slug，冲突时带根哈希后缀） */
  id: string;
  /** 展示名（根目录名） */
  name: string;
  /** 归一化后的项目根绝对路径 */
  root: string;
}

export interface WorkflowSummary {
  projectId: string;
  /** 项目内相对路径（POSIX 分隔符，前端引用用） */
  path: string;
  /** 工作流 meta；解析失败时缺省 */
  meta?: WorkflowMeta;
  /** 解析失败原因（脚本仍列出，供诊断） */
  error?: string;
}

export interface WorkflowValidation {
  meta: WorkflowMeta;
  /** phases 数（无则 0） */
  phaseCount: number;
}

/** 统一错误：code 对齐 PRD §4 错误枚举 */
export class ProjectError extends Error {
  readonly code: "NOT_FOUND" | "FORBIDDEN_PATH" | "INVALID_INPUT";
  constructor(code: ProjectError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function hash8(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectInfo>();
  /** 构造期不可用根（目录缺失/不可读） */
  readonly warnings: string[] = [];

  constructor(roots: string[]) {
    const seen = new Map<string, string>(); // slug -> id（冲突检测）
    for (const raw of roots) {
      const absolute = path.resolve(raw);
      let root: string;
      try {
        root = fs.realpathSync(absolute);
      } catch {
        this.warnings.push(`项目根不可用（已跳过）：${absolute}`);
        continue;
      }
      if (!fs.statSync(root).isDirectory()) {
        this.warnings.push(`项目根不是目录（已跳过）：${root}`);
        continue;
      }
      const name = path.basename(root);
      let id = slugify(name);
      if (seen.has(id)) {
        id = `${id}-${hash8(root).slice(0, 6)}`;
      }
      seen.set(id, id);
      this.projects.set(id, { id, name, root });
    }
  }

  listProjects(): ProjectInfo[] {
    return [...this.projects.values()];
  }

  getProject(id: string): ProjectInfo | undefined {
    return this.projects.get(id);
  }

  /**
   * 解析项目内工作流文件为绝对路径（启动 run /读取内容的唯一入口）。
   * 依次校验：白名单项目存在 → 相对路径形态 → realpath 落点仍在根内。
   */
  resolveWorkflowPath(projectId: string, relPath: string): string {
    const project = this.projects.get(projectId);
    if (!project) {
      // 白名单外不可见：不区分"不存在"与"未授权"
      throw new ProjectError("NOT_FOUND", `项目不存在：${projectId}`);
    }
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new ProjectError("INVALID_INPUT", "workflow path 不能为空");
    }
    if (path.isAbsolute(relPath)) {
      throw new ProjectError("FORBIDDEN_PATH", "仅允许项目内相对路径");
    }
    // `..` 段拒绝（realpath 前的快速门；realpath 兜底 symlink 越权）
    const segments = relPath.split(/[\\/]/);
    if (segments.some((s) => s === "..")) {
      throw new ProjectError("FORBIDDEN_PATH", "路径不允许包含 `..` 段");
    }
    const joined = path.resolve(project.root, relPath);
    let real: string;
    try {
      real = fs.realpathSync(joined);
    } catch {
      throw new ProjectError("NOT_FOUND", `文件不存在：${relPath}`);
    }
    if (real !== project.root && !real.startsWith(project.root + path.sep)) {
      throw new ProjectError("FORBIDDEN_PATH", "路径越出项目根（含符号链接）");
    }
    return real;
  }

  /** 受限遍历枚举项目内 workflow 脚本（解析 meta，不执行） */
  listWorkflows(projectId: string): WorkflowSummary[] {
    const project = this.projects.get(projectId);
    if (!project) throw new ProjectError("NOT_FOUND", `项目不存在：${projectId}`);
    const out: WorkflowSummary[] = [];
    const walk = (dir: string, depth: number): void => {
      if (out.length >= MAX_WORKFLOW_FILES || depth > MAX_TRAVERSE_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_WORKFLOW_FILES) return;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(full, depth + 1);
        } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
          const rel = path.relative(project.root, full).split(path.sep).join("/");
          const summary: WorkflowSummary = { projectId, path: rel };
          try {
            summary.meta = parseWorkflowScript(fs.readFileSync(full, "utf-8")).meta;
          } catch (error) {
            summary.error = error instanceof Error ? error.message : String(error);
          }
          out.push(summary);
        }
      }
    };
    walk(project.root, 0);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  /**
   * 解析校验（PRD §4：解析 meta 和参数校验，不执行 JS）。
   * 入参二选一：白名单内文件（projectId+path）或内联 source。
   */
  validateWorkflow(input: {
    projectId?: string;
    path?: string;
    source?: string;
    args?: unknown;
  }): WorkflowValidation {
    let script: string;
    if (typeof input.source === "string") {
      if (input.source.length > MAX_SOURCE_CHARS) {
        throw new ProjectError("INVALID_INPUT", `脚本内容超限（>${MAX_SOURCE_CHARS} 字符）`);
      }
      script = input.source;
    } else if (input.projectId !== undefined && input.path !== undefined) {
      script = fs.readFileSync(this.resolveWorkflowPath(input.projectId, input.path), "utf-8");
    } else {
      throw new ProjectError("INVALID_INPUT", "需提供 source 或 projectId+path");
    }
    let meta: WorkflowMeta;
    try {
      meta = parseWorkflowScript(script).meta;
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw new ProjectError("INVALID_INPUT", `workflow 解析失败：${error.message}`);
      }
      throw new ProjectError("INVALID_INPUT", `workflow 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (input.args !== undefined) {
      let serialized: string;
      try {
        serialized = JSON.stringify(input.args);
      } catch {
        throw new ProjectError("INVALID_INPUT", "args 必须可 JSON 序列化");
      }
      if (serialized === undefined || serialized.length > MAX_ARGS_JSON_CHARS) {
        throw new ProjectError("INVALID_INPUT", `args 序列化超限（>${MAX_ARGS_JSON_CHARS} 字符）`);
      }
    }
    return { meta, phaseCount: meta.phases?.length ?? 0 };
  }
}
