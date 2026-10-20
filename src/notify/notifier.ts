/**
 * Notifier（NT-001~003）：受理回执 / 成功 / 失败 三模板 + 超长拆分
 * P1 直发（经 BotAdapter.send）；P2 换 Outbox 驱动（接口不变）。
 */

import type { BotAdapter } from "../gateway/wechat/bot-adapter.js";

const WECHAT_LIMIT = 2000; // NT-002：超长拆分

export class Notifier {
  constructor(private readonly bot: Pick<BotAdapter, "send">) {}

  async receipt(userId: string, workflowId: string, taskBindingId: string): Promise<void> {
    await this.send(userId, `✅ 已受理「${workflowId}」（任务 ${taskBindingId}）。完成后会通知你。`);
  }

  async completed(userId: string, workflowId: string, summary: string): Promise<void> {
    await this.send(userId, `🎉「${workflowId}」已完成：\n${summary}`);
  }

  async failed(userId: string, workflowId: string, error: string): Promise<void> {
    await this.send(userId, `❌「${workflowId}」失败：${error}`);
  }

  /** NT-002：超长文本按段落边界拆分发送 */
  async send(userId: string, text: string): Promise<void> {
    if (text.length <= WECHAT_LIMIT) {
      await this.bot.send(userId, text);
      return;
    }
    let rest = text;
    let index = 1;
    const total = Math.ceil(text.length / WECHAT_LIMIT);
    while (rest.length > 0) {
      const chunk = rest.slice(0, WECHAT_LIMIT);
      rest = rest.slice(WECHAT_LIMIT);
      await this.bot.send(userId, `（${index}/${total}）${chunk}`);
      index += 1;
    }
  }
}
