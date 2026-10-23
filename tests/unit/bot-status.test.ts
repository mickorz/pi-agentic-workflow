/**
 * P0-C 单测：Bot 健康状态机 + 双维度聚合（需求 §7.3 契约）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BotStatusMonitor,
  readBotStatus,
  aggregateServiceStatus,
  POLL_STALE_MS,
} from "../../src/gateway/bot-status.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bot-status-"));
}

test("adapter 三态映射：connected/reconnecting 原样，stopped+attempt>0 → login_required（凭据失效类）", () => {
  const dir = tmp();
  const m = new BotStatusMonitor(dir, 111);
  m.handleAdapterStatus("connected");
  assert.equal(readBotStatus(dir)?.status, "connected");
  m.handleAdapterStatus("reconnecting", 3);
  const rec1 = readBotStatus(dir);
  assert.equal(rec1?.status, "reconnecting");
  assert.equal(rec1?.attempt, 3, "连续失败次数记录");
  m.handleAdapterStatus("stopped", 5); // 重连耗尽（WG-006）
  assert.equal(readBotStatus(dir)?.status, "login_required");
  m.handleAdapterStatus("stopped", 0); // 正常停止（app.stop 路径）
  assert.equal(readBotStatus(dir)?.status, "stopped");
});

test("心跳节流：30s 内多次 handlePollOk 只落盘一次；connected 态刷新 lastPollOkAt", () => {
  const dir = tmp();
  const m = new BotStatusMonitor(dir, 111);
  m.handleAdapterStatus("connected");
  let writes = 0;
  const orig = fs.writeFileSync;
  // biome-ignore lint/suspicious/noExplicitAny: 计数 stub
  (fs as any).writeFileSync = (...a: unknown[]) => {
    writes++;
    // biome-ignore lint/suspicious/noExplicitAny: 透传
    return (orig as any)(...a);
  };
  try {
    m.handlePollOk(1000);
    m.handlePollOk(2000);
    m.handlePollOk(3000);
    assert.equal(writes, 1, "节流窗口内只写一次");
    m.handlePollOk(1000 + POLL_STALE_MS); // 超过节流窗
    assert.equal(writes, 2);
  } finally {
    fs.writeFileSync = orig;
  }
});

test("心跳不覆盖非 connected 态（login_required 不被冲掉）", () => {
  const dir = tmp();
  const m = new BotStatusMonitor(dir, 111);
  m.handleAdapterStatus("stopped", 5);
  m.handlePollOk(Date.now());
  assert.equal(readBotStatus(dir)?.status, "login_required", "竞态保护");
});

// ── aggregateServiceStatus ──

test("聚合：进程 online + 心跳新鲜 → healthy", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const r = aggregateServiceStatus({
    processStatus: "online",
    holderPid: 111,
    botStatus: {
      status: "connected", attempt: 0, pid: 111, bootStartedAt: "", updatedAt: "",
      lastPollOkAt: new Date(now - 10_000).toISOString(),
    },
    now,
  });
  assert.equal(r.overall, "healthy");
});

test("聚合：自称 connected 但心跳超时 → unhealthy（不与 login_required 混淆，§7.4）", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const r = aggregateServiceStatus({
    processStatus: "online",
    holderPid: 111,
    botStatus: {
      status: "connected", attempt: 0, pid: 111, bootStartedAt: "", updatedAt: "",
      lastPollOkAt: new Date(now - POLL_STALE_MS - 60_000).toISOString(),
    },
    now,
  });
  assert.equal(r.overall, "unhealthy");
  assert.match(r.detail, /心跳超时/);
});

test("聚合：进程重启后旧状态文件不采信（pid 不匹配 → starting，§7.3 反误报）", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const r = aggregateServiceStatus({
    processStatus: "online",
    holderPid: 222,
    botStatus: {
      status: "login_required", attempt: 5, pid: 111, bootStartedAt: "", updatedAt: "",
      lastPollOkAt: "",
    },
    now,
  });
  assert.equal(r.overall, "starting", "上一代遗留不误报");
  assert.equal(r.bot, "stale");
});

test("聚合：进程不在线/未注册 → stopped；无状态文件 → starting", () => {
  assert.equal(
    aggregateServiceStatus({ processStatus: "unregistered", holderPid: 0, botStatus: null }).overall,
    "stopped",
  );
  assert.equal(
    aggregateServiceStatus({ processStatus: "online", holderPid: 1, botStatus: null }).overall,
    "starting",
  );
});

test("聚合：login_required 带处置指引（rebind）", () => {
  const r = aggregateServiceStatus({
    processStatus: "online",
    holderPid: 111,
    botStatus: {
      status: "login_required", attempt: 5, pid: 111, bootStartedAt: "", updatedAt: "",
      lastPollOkAt: "",
    },
  });
  assert.equal(r.overall, "login_required");
  assert.match(r.detail, /rebind/);
});
