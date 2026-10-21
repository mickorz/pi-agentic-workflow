/**
 * V2-P1 Worker 子进程入口（V2-runtime-server.md §3 进程模型）
 *
 * 协议：stdin/stdout JSON-lines（每行一条消息）。
 *   Server → Worker：start | resume | cancel | checkpointDecision
 *   Worker → Server：ready | heartbeat | event | checkpointAck | terminal
 *
 * 职责边界（单写者约定）：
 *   - Worker 写：journal、manifest（执行态）、result.json
 *   - Server 写：events.jsonl（Worker 只经 IPC event 转发，不落盘）
 *   - Worker 内 engine 以 eventsToDisk:false 创建，事件仅内存订阅→IPC
 *
 * checkpoint.requested / resolved 作为普通事件经 event 通道流动，
 * Server 侧 CheckpointService 由事件流驱动（run-service.wireCheckpointRecording），
 * 无需独立 checkpoint 消息。
 */
import readline from "node:readline";
import { createWorkflowEngine, type WorkflowHandle, type CheckpointDecision } from "../engine.js";
import type { AgentSessionRunner } from "../agent/session-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../runtime/errors.js";

/** 测试 fake runner：确定性文本回复；延迟窗口内响应 abort（模拟可取消的真实 Agent） */
function createFakeRunner(): AgentSessionRunner {
  const delayMs = Number(process.env.PI_WORKFLOW_FAKE_DELAY_MS ?? "0") || 0;
  return {
    async run(prompt: string, options?: { signal?: AbortSignal }) {
      if (delayMs <= 0) return { type: "text" as const, value: `fake:${prompt}`, sessionId: "fake-session" };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ type: "text" as const, value: `fake:${prompt}`, sessionId: "fake-session" }),
          delayMs,
        );
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  };
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const baseDir = process.env.PI_WORKFLOW_BASE_DIR ?? process.cwd();
const runner = process.env.PI_WORKFLOW_TEST_RUNNER === "fake" ? createFakeRunner() : undefined;
const engine = createWorkflowEngine({ baseDir, eventsToDisk: false, ...(runner ? { runner } : {}) });

send({ type: "ready", pid: process.pid });

const heartbeatMs = Number(process.env.PI_WORKFLOW_HEARTBEAT_MS ?? "5000") || 5000;
const heartbeat = setInterval(() => send({ type: "heartbeat", pid: process.pid }), heartbeatMs);

let active: { runId: string; handle: WorkflowHandle } | null = null;
let finished = false;
/** start 尚未就绪时收到的 cancel（消息不丢失，active 后立即执行） */
let cancelRequested = false;

function requestCancel(): void {
  cancelRequested = true;
  if (active && !finished) {
    void engine.cancel(active.runId).catch(() => {
      /* cancel 失败由终态通道兜底 */
    });
  }
}

/** 事件泵：内存订阅 → IPC（跳过 sequence<0 的迭代哨兵，其不落盘也不应转发） */
function pumpEvents(handle: WorkflowHandle): void {
  void (async () => {
    try {
      for await (const event of handle.events) {
        if (event.sequence < 0) continue;
        send({ type: "event", runId: handle.runId, event });
      }
    } catch {
      // 消费流中断不影响执行本身；终态由 result 结算通道汇报
    }
  })();
}

function classify(error: unknown): { status: string; error?: string } {
  if (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED) {
    return { status: "cancelled" };
  }
  if (error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_WAITING) {
    return { status: "waiting_checkpoint" };
  }
  return { status: "failed", error: error instanceof Error ? error.message : String(error) };
}

function finish(runId: string, status: string, error?: string): void {
  if (finished) return;
  finished = true;
  clearInterval(heartbeat);
  send({ type: "terminal", runId, status, ...(error !== undefined ? { error } : {}) });
  // 给 stdout 刷出时间后退出
  setTimeout(() => process.exit(0), 30);
}

/** 结算 result promise：engine 已写 manifest/result.json，Worker 只汇报终态并退出 */
function settle(runId: string, handle: WorkflowHandle): void {
  handle.result
    .then(() => finish(runId, "completed"))
    .catch((error: unknown) => {
      const { status, error: message } = classify(error);
      finish(runId, status, message);
    });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = msg.type;
  if (type === "start" && !finished) {
    const input = msg.input as import("../engine.js").WorkflowInput;
    const runId = msg.runId as string;
    void (async () => {
      try {
        const handle = await engine.start({ ...input, runId });
        active = { runId, handle };
        if (cancelRequested) requestCancel();
        pumpEvents(handle);
        settle(runId, handle);
      } catch (error) {
        finish(runId, "failed", error instanceof Error ? error.message : String(error));
      }
    })();
  } else if (type === "resume" && !finished) {
    const runId = msg.runId as string;
    void (async () => {
      try {
        const handle = await engine.resume(runId);
        active = { runId, handle };
        if (cancelRequested) requestCancel();
        pumpEvents(handle);
        settle(runId, handle);
      } catch (error) {
        finish(runId, "failed", error instanceof Error ? error.message : String(error));
      }
    })();
  } else if (type === "cancel") {
    requestCancel();
  } else if (type === "checkpointDecision" && active) {
    const runId = msg.runId as string;
    const decision = msg.decision as CheckpointDecision;
    void (async () => {
      let applied = false;
      try {
        applied = await engine.respondToCheckpoint(runId, decision);
      } catch {
        applied = false;
      }
      send({ type: "checkpointAck", runId, applied });
    })();
  }
});

/** 优雅停机：IPC cancel / stdin 关闭 / SIGTERM 共用——尽量让终态经 stdout 汇报后再退出 */
function gracefulShutdown(): void {
  if (active && !finished) {
    requestCancel();
    const safety = setTimeout(() => process.exit(0), 1500);
    safety.unref?.();
  } else if (!finished) {
    process.exit(0);
  }
}

// Server 关闭 stdin（进程被处置）→ 尽力优雅取消后退出
rl.on("close", () => {
  if (!finished) gracefulShutdown();
});

// SIGTERM（Supervisor 升级处置）：走 engine.cancel 优雅路径，终态经 stdout 汇报
process.on("SIGTERM", () => {
  if (!finished) gracefulShutdown();
  else process.exit(0);
});
