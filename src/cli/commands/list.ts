/**
 * pi-workflow list —— 列出全部 run（含死进程补偿态）
 */

import { listRuns } from "../../persistence/run-store.js";

export async function list(_argv: string[]): Promise<number> {
  const runs = listRuns(process.cwd());
  if (runs.length === 0) {
    process.stdout.write("（无运行记录；执行 pi-workflow run <script.js> 开始）\n");
    return 0;
  }
  const header = "runId".padEnd(28) + "name".padEnd(20) + "status".padEnd(20) + "created";
  process.stdout.write(`${header}\n`);
  for (const r of runs) {
    const line =
      r.runId.padEnd(28) +
      r.name.slice(0, 18).padEnd(20) +
      r.effectiveStatus.padEnd(20) +
      r.createdAt.slice(0, 19).replace("T", " ");
    process.stdout.write(`${line}\n`);
  }
  return 0;
}
