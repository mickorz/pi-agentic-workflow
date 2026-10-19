/**
 * pi-workflow run <script.js> —— 执行 workflow（P2：持久化 manifest/journal + checkpoint 通道）
 */

import path from "node:path";
import { createTerminalCheckpointProvider } from "../../checkpoint/terminal-provider.js";
import { EXIT, executeWorkflowRun } from "../shared.js";

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
  nonInteractive: boolean;
  continueOnFailure: boolean;
}

function parseFlags(argv: string[]): { flags: RunFlags; error?: string } {
  const flags: RunFlags = { json: false, nonInteractive: false, continueOnFailure: false };
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
      case "--non-interactive":
        flags.nonInteractive = true;
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

export async function run(argv: string[]): Promise<number> {
  const { flags, error } = parseFlags(argv);
  if (error) {
    process.stderr.write(`参数错误：${error}\n用法：pi-workflow run <script.js> [选项]\n`);
    return EXIT.invalid;
  }

  const scriptPath = path.resolve(flags.script!);
  // 交互终端提供 checkpoint 通道；--non-interactive 无通道 → 等待态（绝不自动通过）
  const confirm = flags.nonInteractive ? undefined : createTerminalCheckpointProvider();

  return executeWorkflowRun({
    baseDir: flags.cwd ?? process.cwd(),
    scriptPath,
    ...(flags.cwd ? { cwd: flags.cwd } : {}),
    ...(flags.args !== undefined ? { args: flags.args } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.concurrency ? { concurrency: flags.concurrency } : {}),
    ...(flags.maxAgents ? { maxAgents: flags.maxAgents } : {}),
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
    ...(flags.retries !== undefined && !Number.isNaN(flags.retries) ? { retries: flags.retries } : {}),
    continueOnFailure: flags.continueOnFailure,
    json: flags.json,
    ...(confirm ? { confirm } : {}),
  });
}
