/**
 * Conversation Store（CV-001~003）：待补参数状态机 / TTL / 最近任务引用
 * 存储按 LK-04：内存态 + 可选 JSONL 持久化（P2 CV-004：重启从 conversations.json 恢复）
 */

import fs from "node:fs";
import path from "node:path";
import type { ConversationState } from "../contracts/wx.js";

const TTL_MS = 15 * 60 * 1000; // LK-05：待补参数 TTL 15 分钟

export class ConversationStore {
  private readonly byUser = new Map<string, ConversationState>();
  private readonly file?: string;

  constructor(private readonly dataDir?: string) {
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.file = path.join(dataDir, "conversations.json");
      // CV-004：重启恢复（TTL 已过期的挂起计划自然作废）
      if (fs.existsSync(this.file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as ConversationState[];
          for (const state of parsed ?? []) {
            if (state && state.userId) this.byUser.set(state.userId, state);
          }
        } catch {
          // 损坏则冷启动（关键任务态在 TaskStore，不在此丢）
        }
      }
    }
  }

  get(userId: string): ConversationState | undefined {
    const state = this.byUser.get(userId);
    if (!state) return undefined;
    if (state.expiresAt && Date.now() > Date.parse(state.expiresAt)) {
      this.byUser.delete(userId); // TTL 过期：挂起计划作废
      return undefined;
    }
    return state;
  }

  /** 挂起待补参数计划（IR-005） */
  setPendingPlan(userId: string, pending: ConversationState["pendingPlan"], lastTaskBindingId?: string): void {
    const now = new Date();
    this.byUser.set(userId, {
      userId,
      ...(pending ? { pendingPlan: pending } : {}),
      ...(lastTaskBindingId ? { lastTaskBindingId } : {}),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
    });
    this.persist();
  }

  setLastTask(userId: string, taskBindingId: string): void {
    const existing = this.byUser.get(userId);
    this.byUser.set(userId, {
      userId,
      ...(existing?.pendingPlan ? { pendingPlan: existing.pendingPlan } : {}),
      lastTaskBindingId: taskBindingId,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    });
    this.persist();
  }

  /** 显式重置（CV-003：用户说"算了/取消"） */
  clear(userId: string): void {
    this.byUser.delete(userId);
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    fs.writeFileSync(this.file, JSON.stringify([...this.byUser.values()], null, 2), "utf-8");
  }
}
