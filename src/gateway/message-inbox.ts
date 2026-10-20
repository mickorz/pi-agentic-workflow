/**
 * Message Inbox（WG-003）：channel+messageId 幂等去重（贯穿全链路的第一道）
 * P2（WG-006）：去重状态持久化 .pi-wechat/inbox.jsonl —— 重启/断线重连后恢复游标语义，
 * 不无依据假定已收消息全部重发或全部丢失。
 */

import fs from "node:fs";
import path from "node:path";
import type { BotInboundMessage, BotMessageReceipt } from "../contracts/wx.js";

export class MessageInbox {
  private readonly seen = new Set<string>();
  private readonly file?: string;

  constructor(dataDir?: string) {
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.file = path.join(dataDir, "inbox.jsonl");
      // 重启恢复：折叠读历史去重键
      if (fs.existsSync(this.file)) {
        for (const raw of fs.readFileSync(this.file, "utf-8").split("\n")) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as { key?: string };
            if (parsed.key) this.seen.add(parsed.key);
          } catch {
            // 断裂行跳过
          }
        }
      }
    }
  }

  /** 首见 → received；重复 → duplicate（不重复投递） */
  accept(message: BotInboundMessage): BotMessageReceipt {
    const key = `${message.channel}:${message.messageId}`;
    const duplicate = this.seen.has(key);
    if (!duplicate) {
      this.seen.add(key);
      if (this.file) fs.appendFileSync(this.file, `${JSON.stringify({ key, at: message.receivedAt })}\n`, "utf-8");
    }
    return {
      messageId: message.messageId,
      channel: message.channel,
      userId: message.userId,
      status: duplicate ? "duplicate" : "received",
      receivedAt: message.receivedAt,
    };
  }

  isDuplicate(message: BotInboundMessage): boolean {
    return this.seen.has(`${message.channel}:${message.messageId}`);
  }
}
