/**
 * RunSupervisor —— V2-P1 Worker 进程管理器（V2-runtime-server.md §3）
 *
 * 职责：
 *  - start：预指派 runId + 预写 manifest（status=running、pid=Server 占位、ownerInstanceId/startedAt）
 *    → spawn Worker → IPC 接力事件。所有权先于进程存在（kill-window 安全）。
 *  - resume：仅补写 ownerInstanceId/startedAt（status/pid 由 Worker 内 engine.resume 翻转，
 *    避免占位 pid 被 resume 的 isPidAlive 校验拒绝）。
 *  - 事件单写：Worker 只经 IPC event 转发（eventsToDisk:false），Server 追加 events.jsonl
 *    并喂内存订阅（与 engine 同构的有界 buffer/waiters）。
 *  - 心跳：超时视为 Worker 失联 → kill + manifest interrupted + result reject（不假成功）。
 *  - 取消升级：IPC cancel → 等终态 10s → SIGTERM → 3s → SIGKILL。
 *  - 异常退出无 terminal：manifest interrupted + result reject。
 *
 * 对 RunApplicationService 暴露 engine 形状（start/resume/cancel/respondToCheckpoint），
 * 读路径（getRun/listRuns/readEventsSince）委托内部只读 engine（纯磁盘读）。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createManifest,
  hashArgs,
  hashContent,
  readManifest,
  runDir,
  TERMINAL_STATUSES,
  updateManifest,
  type RunListItem,
  type RunManifest,
} from "../persistence/run-store.js";
import { appendEvent } from "../events/jsonl-sink.js";
import type { WorkflowEvent } from "../events/types.js";
import { parseWorkflowScript } from "../runtime/vm.js";
import { WorkflowScriptError } from "../engine.js";
import {
  createWorkflowEngine,
  type CheckpointDecision,
  type RunSnapshot,
  type WorkflowEngine,
  type WorkflowHandle,
  type WorkflowInput,
} from "../engine.js";

/** 内存事件队列上限（与 engine 一致；超出丢弃最旧，消费者走持久层游标） */
const EVENT_BUFFER_LIMIT = 500;

export interface SupervisorConfig {
  baseDir: string;
  /** 并发上限（真实 Worker 数量约束；run-service 层另有预检） */
  maxConcurrentRuns: number;
  /** Worker 启动命令（缺省 dist/server/worker-main.js，回退 tsx 源码）；测试注入用 */
  workerCommand?: string[];
  /** 心跳间隔（随 env PI_WORKFLOW_HEARTBEAT_MS 传给 Worker；缺省 5000ms） */
  heartbeatIntervalMs?: number;
  /** 心跳超时（缺省 30000ms；超时判失联） */
  heartbeatTimeoutMs?: number;
  /** 取消等待终态时长（缺省 10000ms；其后 SIGTERM→3s→SIGKILL） */
  cancelGraceMs?: number;
  /** 服务实例标识（manifest 所有权字段） */
  instanceId?: string;
  /** Worker 进程额外环境变量（测试注入 fake runner 等） */
  envExtra?: Record<string, string>;
  /** Worker stderr/异常日志回调 */
  onWorkerLog?: (line: string) => void;
}

interface RunState {
  runId: string;
  child: ChildProcess;
  buffer: WorkflowEvent[];
  waiters: Array<(event: WorkflowEvent) => void>;
  done: boolean;
  resultReject: (error: Error) => void;
  resultResolve: (value: never) => void;
  terminalReceived: boolean;
  lastHeartbeat: number;
  heartbeatTimer: NodeJS.Timeout;
  /** 挂起的 checkpointAck 等待 */
  pendingAck?: { resolve: (applied: boolean) => void };
  cleanup: () => void;
}

