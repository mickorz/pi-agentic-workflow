/**
 * pi-workflow stop <runId> —— 终止本机活跃运行（V1：仅本进程组/明确 pid）
 *
 * 语义：SIGINT（优雅取消）→ 等待 3s → SIGTERM；进程死后按 manifest 终态收尾
 * （仍为 running 视为 interrupted/cancelled 补偿）。不承诺跨主机/守护进程能力。
 */

import {
  isPidAlive,
  readManifest,
  updateManifest,
} from "../../persistence/run-store.js";

export async function stop(argv: string[]): Promise<number> {
  const runId = argv[0];
  if (!runId || runId.startsWith("--")) {
    process.stderr.write("用法：pi-workflow stop <runId>\n");
    return 2;
  }
  const manifest = readManifest(process.cwd(), runId);
  if (!manifest) {
    process.stderr.write(`未找到 run：${runId}\n`);
    return 2;
  }
  if (manifest.status !== "running") {
    process.stdout.write(`run ${runId} 状态为 ${manifest.status}，无需停止\n`);
    return 0;
  }
  if (!isPidAlive(manifest.pid)) {
    updateManifest(process.cwd(), runId, { status: "interrupted" });
    process.stdout.write(`run ${runId} 进程已死（pid=${manifest.pid}），标记为 interrupted\n`);
    return 0;
  }
  if (manifest.pid === process.pid) {
    process.stderr.write("不能 stop 自身进程\n");
    return 2;
  }

  process.stdout.write(`向 pid=${manifest.pid} 发送 SIGINT（优雅取消）……\n`);
  process.kill(manifest.pid, "SIGINT");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isPidAlive(manifest.pid)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isPidAlive(manifest.pid)) {
    process.stdout.write("3s 后仍存活，发送 SIGTERM……\n");
    process.kill(manifest.pid, "SIGTERM");
    const deadline2 = Date.now() + 2000;
    while (Date.now() < deadline2 && isPidAlive(manifest.pid)) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // 进程自身的 SIGINT handler 会写 cancelled；此处补偿仍为 running 的情况
  const fresh = readManifest(process.cwd(), runId);
  if (fresh && fresh.status === "running") {
    updateManifest(process.cwd(), runId, { status: isPidAlive(manifest.pid) ? "interrupted" : "cancelled" });
  }
  const final = readManifest(process.cwd(), runId);
  process.stdout.write(`run ${runId} 终态：${final?.status ?? "unknown"}\n`);
  return 0;
}
