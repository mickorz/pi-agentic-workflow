// P0 T0.7：Node 版文章锁原型 —— 与 draft_manager/article_lock.py 完全同协议
// 协议契约（跨语言必须一致）：
//   1. 锁文件 = O_CREAT|O_EXCL 排他创建，内容 JSON {pid, runId, scope, acquiredAt}
//   2. 竞争失败 → LockHeldError（携带持有者信息），绝不等待重试
//   3. 持有进程已死 → 接管（unlink 后重试创建），打印 [LOCK] TAKEOVER
//   4. 仅持有者可 release（按 fd/身份核验，非持有者调用抛错）
import { open, unlink, readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class LockHeldError extends Error {
  constructor(info) {
    super(`lock held by pid=${info?.pid} runId=${info?.runId}`);
    this.info = info ?? { pid: null, runId: null };
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    if (e.code === 'EPERM') return true; // 存在但无权限（macOS 其他用户进程）
    return true;
  }
}

export class ArticleLock {
  constructor(path, { runId = '', scope = 'article' } = {}) {
    this.path = path;
    this.runId = runId;
    this.scope = scope;
    this._fd = null;
    this.takenOver = false;
  }

  async acquire() {
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    let takeoverFails = 0;
    while (true) {
      try {
        this._fd = await open(this.path, 'wx');
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const info = await this._readInfo();
        if (info && Number.isInteger(info.pid) && !pidAlive(info.pid)) {
          console.log(`[LOCK] TAKEOVER stale lock pid=${info.pid} scope=${this.scope}`);
          this.takenOver = true;
          await unlink(this.path).catch(() => {});
          takeoverFails += 1;
          if (takeoverFails > 5) {
            throw new LockHeldError({ ...info, note: 'stale lock unlink keeps failing, manual check' });
          }
          continue;
        }
        throw new LockHeldError(info || { pid: null, runId: null });
      }
    }
    const payload = {
      pid: process.pid,
      runId: this.runId,
      scope: this.scope,
      acquiredAt: new Date().toLocaleString('sv-SE').replace('T', ' '), // YYYY-MM-DD HH:MM:SS
    };
    await this._fd.write(JSON.stringify(payload), 0, 'utf8');
    return this;
  }

  async _readInfo() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 仅持有者可释放：fd 未开（非持有者/已释放）抛错 */
  async release() {
    if (this._fd === null) throw new Error('release() called by non-holder or after release');
    await this._fd.close();
    this._fd = null;
    await unlink(this.path).catch(() => {});
  }
}

/** 便捷入口 */
export async function withArticleLock(path, opts, fn) {
  const lk = await new ArticleLock(path, opts).acquire();
  try {
    return await fn(lk);
  } finally {
    await lk.release();
  }
}
