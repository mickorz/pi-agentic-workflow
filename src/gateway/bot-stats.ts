/**
 * Bot 运营统计落盘（F8 status 增强，P1；需求 §4 P1）
 *
 * 记录最近收发时间与累计 token 供 `wechat service status` 增强展示：
 *   bot-stats.json = { lastInboundAt, lastOutboundAt, totalTokens, turnsCount, updatedAt, pid }
 *
 * 写入策略：内存累加 + 脏标记；落盘节流（5s 内合并，写时带 pid——status 侧与锁核对后采信，
 * 与 bot-status.json 同款反误报约定）。进程死亡丢失未落盘增量可接受（统计非账本）。
 */

import fs from "node:fs";
import path from "node:path";

export interface BotStatsFile {
  lastInboundAt: string;
  lastOutboundAt: string;
  totalTokens: number;
  turnsCount: number;
  updatedAt: string;
  pid: number;
}

const FILE = "bot-stats.json";
const FLUSH_THROTTLE_MS = 5_000;

export class BotStatsRecorder {
  private readonly file: string;
  private readonly pid = process.pid;
  private readonly state: BotStatsFile;
  private dirty = false;
  private lastFlush = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, FILE);
    const prev = readBotStats(dataDir);
    // pid 不一致视为上一代遗留：时间戳清零重计，token 累计从 0 起（统计口径=本代进程）
    this.state = {
      lastInboundAt: prev?.pid === this.pid ? prev.lastInboundAt : "",
      lastOutboundAt: prev?.pid === this.pid ? prev.lastOutboundAt : "",
      totalTokens: prev?.pid === this.pid ? prev.totalTokens : 0,
      turnsCount: prev?.pid === this.pid ? prev.turnsCount : 0,
      updatedAt: new Date().toISOString(),
      pid: this.pid,
    };
  }

  recordInbound(): void {
    this.state.lastInboundAt = new Date().toISOString();
    this.touch();
  }

  recordOutbound(): void {
    this.state.lastOutboundAt = new Date().toISOString();
    this.touch();
  }

  recordTurn(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.state.totalTokens += Math.round(tokens);
    this.state.turnsCount += 1;
    this.touch();
  }

  /** 退出前冲刷（graceful stop 路径调用；未调则最多丢 5s 增量） */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.writeNow();
  }

  private touch(): void {
    this.dirty = true;
    const now = Date.now();
    if (now - this.lastFlush >= FLUSH_THROTTLE_MS) {
      this.writeNow();
      return;
    }
    // 节流窗内：延迟到窗口结束落盘（定时器 unref 不吊事件循环——服务模式早退不受影响）
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.dirty) this.writeNow();
      }, FLUSH_THROTTLE_MS);
      this.timer.unref?.();
    }
  }

  private writeNow(): void {
    this.dirty = false;
    this.lastFlush = Date.now();
    this.state.updatedAt = new Date().toISOString();
    this.state.pid = this.pid;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf8");
    } catch {
      // 统计落盘失败不阻断业务链路
    }
  }
}

export function readBotStats(dataDir: string): BotStatsFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")) as Partial<BotStatsFile>;
    if (typeof parsed.totalTokens !== "number" || typeof parsed.pid !== "number") return null;
    return {
      lastInboundAt: typeof parsed.lastInboundAt === "string" ? parsed.lastInboundAt : "",
      lastOutboundAt: typeof parsed.lastOutboundAt === "string" ? parsed.lastOutboundAt : "",
      totalTokens: parsed.totalTokens,
      turnsCount: typeof parsed.turnsCount === "number" ? parsed.turnsCount : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      pid: parsed.pid,
    };
  } catch {
    return null;
  }
}
