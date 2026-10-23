/**
 * P0-B T1 单测：优雅停止 helper（需求 §4 F2 契约）
 *  - 幂等：重复触发只停一次
 *  - stop 抛错也释放锁、回调 onStopped
 *  - 服务模式停完 process.exit(0)（stub exit 验证，不真退出测试进程）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGracefulShutdown } from "../../src/gateway/service-shutdown.js";

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

test("优雅停止：stop 成功 → 释放锁 → onStopped", async () => {
  const calls: string[] = [];
  let resolveStop: () => void = () => {};
  const shutdown = createGracefulShutdown({
    stop: () => new Promise<void>((r) => { resolveStop = r; }),
    releaseLock: () => calls.push("releaseLock"),
    onStopped: () => calls.push("onStopped"),
    serviceMode: false,
    log: () => {},
  });
  shutdown("SIGINT");
  await flush();
  assert.deepEqual(calls, [], "stop 未完成前不应释放锁");
  resolveStop();
  await flush();
  assert.deepEqual(calls, ["releaseLock", "onStopped"], "顺序：释放锁后回调");
});

test("防重复停止：二次触发被忽略（stop 仅一次）", async () => {
  let stopCount = 0;
  let lockCount = 0;
  let resolveStop: () => void = () => {};
  const shutdown = createGracefulShutdown({
    stop: () => { stopCount++; return new Promise<void>((r) => { resolveStop = r; }); },
    releaseLock: () => lockCount++,
    onStopped: () => {},
    serviceMode: false,
    log: () => {},
  });
  shutdown("SIGINT");
  shutdown("PM2 shutdown message"); // PM2 stop 时又补发的重复消息
  shutdown("SIGINT");
  assert.equal(stopCount, 1, "stop 只触发一次");
  resolveStop();
  await flush();
  assert.equal(lockCount, 1, "锁只释放一次");
});

test("stop 抛错也必须释放锁（finally）", async () => {
  const calls: string[] = [];
  const shutdown = createGracefulShutdown({
    stop: async () => { throw new Error("adapter stop failed"); },
    releaseLock: () => calls.push("releaseLock"),
    onStopped: () => calls.push("onStopped"),
    serviceMode: false,
    log: () => {},
  });
  shutdown("PM2 shutdown message");
  await flush();
  assert.deepEqual(calls, ["releaseLock", "onStopped"], "stop 失败不阻断收尾");
});

test("服务模式：停止完成后 exit(0)", async () => {
  const origExit = process.exit;
  const exits: Array<number | undefined> = [];
  // biome-ignore lint/suspicious/noExplicitAny: 测试 stub（记录不真退出，也不 throw——throw 会变未处理 rejection）
  (process as any).exit = ((code?: number) => { exits.push(code); }) as never;
  try {
    const shutdown = createGracefulShutdown({
      stop: async () => {},
      releaseLock: () => {},
      onStopped: () => {},
      serviceMode: true,
      log: () => {},
    });
    shutdown("PM2 shutdown message");
    await flush();
    await flush();
    assert.equal(exits[0], 0, "服务模式退出码 0");
  } finally {
    process.exit = origExit;
  }
});
