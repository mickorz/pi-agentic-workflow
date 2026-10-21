/**
 * CLI 共享执行器：run 与 resume 共用的持久化编排（manifest/journal/终态/信号）
 */

import path from "node:path";
import { runWorkflow } from "../runtime/workflow-runtime.js";
import { parseWorkflowScript } from "../runtime/vm.js";
import { WorkflowError, WorkflowErrorCode } from "../runtime/errors.js";
import { PiAgentAdapter } from "../adapters/pi/pi-agent-adapter.js";
import { appendJournalEntry, loadJournal, type Journal, type JournalEntry } from "../persistence/journal.js";
import { appendEvent, lastEventSequence } from "../events/jsonl-sink.js";
import {
  createManifest,
  hashArgs,
  hashContent,
  runDir,
  updateManifest,
  writeResult,
  type RunManifest,
} from "../persistence/run-store.js";
import type { ConfirmChannel } from "../checkpoint/terminal-provider.js";
import type { WorkflowEvent } from "../events/types.js";

export interface ExecuteOptions {
  baseDir: string;
  scriptPath: string;
  cwd?: string;
  args?: unknown;
  model?: string;
  concurrency?: number;
  timeoutMs?: number | null;
  retries?: number;
  maxAgents?: number;
  continueOnFailure: boolean;
  json: boolean;
  /** 已有 run（resume）；缺省新建 */
  existing?: RunManifest;
  /** resume 的旧 journal */
  resumeJournal?: Journal;
  /** checkpoint 通道；undefined = 无通道（等待态语义） */
  confirm?: ConfirmChannel;
}

export const EXIT = {
  completed: 0,
  failed: 1,
  invalid: 2,
  waitingCheckpoint: 3,
  interrupted: 130,
} as const;

export async function executeWorkflowRun(options: ExecuteOptions): Promise<number> {
  const script = await readScript(options.scriptPath);
  const meta = parseWorkflowScript(script).meta;
  const now = new Date().toISOString();

  let manifest: RunManifest;
  if (options.existing) {
    // CLI resume：显式恢复路径，允许终态→running（需 force 绕过终态不可逆守卫）
    manifest = updateManifest(options.baseDir, options.existing.runId, {
      status: "running",
      pid: process.pid,
      options: {
        model: options.model,
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        maxAgents: options.maxAgents,
        continueOnFailure: options.continueOnFailure,
      },
    });
  } else {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    manifest = {
      runId,
      scriptPath: path.resolve(options.scriptPath),
      scriptHash: hashContent(script),
      argsHash: hashArgs(options.args),
      ...(options.args !== undefined ? { args: options.args } : {}),
      cwd: options.cwd ?? process.cwd(),
      status: "running",
      pid: process.pid,
      meta: { name: meta.name, ...(meta.description ? { description: meta.description } : {}) },
      createdAt: now,
      updatedAt: now,
      options: {
        model: options.model,
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        maxAgents: options.maxAgents,
        continueOnFailure: options.continueOnFailure,
      },
    };
    createManifest(options.baseDir, manifest);
  }

  const dir = runDir(options.baseDir, manifest.runId);
  // 事件序号续接（同 runId 的 append-only 事件流连续）
  const eventSequenceStart = lastEventSequence(dir);
  const controller = new AbortController();
  let signalHandled = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    signalHandled = true;
    controller.abort();
    updateManifest(options.baseDir, manifest.runId, { status: "cancelled" });
    process.stderr.write(`\n收到 ${signal}，正在取消……\n`);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  const adapter = new PiAgentAdapter({
    cwd: manifest.cwd,
    ...(options.model ? { defaultModel: options.model } : {}),
  });

  try {
    const result = await runWorkflow(script, {
      runId: manifest.runId,
      cwd: manifest.cwd,
      scriptPath: manifest.scriptPath,
      ...(options.args !== undefined ? { args: options.args } : {}),
      agent: adapter,
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      ...(options.maxAgents ? { maxAgents: options.maxAgents } : {}),
      ...(options.timeoutMs !== undefined ? { agentTimeoutMs: options.timeoutMs } : {}),
      ...(options.retries !== undefined && !Number.isNaN(options.retries) ? { agentRetries: options.retries } : {}),
      signal: controller.signal,
      continueOnAgentFailure: options.continueOnFailure,
      eventSequenceStart,
      ...(options.resumeJournal ? { resumeJournal: options.resumeJournal } : {}),
      onAgentJournal: (entry: JournalEntry & { key: string }) => appendJournalEntry(dir, entry),
      onEvent: (event: WorkflowEvent) => appendEvent(dir, event),
      ...(options.confirm ? { confirm: options.confirm } : {}),
    });

    updateManifest(options.baseDir, manifest.runId, { status: "completed" });
    writeResult(options.baseDir, manifest.runId, result);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printSummary(result, manifest.runId, options.resumeJournal ? loadJournal(dir).entries : 0);
    }
    return EXIT.completed;
  } catch (error: unknown) {
    if (error instanceof WorkflowError) {
      switch (error.code) {
        case WorkflowErrorCode.CHECKPOINT_WAITING: {
          updateManifest(options.baseDir, manifest.runId, {
            status: "waiting_checkpoint",
            error: error.message,
          });
          process.stderr.write(`⏸  ${error.message}\n   恢复：pi-workflow resume ${manifest.runId}\n`);
          return EXIT.waitingCheckpoint;
        }
        case WorkflowErrorCode.WORKFLOW_ABORTED: {
          updateManifest(options.baseDir, manifest.runId, { status: "cancelled" });
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
          } else {
            process.stderr.write(`❌ 已取消：${error.message}\n`);
          }
          return EXIT.interrupted;
        }
        default: {
          updateManifest(options.baseDir, manifest.runId, { status: "failed", error: error.message });
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: `[${error.code}] ${error.message}` }, null, 2)}\n`);
          } else {
            process.stderr.write(`❌ 执行失败：[${error.code}] ${error.message}\n`);
          }
          return EXIT.failed;
        }
      }
    }
    // 非 WorkflowError（读盘/SDK 等）
    const message = error instanceof Error ? error.message : String(error);
    if (signalHandled) {
      updateManifest(options.baseDir, manifest.runId, { status: "cancelled" });
      return EXIT.interrupted;
    }
    updateManifest(options.baseDir, manifest.runId, { status: "failed", error: message });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`❌ 执行失败：${message}\n`);
    }
    return EXIT.failed;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

async function readScript(scriptPath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(scriptPath, "utf-8");
}

function printSummary(
  result: {
    meta: { name: string };
    agentCount: number;
    durationMs: number;
    agents: Array<{ label: string; status: string; tokens?: number; error?: string; replayed?: boolean }>;
    logs: string[];
  },
  runId: string,
  replayedEntries: number,
): void {
  const lines: string[] = [];
  lines.push(`✅ workflow "${result.meta.name}" 完成（run=${runId}${replayedEntries ? `，journal 回放 ${replayedEntries} 节点` : ""}）`);
  lines.push(`   agents: ${result.agentCount}，耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
  for (const a of result.agents) {
    const tokens = a.tokens ? `，tokens=${a.tokens}` : "";
    const replay = a.replayed ? "（journal 回放）" : "";
    const error = a.status !== "ok" && a.error ? `，error=${a.error}` : "";
    lines.push(`   - [${a.status}] ${a.label}${replay}${tokens}${error}`);
  }
  if (result.logs.length > 0) {
    lines.push("   日志（最近 20 条）：");
    for (const line of result.logs.slice(-20)) lines.push(`     ${line}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
