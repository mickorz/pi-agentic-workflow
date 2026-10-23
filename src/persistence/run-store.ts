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
  /** 启动进程 pid（stop / 死进程检测；V2：Worker 子进程 pid，Server 预写时为占位 server pid） */
  pid: number;
  /** V2-P1 写入所有权（V2-runtime-server.md §3.1）：启动服务实例标识，PID 复用误杀防护 */
  ownerInstanceId?: string;
  /** V2-P1：Worker 启动时间（与 ownerInstanceId 共同校验身份） */
  startedAt?: string;
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

/** 原子写：tmp + rename（manifest/result 共用）。Windows 下 rename 可能耗尽重试 EPERM/EBUSY（AV 扫描/并发读者短暂占用目标）——短退避重试 */
export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1)); // 20/40/60/80ms
    }
  }
  throw lastErr;
}

export function createManifest(baseDir: string, manifest: RunManifest): void {
  atomicWriteJson(path.join(runDir(baseDir, manifest.runId), "manifest.json"), manifest);
}

/** 终态集合：completed/failed/cancelled/interrupted——一经写入即事实，除显式恢复（force）外不可迁出 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * manifest 读-合-写的跨进程互斥：Server（checkpoint 回翻/pid 回填）与 Worker（终态写入）
 * 是两个进程写同一 manifest.json，无锁的 read-merge-write 会在交错窗口互相覆盖
 * （实踩：Worker 已写 completed，Server 迟到的 waiting→running 回翻把它改回 running→
 * effectiveStatus=interrupted）。锁文件 + 陈锁自愈（持锁者崩溃后 4s 强制重置）；
 * 持锁等待用 Atomics.wait（Node 允许主线程），避免忙转烧 CPU。
 */
function withManifestLock<T>(dir: string, fn: () => T): T {
  const lockPath = path.join(dir, "manifest.lock");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.closeSync(fd);
      break; // 获锁
    } catch {
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 4000) {
          fs.rmSync(lockPath, { force: true }); // 陈锁自愈：持锁者已崩溃
          continue;
        }
      } catch {
        continue; // 锁刚被释放，重试
      }
      Atomics.wait(sleeper, 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

export function updateManifest(
  baseDir: string,
  runId: string,
  patch: Partial<RunManifest>,
  opts?: { force?: boolean },
): RunManifest {
  const dir = runDir(baseDir, runId);
  return withManifestLock(dir, () => {
    const current = readManifest(baseDir, runId);
    if (!current) throw new Error(`manifest 不存在：${runId}`);
    // 终态不可逆守卫（锁内原子判定）：终态后被迟到写入回翻是双写竞态，静默丢弃 status（其余字段照常合并）。
    // 显式恢复（engine/CLI resume）传 opts.force。
    let effectivePatch = patch;
    if (
      patch.status !== undefined &&
      patch.status !== current.status &&
      TERMINAL_STATUSES.has(current.status) &&
      !opts?.force
    ) {
      const { status: _dropped, ...rest } = patch;
      effectivePatch = rest as Partial<RunManifest>;
    }
    const next: RunManifest = { ...current, ...effectivePatch, updatedAt: new Date().toISOString() };
    atomicWriteJson(path.join(dir, "manifest.json"), next);
    return next;
  });
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
