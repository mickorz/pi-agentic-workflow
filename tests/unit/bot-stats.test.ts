/**
 * P1 F8 单测：运营统计记录器 + WechatApp 埋点联动（最近收发/累计 token）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotStatsRecorder, readBotStats } from "../../src/gateway/bot-stats.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bot-stats-"));
}

test("记录与节流落盘：inbound/outbound/turn 累计，flushSync 立即落盘", () => {
  const dir = tmp();
  const r = new BotStatsRecorder(dir);
  r.recordInbound();
  r.recordTurn(120);
  r.recordTurn(80);
  r.recordOutbound();
  r.flushSync();
  const s = readBotStats(dir);
  assert.ok(s);
  assert.equal(s.turnsCount, 2);
  assert.equal(s.totalTokens, 200);
  assert.ok(s.lastInboundAt, "入站时间已记");
  assert.ok(s.lastOutboundAt, "出站时间已记");
  assert.equal(s.pid, process.pid);
});

test("首次立即落盘；节流窗内后续增量延迟落盘", () => {
  const dir = tmp();
  const r = new BotStatsRecorder(dir);
  r.recordInbound();
  assert.ok(readBotStats(dir), "首次记录立即落盘");
  r.recordTurn(77); // 节流窗内：不重写（flushSync 前文件保持旧值）
  assert.equal(readBotStats(dir)?.totalTokens ?? 0, 0, "窗内增量未落盘");
  r.flushSync();
  assert.equal(readBotStats(dir)?.totalTokens, 77);
});

test("上一代遗留（pid 不一致）不采信：时间戳与累计清零重计", () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "bot-stats.json"),
    JSON.stringify({
      lastInboundAt: "2026-01-01T00:00:00Z", lastOutboundAt: "2026-01-01T00:00:01Z",
      totalTokens: 9999, turnsCount: 99, updatedAt: "2026-01-01T00:00:02Z", pid: 1,
    }),
    "utf8",
  );
  const r = new BotStatsRecorder(dir);
  r.recordTurn(5);
  r.flushSync();
  const s = readBotStats(dir);
  assert.equal(s?.pid, process.pid);
  assert.equal(s?.totalTokens, 5, "上一代累计不继承（口径=本代进程）");
  assert.equal(s?.turnsCount, 1);
  assert.equal(s?.lastInboundAt, "", "上一代时间戳不继承");
});

test("recordTurn 非法值忽略（0/负数/NaN）", () => {
  const dir = tmp();
  const r = new BotStatsRecorder(dir);
  r.recordTurn(0);
  r.recordTurn(-5);
  r.recordTurn(Number.NaN);
  r.flushSync();
  const s = readBotStats(dir);
  assert.equal(s?.turnsCount, 0);
  assert.equal(s?.totalTokens, 0);
});

test("损坏文件按空处理（不抛）", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "bot-stats.json"), "not-json", "utf8");
  const r = new BotStatsRecorder(dir);
  r.recordTurn(10);
  r.flushSync();
  assert.equal(readBotStats(dir)?.totalTokens, 10);
});
