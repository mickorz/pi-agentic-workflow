/**
 * 微信 Bot 服务单实例锁（F5，需求：dev-docs/design/2026-10-22-wechat-persistent-service.md）
 *
 * acquire 流程：
 *   normalizeDataDir(dataDir)
 *     ├─> openSync(service.lock, "wx") 原子创建 ──成功──> 写入 pid/startedAt/cwd ──> 持有
 *     └─EEXIST──> 读锁内容并校验持有者 pid
 *           ├─ pid 存活 ──> 返回 acquired:false（不动原锁，杜绝误删活跃实例）
 *           └─ pid 已死或内容损坏 ──> rename 到唯一 stale 文件后重建 ──> 接管
 *                 └─rename 失败──> 他方先接管，返回 acquired:false
 *
 * release 流程：读锁内容，pid 等于当前进程才删除（防误删他方锁）。
 *
 * 锁在共享 Bot 启动层使用：前台 `wechat start` 与后台 service 形态都经过，
 * 只承诺同机同 data 目录互斥；跨机互踢靠运维约定（固定运行机）。
 */

import fs from "node:fs";
import path from "node:path";

export interface ServiceLockInfo {
  pid: number;
  startedAt: string;
  cwd: string;
}

export interface AcquireOutcome {
  acquired: boolean;
  /** 规范化后的 data 目录（锁的真实归属地） */
  lockDir: string;
  /** 竞争失败时的持有者信息（可解析时） */
  holder?: ServiceLockInfo;
  /** 本次是否通过接管陈旧锁获得 */
  stale?: boolean;
}

const LOCK_NAME = "service.lock";

/** Windows 下 process.kill(pid, 0)：ESRCH=不存在；EPERM=存在但无权限（按存活处理） */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 规范化 data 目录：绝对化 + 创建 + realpath（Windows 大小写/短路径归一，防产生第二把锁） */
function normalizeDataDir(dataDir: string): string {
  const abs = path.resolve(dataDir);
  fs.mkdirSync(abs, { recursive: true });
  return fs.realpathSync.native(abs);
}

function readLockInfo(lockPath: string): ServiceLockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ServiceLockInfo>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    };
  } catch {
    return null; // 读失败/JSON 损坏（崩溃残留）按陈锁处理
  }
}

export function acquireServiceLock(dataDir: string): AcquireOutcome {
  const lockDir = normalizeDataDir(dataDir);
  const lockPath = path.join(lockDir, LOCK_NAME);
  const info: ServiceLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };

  const writeLock = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify(info, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  if (writeLock()) return { acquired: true, lockDir };

  // 锁已存在：校验持有者
  const holder = readLockInfo(lockPath);
  if (holder && isPidAlive(holder.pid)) {
    return { acquired: false, lockDir, holder };
  }

  // 陈旧锁（持有者已死或内容损坏）：rename 原子移走后重建；rename 失败=他方先接管
  const stalePath = `${lockPath}.stale.${process.pid}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch {
    return {
      acquired: false,
      lockDir,
      ...(holder ? { holder } : {}),
    };
  }
  try {
    if (!writeLock()) {
      return { acquired: false, lockDir, ...(holder ? { holder } : {}) };
    }
  } finally {
    fs.rmSync(stalePath, { force: true });
  }
  return { acquired: true, lockDir, stale: true };
}

/** 释放锁：仅当锁内 pid 是当前进程才删除（防误删他方/陈旧接管中的锁） */
export function releaseServiceLock(dataDir: string): void {
  let lockDir: string;
  try {
    lockDir = normalizeDataDir(dataDir);
  } catch {
    return; // 目录都没了，无锁可释放
  }
  const lockPath = path.join(lockDir, LOCK_NAME);
  const holder = readLockInfo(lockPath);
  if (holder && holder.pid === process.pid) {
    fs.rmSync(lockPath, { force: true });
  }
}

/** 供 status/诊断用：读取当前锁信息（无锁或损坏返回 null） */
export function readServiceLock(dataDir: string): ServiceLockInfo | null {
  try {
    return readLockInfo(path.join(normalizeDataDir(dataDir), LOCK_NAME));
  } catch {
    return null;
  }
}
