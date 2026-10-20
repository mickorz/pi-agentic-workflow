/**
 * Task Store（EX-002~004）：TaskBinding 持久化（.pi-wechat/tasks.jsonl，LK-04）
 */

import fs from "node:fs";
import path from "node:path";
import type { TaskBinding } from "../contracts/wx.js";

export class TaskStore {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "tasks.jsonl");
  }

  append(binding: TaskBinding): void {
    fs.appendFileSync(this.file, `${JSON.stringify(binding)}\n`, "utf-8");
  }

  update(runId: string, patch: Partial<TaskBinding>): TaskBinding | null {
    const all = this.list();
    const index = all.findIndex((t) => t.runId === runId);
    if (index === -1) return null;
    const next: TaskBinding = { ...all[index]!, ...patch, updatedAt: new Date().toISOString() };
    all[index] = next;
    // JSONL 追加式：以最新行覆盖语义（读端折叠，同 key 取最后）
    fs.appendFileSync(this.file, `${JSON.stringify(next)}\n`, "utf-8");
    return next;
  }

  /** 折叠读取：同 runId 取最后一条 */
  list(): TaskBinding[] {
    if (!fs.existsSync(this.file)) return [];
    const byRun = new Map<string, TaskBinding>();
    for (const line of fs.readFileSync(this.file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as TaskBinding;
        if (parsed.runId) byRun.set(parsed.runId, parsed);
      } catch {
        // 断裂行跳过
      }
    }
    return [...byRun.values()];
  }

  byUser(userId: string): TaskBinding[] {
    return this.list().filter((t) => t.userId === userId);
  }

  latestByUser(userId: string): TaskBinding | undefined {
    const mine = this.byUser(userId);
    return mine.length > 0
      ? mine.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
      : undefined;
  }
}
