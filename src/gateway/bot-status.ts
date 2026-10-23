/**
 * Bot 健康状态落盘（F11，P0-C T1；需求 §7.3 双维度契约）
 *
 * Bot 维度状态机（对外五态，映射自 adapter 三态 + 心跳陈旧度）：
 *   connected      adapter connected 且心跳新鲜
 *   reconnecting   adapter reconnecting（attempt=连续失败次数）
 *   login_required adapter stopped 且由重连耗尽收尾（WG-006 凭据失效类，提示 rebind）
 *   unhealthy      adapter 自称 connected 但心跳超时（拉取死循环卡死/网络黑洞）
 *   stopped        正常停止（app.stop 路径）
 *
 * 反误报（§7.3「进程重启后不把旧状态误报为当前健康」）：
 *   状态文件带 pid + bootStartedAt；读取方仅当 pid 与当前锁持有者一致时采信，
 *   不一致即为上一代进程遗留 → 视作无状态（starting）。
 *
 * 落盘：每次状态变化立即写；心跳（拉取成功）节流写（≥30s 一次，避免长轮询高频 IO）。
 */

import fs from "node:fs";
import path from "node:path";

export type BotHealthStatus =
  | "connected"
  | "reconnecting"
  | "login_required"
  | "unhealthy"
  | "stopped";

export interface BotStatusFile {
  status: BotHealthStatus;
  /** 连续失败次数（reconnecting 时的 attempt） */
  attempt: number;
  /** 写状态的进程 pid（读取方核对锁持有者后才采信） */
  pid: number;
  /** 本代进程启动时间（ISO） */
  bootStartedAt: string;
  /** 状态更新时间（ISO） */
  updatedAt: string;
  /** 最近一次成功拉取时间（ISO；心跳陈旧判定用） */
  lastPollOkAt: string;
}

const FILE = "bot-status.json";
const HEARTBEAT_THROTTLE_MS = 30_000;
/** 心跳超时阈值：超过此时长无成功拉取 → unhealthy（长轮询周期可到 ~25s，阈值需显著大于它） */
export const POLL_STALE_MS = 120_000;

export class BotStatusMonitor {
  private readonly file: string;
  private readonly pid: number;
  private readonly bootStartedAt: string;
  private lastPollWrite = Number.NEGATIVE_INFINITY;

  constructor(dataDir: string, pid: number, bootStartedAt = new Date().toISOString()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, FILE);
    this.pid = pid;
    this.bootStartedAt = bootStartedAt;
  }

  /** adapter onStatus 入口：映射到对外五态并落盘 */
  handleAdapterStatus(status: "connected" | "reconnecting" | "stopped", attempt = 0): void {
    // stopped 两义：正常停止（attempt=0，app.stop 路径）与重连耗尽（attempt>=maxRetries，凭据失效类）
    const mapped: BotHealthStatus =
      status === "stopped" && attempt > 0 ? "login_required" : status;
    this.write({ status: mapped, attempt });
  }

  /** 拉取成功心跳：节流落盘（只刷新 lastPollOkAt/updatedAt） */
  handlePollOk(now = Date.now()): void {
    if (now - this.lastPollWrite < HEARTBEAT_THROTTLE_MS) return;
    this.lastPollWrite = now;
    const prev = readBotStatus(path.dirname(this.file));
    // 只在仍是 connected 时刷新心跳；其它状态不覆盖（避免竞态把 login_required 冲掉）
    if (prev && prev.pid === this.pid && prev.status === "connected") {
      this.write({ status: "connected", attempt: 0, lastPollOkAt: new Date(now).toISOString() });
    } else if (!prev || prev.pid !== this.pid) {
      this.write({ status: "connected", attempt: 0, lastPollOkAt: new Date(now).toISOString() });
    }
  }

  private write(over: { status: BotHealthStatus; attempt: number; lastPollOkAt?: string }): void {
    const now = new Date().toISOString();
    const rec: BotStatusFile = {
      status: over.status,
      attempt: over.attempt,
      pid: this.pid,
      bootStartedAt: this.bootStartedAt,
      updatedAt: now,
      lastPollOkAt: over.lastPollOkAt ?? now,
    };
    fs.writeFileSync(this.file, JSON.stringify(rec, null, 2), "utf8");
  }
}

