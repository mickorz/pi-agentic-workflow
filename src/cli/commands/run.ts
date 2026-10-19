/**
 * pi-workflow run <script.js> —— 执行 workflow
 *
 * P0：进程内执行 + stdout 输出；结果 JSON 全量输出（--json 同源）。
 * P2 将加入 .pi-workflows/ 持久化与 resume。
 */

import fs from "node:fs";
import path from "node:path";
import { runWorkflow } from "../../runtime/workflow-runtime.js";
import { WorkflowError, WorkflowErrorCode } from "../../runtime/errors.js";
import { PiAgentAdapter } from "../../adapters/pi/pi-agent-adapter.js";

interface RunFlags {
  script?: string;
  cwd?: string;
  args?: unknown;
  model?: string;
  concurrency?: number;
  timeoutMs?: number | null;
  retries?: number;
  maxAgents?: number;
  json: boolean;
  continueOnFailure: boolean;
}

function parseFlags(argv: string[]): { flags: RunFlags; error?: string } {
  const flags: RunFlags = { json: false, continueOnFailure: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case "--cwd":
        flags.cwd = next();
        break;
      case "--args": {
        const raw = next();
        if (raw === undefined) return { flags, error: "--args 需要 JSON 字符串参数" };
        try {
          flags.args = JSON.parse(raw);
        } catch (e) {
          return { flags, error: `--args 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
        }
        break;
      }
      case "--model":
        flags.model = next();
        break;
      case "--concurrency":
        flags.concurrency = Number.parseInt(next() ?? "", 10);
        break;
      case "--timeout": {
        const raw = next();
        const value = Number.parseInt(raw ?? "", 10);
        // 0 = 无上限（与 runtime 的 null 语义对齐）
        flags.timeoutMs = Number.isNaN(value) ? null : value === 0 ? null : value;
        break;
      }
      case "--retries":
        flags.retries = Number.parseInt(next() ?? "", 10);
        break;
      case "--max-agents":
        flags.maxAgents = Number.parseInt(next() ?? "", 10);
        break;
      case "--json":
        flags.json = true;
        break;
      case "--continue-on-failure":
        flags.continueOnFailure = true;
        break;
      default:
        if (!arg.startsWith("--") && !flags.script) {
          flags.script = arg;
        } else {
          return { flags, error: `未知参数：${arg}` };
        }
    }
  }
  if (!flags.script) return { flags, error: "缺少脚本路径参数" };
  return { flags };
}

function summarize(result: {
  runId: string;
  meta: { name: string; description?: string };
  agentCount: number;
  durationMs: number;
  agents: Array<{ label: string; status: string; tokens?: number; error?: string }>;
  logs: string[];
}): string {
  const lines: string[] = [];
  lines.push(`✅ workflow "${result.meta.name}" 完成（run=${result.runId}）`);
  lines.push(`   agents: ${result.agentCount}，耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
  for (const a of result.agents) {
    const tokens = a.tokens ? `，tokens=${a.tokens}` : "";
    const error = a.status !== "ok" && a.error ? `，error=${a.error}` : "";
    lines.push(`   - [${a.status}] ${a.label}${tokens}${error}`);
  }
  if (result.logs.length > 0) {
    lines.push("   日志：");
    for (const line of result.logs.slice(-20)) lines.push(`     ${line}`);
  }
  return lines.join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const { flags, error } = parseFlags(argv);
  if (error) {
    process.stderr.write(`参数错误：${error}\n用法：pi-workflow run <script.js> [选项]\n`);
    return 2;
  }

  const file = path.resolve(flags.script!);
  let script: string;
  try {
    script = fs.readFileSync(file, "utf-8");
  } catch (e) {
    process.stderr.write(`无法读取脚本：${file}\n${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  // SIGINT → abort（进程内取消；stop 跨进程能力属 P2）
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
  });

  const adapter = new PiAgentAdapter({
    cwd: flags.cwd,
    ...(flags.model ? { defaultModel: flags.model } : {}),
  });

  try {
    const result = await runWorkflow(script, {
      ...(flags.cwd ? { cwd: flags.cwd } : {}),
      scriptPath: file,
      ...(flags.args !== undefined ? { args: flags.args } : {}),
      agent: adapter,
      ...(flags.concurrency ? { concurrency: flags.concurrency } : {}),
      ...(flags.maxAgents ? { maxAgents: flags.maxAgents } : {}),
      ...(flags.timeoutMs !== undefined ? { agentTimeoutMs: flags.timeoutMs } : {}),
      ...(flags.retries !== undefined && !Number.isNaN(flags.retries) ? { agentRetries: flags.retries } : {}),
      signal: controller.signal,
      continueOnAgentFailure: flags.continueOnFailure,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${summarize(result)}\n`);
      process.stdout.write(`结果：${JSON.stringify(result.result)}\n`);
    }
    return 0;
  } catch (e) {
    const isCancelled =
      e instanceof WorkflowError &&
      (e.code === WorkflowErrorCode.WORKFLOW_ABORTED || /\babort/i.test(e.message));
    const message = e instanceof WorkflowError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`❌ ${isCancelled ? "已取消" : "执行失败"}：${message}\n`);
    }
    return isCancelled ? 130 : 1;
  }
}
