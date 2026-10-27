/**
 * 聊天记录持久化（复盘用）：按日期分文件追加写 JSONL —— <dataDir>/chat-logs/YYYY-MM-DD.jsonl（本地日期）。
 *
 * 挂在 BotAdapter 收发两端的最低层（WG 契约之下），业务路径（agent/legacy/outbox/审批卡/通知）
 * 全部经此，天然全量；与业务解耦——新增发送路径无需记得埋点。
 * 尽力而为：写失败静默吞掉，绝不影响收发主链路（复盘可容忍丢行，不可容忍断链）。
 */

import fs from "node:fs";
import path from "node:path";

/** 一条聊天记录（入站 = 用户发给 Bot；出站 = Bot 发给用户） */
export interface ChatLogEntry {
  /** 事件时间（ISO；入站取消息时间戳缺省到达时间，出站取发送完成时间） */
  ts: string;
  direction: "in" | "out";
  userId: string;
  text: string;
  /** 入站消息幂等键（重投递会出现同 messageId 多行，复盘可见原始投递行为） */
  messageId?: string;
  /** 出站结果：sent = 客户端已接受；failed = 抛错（重试由 Outbox 负责，此处只记事实） */
  status?: "sent" | "failed";
}

/** 最小接口（adapter 依赖它而非具体类，测试可注入内存版） */
export interface ChatLogLike {
  record(entry: ChatLogEntry): void;
}

function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class ChatLog implements ChatLogLike {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "chat-logs");
  }

  record(entry: ChatLogEntry): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // 文件归属按事件时间（entry.ts）而非写入时间：跨零点迟到的入站消息落在其发生日
      const day = localDateKey(new Date(entry.ts));
      fs.appendFileSync(path.join(this.dir, `${day}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // 尽力而为：绝不向上抛
    }
  }
}
