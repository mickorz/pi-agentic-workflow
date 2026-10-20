/**
 * BotAdapter 契约（WG-001）+ 微信实现（LK-01 路径 B：复用 pi-wechat-assistant 协议模块）
 * LK-03/LK-05 默认：绑定用户过滤、messageId 幂等、chat 回固定话术。
 * P2（WG-006/007，A17）：会话过期自动退避重连；stop() 只停 Bot，不触碰任何 Run（停止≠取消）。
 */

import type { BotInboundMessage } from "../../contracts/wx.js";

export interface BotAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void;
  send(userId: string, text: string): Promise<void>;
}

export interface ReconnectOptions {
  /** 最大重连尝试次数（缺省 5；0 = 不自动重连） */
  maxRetries?: number;
  /** 退避基数毫秒（缺省 5s，指数递增） */
  backoffMs?: number;
}

export interface WechatBotAdapterOptions {
  allowedUserIds?: string[];
  /** 复用 submodule 客户端工厂（测试注入 fake） */
  clientFactory?: () => Promise<{ sendMessage(toUserId: string, text: string): Promise<unknown> }>;
  /** 断线重连策略 */
  reconnect?: ReconnectOptions;
  /** 状态回调（审计/观测用） */
  onStatus?: (status: "connected" | "reconnecting" | "stopped", attempt?: number) => void;
}

/** 微信 BotAdapter：包装 WeixinClient（凭据来自 ~/.pi/agent/wechat-assistant/credentials.json） */
export class WechatBotAdapter implements BotAdapter {
  private handler?: (message: BotInboundMessage) => Promise<void>;
  private client?: { sendMessage(toUserId: string, text: string): Promise<unknown> };
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private readonly options: WechatBotAdapterOptions = {}) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempt = 0;
    await this.connect();
    this.options.onStatus?.("connected");
  }

  /** WG-007：停止 Bot ≠ 取消 Run。仅关闭本 Gateway，不改任何任务状态。 */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.client = undefined;
    this.options.onStatus?.("stopped");
    return Promise.resolve();
  }

  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(userId: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Bot 未启动");
    await this.client.sendMessage(userId, text);
  }

  /** WG-006：会话过期 → 指数退避重连（凭据失效最终停在 stopped，可人工重新扫码 SOP） */
  handleSessionExpired(): void {
    if (this.stopped) return;
    const { maxRetries = 5, backoffMs = 5000 } = this.options.reconnect ?? {};
    if (this.reconnectAttempt >= maxRetries) {
      this.client = undefined;
      this.options.onStatus?.("stopped", this.reconnectAttempt);
      return;
    }
    this.reconnectAttempt += 1;
    const delay = backoffMs * 2 ** (this.reconnectAttempt - 1);
    this.options.onStatus?.("reconnecting", this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.connect();
          this.reconnectAttempt = 0; // 重连成功重置计数
          this.options.onStatus?.("connected");
        } catch {
          this.handleSessionExpired(); // 继续退避
        }
      })();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async connect(): Promise<void> {
    // 测试注入：fake 客户端不依赖真机凭据
    if (this.options.clientFactory) {
      this.client = await this.options.clientFactory();
      return;
    }
    const authPath = "../../../thirdparties/pi-wechat-assistant/src/bridge/auth.ts";
    const { loadCredentials } = (await import(authPath)) as {
      loadCredentials: () => Promise<{ token: string; baseUrl: string; accountId: string; userId: string } | null>;
    };
    const creds = await loadCredentials();
    if (!creds) throw new Error("无微信凭据：先执行真机 SOP（dev-examples/wx-m0/standalone-adapter.ts --qr）扫码登录");
    const modPath = "../../../thirdparties/pi-wechat-assistant/src/wechat/client.ts";
    const { WeixinClient } = (await import(/* @vite-ignore */ modPath)) as {
      WeixinClient: new (
        creds: unknown,
        handlers: unknown,
      ) => { sendMessage(toUserId: string, text: string): Promise<unknown> };
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
        this.handleSessionExpired();
      },
    } as never);
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
export const CHAT_FALLBACK_REPLY =
  "我是工作流助手，暂不支持闲聊。可说「分析 <github 仓库地址>」这类指令，或回复「帮助」查看可用流程。";
