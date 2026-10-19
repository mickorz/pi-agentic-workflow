#!/usr/bin/env node
/**
 * pi-workflow —— CLI 入口
 *
 * 命令：run / validate（P0）；list / status / resume / stop 在 P2 引入。
 * 退出码：0 = completed；1 = failed/cancelled；2 = invalid（脚本/参数错误）；130 = interrupted
 */

import { run as runCommand } from "./commands/run.js";
import { validate as validateCommand } from "./commands/validate.js";
import { list as listCommand } from "./commands/list.js";
import { status as statusCommand } from "./commands/status.js";
import { resume as resumeCommand } from "./commands/resume.js";
import { stop as stopCommand } from "./commands/stop.js";

const HELP = `pi-workflow — Pi 动态工作流 CLI Runtime

用法：
  pi-workflow run <script.js> [选项]        执行 workflow 脚本
  pi-workflow validate <script.js>          校验脚本（meta 信封 + 确定性检查）
  pi-workflow list                          列出全部 run（含中断补偿态）
  pi-workflow status <runId>                查看运行详情与 journal 摘要
  pi-workflow resume <runId> [--yes]        从 journal 恢复执行
  pi-workflow stop <runId>                  终止本机活跃运行（SIGINT→SIGTERM）
  pi-workflow help                          显示本帮助

run 选项：
  --cwd <dir>             工作目录（缺省 process.cwd()）
  --args <json>           传给脚本的 args 全局（JSON 字符串）
  --model <spec>          运行级默认模型（"provider/modelId" 或裸 id；脚本级 model 优先）
  --concurrency <n>       最大并发（1-16）
  --timeout <ms>          run 级 agent 默认超时（毫秒；0 = 无上限）
  --retries <n>           run 级 agent 默认重试次数（0-3）
  --max-agents <n>        单 run agent 总数上限
  --json                  机器可读 JSON 输出（stdout）
  --non-interactive       无交互模式：checkpoint 进入等待态（绝不自动通过）
  --continue-on-failure   恢复静默继续旧行为（agent 重试耗尽返回 null 不终止）

resume 选项：
  --yes                   跳过副作用窗口人工确认（中断恢复可能重复未记 journal 的副作用）
  --non-interactive       无交互模式：副作用确认未决则拒绝；checkpoint 进入等待态
  --model <spec>          覆盖运行级默认模型

持久化：
  .pi-workflows/runs/<runId>/{manifest.json,journal.jsonl,result.json}

退出码：
  0  completed
  1  failed（agent 失败/超时耗尽/闸门终止）
  2  invalid（脚本校验失败/CLI 参数错误/resume 哈希不匹配）
  3  waiting_checkpoint（人工审批等待态，resume 恢复）
  130 interrupted（SIGINT 取消）
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "run":
      return runCommand(rest);
    case "validate":
      return validateCommand(rest);
    case "list":
      return listCommand(rest);
    case "status":
      return statusCommand(rest);
    case "resume":
      return resumeCommand(rest);
    case "stop":
      return stopCommand(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`未知命令：${command}\n\n`);
      process.stdout.write(HELP);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`cli internal error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