/** 读取 Bot 状态文件（无/损坏返回 null） */
export function readBotStatus(dataDir: string): BotStatusFile | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<BotStatusFile>;
    if (typeof parsed.status !== "string" || typeof parsed.pid !== "number") return null;
    return {
      status: parsed.status as BotHealthStatus,
      attempt: typeof parsed.attempt === "number" ? parsed.attempt : 0,
      pid: parsed.pid,
      bootStartedAt: typeof parsed.bootStartedAt === "string" ? parsed.bootStartedAt : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      lastPollOkAt: typeof parsed.lastPollOkAt === "string" ? parsed.lastPollOkAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * 综合判定（status 命令用）：
 *   输入 PM2 进程态 + 锁持有者 + Bot 状态文件 → 单一对外结论 + 明细。
 * 反误报：botStatus.pid ≠ holderPid → 视为上一代遗留（starting/unknown）。
 * 心跳陈旧：自称 connected 但 lastPollOkAt 超过 POLL_STALE_MS → unhealthy。
 */
export interface AggregateInput {
  processStatus: "online" | "stopped" | "errored" | "unregistered";
  holderPid: number; // 锁持有者 pid（0=无锁）
  botStatus: BotStatusFile | null;
  now?: number;
}

export interface AggregateResult {
  overall: "healthy" | "reconnecting" | "login_required" | "unhealthy" | "stopped" | "errored" | "starting" | "unknown";
  bot: BotHealthStatus | "none" | "stale";
  detail: string;
}

export function aggregateServiceStatus(input: AggregateInput): AggregateResult {
  const now = input.now ?? Date.now();
  if (input.processStatus !== "online" || input.holderPid <= 0) {
    const overall: AggregateResult["overall"] =
      input.processStatus === "unregistered"
        ? "stopped"
        : input.processStatus === "online"
          ? "unknown" // PM2 报 online 但无存活锁持有者——进程态与锁不一致（如锁丢失），不假报健康
          : input.processStatus;
    return {
      overall,
      bot: "none",
      detail: `进程 ${input.processStatus}${input.holderPid <= 0 ? "（无存活锁持有者）" : ""}，无 Bot 状态可言`,
    };
  }
  const b = input.botStatus;
  if (!b || b.pid !== input.holderPid) {
    return {
      overall: "starting",
      bot: b ? "stale" : "none",
      detail: b
        ? `状态文件为上一代进程遗留（file pid=${b.pid} ≠ holder=${input.holderPid}），本代启动中`
        : "无 Bot 状态文件（启动中或旧版本运行）",
    };
  }
  if (b.status === "connected") {
    const staleMs = b.lastPollOkAt ? now - Date.parse(b.lastPollOkAt) : Number.POSITIVE_INFINITY;
    if (staleMs > POLL_STALE_MS) {
      return { overall: "unhealthy", bot: "unhealthy", detail: `心跳超时 ${Math.round(staleMs / 1000)}s 无成功拉取` };
    }
    return { overall: "healthy", bot: "connected", detail: "心跳新鲜" };
  }
  const overall: AggregateResult["overall"] =
    b.status === "login_required" ? "login_required" : b.status === "stopped" ? "stopped" : b.status;
  return {
    overall,
    bot: b.status,
    detail:
      b.status === "login_required"
        ? `凭据失效（重连 ${b.attempt} 次耗尽）；处理：pi-workflow wechat rebind 重新扫码`
        : b.status === "reconnecting"
          ? `重连中（第 ${b.attempt} 次退避）`
          : "Bot 已停止",
  };
}
