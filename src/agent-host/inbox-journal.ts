/**
 * 消息处理状态机与恢复协议（AM-P0 T1 纯逻辑；V2.1 §4）
 *
 * received ≠ processed：现有 MessageInbox 收到即持久化去重键会吞掉崩溃后重发；
 * 本 journal 记录完整原始消息快照 + 处理状态，服务启动时从 Journal 恢复未完成消息
 * （不等旧 Inbox 去重）；存在不确定副作用的恢复消息禁止重调 Agent（由上层判定）。
 */

import fs from "node:fs";
import path from "node:path";
import type { InboxJournalEntry, MessageState } from "./types.js";

const FILE = "inbox-journal.jsonl";

export interface InboundSnapshot {
  channel: string;
  messageId: string;
  userId: string;
  text: string;
  receivedAt: string;
}

export class InboxJournal {
  private readonly file: string;
  private readonly byKey = new Map<string, InboxJournalEntry>(); // key = channel:messageId

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, FILE);
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, "utf8").trim().split(/\r?\n/)) {
        if (!line) continue;
        const e = JSON.parse(line) as InboxJournalEntry;
        this.byKey.set(`${e.channel}:${e.messageId}`, e);
      }
    }
  }

  private serialize(e: InboxJournalEntry): void {
    fs.appendFileSync(this.file, `${JSON.stringify(e)}\n`, "utf8");
    this.byKey.set(`${e.channel}:${e.messageId}`, e);
  }

  /** 记录消息快照；duplicate = 已见过（处理中/已完成/失败） */
  record(msg: InboundSnapshot): { entry: InboxJournalEntry; duplicate: boolean } {
    const key = `${msg.channel}:${msg.messageId}`;
    const existing = this.byKey.get(key);
    if (existing) return { entry: existing, duplicate: true };
    const entry: InboxJournalEntry = { ...msg, state: "received", updatedAt: msg.receivedAt };
    this.serialize(entry);
    return { entry, duplicate: false };
  }

  markProcessing(channel: string, messageId: string, agentTurnId?: string): void {
    const e = this.byKey.get(`${channel}:${messageId}`);
    if (!e || e.state !== "received") return;
    this.serialize({ ...e, state: "processing", ...(agentTurnId ? { agentTurnId } : {}), updatedAt: new Date().toISOString() });
  }

  markCompleted(channel: string, messageId: string): void {
    const e = this.byKey.get(`${channel}:${messageId}`);
    if (!e || e.state === "completed") return;
    this.serialize({ ...e, state: "completed", updatedAt: new Date().toISOString() });
  }

  markFailed(channel: string, messageId: string): void {
    const e = this.byKey.get(`${channel}:${messageId}`);
    if (!e || e.state === "completed") return;
    this.serialize({ ...e, state: "failed", updatedAt: new Date().toISOString() });
  }

  /** 启动恢复：未完成（received/processing）消息重入队（恢复前由上层检查副作用关联） */
  unfinished(): InboxJournalEntry[] {
    return [...this.byKey.values()].filter((e) => e.state === "received" || e.state === "processing");
  }

  get(channel: string, messageId: string): InboxJournalEntry | undefined {
    return this.byKey.get(`${channel}:${messageId}`);
  }

  listStates(): MessageState[] {
    return [...this.byKey.values()].map((e) => e.state);
  }
}
