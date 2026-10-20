/**
 * Notification Outbox（NT-004~006，A15，D-06）：
 *  - 持久化 .pi-wechat/outbox.jsonl：pending / sent / failed 状态机
 *  - 「Run 完成」与「微信送达」分别记录（§9.3 完成不等于已送达）
 *  - 投递失败退避重试；超过重试上限或 24h（LK-05）→ failed（不无限重试）
 *  - 通知失败不丢结果：用户「任务列表」主动查询补偿（NT-006，由 TaskController 提供）
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuditLog } from "../audit/audit-log.js";
import type { NotificationOutboxItem, OutboxKind } from "../contracts/wx.js";

export interface OutboxOptions {
  /** 单条最大尝试次数（缺省 5） */
  maxAttempts?: number;
  /** 最大存活时长毫秒（缺省 24h，LK-05） */
  maxAgeMs?: number;
  /** 退避基数毫秒（缺省 30s；第 n 次失败后等待 base * 2^(n-1)） */
  retryBaseMs?: number;
}

/** 发送通道（生产 = BotAdapter.send；测试 = fake） */
export type OutboxSender = (userId: string, text: string) => Promise<void>;

export class Outbox {
  private readonly file: string;
  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;
  private readonly retryBaseMs: number;
  private flushing = false;
  private inFlight: Promise<{ sent: number; failed: number; deferred: number }> | null = null;

  constructor(
    dataDir: string,
    private readonly options: { audit?: AuditLog } & OutboxOptions = {},
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "outbox.jsonl");
    this.maxAttempts = options.maxAttempts ?? 5;
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.retryBaseMs = options.retryBaseMs ?? 30_000;
    this.resetBackoffOnRestart();
  }

  /** 重启补投（CV-004）：新进程加载时待发项退避清零 —— 重启即一次自然重试机会 */
  private resetBackoffOnRestart(): void {
    if (!fs.existsSync(this.file)) return;
    const items = this.readFolded();
    const pending = items.filter((i) => i.status === "pending" && i.nextRetryAt);
    if (pending.length === 0) return;
    fs.rmSync(this.file);
    for (const item of items) {
      this.append(item.status === "pending" && item.nextRetryAt ? { ...item, nextRetryAt: undefined } : item);
    }
  }

  /** 入队待发通知（立即落盘 pending） */
  enqueue(input: {
    userId: string;
    kind: OutboxKind;
    text: string;
    runId?: string;
    taskBindingId?: string;
  }): NotificationOutboxItem {
    const item: NotificationOutboxItem = {
      outboxId: `ob-${randomUUID().slice(0, 8)}`,
      userId: input.userId,
      kind: input.kind,
      text: input.text,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskBindingId ? { taskBindingId: input.taskBindingId } : {}),
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.append(item);
    return item;
  }

  /**
   * 投递一轮：对到期 pending 逐条尝试发送。
   * 成功 → sent；失败 → 退避排下次；尝试超限或超龄 → failed（审计 outbox.giveup）。
   */
  async flush(sender: OutboxSender): Promise<{ sent: number; failed: number; deferred: number }> {
    // 并发防双发：同轮只跑一个 pass，后来者链到同一 promise
    if (this.inFlight) return this.inFlight;
    this.flushing = true;
    const pass = this.flushInner(sender).finally(() => {
      if (this.inFlight === pass) this.inFlight = null;
      this.flushing = false;
    });
    this.inFlight = pass;
    return pass;
  }

  private async flushInner(sender: OutboxSender): Promise<{ sent: number; failed: number; deferred: number }> {
    const items = this.list().filter((i) => i.status === "pending");
    let sent = 0;
    let failed = 0;
    let deferred = 0;
    for (const item of items) {
      if (item.nextRetryAt && Date.now() < Date.parse(item.nextRetryAt)) {
        deferred += 1;
        continue;
      }
      try {
        await sender(item.userId, item.text);
        this.append({ ...item, status: "sent", sentAt: new Date().toISOString() });
        sent += 1;
      } catch (error) {
        const attempts = item.attempts + 1;
        const ageMs = Date.now() - Date.parse(item.createdAt);
        const giveUp = attempts >= this.maxAttempts || ageMs > this.maxAgeMs;
        if (giveUp) {
          this.append({
            ...item,
            status: "failed",
            attempts,
            lastError: error instanceof Error ? error.message : String(error),
          });
          failed += 1;
          this.options.audit?.record({
            actor: "system",
            action: "outbox.giveup",
            target: {
              ...(item.runId ? { runId: item.runId } : {}),
              ...(item.taskBindingId ? { taskBindingId: item.taskBindingId } : {}),
            },
            outcome: "failed",
            detail: `通知放弃投递（attempts=${attempts}）：${error instanceof Error ? error.message : String(error)}`,
          });
        } else {
          this.append({
            ...item,
            attempts,
            lastError: error instanceof Error ? error.message : String(error),
            nextRetryAt: new Date(Date.now() + this.retryBaseMs * 2 ** (attempts - 1)).toISOString(),
          });
          deferred += 1;
        }
      }
    }
    return { sent, failed, deferred };
  }

  list(): NotificationOutboxItem[] {
    return this.readFolded();
  }

  /** NT-006 补偿：某用户待发/失败通知（主动查询兜底展示） */
  pendingFor(userId: string): NotificationOutboxItem[] {
    return this.readFolded().filter((i) => i.userId === userId && i.status !== "sent");
  }

  /** 折叠读取：同 outboxId 取最后一条 */
  private readFolded(): NotificationOutboxItem[] {
    if (!fs.existsSync(this.file)) return [];
    const byId = new Map<string, NotificationOutboxItem>();
    for (const raw of fs.readFileSync(this.file, "utf-8").split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as NotificationOutboxItem;
        if (parsed?.outboxId) byId.set(parsed.outboxId, parsed);
      } catch {
        // 断裂行跳过
      }
    }
    return [...byId.values()];
  }

  private append(item: NotificationOutboxItem): void {
    fs.appendFileSync(this.file, `${JSON.stringify(item)}\n`, "utf-8");
  }
}