export class RunSupervisor implements Pick<WorkflowEngine, "start" | "resume" | "cancel" | "respondToCheckpoint"> {
  private readonly baseDir: string;
  private readonly maxConcurrentRuns: number;
  private readonly workerCommand: string[];
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly instanceId: string;
  private readonly envExtra: Record<string, string>;
  /** Worker stderr/异常日志回调 */
  private readonly onWorkerLog: (line: string) => void;
  /** 纯读路径委托（getRun/listRuns/readEventsSince 不经本类） */
  readonly reader: WorkflowEngine;
  private readonly active = new Map<string, RunState>();

  constructor(config: SupervisorConfig) {
    this.baseDir = config.baseDir;
    this.maxConcurrentRuns = config.maxConcurrentRuns;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 5000;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 30000;
    this.cancelGraceMs = config.cancelGraceMs ?? 10000;
    this.instanceId = config.instanceId ?? `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.envExtra = config.envExtra ?? {};
    this.onWorkerLog = config.onWorkerLog ?? (() => {});
    this.workerCommand =
      config.workerCommand ?? resolveDefaultWorkerCommand();
    this.reader = createWorkflowEngine({ baseDir: this.baseDir });
  }

  /** 引擎形状：getRun/listRuns/readEventsSince 透传（纯磁盘读） */
  getRun(runId: string): Promise<RunSnapshot | null> {
    return this.reader.getRun(runId);
  }
  listRuns(): Promise<RunListItem[]> {
    return this.reader.listRuns();
  }
  readEventsSince(runId: string, afterSequence: number): Promise<WorkflowEvent[]> {
    return this.reader.readEventsSince(runId, afterSequence);
  }

  async start(input: WorkflowInput): Promise<WorkflowHandle> {
    if (this.active.size >= this.maxConcurrentRuns) {
      const err = new Error(`并发 Worker 上限 ${this.maxConcurrentRuns}（当前活跃 ${this.active.size}）`) as Error & {
        code: string;
      };
      err.code = "RUN_LIMIT_REACHED";
      throw err;
    }
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
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    // 预写 manifest：所有权先于进程存在；pid 暂为 Server 占位，Worker ready 后覆盖
    const manifest: RunManifest = {
      runId,
      scriptPath,
      scriptHash: hashContent(script),
      argsHash: hashArgs(input.args),
      ...(input.args !== undefined ? { args: input.args } : {}),
      cwd: input.cwd ?? process.cwd(),
      status: "running",
      pid: process.pid,
      ownerInstanceId: this.instanceId,
      startedAt: now,
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
    createManifest(this.baseDir, manifest);
    return this.launchWorker(manifest.runId, { type: "start", runId, input: { ...input, runId } });
  }

  async resume(runId: string): Promise<WorkflowHandle> {
    if (this.active.size >= this.maxConcurrentRuns) {
      const err = new Error(`并发 Worker 上限 ${this.maxConcurrentRuns}`) as Error & { code: string };
      err.code = "RUN_LIMIT_REACHED";
      throw err;
    }
    const manifest = readManifest(this.baseDir, runId);
    if (!manifest) throw new Error(`run not found: ${runId}`);
    if (manifest.status === "running" && manifest.ownerInstanceId === this.instanceId && this.active.has(runId)) {
      throw new Error(`run ${runId} still active in this supervisor`);
    }
    // 仅补所有权字段；status/pid 由 Worker 内 engine.resume 翻转（占位 pid 会挡住 resume 校验）
    updateManifest(this.baseDir, runId, { ownerInstanceId: this.instanceId, startedAt: new Date().toISOString() });
    return this.launchWorker(runId, { type: "resume", runId });
  }

  async cancel(runId: string): Promise<void> {
    const state = this.active.get(runId);
    if (!state) throw new Error("no active run in this engine");
    this.writeLine(state, { type: "cancel", runId });
    // 等终态（Worker 优雅取消后回 terminal）→ 超时升级 SIGTERM→SIGKILL
    await new Promise<void>((resolve) => {
      const onTerminal = () => resolve();
      const timer = setTimeout(() => {
        this.onWorkerLog(`cancel 超时（${this.cancelGraceMs}ms），升级 SIGTERM：runId=${runId} pid=${state.child.pid}`);
        state.child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          if (!state.terminalReceived && state.child.pid) {
            this.onWorkerLog(`SIGTERM 后 3s 仍无终态，SIGKILL：runId=${runId}`);
            state.child.kill("SIGKILL");
          }
        }, 3000);
        killTimer.unref?.();
        // exit 事件兜底 resolve
        setTimeout(resolve, 3500).unref?.();
      }, this.cancelGraceMs);
      timer.unref?.();
      const wasDone = state.done;
      if (wasDone) onTerminal();
      else {
        const origCleanup = state.cleanup;
        state.cleanup = () => {
          origCleanup();
          onTerminal();
        };
      }
    });
  }

  async respondToCheckpoint(runId: string, decision: CheckpointDecision): Promise<boolean> {
    const state = this.active.get(runId);
    if (!state) return false;
    return new Promise<boolean>((resolve) => {
      state.pendingAck = { resolve };
      this.writeLine(state, { type: "checkpointDecision", runId, decision });
      setTimeout(() => {
        if (state.pendingAck) {
          state.pendingAck = undefined;
          resolve(false);
        }
      }, 5000).unref?.();
    });
  }

  /** 进程内仍在活跃的 run（供停机判断） */
  has(runId: string): boolean {
    return this.active.has(runId);
  }

  async shutdown(): Promise<void> {
    for (const runId of [...this.active.keys()]) {
      try {
        await this.cancel(runId);
      } catch {
        /* 尽力而为 */
      }
    }
  }

  // ---- 内部 ----

  private writeLine(state: RunState, msg: unknown): void {
    if (state.child.stdin && !state.child.killed) {
      state.child.stdin.write(`${JSON.stringify(msg)}\n`);
    }
  }

  private makeEventsIterable(state: RunState): AsyncIterable<WorkflowEvent> {
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
  }

  private finishRun(state: RunState, status: string, error?: string): void {
    if (state.done) return;
    state.done = true;
    state.terminalReceived = true;
    clearInterval(state.heartbeatTimer);
    state.cleanup();
    // 唤醒剩余消费者结束迭代（哨兵不落盘不转发）
    for (const waiter of state.waiters.splice(0)) {
      waiter({
        schemaVersion: 1,
        eventId: "end",
        runId: state.runId,
        sequence: -1,
        timestamp: new Date().toISOString(),
        type: "log.appended",
      });
    }
    if (status === "completed") {
      state.resultResolve({ runId: state.runId, status: "completed" } as never);
    } else {
      // cancelled/failed/waiting_checkpoint/失联：与 engine 同构——result reject（消费方经磁盘终态获知细节）
      state.resultReject(new Error(error ?? `run ${state.runId} ended with status ${status}`));
    }
    this.active.delete(state.runId);
  }

  private launchWorker(runId: string, startMessage: Record<string, unknown>): WorkflowHandle {
    const child = spawn(this.workerCommand[0]!, this.workerCommand.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_WORKFLOW_BASE_DIR: this.baseDir,
        PI_WORKFLOW_HEARTBEAT_MS: String(this.heartbeatIntervalMs),
        ...this.envExtra,
      },
    });

    const dir = runDir(this.baseDir, runId);
    const state: RunState = {
      runId,
      child,
      buffer: [],
      waiters: [],
      done: false,
      resultReject: () => {},
      resultResolve: () => {},
      terminalReceived: false,
      lastHeartbeat: Date.now(),
      heartbeatTimer: setInterval(() => {
        if (Date.now() - state.lastHeartbeat > this.heartbeatTimeoutMs) {
          this.onWorkerLog(`心跳超时（${this.heartbeatTimeoutMs}ms），判定失联并 SIGKILL：runId=${runId}`);
          state.child.kill("SIGKILL");
        }
      }, Math.max(Math.floor(this.heartbeatTimeoutMs / 2), 50)),
      cleanup: () => {},
    };
    state.heartbeatTimer.unref?.();

    // handle 立即返回（run-service 需尽早订阅事件流）；result 随终态结算
    const resultPromise = new Promise<never>((resolve, reject) => {
      state.resultResolve = resolve;
      state.resultReject = reject;
    });
    // 无消费者时避免 unhandledRejection（真消费者仍能拿到 reject）
    resultPromise.catch(() => {});
    this.active.set(runId, state);
    const handle: WorkflowHandle = {
      runId,
      events: this.makeEventsIterable(state),
      result: resultPromise,
    };

    // stdout JSON-lines 分发
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        this.onWorkerLog(`[worker:stdout 非协议] ${text.slice(0, 200)}`);
        return;
      }
      const type = msg.type;
      if (type === "ready") {
        // Worker 真实 pid 覆盖占位（isPidAlive 检测由此生效）
        updateManifest(this.baseDir, runId, { pid: Number(msg.pid ?? 0) || process.pid });
      } else if (type === "heartbeat") {
        state.lastHeartbeat = Date.now();
      } else if (type === "event") {
        const event = msg.event as WorkflowEvent;
        if (!event || typeof event.sequence !== "number") return;
        appendEvent(dir, event);
        if (state.buffer.length >= EVENT_BUFFER_LIMIT) state.buffer.shift();
        state.buffer.push(event);
        for (const waiter of state.waiters.splice(0)) waiter(event);
      } else if (type === "checkpointAck") {
        state.pendingAck?.resolve(Boolean(msg.applied));
        state.pendingAck = undefined;
      } else if (type === "terminal") {
        this.finishRun(state, String(msg.status), typeof msg.error === "string" ? msg.error : undefined);
      }
    });

    const errRl = readline.createInterface({ input: child.stderr! });
    errRl.on("line", (line) => this.onWorkerLog(`[worker:stderr] ${line.slice(0, 300)}`));

    child.on("error", (error) => {
      this.onWorkerLog(`spawn 失败：runId=${runId} ${error.message}`);
      this.failRun(state, `Worker 启动失败：${error.message}`);
    });

    child.on("exit", (code, signal) => {
      if (!state.terminalReceived) {
        this.onWorkerLog(`Worker 异常退出（无终态）：runId=${runId} code=${code} signal=${signal}`);
        this.failRun(state, `Worker 异常退出（code=${code} signal=${signal}）`);
      }
    });

    // stdin 打开即写（Worker readline 就绪前缓冲于管道）
    this.writeLine(state, startMessage);

    return handle;
  }

  /** 异常收尾：manifest interrupted + result reject（E05：kill -9 不假成功）。
   *  已是终态（如 Worker 终态已落盘但 terminal 行丢失的窗口）则不覆盖——终态是事实 */
  private failRun(state: RunState, message: string): void {
    if (state.done) return;
    try {
      const m = readManifest(this.baseDir, state.runId);
      if (!m || !TERMINAL_STATUSES.has(m.status)) {
        updateManifest(this.baseDir, state.runId, { status: "interrupted", error: message });
      }
    } catch {
      /* manifest 可能尚未建成（spawn 即败） */
    }
    this.finishRun(state, "failed", message);
  }
}

/** 缺省 Worker 命令：优先 dist 产物，回退 tsx 源码（开发/测试环境）。
 *  必须经 fileURLToPath：Windows 上 URL.pathname 是 /C:/... 形式，existsSync 恒 false，
 *  spawn 会拿到不存在的模块路径→Worker 启动即退→run 被误判 interrupted（CI Windows 实踩） */
function resolveDefaultWorkerCommand(): string[] {
  const here = new URL(".", import.meta.url);
  const distEntry = fileURLToPath(new URL("worker-main.js", here));
  if (fs.existsSync(distEntry)) return [process.execPath, distEntry];
  const srcEntry = fileURLToPath(new URL("../../../src/server/worker-main.ts", here));
  return [process.execPath, "--import", "tsx", srcEntry];
}
