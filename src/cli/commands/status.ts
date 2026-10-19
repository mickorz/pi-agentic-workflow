/**
 * pi-workflow status <runId> —— 运行详情 + journal 摘要
 */

import fs from "node:fs";
import path from "node:path";
import {
  isPidAlive,
  readManifest,
  runDir,
} from "../../persistence/run-store.js";
import { journalPath, loadJournal } from "../../persistence/journal.js";

export async function status(argv: string[]): Promise<number> {
  const runId = argv[0];
  if (!runId || runId.startsWith("--")) {
    process.stderr.write("用法：pi-workflow status <runId>\n");
    return 2;
  }
  const manifest = readManifest(process.cwd(), runId);
  if (!manifest) {
    process.stderr.write(`未找到 run：${runId}（查看 pi-workflow list）\n`);
    return 2;
  }
  const dir = runDir(process.cwd(), runId);
  const effectiveStatus =
    manifest.status === "running" && !isPidAlive(manifest.pid) ? "interrupted（进程已死）" : manifest.status;
  const { entries, skipped } = loadJournal(dir);
  const resultFile = path.join(dir, "result.json");
  const result = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, "utf-8")) as Record<string, unknown>
    : null;

  const out: Record<string, unknown> = {
    runId,
    name: manifest.meta.name,
    status: effectiveStatus,
    scriptPath: manifest.scriptPath,
    scriptHash: manifest.scriptHash.slice(0, 16),
    argsHash: manifest.argsHash?.slice(0, 16) ?? null,
    cwd: manifest.cwd,
    pid: manifest.pid,
    pidAlive: isPidAlive(manifest.pid),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    ...(manifest.error ? { error: manifest.error } : {}),
    journal: { file: journalPath(dir), entries, skippedDamagedLines: skipped },
    ...(result
      ? {
          resultSummary: {
            agentCount: result.agentCount,
            durationMs: result.durationMs,
            result: result.result,
          },
        }
      : {}),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}
