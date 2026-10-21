/**
 * RunApplicationService —— 唯一启动/取消/恢复入口（V2-P0-03，应用服务层）
 *
 * 职责（不依赖 CLI/readline；可被 Web Server 与未来 CLI 外壳共同调用）：
 *  - start/get/list/cancel/resume/decideCheckpoint 应用 API
 *  - 组合：WorkflowEngine（进程内执行）+ CheckpointService（持久化审批）
 *  - 资源限额：maxConcurrentRuns（RUN_LIMIT_REACHED）
 *  - resume 副作用确认：interrupted 且有 journal 时必须 acknowledgeSideEffects
 *
 * 进程模型说明（V2-P0）：当前为 in-process 执行（与 V1 CLI 同级）；
 * V2-P1 将把执行下沉到 Worker 子进程（见 docs/architecture/V2-runtime-server.md），
 * 本服务接口保持不变。
 */

import path from "node:path";
import fs from "node:fs";
import { createWorkflowEngine, type WorkflowEngine, type WorkflowHandle, type RunSnapshot } from "../engine.js";
import { CheckpointService } from "./checkpoint-service.js";
import { loadJournal } from "../persistence/journal.js";
import { readManifest, updateManifest, isPidAlive, runDir, type RunListItem } from "../persistence/run-store.js";
import type { CheckpointRecordV2, RunDecision } from "../contracts/web.js";
import type { AgentSessionRunner } from "../agent/session-runner.js";

export type ServiceErrorCode =
  | "INVALID_INPUT"
  | "RUN_NOT_FOUND"
  | "CONFLICT"
  | "RESUME_MISMATCH"
  | "CHECKPOINT_NOT_PENDING"
  | "RUN_LIMIT_REACHED"
  | "SIDE_EFFECTS_UNACKNOWLEDGED"
  | "RUN_STILL_ACTIVE";

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface StartRunOptions {
  /** 脚本绝对路径（Web 层负责项目白名单校验后传入） */
  scriptPath: string;
  args?: unknown;
  cwd?: string;
  model?: string;
  concurrency?: number;
  timeoutMs?: number | null;
  retries?: number;
  maxAgents?: number;
  continueOnFailure?: boolean;
}

export interface ResumeOptions {
  /** 中断恢复副作用确认（waiting_checkpoint 恢复不要求） */
  acknowledgeSideEffects: boolean;
}

export interface ServiceConfig {
  baseDir?: string;
  /** 注入 runner（测试）；缺省 PiAgentAdapter */
  runner?: AgentSessionRunner;
  /** 最大并行 Run 数（缺省 2） */
  maxConcurrentRuns?: number;
}

export interface RunDetail {
  snapshot: RunSnapshot;
  checkpoints: CheckpointRecordV2[];
}

export class RunApplicationService {
  private readonly engine: WorkflowEngine;
  private readonly checkpoints: CheckpointService;
  private readonly maxConcurrentRuns: number;
  private readonly baseDir: string;

  constructor(config: ServiceConfig = {}) {
    this.baseDir = config.baseDir ?? process.cwd();
    this.engine = createWorkflowEngine({ baseDir: this.baseDir, ...(config.runner ? { runner: config.runner } : {}) });
    this.checkpoints = new CheckpointService(this.baseDir);
    this.maxConcurrentRuns = config.maxConcurrentRuns ?? 2;
  }

