/**
 * 启动关联三阶段 + Run 结果关联（AM-P0 T1 纯逻辑；V2.1 §2.3/§3.3/§5）
 *
 * RunLaunchAttempt: launched → linked（成功回填 runId）| unknown（方案 B：启动不确定，
 *   禁止自动重试，人工核对——不假装 exactly-once）
 * RunLink: Run 终态回写（resultSummary/resultRef），后续 Turn 的 task_status 读取真实产物
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunLaunchAttempt, RunLink } from "./types.js";

const LAUNCH_FILE = "run-attempts.jsonl";
const LINK_FILE = "run-links.jsonl";

function loadAppendStore<T>(file: string, keyOf: (r: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").trim().split(/\r?\n/)) {
      if (!line) continue;
      const rec = JSON.parse(line) as T;
      map.set(keyOf(rec), rec); // 末条生效
    }
  }
  return map;
}

function append<T>(file: string, rec: T): void {
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
}

export class RunLaunchStore {
  private readonly file: string;
  private readonly byId = new Map<string, RunLaunchAttempt>();

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, LAUNCH_FILE);
    for (const [k, v] of loadAppendStore<RunLaunchAttempt>(this.file, (r) => r.attemptId)) this.byId.set(k, v);
  }

  /** 启动前预写（堵"启动后落盘前崩溃"窗口）：TaskBinding 不接收假 runId，先落 attempt */
  prewrite(input: {
    userId: string;
    workflowId: string;
    argsDigest: string;
    agentTurnId?: string;
    originMessageId?: string;
  }): RunLaunchAttempt {
    const attempt: RunLaunchAttempt = {
      attemptId: `la-${randomUUID().slice(0, 8)}`,
      userId: input.userId,
      workflowId: input.workflowId,
      argsDigest: input.argsDigest,
      ...(input.agentTurnId ? { agentTurnId: input.agentTurnId } : {}),
      ...(input.originMessageId ? { originMessageId: input.originMessageId } : {}),
      status: "launched",
      createdAt: new Date().toISOString(),
    };
    append(this.file, attempt);
    this.byId.set(attempt.attemptId, attempt);
    return attempt;
  }

  /** 启动成功：回填真实 runId（linked） */
  link(attemptId: string, runId: string, taskBindingId?: string): void {
    const a = this.byId.get(attemptId);
    if (!a || a.status === "linked") return;
    const next: RunLaunchAttempt = {
      ...a,
      status: "linked",
      runId,
      ...(taskBindingId ? { taskBindingId } : {}),
      linkedAt: new Date().toISOString(),
    };
    append(this.file, next);
    this.byId.set(attemptId, next);
  }

  /** 方案 B：启动结果不确定（崩溃/超时且无法确认）→ unknown，禁止自动重试，人工核对 */
  markUnknown(attemptId: string): void {
    const a = this.byId.get(attemptId);
    if (!a || a.status !== "launched") return;
    const next = { ...a, status: "unknown" as const };
    append(this.file, next);
    this.byId.set(attemptId, next);
  }

  /** 确定性同步失败作废（启动被拒/未发生；区别于 unknown 不确定态）：launched → discarded */
  discard(attemptId: string): void {
    const a = this.byId.get(attemptId);
    if (!a || a.status !== "launched") return;
    const next = { ...a, status: "discarded" as const };
    append(this.file, next);
    this.byId.set(attemptId, next);
  }

  /** 启动后未回填的 launched（崩溃窗口遗留）：恢复流程据此判定（存在即查 runs/ 比对，不盲目重试） */
  staleLaunched(): RunLaunchAttempt[] {
    return [...this.byId.values()].filter((a) => a.status === "launched");
  }

  unknownAttempts(): RunLaunchAttempt[] {
    return [...this.byId.values()].filter((a) => a.status === "unknown");
  }

  get(attemptId: string): RunLaunchAttempt | undefined {
    return this.byId.get(attemptId);
  }
}

export class RunLinkStore {
  private readonly file: string;
  private readonly byRun = new Map<string, RunLink>();

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, LINK_FILE);
    for (const [k, v] of loadAppendStore<RunLink>(this.file, (r) => r.runId)) this.byRun.set(k, v);
  }

  /** RunMonitor 终态回写（upsert；每次更新追加，内存末条生效） */
  upsert(link: Omit<RunLink, "updatedAt">): RunLink {
    const next: RunLink = { ...link, updatedAt: new Date().toISOString() };
    append(this.file, next);
    this.byRun.set(next.runId, next);
    return next;
  }

  get(runId: string): RunLink | undefined {
    return this.byRun.get(runId);
  }

  byUserAgentTurns(agentTurnIds: Set<string>): RunLink[] {
    return [...this.byRun.values()].filter((l) => l.agentTurnId && agentTurnIds.has(l.agentTurnId));
  }
}
