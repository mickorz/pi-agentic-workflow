/**
 * 限额（EX-010，SC-005，MR-011，A18）三层：
 *  - RateLimiter：每用户消息频率（滑动窗口）
 *  - BudgetTracker：每用户 Token 预算（持久化，重启恢复；成本估算按 NFR-008 允许延后）
 *  - Run 并发上限沿用 RunApplicationService.maxConcurrentRuns（RUN_LIMIT_REACHED）
 */

import fs from "node:fs";
import path from "node:path";

// ── 消息频率（SC-005） ──

export interface RateLimiterOptions {
  /** 窗口毫秒（缺省 60s） */
  windowMs?: number;
  /** 窗口内最大条数（缺省 20） */
  max?: number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly hits = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.max = options.max ?? 20;
  }

  /** 是否放行；拒绝时返回建议等待秒数 */
  allow(userId: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      const oldest = recent[0] ?? now - this.windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
      this.hits.set(userId, recent);
      return { ok: false, retryAfterSec };
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return { ok: true };
  }
}

// ── Token 预算（MR-011） ──

export interface BudgetOptions {
  /** 每用户 Token 上限；0/undefined = 不限 */
  maxTokensPerUser?: number;
  dataDir?: string;
}

interface BudgetLine {
  userId: string;
  tokens: number;
  at: string;
}

export class BudgetTracker {
  private readonly maxTokensPerUser: number;
  private readonly file?: string;

  constructor(options: BudgetOptions = {}) {
    this.maxTokensPerUser = options.maxTokensPerUser ?? 0;
    if (options.dataDir) {
      fs.mkdirSync(options.dataDir, { recursive: true });
      this.file = path.join(options.dataDir, "budget.jsonl");
    }
  }

  /** 记录消耗（追加落盘，重启可累计） */
  record(userId: string, tokens: number): void {
    if (!this.file || tokens <= 0) return;
    const line: BudgetLine = { userId, tokens, at: new Date().toISOString() };
    fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`, "utf-8");
  }

  used(userId: string): number {
    if (!this.file || !fs.existsSync(this.file)) return 0;
    let sum = 0;
    for (const raw of fs.readFileSync(this.file, "utf-8").split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as BudgetLine;
        if (parsed.userId === userId && typeof parsed.tokens === "number") sum += parsed.tokens;
      } catch {
        // 断裂行跳过
      }
    }
    return sum;
  }

  /** 预算检查：超限 → 明确反馈（拒绝新启动） */
  check(userId: string): { ok: true; used: number } | { ok: false; used: number; limit: number } {
    const used = this.used(userId);
    if (this.maxTokensPerUser > 0 && used >= this.maxTokensPerUser) {
      return { ok: false, used, limit: this.maxTokensPerUser };
    }
    return { ok: true, used };
  }
}
