/**
 * Message Inbox（WG-003）：channel+messageId 幂等去重（贯穿全链路的第一道）
 */

import type { BotInboundMessage, BotMessageReceipt } from "../contracts/wx.js";

export class MessageInbox {
  private readonly seen = new Set<string>();

  /** 首见 → received；重复 → duplicate（不重复投递） */
  accept(message: BotInboundMessage): BotMessageReceipt {
    const key = `${message.channel}:${message.messageId}`;
    const duplicate = this.seen.has(key);
    if (!duplicate) this.seen.add(key);
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
