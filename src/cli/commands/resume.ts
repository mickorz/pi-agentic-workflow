/**
 * pi-workflow resume <runId> —— 从 journal 恢复执行
 *
 * 规则：
 *  1. 脚本/args 哈希变化 → 拒绝（RESUME_MISMATCH）
 *  2. 副作用窗口防护：interrupted 恢复时，重执行可能重复已发生但未记 journal 的副作用——
 *     需交互确认或 --yes；--non-interactive 且无 --yes → 拒绝
 *  3. journal 命中且哈希一致 → 回放（不重复调模型）；首个未命中之后全部重执行
 */

import fs from "node:fs";
import * as readline from "node:readline/promises";
import { WorkflowError, WorkflowErrorCode } from "../../runtime/errors.js";
import { loadJournal } from "../../persistence/journal.js";
import { hashArgs, hashContent, isPidAlive, readManifest, runDir } from "../../persistence/run-store.js";
import { createTerminalCheckpointProvider } from "../../checkpoint/terminal-provider.js";
import { EXIT, executeWorkflowRun } from "../shared.js";

interface ResumeFlags {
  runId?: string;
  json: boolean;
  nonInteractive: boolean;
  yes: boolean;
  model?: string;
}

function parseFlags(argv: string[]): { flags: ResumeFlags; error?: string } {
  const flags: ResumeFlags = { json: false, nonInteractive: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--json": flags.json = true; break;
      case "--non-interactive": flags.nonInteractive = true; break;
      case "--yes": flags.yes = true; break;
      case "--model": flags.model = argv[++i]; break;
      default:
        if (!arg.startsWith("--") && !flags.runId) flags.runId = arg;
        else return { flags, error: `未知参数：${arg}` };
    }
  }
  if (!flags.runId) return { flags, error: "缺少 runId" };
  return { flags };
}

export async function resume(argv: string[]): Promise<number> {
  const { flags, error } = parseFlags(argv);
  if (error) {
    process.stderr.write(`参数错误：${error}\n用法：pi-workflow resume <runId> [--yes] [--non-interactive] [--model <spec>]\n`);
    return 2;
  }

  const manifest = readManifest(process.cwd(), flags.runId!);
  if (!manifest) {
    process.stderr.write(`未找到 run：${flags.runId}（查看 pi-workflow list）\n`);
    return 2;
  }
  if (manifest.status === "running" && isPidAlive(manifest.pid)) {
    process.stderr.write(`run ${flags.runId} 仍在运行（pid=${manifest.pid}）；如需终止请先 pi-workflow stop ${flags.runId}\n`);
    return 2;
  }
  if (manifest.status === "completed") {
    process.stderr.write(`run ${flags.runId} 已完成，无需恢复\n`);
    return 2;
  }

  // 1) 哈希校验：脚本或 args 变化 → 拒绝复用旧 journal
  let script: string;
  try {
    script = fs.readFileSync(manifest.scriptPath, "utf-8");
  } catch (e) {
    process.stderr.write(`脚本不可读：${manifest.scriptPath}（${e instanceof Error ? e.message : String(e)}）\n`);
    return 2;
  }
  if (hashContent(script) !== manifest.scriptHash) {
    process.stderr.write(
      `[${WorkflowErrorCode.RESUME_MISMATCH}] 脚本内容已变化，拒绝复用旧 journal（新开 run 或还原脚本后重试）\n`,
    );
    return 2;
  }
  if (hashArgs(manifest.args) !== manifest.argsHash) {
    process.stderr.write(`[${WorkflowErrorCode.RESUME_MISMATCH}] args 哈希不一致，拒绝复用旧 journal\n`);
    return 2;
  }

  const dir = runDir(process.cwd(), flags.runId!);
  const { journal, entries } = loadJournal(dir);

  // 2) 副作用窗口确认：中断后重执行不承诺 exactly-once
  const interrupted =
    manifest.status === "interrupted" || (manifest.status === "running" && !isPidAlive(manifest.pid));
  if (interrupted && entries > 0 && !flags.yes) {
    if (flags.nonInteractive) {
      process.stderr.write(
        `中断恢复可能重复未记 journal 节点的副作用（文件写入等）；非交互模式需显式 --yes 确认\n`,
      );
      return 2;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        `\n⚠️  run ${flags.runId} 在中断前可能有已执行但未记入 journal 的节点（副作用窗口）。\n   resume 将从中断点重执行，可能重复写文件类副作用。确认继续？[y/N] `,
      );
      if (answer.trim().toLowerCase() !== "y") {
        process.stderr.write("已放弃恢复\n");
        return 2;
      }
    } finally {
      rl.close();
    }
  }

  const opts = manifest.options ?? {};
  process.stderr.write(`恢复 ${flags.runId}：journal ${entries} 条可回放\n`);

  return executeWorkflowRun({
    baseDir: process.cwd(),
    scriptPath: manifest.scriptPath,
    cwd: manifest.cwd,
    ...(manifest.args !== undefined ? { args: manifest.args } : {}),
    model: flags.model ?? opts.model,
    concurrency: opts.concurrency,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    maxAgents: opts.maxAgents,
    continueOnFailure: opts.continueOnFailure ?? false,
    json: flags.json,
    existing: manifest,
    resumeJournal: journal,
    // 交互终端提供 checkpoint 通道；--non-interactive 无通道 → 等待态
    ...(flags.nonInteractive ? {} : { confirm: createTerminalCheckpointProvider() }),
  });
}

export { EXIT };
