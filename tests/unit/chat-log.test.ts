/**
 * 聊天记录（ChatLog + BotAdapter 埋点）：收发双向全量、按日期分文件、发送失败也记录、写坏不炸主链路。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WechatBotAdapter } from "../../src/gateway/wechat/bot-adapter.js";
import { ChatLog } from "../../src/gateway/wechat/chat-log.js";
import type { ChatLogEntry } from "../../src/gateway/wechat/chat-log.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-test-"));
}

function todayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test("ChatLog：入站+出站按本地日期落盘为 JSONL", () => {
  const dir = tmpDir();
  const log = new ChatLog(dir);
  const inTs = new Date().toISOString();
  log.record({ ts: inTs, direction: "in", userId: "u1", text: "你好", messageId: "m1" });
  log.record({ ts: new Date().toISOString(), direction: "out", userId: "u1", text: "收到", status: "sent" });
  const file = path.join(dir, "chat-logs", `${todayKey()}.jsonl`);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ChatLogEntry);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].direction, "in");
  assert.equal(lines[0].text, "你好");
  assert.equal(lines[1].status, "sent");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("BotAdapter 埋点：入站经轮询记录、出站成功记 sent、失败记 failed 并照常抛错", async () => {
  const entries: ChatLogEntry[] = [];
  const chatLog = { record: (e: ChatLogEntry) => entries.push(e) };
  let failNext = false;
  let delivered = false;
  const adapter = new WechatBotAdapter({
    clientFactory: async () => ({
      sendText: async (_to: string, _text: string) => {
        if (failNext) throw new Error("send boom");
        return undefined;
      },
      getUpdates: async () => {
        await new Promise((r) => setTimeout(r, 2));
        return delivered
          ? []
          : ((delivered = true),
            [
              { messageId: "m1", userId: "u1", text: "帮助", timestamp: new Date() },
              { messageId: "m2", userId: "u1", text: "  " }, // 空文本：过滤不记录
            ]);
      },
    }),
    pollIdleMs: 1,
    allowedUserIds: ["u1"],
    chatLog,
  });
  const seen: string[] = [];
  adapter.onMessage(async (m) => {
    seen.push(m.messageId);
  });
  await adapter.start();
  await new Promise((r) => setTimeout(r, 30));

  await adapter.send("u1", "回复一");
  failNext = true;
  await assert.rejects(adapter.send("u1", "回复二"), /send boom/);
  await adapter.stop();

  assert.deepEqual(seen, ["m1"]);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].direction, "in");
  assert.equal(entries[0].messageId, "m1");
  assert.equal(entries[0].text, "帮助");
  assert.equal(entries[1].status, "sent");
  assert.equal(entries[1].text, "回复一");
  assert.equal(entries[2].status, "failed");
  assert.equal(entries[2].text, "回复二");
});

test("ChatLog：目录不可写时不抛（主链路不受影响）", () => {
  // 用一个「路径被文件占位」的目录制造 mkdirSync 失败
  const dir = tmpDir();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const log = new ChatLog(path.join(blocker, "sub")); // mkdirSync 会撞文件
  log.record({ ts: new Date().toISOString(), direction: "in", userId: "u", text: "t" }); // 不抛即过
  fs.rmSync(dir, { recursive: true, force: true });
});
