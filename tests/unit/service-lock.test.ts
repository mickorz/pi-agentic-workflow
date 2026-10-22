/**
 * service-lock 单测：原子获取、存活校验、陈锁接管、防误删
 * 对应 P0-A T1（dev-docs/planning/2026-10-22-wechat-p0a-execution.md §3）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireServiceLock, releaseServiceLock, readServiceLock } from "../../src/gateway/service-lock.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "svc-lock-"));
}

test("首次 acquire 成功，锁内容为当前进程", () => {
  const dir = tmpDir();
  const out = acquireServiceLock(dir);
  assert.equal(out.acquired, true);
  assert.equal(out.stale, undefined);
  const info = readServiceLock(dir);
  assert.ok(info);
  assert.equal(info.pid, process.pid);
  assert.ok(info.startedAt);
  releaseServiceLock(dir);
});

test("同目录二次 acquire 失败且返回持有者，原锁不被破坏", () => {
  const dir = tmpDir();
  const first = acquireServiceLock(dir);
  assert.equal(first.acquired, true);
  const before = fs.readFileSync(path.join(first.lockDir, "service.lock"), "utf-8");

  const second = acquireServiceLock(dir);
  assert.equal(second.acquired, false);
  assert.ok(second.holder);
  assert.equal(second.holder.pid, process.pid);

  const after = fs.readFileSync(path.join(first.lockDir, "service.lock"), "utf-8");
  assert.equal(before, after); // 原锁原样
  releaseServiceLock(dir);
});

test("release 后可重新 acquire", () => {
  const dir = tmpDir();
  assert.equal(acquireServiceLock(dir).acquired, true);
  releaseServiceLock(dir);
  assert.equal(readServiceLock(dir), null);
  assert.equal(acquireServiceLock(dir).acquired, true);
  releaseServiceLock(dir);
});

test("release 不删他人锁：锁内 pid 非当前进程时文件保留", () => {
  const dir = tmpDir();
  acquireServiceLock(dir);
  const lockPath = path.join(dir, "service.lock");
  // 伪造持有者为其他 pid（存活判定无关紧要，release 只比对自己）
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: "x", cwd: "y" }));
  releaseServiceLock(dir);
  assert.ok(fs.existsSync(lockPath)); // 未被删除
  fs.rmSync(lockPath, { force: true });
});

test("陈旧锁接管：持有者 pid 已死时 acquire 成功且 stale 标记", () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, "service.lock");
  // pid=0 必然判定为死亡（isPidAlive 对 <=0 直接 false）
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 0, startedAt: "old", cwd: "old" }));
  const out = acquireServiceLock(dir);
  assert.equal(out.acquired, true);
  assert.equal(out.stale, true);
  const info = readServiceLock(dir);
  assert.equal(info?.pid, process.pid);
  // 陈旧残留文件已清理
  assert.equal(fs.readdirSync(dir).some((f) => f.includes(".stale.")), false);
  releaseServiceLock(dir);
});

test("损坏锁内容按陈锁处理：接管成功", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "service.lock"), "not-json{{{");
  const out = acquireServiceLock(dir);
  assert.equal(out.acquired, true);
  assert.equal(out.stale, true);
  releaseServiceLock(dir);
});

test("连续多次尝试：只有首次获锁，其余失败", () => {
  const dir = tmpDir();
  const results = Array.from({ length: 10 }, () => acquireServiceLock(dir));
  assert.equal(results.filter((r) => r.acquired).length, 1);
  assert.equal(results.filter((r) => !r.acquired).length, 9);
  releaseServiceLock(dir);
});

test("相对路径与绝对路径解析为同一把锁", () => {
  const abs = tmpDir();
  const prev = process.cwd();
  try {
    process.chdir(path.dirname(abs));
    const base = path.basename(abs);
    assert.equal(acquireServiceLock(abs).acquired, true);
    // 相对路径指向同一目录：必须被锁拦下（Windows 下 realpath 字符串形式可能长短名不一，不断言字符串）
    const again = acquireServiceLock(path.join(".", base));
    assert.equal(again.acquired, false);
  } finally {
    process.chdir(prev);
    releaseServiceLock(abs);
  }
});

test("Windows 下大小写不同写法解析为同一把锁", { skip: process.platform !== "win32" }, () => {
  const abs = tmpDir();
  assert.equal(acquireServiceLock(abs).acquired, true);
  const flipped = abs.replace(/[a-z]/, (c) => c.toUpperCase()); // 首个小写字母翻大写
  // 互斥由 OS 大小写不敏感兑底（realpath 对翻转输入可能返回 8.3 短名，lockDir 字符串不保证一致）
  const again = acquireServiceLock(flipped);
  assert.equal(again.acquired, false);
  releaseServiceLock(abs);
});
