/**
 * WorkflowEngine —— 宿主无关的公共引擎 API（P3，V1 执行文档 §4.2）
 *
 * 第三方 TS 程序不依赖 CLI 即可启停 run、订阅同源事件、审批 checkpoint、查询历史。
 * V2 Web Server 直接把本接口挂到 HTTP/SSE：
 *   start() → 201 + runId；events → SSE（EventSource 映射 AsyncIterable）
 *   respondToCheckpoint() → POST /runs/:id/checkpoints/:nodeId
 *
 * 事件不因无人消费而无限积累：持久化优先（events.jsonl），内存队列有界；
 * 迟到消费者用 getRun().events.lastSequence 作为游标从持久层续读。
 */

import fs from "node:fs";
import path from "node:path";
import { runWorkflow } from "./runtime/workflow-runtime.js";
import { parseWorkflowScript } from "./runtime/vm.js";

/** workflow 脚本加载/解析失败（engine/supervisor 抛出；run-service 映射为 INVALID_INPUT） */
export class WorkflowScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowScriptError";
  }
}
import { PiAgentAdapter } from "./adapters/pi/pi-agent-adapter.js";
import type { AgentSessionRunner } from "./agent/session-runner.js";
import { appendJournalEntry, loadJournal } from "./persistence/journal.js";
import {
  createManifest,
  hashArgs,
  hashContent,
  isPidAlive,
  listRuns,
  readManifest,
  runDir,
  runsRoot,
  updateManifest,
  writeResult,
  type RunListItem,
  type RunManifest,
} from "./persistence/run-store.js";
import { appendEvent, lastEventSequence, readEvents, validateEventSequence } from "./events/jsonl-sink.js";
import type { WorkflowEvent } from "./events/types.js";
import type { WorkflowRunResult } from "./runtime/types.js";
import { WorkflowError, WorkflowErrorCode } from "./runtime/errors.js";

/** 内存事件队列上限（超出后丢弃最旧入队项，消费者应改用持久层游标） */
const EVENT_BUFFER_LIMIT = 500;

export interface WorkflowInput {
  scriptPath: string;
  /** V2-P1：预指派 runId（Server 先写 manifest 再 spawn Worker 时由 Supervisor 注入） */
  runId?: string;
  args?: unknown;
  cwd?: string;
  model?: string;
  concurrency?: number;
  timeoutMs?: number | null;
  retries?: number;
  maxAgents?: number;
  continueOnFailure?: boolean;
}

export interface WorkflowHandle {
  runId: string;
  /** 同源事件流（有界内存队列；持久层为 events.jsonl） */
  events: AsyncIterable<WorkflowEvent>;
  result: Promise<WorkflowRunResult>;
}

export interface RunSnapshot {
  runId: string;
  status: string;
  effectiveStatus: string;
  manifest: RunManifest | null;
  journalEntries: number;
  events: { count: number; lastSequence: number; sequenceValid: boolean; sequenceIssue?: string };
  result: unknown | null;
}

export type CheckpointDecision = "approve" | "reject";

export interface WorkflowEngine {
  start(input: WorkflowInput): Promise<WorkflowHandle>;
  /** 恢复既有 run（journal 回放；哈希不匹配拒绝） */
  resume(runId: string): Promise<WorkflowHandle>;
  /** 查询运行快照（含事件游标） */
  getRun(runId: string): Promise<RunSnapshot | null>;
  /** 列出历史 run */
  listRuns(): Promise<RunListItem[]>;
  /** 取消活跃 run（本进程内） */
  cancel(runId: string): Promise<void>;
  /** 审批等待中的 checkpoint（engine 级通道；approve/reject） */
  respondToCheckpoint(runId: string, decision: CheckpointDecision): Promise<boolean>;
  /** 从游标读取持久化事件（V2 SSE 续读面） */
  readEventsSince(runId: string, afterSequence: number): Promise<WorkflowEvent[]>;
}

export interface EngineConfig {
  /** 注入 runner（测试用 fake）；缺省 PiAgentAdapter */
  runner?: AgentSessionRunner;
  /** 持久化根目录（缺省 process.cwd()） */
  baseDir?: string;
  /** 运行级默认模型 */
  model?: string;
  /** V2-P1 Worker 模式：false = 事件不落盘（Server 单写 events.jsonl），仅内存订阅转发 */
  eventsToDisk?: boolean;
}

