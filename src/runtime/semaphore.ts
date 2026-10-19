/**
 * 并发限制器（迁移自参考仓库 src/runtime/semaphore.ts，语义保持一致）
 */

export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  /** 运行中调整上限：调大立即唤醒排队者；调小不抢占，等存量自然释放 */
  setLimit(n: number): void;
}

/** 创建一个最多同时执行 limit 个任务的信号量 */
export function createLimiter(limit: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
  const setLimit = (n: number) => {
    limit = n;
    // 唤醒排队者：每 shift 一次记一次准入（被唤醒任务的 active++ 在其微任务续体里才发生）
    let admissions = 0;
    while (queue.length > 0 && active + admissions < limit) {
      queue.shift()?.();
      admissions++;
    }
  };
  // 保持 callable 形态并附加 setLimit
  return Object.assign(run, { setLimit });
}
