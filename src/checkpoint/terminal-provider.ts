/**
 * Checkpoint Provider 抽象（P2）
 *
 * 人工审批通道与运行时解耦：runtime 只认 confirm(promptText) → reply 契约。
 *  - TerminalCheckpointProvider：CLI readline 交互（y/n）
 *  - 无 Provider + 无显式默认 → runtime 抛 CHECKPOINT_WAITING（等待态，绝不自动通过）
 *
 * reply === false 语义为 Human Reject（硬停止）。
 */

import * as readline from "node:readline/promises";

export type ConfirmChannel = (promptText: string) => Promise<unknown>;

/** 终端交互 Provider：y = 通过，n/其他 = 拒绝（false） */
export function createTerminalCheckpointProvider(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): ConfirmChannel {
  return async (promptText: string): Promise<unknown> => {
    const rl = readline.createInterface({
      input: input ?? process.stdin,
      output: output ?? process.stdout,
    });
    try {
      const answer = await rl.question(`\n⏸  checkpoint 人工确认：${promptText}\n   批准继续？[y/N] `);
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } finally {
      rl.close();
    }
  };
}
