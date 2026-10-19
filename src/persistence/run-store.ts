/**
 * Run Store —— manifest 与运行目录管理（P2）
 *
 * 数据布局（V1 执行文档 §7）：
 *  .pi-workflows/runs/<runId>/
 *    manifest.json   # scriptHash/argsHash/status/pid/...（原子写）
 *    journal.jsonl   # append-only（journal.ts 管理）
 *    result.json     # 终态摘要（原子写）
 *
 * 状态模型（§4.4）：created → running → completed | failed | cancelled | waiting_checkpoint | interrupted
 *  - waiting_checkpoint 为持久化非终态
 *  - crash 检测：status=running 且 pid 已死 → interrupted（不假设任意 running 记录仍有活动进程）
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type RunStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_checkpoint"
  | "interrupted";

export interface RunManifest {
  runId: string;
  /** 脚本绝对路径 */
  scriptPath: string;
  /** 脚本内容 sha256（resume 校验：变化即拒绝） */
  scriptHash: string;
  /** args JSON sha256（null 表示无 args） */
  argsHash: string | null;
  /** args 原值（可序列化） */
  args?: unknown;
  cwd: string;
  status: RunStatus;
  /** 启动进程 pid（stop / 死进程检测） */
  pid: number;
  meta: { name: string; description?: string };
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** 运行级配置（resume 重建时使用） */
  options?: {
    model?: string;
    concurrency?: number;
    timeoutMs?: number | null;
    retries?: number;
    maxAgents?: number;
    continueOnFailure?: boolean;
  };
}

export function runsRoot(baseDir: string): string {
  return path.join(baseDir, ".pi-workflows", "runs");
}

export function runDir(baseDir: string, runId: string): string {
  return path.join(runsRoot(baseDir), runId);
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashArgs(args: unknown): string | null {
  if (args === undefined) return null;
  return createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

/** 原子写：tmp + rename（manifest/result 共用） */
export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}

export function createManifest(baseDir: string, manifest: RunManifest): void {
  atomicWriteJson(path.join(runDir(baseDir, manifest.runId), "manifest.json"), manifest);
}

export function updateManifest(baseDir: string, runId: string, patch: Partial<RunManifest>): RunManifest {
  const current = readManifest(baseDir, runId);
  if (!current) throw new Error(`manifest 不存在：${runId}`);
  const next: RunManifest = { ...current, ...patch, updatedAt: new Date().toISOString() };
  atomicWriteJson(path.join(runDir(baseDir, runId), "manifest.json"), next);
  return next;
}

export function readManifest(baseDir: string, runId: string): RunManifest | null {
  const file = path.join(runDir(baseDir, runId), "manifest.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as RunManifest;
  } catch {
    return null;
  }
}

/** pid 是否存活 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RunListItem {
  runId: string;
  status: RunStatus;
  /** 死进程补偿态：manifest=running 但 pid 已死 → interrupted（列表显示用） */
  effectiveStatus: RunStatus;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** 列出全部 run（按创建时间倒序） */
export function listRuns(baseDir: string): RunListItem[] {
  const root = runsRoot(baseDir);
  if (!fs.existsSync(root)) return [];
  const items: RunListItem[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(baseDir, entry.name);
    if (!manifest) continue;
    const effectiveStatus =
      manifest.status === "running" && !isPidAlive(manifest.pid) ? "interrupted" : manifest.status;
    items.push({
      runId: manifest.runId,
      status: manifest.status,
      effectiveStatus,
      name: manifest.meta.name,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 写终态结果摘要 */
export function writeResult(baseDir: string, runId: string, result: unknown): void {
  atomicWriteJson(path.join(runDir(baseDir, runId), "result.json"), result);
}