interface ActiveRun {
  controller: AbortController;
  /** 等待审批的 checkpoint resolver */
  pendingCheckpoint?: { resolve: (reply: unknown) => void };
  buffer: WorkflowEvent[];
  waiters: Array<(event: WorkflowEvent) => void>;
  done: boolean;
}

export function createWorkflowEngine(config: EngineConfig = {}): WorkflowEngine {
  const baseDir = config.baseDir ?? process.cwd();
  const active = new Map<string, ActiveRun>();

  const attach = (runId: string): ActiveRun => {
    let run = active.get(runId);
    if (!run) {
      run = { controller: new AbortController(), buffer: [], waiters: [], done: false };
      active.set(runId, run);
    }
    return run;
  };

  const makeEventsIterable = (runId: string): AsyncIterable<WorkflowEvent> => {
    const state = attach(runId);
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: (): Promise<IteratorResult<WorkflowEvent>> => {
            if (index < state.buffer.length) {
              return Promise.resolve({ value: state.buffer[index++]!, done: false });
            }
            if (state.done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              state.waiters.push((event) => {
                index = state.buffer.length;
                resolve({ value: event, done: false });
              });
            });
          },
        };
      },
    };
  };

  const execute = (manifest: RunManifest, input: WorkflowInput, resumeJournal?: Map<string, unknown>): WorkflowHandle => {
    const state = attach(manifest.runId);
    const dir = runDir(baseDir, manifest.runId);
    const script = fs.readFileSync(manifest.scriptPath, "utf-8");
    // 事件序号续接（同 runId 连续，V2 SSE 游标不回绕）
    const eventSequenceStart = lastEventSequence(dir);
    const adapter =
      config.runner ??
      new PiAgentAdapter({ cwd: manifest.cwd, ...(input.model ? { defaultModel: input.model } : {}) });

    const handle: WorkflowHandle = {
      runId: manifest.runId,
      events: makeEventsIterable(manifest.runId),
      result: runWorkflow(script, {
        runId: manifest.runId,
        cwd: manifest.cwd,
        scriptPath: manifest.scriptPath,
        ...(manifest.args !== undefined ? { args: manifest.args } : {}),
        agent: adapter,
        ...(input.concurrency ? { concurrency: input.concurrency } : {}),
        ...(input.maxAgents ? { maxAgents: input.maxAgents } : {}),
        ...(input.timeoutMs !== undefined ? { agentTimeoutMs: input.timeoutMs } : {}),
        ...(input.retries !== undefined ? { agentRetries: input.retries } : {}),
        signal: state.controller.signal,
        continueOnAgentFailure: input.continueOnFailure ?? false,
        eventSequenceStart,
        ...(resumeJournal ? { resumeJournal: resumeJournal as never } : {}),
        onAgentJournal: (entry) => appendJournalEntry(dir, entry),
        confirm: async (promptText: string) => {
          // engine 级审批通道：挂起等待 respondToCheckpoint；拒绝 = false
          const reply = await new Promise<unknown>((resolve) => {
            state.pendingCheckpoint = { resolve };
          });
          state.pendingCheckpoint = undefined;
          return reply;
        },
        onEvent: (event) => {
          if (config.eventsToDisk !== false) appendEvent(dir, event);
          if (state.buffer.length >= EVENT_BUFFER_LIMIT) state.buffer.shift();
          state.buffer.push(event);
          for (const waiter of state.waiters.splice(0)) waiter(event);
        },
      }),
    };

    void handle.result
      .then((result) => {
        updateManifest(baseDir, manifest.runId, { status: "completed" });
        writeResult(baseDir, manifest.runId, result);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const status =
          error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED
            ? "cancelled"
            : error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_WAITING
              ? "waiting_checkpoint"
              : "failed";
        updateManifest(baseDir, manifest.runId, { status, ...(status === "failed" ? { error: message } : {}) });
      })
      .finally(() => {
        state.done = true;
        for (const waiter of state.waiters.splice(0)) {
          // 唤醒剩余消费者结束迭代
          waiter({ schemaVersion: 1, eventId: "end", runId: manifest.runId, sequence: -1, timestamp: new Date().toISOString(), type: "log.appended" });
        }
        // 运行结束后保留缓冲供 getRun 前读取；活跃表在进程生命周期内不删除（避免 GC 后 cancel 失效）
      });

    return handle;
  };

  return {
    async start(input) {
      const scriptPath = path.resolve(input.scriptPath);
      let script: string;
      let meta: ReturnType<typeof parseWorkflowScript>["meta"];
      try {
        script = fs.readFileSync(scriptPath, "utf-8");
        meta = parseWorkflowScript(script).meta;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new WorkflowScriptError(`workflow 无法加载/解析：${msg}`);
      }
      const now = new Date().toISOString();
      const runId = input.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const manifest: RunManifest = {
        runId,
        scriptPath,
        scriptHash: hashContent(script),
        argsHash: hashArgs(input.args),
        ...(input.args !== undefined ? { args: input.args } : {}),
        cwd: input.cwd ?? process.cwd(),
        status: "running",
        pid: process.pid,
        meta: { name: meta.name, ...(meta.description ? { description: meta.description } : {}) },
        createdAt: now,
        updatedAt: now,
        options: {
          model: input.model,
          concurrency: input.concurrency,
          timeoutMs: input.timeoutMs,
          retries: input.retries,
          maxAgents: input.maxAgents,
          continueOnFailure: input.continueOnFailure,
        },
      };
      // V2-P1 Worker 模式：Server 预写 manifest（所有权先于进程存在）——采纳并覆盖 pid，不重建
      const existing = readManifest(baseDir, runId);
      if (existing) {
        return execute(updateManifest(baseDir, runId, { status: "running", pid: process.pid }), input);
      }
      createManifest(baseDir, manifest);
      return execute(manifest, input);
    },

    async resume(runId) {
      const manifest = readManifest(baseDir, runId);
      if (!manifest) throw new Error(`run not found: ${runId}`);
      if (manifest.status === "running" && isPidAlive(manifest.pid)) {
        throw new Error(`run ${runId} still active (pid=${manifest.pid})`);
      }
      if (manifest.status === "completed") throw new Error(`run ${runId} already completed`);
      // 哈希校验
      const script = fs.readFileSync(manifest.scriptPath, "utf-8");
      if (hashContent(script) !== manifest.scriptHash) {
        throw new WorkflowError("脚本内容已变化，拒绝复用旧 journal", WorkflowErrorCode.RESUME_MISMATCH, {
          recoverable: false,
        });
      }
      const { journal } = loadJournal(runDir(baseDir, runId));
      // 同进程恢复：丢弃旧执行态（cancel/中断后 controller 已 abort、事件缓冲已消费），
      // 否则 attach 复用旧 state，新执行拿到已 aborted 的 signal 直接变 cancelled（V2 长驻服务场景）
      active.delete(runId);
      const updated = updateManifest(baseDir, runId, { status: "running", pid: process.pid });
      const opts = manifest.options ?? {};
      return execute(updated, {
        scriptPath: manifest.scriptPath,
        cwd: manifest.cwd,
        ...(manifest.args !== undefined ? { args: manifest.args } : {}),
        model: opts.model,
        concurrency: opts.concurrency,
        timeoutMs: opts.timeoutMs,
        retries: opts.retries,
        maxAgents: opts.maxAgents,
        continueOnFailure: opts.continueOnFailure,
      }, journal);
    },

    async getRun(runId) {
      const manifest = readManifest(baseDir, runId);
      if (!manifest) return null;
      const dir = runDir(baseDir, runId);
      const { entries } = loadJournal(dir);
      const { events } = readEvents(dir);
      const validation = validateEventSequence(events);
      const resultFile = path.join(dir, "result.json");
      const result = fs.existsSync(resultFile)
        ? (JSON.parse(fs.readFileSync(resultFile, "utf-8")) as unknown)
        : null;
      const effectiveStatus =
        manifest.status === "running" && !isPidAlive(manifest.pid) ? "interrupted" : manifest.status;
      return {
        runId,
        status: manifest.status,
        effectiveStatus,
        manifest,
        journalEntries: entries,
        events: {
          count: events.length,
          lastSequence: events.length > 0 ? (events[events.length - 1]?.sequence ?? 0) : 0,
          sequenceValid: validation.valid,
          ...(validation.issue ? { sequenceIssue: validation.issue } : {}),
        },
        result,
      };
    },

    async listRuns() {
      return listRuns(baseDir);
    },

    async cancel(runId) {
      const state = active.get(runId);
      if (!state) throw new Error(`no active run in this engine: ${runId}`);
      state.controller.abort();
    },

    async respondToCheckpoint(runId, decision) {
      const state = active.get(runId);
      if (!state?.pendingCheckpoint) return false;
      state.pendingCheckpoint.resolve(decision === "approve");
      return true;
    },

    async readEventsSince(runId, afterSequence) {
      return readEvents(runDir(baseDir, runId), afterSequence).events;
    },
  };
}

export { runsRoot };
