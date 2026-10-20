/**
 * BotAdapter 契约（WG-001）+ 微信实现（LK-01 路径 B：复用 pi-wechat-assistant 协议模块）
 * LK-03/LK-05 默认：绑定用户过滤、messageId 幂等、chat 回固定话术。
 */

import type { BotInboundMessage } from "../../contracts/wx.js";

export interface BotAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void;
  send(userId: string, text: string): Promise<void>;
}

/** 微信 BotAdapter：包装 WeixinClient（凭据来自 ~/.pi/agent/wechat-assistant/credentials.json） */
export class WechatBotAdapter implements BotAdapter {
  private handler?: (message: BotInboundMessage) => Promise<void>;
  private client?: { sendMessage(toUserId: string, text: string): Promise<unknown> };

  constructor(
    private readonly options: {
      allowedUserIds?: string[];
      /** 复用 submodule 客户端工厂（测试注入 fake） */
      clientFactory?: () => Promise<{ sendMessage(toUserId: string, text: string): Promise<unknown> }>;
    } = {},
  ) {}

  async start(): Promise<void> {
    const authPath = "../../../../thirdparties/pi-wechat-assistant/src/bridge/auth.ts";
    const { loadCredentials } = (await import(authPath)) as {
      loadCredentials: () => Promise<{ token: string; baseUrl: string; accountId: string; userId: string } | null>;
    };
    const creds = await loadCredentials();
    if (!creds) throw new Error("无微信凭据：先执行真机 SOP（dev-examples/wx-m0/standalone-adapter.ts --qr）扫码登录");
    if (this.options.clientFactory) {
      this.client = await this.options.clientFactory();
      return;
    }
    const modPath = "../../../../thirdparties/pi-wechat-assistant/src/wechat/client.ts";
    const { WeixinClient } = (await import(/* @vite-ignore */ modPath)) as {
      WeixinClient: new (creds: unknown, handlers: unknown) => { sendMessage(toUserId: string, text: string): Promise<unknown> };
    };
    this.client = new WeixinClient(creds, {
        onMessage: async (incoming: { fromUserId: string; messageId: string; content: unknown }) => {
          if (!this.handler) return;
          // WG-002：绑定用户过滤
          if (this.options.allowedUserIds && !this.options.allowedUserIds.includes(incoming.fromUserId)) return;
          const text = extractText(incoming.content);
          if (!text) return;
          await this.handler({
            channel: "wechat",
            userId: incoming.fromUserId,
            messageId: incoming.messageId,
            text,
            receivedAt: new Date().toISOString(),
          });
        },
        onSessionExpired: () => {
          // P2 断线自愈处理；P1 记录即可
        },
      } as never);
  }

  stop(): Promise<void> {
    this.client = undefined;
    return Promise.resolve();
  }

  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(userId: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Bot 未启动");
    await this.client.sendMessage(userId, text);
  }
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as { text?: unknown; content?: unknown };
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
  }
  return undefined;
}

/** chat 固定话术（LK-05：chat 默认关闭） */
export const CHAT_FALLBACK_REPLY = "我是工作流助手，暂不支持闲聊。可说「分析 <github 仓库地址>」这类指令，或回复「帮助」查看可用流程。";