  /** 启动新 run（checkpoint 请求自动登记持久化记录） */
  async start(input: StartRunOptions): Promise<{ runId: string }> {
    if (!fs.existsSync(input.scriptPath)) {
      throw new ServiceError("INVALID_INPUT", `脚本不存在：${input.scriptPath}`);
    }
    const active = await this.countActive();
    if (active >= this.maxConcurrentRuns) {
      throw new ServiceError("RUN_LIMIT_REACHED", `并发 Run 上限 ${this.maxConcurrentRuns}（当前活跃 ${active}）`);
    }
    const handle = await this.engine.start({
      scriptPath: input.scriptPath,
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.concurrency ? { concurrency: input.concurrency } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.retries !== undefined ? { retries: input.retries } : {}),
      ...(input.maxAgents ? { maxAgents: input.maxAgents } : {}),
      ...(input.continueOnFailure !== undefined ? { continueOnFailure: input.continueOnFailure } : {}),
    });
    this.wireCheckpointRecording(handle);
    return { runId: handle.runId };
  }

  async get(runId: string): Promise<RunDetail | null> {
    const snapshot = await this.engine.getRun(runId);
    if (!snapshot) return null;
    return { snapshot, checkpoints: this.checkpoints.list(runId) };
  }

  async list(): Promise<RunListItem[]> {
    return this.engine.listRuns();
  }

  async cancel(runId: string): Promise<RunSnapshot> {
    const snapshot = await this.engine.getRun(runId);
    if (!snapshot) throw new ServiceError("RUN_NOT_FOUND", `run 不存在：${runId}`);
    if (snapshot.effectiveStatus !== "running") {
      // 幂等：非活跃状态直接返回快照
      return snapshot;
    }
    await this.engine.cancel(runId);
    // 等待终态落盘（事件写入 manifest 在 result promise 结算后）
    return (await this.waitForStatus(runId, ["cancelled", "failed", "completed"], 10_000)) ?? snapshot;
  }

  /** 恢复（waiting_checkpoint：重新询问审批；interrupted：需副作用确认） */
  async resume(runId: string, options: ResumeOptions): Promise<{ runId: string }> {
    const manifest = readManifest(this.currentBase(), runId);
    if (!manifest) throw new ServiceError("RUN_NOT_FOUND", `run 不存在：${runId}`);
    if (manifest.status === "running" && isPidAlive(manifest.pid)) {
      throw new ServiceError("RUN_STILL_ACTIVE", `run ${runId} 仍在运行（pid=${manifest.pid}）`);
    }
    if (manifest.status === "completed") {
      throw new ServiceError("CONFLICT", "已完成 run 不能恢复");
    }
    const interrupted =
      manifest.status === "interrupted" || (manifest.status === "running" && !isPidAlive(manifest.pid));
    if (interrupted) {
      const { entries } = loadJournal(runDir(this.currentBase(), runId));
      if (entries > 0 && !options.acknowledgeSideEffects) {
        throw new ServiceError(
          "SIDE_EFFECTS_UNACKNOWLEDGED",
          "中断恢复可能重复未记 journal 节点的副作用；需显式 acknowledgeSideEffects",
        );
      }
    }
    const active = await this.countActive();
    if (active >= this.maxConcurrentRuns) {
      throw new ServiceError("RUN_LIMIT_REACHED", `并发 Run 上限 ${this.maxConcurrentRuns}`);
    }
    try {
      const handle = await this.engine.resume(runId);
      this.wireCheckpointRecording(handle);
      return { runId };
    } catch (error) {
      if (error instanceof Error && /脚本内容已变化|args 哈希不一致/.test(error.message)) {
        throw new ServiceError("RESUME_MISMATCH", error.message);
      }
      throw error;
    }
  }

  /** 审批决策：持久化状态机（expectedVersion）+ 引擎通道唤醒 */
  async decideCheckpoint(
    runId: string,
    checkpointId: string,
    input: { decision: RunDecision; expectedVersion: number },
  ): Promise<CheckpointRecordV2> {
    const outcome = this.checkpoints.applyDecision(runId, checkpointId, input);
    if (!outcome.ok) {
      throw new ServiceError(
        outcome.reason === "CONFLICT" ? "CONFLICT" : "CHECKPOINT_NOT_PENDING",
        `checkpoint 决策被拒绝：${outcome.reason}（checkpointId=${checkpointId}）`,
      );
    }
    let delivered = false;
    if (!outcome.idempotent) {
      delivered = await this.engine.respondToCheckpoint(runId, input.decision);
    }
    if (!delivered) {
      // 跨进程决策/服务重启场景：等待方不在本进程（delivered=false），或决策已固化但 run 未推进
      // （idempotent 重放）。恢复路径：resume 重挂 checkpoint 等待 → 重放已固化决策 → 推进至终态。
      const m = readManifest(this.baseDir, runId);
      if (m && m.status === "waiting_checkpoint") {
        try {
          await this.engine.resume(runId);
          for (let i = 0; i < 20; i++) {
            delivered = await this.engine.respondToCheckpoint(runId, input.decision);
            if (delivered) break;
            await new Promise((r) => setTimeout(r, 250));
          }
        } catch {
          // resume 失败（如脚本已变化）：决策已持久化，由人工/后续恢复流程处置
        }
      }
    }
    return outcome.record;
  }

  /** 活跃 run 计数（running 且进程存活） */
  private async countActive(): Promise<number> {
    const runs = await this.engine.listRuns();
    return runs.filter((r) => r.effectiveStatus === "running").length;
  }

  private async waitForStatus(runId: string, statuses: string[], timeoutMs: number): Promise<RunSnapshot | null> {
    const start = Date.now();
    for (;;) {
      const snapshot = await this.engine.getRun(runId);
      if (snapshot && statuses.includes(snapshot.status)) return snapshot;
      if (Date.now() - start > timeoutMs) return snapshot;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** 订阅 handle 事件：checkpoint.requested → 持久化登记 + manifest 等待态；resolved → 回 running */
  private wireCheckpointRecording(handle: WorkflowHandle): void {
    void (async () => {
      try {
        for await (const event of handle.events) {
          if (event.type === "checkpoint.requested" && event.nodeId) {
            this.checkpoints.recordRequested(
              handle.runId,
              event.nodeId,
              event.nodeId,
              String((event.payload as { prompt?: string } | undefined)?.prompt ?? ""),
            );
            // 等待态持久化（V2：页面刷新/服务重启可见；仅 running 时迁移，不覆盖终态）
            const m = readManifest(this.baseDir, handle.runId);
            if (m && m.status === "running") {
              updateManifest(this.baseDir, handle.runId, { status: "waiting_checkpoint" });
            }
          }
          if (event.type === "checkpoint.resolved") {
            const m = readManifest(this.baseDir, handle.runId);
            if (m && m.status === "waiting_checkpoint") {
              updateManifest(this.baseDir, handle.runId, { status: "running" });
            }
          }
          if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
            break;
          }
        }
      } catch {
        // 事件流早关（run 结束）：记录已由 engine 落盘 events.jsonl，无损
      }
    })();
  }

  private currentBase(): string {
    return this.baseDir;
  }
}

/** 便捷工厂（与配置一致的 baseDir 传递给两个内部字段） */
export function createRunApplicationService(config: ServiceConfig = {}): RunApplicationService {
  return new RunApplicationService(config);
}

export { path };
